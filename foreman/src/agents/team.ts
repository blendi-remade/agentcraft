// The agent team: a lead and workers doing real work, each turn run by an engine (engine.ts):
// the Claude Agent SDK or the Codex app-server, chosen per agent (a team can mix them).
//
// Each agent processes a queue of jobs, one engine turn per job:
//   plan    lead explores the repo (read-only), writes the plan, creates tasks
//   work    worker implements a task in its own git worktree
//   review  lead reviews a finished task (diff + CI) -> request_merge or changes
//   followup resume an agent's session with new input (user message, answer, feedback)
// Session ids are persisted per (agent, task|goal). A job interrupted by a Foreman restart is
// resumed with the same session AND the same kind, so what happens after the turn (a planning
// goal becomes active, a finished task goes to CI + review) is never lost. start() reconciles
// every non-terminal state (planning goals, doing tasks, review tasks) with what is running.
//
// Steering: pause = abort the turn, keep the task, resume later; stop = off shift: abort the
// turn, withdraw the agent's open questions, hand its tasks back to the board, never scheduled
// again until resume/spawn (persisted across restarts).
//
// Hand-off: a task that changes hands (stop, reassign) is held off the board until the old turn
// is really over - its CLI process has exited and every process it started is gone (they keep
// the worktree busy on Windows and could still write to it) - and the old worktree's work is
// committed on its branch. The next worker's worktree then starts from that branch.
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TeamConfig } from '../config.js';
import type { AgentRuntime } from './runtime.js';
import { AuthenticationError } from './runtime.js';
import { RuntimeEngine } from './engine.js';
import { TeamPermissions } from '../permissions.js';
import { FOREMAN_VERSION } from '../config.js';
import { ClientError, type Backend, type Foreman } from '../foreman.js';
import { withGitSafety } from '../gitsafety.js';
import { agentGitIdentity } from '../util/git.js';
import type { BackendName, Decision, Goal, Task } from '../protocol.js';
import { MERGE_OPTIONS } from '../protocol.js';
import type { TestResult } from '../repos.js';
import { renderDiffText } from '../diff.js';
import { formatInbox } from '../bus.js';
import { descendantsOf, killSnapshot, killTree, orphansOf, processTable, type ProcEntry } from '../util/proc.js';
import { truncate } from '../util/text.js';
import { leadSystemPrompt, planPrompt, RESUME_PROMPT, reviewPrompt, workerSystemPrompt, workPrompt } from './prompts.js';
import { fetchPulls, githubOrigin, prRefs, pullBriefs, type PullRequest } from '../pulls.js';
import type { Engine, EngineId, PermissionGate, Role, TurnStats } from './engine.js';
import { agentTools, type ToolHooks, type TurnHandle } from './tools.js';
import { modelLabel } from './models.js';
import { userName } from '../user.js';

type JobKind = 'plan' | 'work' | 'review' | 'followup';
type AbortReason = 'pause' | 'stop' | 'shutdown' | 'cancel' | 'timeout';

interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  /** start a new session even if one exists for the key */
  fresh?: boolean;
  /** nudges already sent for this task (worker ended without update_task) */
  nudges?: number;
  /** continuing an interrupted job (restart, pause): log the prompt */
  resumed?: boolean;
}

interface Inflight {
  kind: JobKind;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  startedAt: number;
}

interface TeamState {
  inflight: Record<string, Inflight>;
  ciFixes: Record<string, number>;
  /** agents the user stopped (off shift until resume/spawn) */
  stopped: string[];
  /** Inbox messages reserved by live RPCs, returned to unread after a crash. */
  steering?: Record<string, string[]>;
}

interface Running {
  abort: AbortController;
  job: Job;
  reason?: AbortReason;
  /** the agent's CLI process (the engine spawns it and reports it, so we know its pid) */
  child?: ChildProcess;
  /** settles when runJob is completely done with this turn */
  done?: Promise<void>;
  /** when we spawned the CLI (epoch ms) */
  spawnedAt?: number;
  /** snapshot of the CLI's process tree taken when the turn was aborted (undefined: unreadable) */
  tree?: Promise<ProcEntry[] | undefined>;
  /** the (single) clean-up of this turn's processes, once started */
  reaping?: Promise<void>;
  steer?: (prompt: string) => Promise<boolean>;
  steering?: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

const TURN_TIMEOUT_MS = 45 * 60_000;
const LEAD = 'marlow';

/**
 * Environment for an agent's CLI process (and every command it runs): git refuses all
 * transports (no push, ever) and never signs; git does not walk up out of the agent's cwd; the
 * agent's commits carry its own placeholder identity ("AgentCraft Kit <kit@agentcraft.local>"),
 * never the user's; and each Bash call starts in the agent's own cwd, so a `cd` in one command
 * cannot carry the next one out of the worktree.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
  return withGitSafety(
    { ...base, YAMS_ALLOW_NET: '0' },
    {
      CLAUDE_AGENT_SDK_CLIENT_APP: `agentcraft-foreman/${FOREMAN_VERSION}`,
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      ...(who.agentId ? (agentGitIdentity(who.agentId) as Record<string, string>) : {}),
    },
    who.cwd ? { ceiling: path.dirname(path.resolve(who.cwd)) } : {},
  );
}

/** Which engine runs which agent: the lead's, the workers', and per-agent exceptions. */
export interface TeamEngines {
  lead: Engine;
  worker: Engine;
  byAgent?: Record<string, Engine>;
}

export interface TeamOptions {
  /** the backend name reported to clients ("claude" or "codex": the workers' engine) */
  name: BackendName;
  engines: TeamEngines;
  /** skip the startup auth probe (tests) */
  skipAuthCheck?: boolean;
  /** injectable for tests: pull request intake (default: git + gh, see pulls.ts) */
  pullFetcher?: PullFetcher;
}

export interface PullFetcher {
  origin(repoPath: string): Promise<string | undefined>;
  fetch(repoPath: string, numbers: number[]): Promise<{ pulls: PullRequest[]; errors: string[] }>;
}

const defaultPullFetcher: PullFetcher = { origin: (p) => githubOrigin(p), fetch: (p, n) => fetchPulls(p, n) };

export class TeamBackend implements Backend {
  readonly name: BackendName;
  private queues = new Map<string, Job[]>();
  private running = new Map<string, Running>();
  private pausedJobs = new Map<string, Job>();
  private tickTimer: NodeJS.Timeout | undefined;
  private authFailed = false;
  private stopping = false;
  private waitingUser = new Set<string>();
  private hooks: ToolHooks;
  private lastCost = new Map<string, number>();
  private turnPromises = new Set<Promise<void>>();
  /** tasks whose CI + review hand-off is in progress */
  private reviewing = new Set<string>();
  /** the most recent turn per agent (kept after it ends, for quiesce) */
  private lastTurn = new Map<string, Running>();
  /** tasks changing hands: off the board until the old turn is over and its work committed */
  private handoffs = new Map<string, Promise<void>>();
  /** scheduler retry after an error (backoff) */
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = 2000;
  private readonly pullFetcher: PullFetcher;
  private readonly permissions: TeamPermissions;
  private readonly opts: TeamOptions;
  /** the model each agent's last turn really ran (shown on its nameplate) */
  private reportedModels = new Map<string, { engine: EngineId; label: string }>();

  constructor(
    protected fm: Foreman,
    protected cfg: TeamConfig,
    options: TeamOptions | AgentRuntime,
  ) {
    const runtime = 'run' in options ? new RuntimeEngine(fm, cfg, options) : undefined;
    const opts: TeamOptions = runtime ? { name: runtime.id, engines: { lead: runtime, worker: runtime } } : options as TeamOptions;
    this.opts = opts;
    this.name = opts.name;
    this.pullFetcher = opts.pullFetcher ?? defaultPullFetcher;
    this.permissions = new TeamPermissions(fm);
    this.hooks = {
      onReview: () => {
        /* handled after the worker's turn ends (CI then review) */
      },
      onChangesRequested: (taskId, feedback) => this.sendBackToWorker(taskId, `Marlow reviewed your work on ${taskId} and asks for changes:\n${feedback}\n\nMake the changes, re-run the tests, then update_task("${taskId}", status "review", summary).`),
      onTasksChanged: () => this.tick(),
      onMergeRequested: (taskId) => this.fm.log.info(`merge decision opened for ${taskId}`),
      onWaiting: (agentId, waiting) => {
        if (waiting) this.waitingUser.add(agentId);
        else this.waitingUser.delete(agentId);
      },
    };
  }

  private get st(): TeamState {
    const b = this.fm.store.data.backend;
    let s = b[this.name] as TeamState | undefined;
    // Before provider-specific state, upstream teams (including Codex-only teams) persisted
    // under `claude`. Move that state once; an existing PR Codex state takes precedence.
    if (!s && this.name === 'codex' && b.claude) {
      s = b.claude as TeamState;
      b.codex = s;
      delete b.claude;
      this.fm.store.markDirty();
    }
    if (!s) {
      s = { inflight: {}, ciFixes: {}, stopped: [] };
      b[this.name] = s;
    }
    s.inflight ??= {};
    s.ciFixes ??= {};
    s.stopped ??= [];
    return s;
  }

  get team(): string[] {
    return this.cfg.workers.filter((w) => this.fm.agent(w));
  }

  /** The engine that runs an agent's turns. */
  engineFor(agentId: string): Engine {
    const e = this.opts.engines;
    return e.byAgent?.[agentId] ?? (agentId === LEAD ? e.lead : e.worker);
  }

  /**
   * Every agent's nameplate shows its engine and model: the configured model until a turn reports
   * the real one (onModel). Off-shift agents too: it is what they would run when spawned.
   */
  private showEngines(): void {
    for (const a of this.fm.agents()) {
      const engine = this.engineFor(a.id);
      const reported = this.reportedModels.get(a.id);
      const model = (reported?.engine === engine.id ? reported.label : undefined) ?? modelLabel(engine.model(a.id === LEAD ? 'lead' : 'worker')) ?? engine.label;
      this.fm.setAgent(a.id, { engine: engine.id, model });
    }
  }

  /** Every engine on the team (each is checked at start). */
  private enginesInUse(): Engine[] {
    return [...new Set([LEAD, ...this.team].map((id) => this.engineFor(id)))];
  }

  /** e.g. "Claude (lead opus, workers sonnet)" or "Claude lead opus · Codex workers gpt-5" */
  private teamLabel(): string {
    const lead = this.engineFor(LEAD);
    const workers = [...new Set(this.team.map((w) => this.engineFor(w)))];
    // aliases as configured ("opus"), full model ids as display names ("claude-opus-5-5" -> "Opus 5.5")
    const m = (e: Engine, role: Role) => (/^[a-z]+$/.test(e.model(role)) ? e.model(role) : (modelLabel(e.model(role)) ?? e.model(role)));
    if (!workers.length || (workers.length === 1 && workers[0] === lead)) return `${lead.label} (lead ${m(lead, 'lead')}, workers ${m(lead, 'worker')})`;
    if (workers.length === 1) return `${lead.label} lead ${m(lead, 'lead')} · ${workers[0]!.label} workers ${m(workers[0]!, 'worker')}`;
    return `${lead.label} lead ${m(lead, 'lead')} · ${this.team.map((w) => `${this.fm.nameOf(w)} ${this.engineFor(w).label}`).join(', ')}`;
  }

  private isStopped(agentId: string): boolean {
    return this.st.stopped.includes(agentId);
  }

  private setStopped(agentId: string, stopped: boolean): void {
    const s = this.st;
    s.stopped = s.stopped.filter((x) => x !== agentId);
    if (stopped) s.stopped.push(agentId);
    this.fm.store.markDirty();
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async start(): Promise<void> {
    for (const [agentId, ids] of Object.entries(this.st.steering ?? {})) this.fm.bus.markUnread(agentId, ids);
    delete this.st.steering;
    for (const a of this.fm.agents()) {
      const onTeam = (a.id === LEAD || this.team.includes(a.id)) && !this.isStopped(a.id);
      this.fm.setAgent(a.id, { active: onTeam });
      if (!onTeam) this.fm.setAgent(a.id, { state: 'idle', station: 'lounge', activity: this.isStopped(a.id) ? 'stopped - off shift' : 'off shift' });
      else if (a.activity === 'off shift' || a.activity.startsWith('stopped')) this.fm.setAgent(a.id, { activity: 'ready' });
    }
    // the spend survives restarts: every session's cost is persisted, so the total is their sum
    const spent = Object.values(this.fm.store.data.sessions).reduce((sum, s) => sum + (s.costUsd || 0), 0);
    if (spent > 0) this.fm.setStatus({ costUsd: Math.round(spent * 1000) / 1000 });
    this.showEngines();
    await this.checkAuth();
    this.showEngines(); // the auth check may have learned the configured model
    if (!this.cfg.resumeOnStart) {
      this.st.inflight = {};
    } else {
      this.recover();
    }
    // the user's messages that no agent read before the restart
    for (const id of [LEAD, ...this.team]) this.deliverPending(id);
    void this.fm.repos.sweepPendingRemovals().catch((e) => this.fm.log.debug(`sweep: ${(e as Error).message}`));
    this.tick();
  }

  async checkAuth(): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: this.teamLabel() });
      return true;
    }
    const engines = this.enginesInUse();
    this.fm.setStatus({ auth: 'checking', message: `Checking ${engines.map((e) => e.label).join(' and ')} access...` });
    const accounts: string[] = [];
    for (const engine of engines) {
      const r = await engine.checkAuth().catch((e: Error): { ok: false; message: string } => ({ ok: false, message: `${engine.label} check failed: ${e.message}` }));
      if (!r.ok) {
        this.markAuthFailed(r.message);
        return false;
      }
      accounts.push(engines.length > 1 ? `${engine.label}: ${r.account}` : r.account);
      this.fm.log.info(`${engine.id} auth ok (${r.account})`);
    }
    this.authFailed = false;
    this.fm.setStatus({ auth: 'ok', account: accounts.join(' · '), message: this.teamLabel() });
    return true;
  }

  private markAuthFailed(message: string): void {
    this.authFailed = true;
    this.fm.setStatus({ auth: 'failed', message });
    this.fm.log.error(message);
    this.fm.bus.feed('error', message);
    this.fm.notify('warn', message);
    if (process.stdout.isTTY) process.stdout.write('\x07');
  }

  private openQuestion(agentId: string): Decision | undefined {
    return this.fm.decisions.open().find((d) => d.kind === 'question' && d.agentId === agentId);
  }

  /** A job matching `pred` is queued, running or paused (waiting for /resume) for this agent. */
  private hasQueued(agentId: string, pred: (j: Job) => boolean): boolean {
    const running = this.running.get(agentId);
    const paused = this.pausedJobs.get(agentId);
    return (this.queues.get(agentId) ?? []).some(pred) || (running ? pred(running.job) : false) || (paused ? pred(paused) : false);
  }

  /**
   * After a restart: re-attach or re-queue everything that was in flight, then reconcile every
   * non-terminal state with what is actually running, so nothing waits forever.
   */
  private recover(): void {
    const st = this.st;
    // permission prompts from a dead process are moot; the resumed agent retries the tool
    for (const d of this.fm.decisions.open().filter((x) => x.kind === 'permission')) this.fm.decisions.cancel(d.id, 'Foreman restarted');
    for (const [agentId, inf] of Object.entries(st.inflight)) {
      const task = inf.taskId ? this.fm.tasks.get(inf.taskId) : undefined;
      if (this.isStopped(agentId) || !this.fm.agent(agentId) || (inf.taskId && (!task || task.status === 'cancelled'))) {
        delete st.inflight[agentId];
        continue;
      }
      const openQ = this.openQuestion(agentId);
      if (openQ) {
        this.fm.log.info(`recover: ${agentId} is waiting on ${openQ.id}; will resume after the answer`);
        this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
        continue;
      }
      const session = this.fm.store.data.sessions[inf.sessionKey];
      if (session?.sessionId) {
        this.fm.log.info(`recover: resuming ${agentId} (${inf.kind}${inf.taskId ? ` ${inf.taskId}` : ''})`);
        this.enqueue({ kind: inf.kind, agentId, sessionKey: inf.sessionKey, prompt: RESUME_PROMPT, resumed: true, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
      } else {
        // the turn died before it had a session: the reconciliation below starts it again
        delete st.inflight[agentId];
      }
    }
    this.reconcile();
    this.fm.store.markDirty();
  }

  /** Bring planning goals, doing tasks and review tasks back in line with running/queued jobs. */
  private reconcile(): void {
    const st = this.st;
    // goals still planning with nobody planning them
    for (const g of this.fm.goals().filter((x) => x.status === 'planning')) {
      const leadOnIt = st.inflight[LEAD]?.goalId === g.id || this.hasQueued(LEAD, (j) => j.goalId === g.id) || this.openQuestion(LEAD) !== undefined;
      if (leadOnIt || this.isStopped(LEAD)) continue;
      if (this.fm.tasks.forGoal(g.id).length) this.promoteGoal(g, 'recovered');
      else {
        const repo = g.repoId ? this.fm.repos.get(g.repoId) : undefined;
        if (!repo) continue;
        this.fm.log.info(`recover: re-planning ${g.id}`);
        this.enqueue({ kind: 'plan', agentId: LEAD, goalId: g.id, sessionKey: `${LEAD}:${g.id}`, fresh: !this.fm.store.data.sessions[`${LEAD}:${g.id}`]?.sessionId, prompt: planPrompt(this.fm, g, repo.path, repo.branch) });
      }
    }
    // doing tasks whose worker is not working on them: back on the board (the session resumes)
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'doing' || !t.assignee || t.assignee === LEAD) continue;
      const w = t.assignee;
      if (st.inflight[w]?.taskId === t.id || this.hasQueued(w, (j) => j.taskId === t.id)) continue;
      if (this.openQuestion(w)?.taskId === t.id) continue; // resumes with the answer
      this.fm.log.info(`recover: ${t.id} was doing without a running turn; re-queued`);
      this.fm.tasks.setStatus(t.id, 'todo', { force: true });
      if (this.isStopped(w)) this.fm.tasks.update(t.id, { assignee: null });
    }
    this.sweepReviews();
  }

  /** Tasks in review with no merge decision and no review job: CI + review (again). */
  private sweepReviews(): void {
    const st = this.st;
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'review' || !t.worktree) continue;
      if (this.fm.decisions.open().some((d) => d.taskId === t.id)) continue;
      if (Object.values(st.inflight).some((i) => i.taskId === t.id)) continue;
      if (this.reviewing.has(t.id) || this.hasQueued(LEAD, (j) => j.taskId === t.id) || (t.assignee && this.hasQueued(t.assignee, (j) => j.taskId === t.id))) continue;
      void this.afterWorkerDone(t.id);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const turns = [...this.running.values()];
    for (const r of turns) this.abortTurn(r, 'shutdown');
    await Promise.race([Promise.allSettled([...this.turnPromises]), sleep(4000)]);
    // nothing an agent started outlives the Foreman (sessions resume on the next start)
    await Promise.race([Promise.allSettled(turns.map((r) => this.reap(r, 1500))), sleep(3000)]);
    // inflight entries stay persisted so the next start resumes them
    this.fm.store.markDirty();
  }

  // ---- turn teardown ------------------------------------------------------------------------

  /** Abort a turn: remember why, snapshot its process tree while the CLI is still alive, close it. */
  private abortTurn(r: Running, reason: AbortReason): void {
    r.reason = reason;
    const pid = r.child?.pid;
    if (pid && alive(r.child) && !r.tree) r.tree = processTable().then((t) => (t ? descendantsOf(t, pid) : undefined)).catch(() => undefined);
    r.abort.abort();
  }

  /**
   * Make sure an aborted turn's CLI process and everything it started are gone. The SDK's close()
   * gives the CLI ~2 s to exit; after that its tree is killed. Processes that outlived the CLI
   * (orphans on Windows) come from the snapshot taken at abort time plus, read after the CLI
   * exited, every newer process whose parent chain leads to the CLI's pid (unless that pid was
   * reused). Only processes that are still the same ones (pid + creation time) are killed.
   */
  private reap(r: Running, graceMs = 4000): Promise<void> {
    r.reaping ??= this.doReap(r, graceMs).catch((e) => this.fm.log.warn(`clean-up of ${r.job.agentId}'s turn: ${(e as Error).message}`));
    return r.reaping;
  }

  private async doReap(r: Running, graceMs: number): Promise<void> {
    const child = r.child;
    if (!child?.pid) return;
    if (alive(child)) {
      await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(graceMs)]);
      if (alive(child)) {
        killTree(child);
        await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(2000)]);
      }
    }
    const snapshot = r.tree ? await r.tree : undefined;
    const table = await processTable();
    if (!table) {
      this.fm.log.warn(`could not read the process table to check for processes left by ${r.job.agentId}'s stopped turn`);
      return;
    }
    const targets = new Map<number, ProcEntry>();
    for (const e of [...(snapshot ?? []), ...orphansOf(table, child.pid, r.spawnedAt ?? 0)]) targets.set(e.pid, e);
    const killed = (await killSnapshot([...targets.values()], table)) ?? [];
    if (killed.length) this.fm.log.info(`killed ${killed.length} leftover process(es) of ${r.job.agentId}'s stopped turn (pids ${killed.join(', ')})`);
  }

  /** Wait until an agent's current/last turn is completely over (CLI exited, its processes gone). */
  private async quiesce(agentId: string, maxMs = 15_000): Promise<void> {
    const r = this.running.get(agentId) ?? this.lastTurn.get(agentId);
    if (!r) return;
    if (r.done) await Promise.race([r.done.catch(() => undefined), sleep(maxMs)]);
    await this.reap(r);
  }

  /**
   * A task leaves `fromAgent` (stop, reassign): hold it off the board until that agent's turn is
   * really over, then commit its work on its branch (the next worker starts from that branch).
   */
  private handOff(taskId: string, fromAgent: string, why: string): void {
    if (this.handoffs.has(taskId)) return;
    const p = (async () => {
      try {
        await this.quiesce(fromAgent);
        const t = this.fm.tasks.get(taskId);
        const wt = t?.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
        if (t && wt && wt.agentId === fromAgent && wt.status === 'active') {
          await this.fm.repos.abandon(t.repoId!, wt.id, `agentcraft: ${t.id} work in progress (${why})`);
        }
      } catch (e) {
        this.fm.log.warn(`hand-off of ${taskId} from ${fromAgent}: ${(e as Error).message}`);
      } finally {
        this.handoffs.delete(taskId);
        this.tick();
      }
    })();
    this.handoffs.set(taskId, p);
  }

  /** Scheduler failed (git error, busy directory...): try again later instead of stalling. */
  private retryLater(): void {
    if (this.retryTimer || this.stopping) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(60_000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.tick();
    }, delay);
    this.retryTimer.unref?.();
  }

  // ---- goals & scheduling -------------------------------------------------------------------

  async submitGoal(goal: Goal): Promise<void> {
    if (this.authFailed) {
      this.fm.setGoal(goal.id, { status: 'failed' });
      throw new ClientError(`Agent team is not available: ${this.fm.status.message ?? 'auth failed'}`);
    }
    const repo = this.fm.repos.require(goal.repoId!);
    if (this.isStopped(LEAD)) {
      this.setStopped(LEAD, false);
      this.fm.bus.feed('system', 'Marlow is back on shift for the new goal', { agentId: LEAD });
    }
    for (const w of [LEAD, ...this.team]) if (!this.isStopped(w)) this.fm.setAgent(w, { active: true });
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal', repoId: repo.id });
    const pulls = await this.intakePulls(goal, repo.path);
    this.enqueue({ kind: 'plan', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, fresh: true, prompt: planPrompt(this.fm, goal, repo.path, repo.branch, pulls) });
  }

  /**
   * A goal that mentions pull requests ("#12") on a GitHub repository: fetch them before the lead
   * plans (see pulls.ts), announce them in the feed and keep a brief in shared memory.
   */
  private async intakePulls(goal: Goal, repoPath: string): Promise<PullRequest[]> {
    const refs = prRefs(goal.text);
    if (!refs.length || !(await this.pullFetcher.origin(repoPath))) return [];
    this.fm.setAgent(LEAD, { state: 'reading', station: 'library', activity: `fetching ${refs.length} pull request${refs.length === 1 ? '' : 's'}` });
    this.fm.bus.feed('system', `Fetching ${refs.length} pull request${refs.length === 1 ? '' : 's'} from GitHub`, { agentId: LEAD });
    const { pulls, errors } = await this.pullFetcher.fetch(repoPath, refs);
    for (const p of pulls) this.fm.bus.feed('task', `PR #${p.number} by @${p.author}: ${p.title}`, { agentId: LEAD });
    for (const e of errors) this.fm.bus.feed('error', `PR ${e}`, { agentId: LEAD });
    if (pulls.length) {
      this.fm.memory.write({ scope: 'shared', title: `Pull requests for ${goal.id}`, body: pullBriefs(pulls), author: LEAD, mode: 'replace' });
    }
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal' });
    return pulls;
  }

  private promoteGoal(goal: Goal, why: string): void {
    if (goal.status !== 'planning') return;
    const n = this.fm.tasks.forGoal(goal.id).length;
    this.fm.setGoal(goal.id, { status: 'active' });
    this.fm.bus.feed('plan', `Marlow planned the goal into ${n} task${n === 1 ? '' : 's'}${why === 'recovered' ? ' (picked up after a restart)' : ''}`, { agentId: LEAD });
    this.tick();
  }

  tick(): void {
    if (this.tickTimer || this.stopping) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.schedule().catch((e) => {
        this.fm.log.error(`scheduler: ${(e as Error).stack ?? e}`);
        this.retryLater();
      });
    }, 50);
    this.tickTimer.unref?.();
  }

  private workersRunning(): number {
    return [...this.running.keys()].filter((id) => id !== LEAD).length;
  }

  private isFree(w: string): boolean {
    const a = this.fm.agent(w);
    if (!a || !a.active || a.paused || this.isStopped(w) || !this.team.includes(w)) return false;
    if (this.running.has(w) || (this.queues.get(w)?.length ?? 0) > 0) return false;
    return !this.fm.tasks.list().some((t) => t.assignee === w && t.status === 'doing');
  }

  private async schedule(): Promise<void> {
    if (this.authFailed || this.stopping) return;
    for (const goal of this.fm.goals().filter((g) => g.status === 'active')) {
      for (const t of this.fm.tasks.ready(goal.id)) {
        if (this.workersRunning() >= this.cfg.maxConcurrent) return;
        if (this.handoffs.has(t.id)) continue; // the previous worker's turn is still winding down
        let w: string | undefined;
        if (t.assignee && this.team.includes(t.assignee) && !this.isStopped(t.assignee)) {
          if (!this.isFree(t.assignee)) continue; // wait for the intended worker
          w = t.assignee;
        } else {
          w = this.team.find((x) => this.isFree(x));
        }
        if (!w) continue;
        try {
          await this.startWork(w, t, goal);
          this.retryDelayMs = 2000;
        } catch (e) {
          // the task stays on the board (assigned to w); try again shortly
          this.fm.log.error(`could not start ${t.id} for ${w}: ${(e as Error).message}`);
          this.retryLater();
        }
      }
    }
    // pump queues that were held back by the concurrency cap
    for (const id of this.queues.keys()) this.pump(id);
  }

  private async startWork(agentId: string, t: Task, goal: Goal): Promise<void> {
    if (!t.repoId) t.repoId = goal.repoId;
    this.fm.tasks.update(t.id, { assignee: agentId });
    // a task another worker started (stopped / reassigned): continue from that worker's branch,
    // whether or not its worktree was already wound down (abandoned)
    let startPoint: string | undefined;
    let continuesFrom: string | undefined;
    const prev = t.worktree ? this.fm.repos.findWorktree(t.repoId!, t.worktree) : undefined;
    if (prev && prev.agentId !== agentId && prev.status !== 'merged') {
      if (prev.status === 'active') {
        // nobody prepared the hand-off (e.g. reconciled after a restart): finish it here
        if (this.lastTurn.get(prev.agentId)?.job.taskId === t.id) await this.quiesce(prev.agentId);
        await this.fm.repos.abandon(t.repoId!, prev.id, `agentcraft: ${t.id} work in progress (handed to ${this.fm.nameOf(agentId)})`).catch((e) => this.fm.log.warn(`abandon ${prev.id}: ${(e as Error).message}`));
      }
      if ((await this.fm.repos.commitsAhead(t.repoId!, prev.branch, prev.base)) > 0) {
        startPoint = prev.branch;
        continuesFrom = prev.agentId;
        this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} continues ${t.id} from ${this.fm.nameOf(prev.agentId)}'s branch`, { agentId });
      }
    }
    // a pull request task starts from the contributor's commits (fetched at goal intake)
    if (!startPoint && t.startBranch) startPoint = t.startBranch;
    const wt = await this.fm.repos.createWorktree(t.repoId!, agentId, t, startPoint ? { startPoint } : {});
    this.fm.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    this.fm.tasks.setStatus(t.id, 'doing');
    this.fm.setAgent(agentId, { taskId: t.id, repoId: t.repoId!, worktree: wt.id, state: 'thinking', station: 'desk', activity: `starting ${t.id}` });
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} started ${t.id}: ${t.title}`, { agentId });
    const inbox = formatInbox(this.fm.bus.inbox(agentId, { markRead: true }), (id) => this.fm.nameOf(id));
    this.enqueue({ kind: 'work', agentId, taskId: t.id, goalId: goal.id, sessionKey: `${agentId}:${t.id}`, fresh: !this.fm.store.data.sessions[`${agentId}:${t.id}`]?.sessionId, prompt: workPrompt(this.fm, t, goal, wt, inbox, continuesFrom) });
  }

  // ---- job queue ----------------------------------------------------------------------------

  private enqueue(job: Job): void {
    const q = this.queues.get(job.agentId) ?? [];
    q.push(job);
    this.queues.set(job.agentId, q);
    this.pump(job.agentId);
  }

  private pump(agentId: string): void {
    if (this.stopping || this.authFailed) return;
    if (this.running.has(agentId)) return;
    const a = this.fm.agent(agentId);
    if (!a || a.paused || !a.active || this.isStopped(agentId)) return;
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (agentId !== LEAD && this.workersRunning() >= this.cfg.maxConcurrent) return;
    const job = q.shift()!;
    const p = this.runJob(job).finally(() => {
      this.turnPromises.delete(p);
    });
    this.turnPromises.add(p);
    // runJob registers its Running entry synchronously, before its first await
    const entry = this.running.get(agentId);
    if (entry) {
      entry.done = p;
      this.lastTurn.set(agentId, entry);
    }
  }

  private cwdFor(job: Job): { cwd: string; role: 'lead' | 'worker'; repoId: string } {
    if (job.agentId === LEAD) {
      const goal = job.goalId ? this.fm.goal(job.goalId) : this.fm.currentGoal();
      const repo = goal?.repoId ? this.fm.repos.get(goal.repoId) : this.fm.repos.defaultRepo();
      if (!repo) throw new Error('no repo for the lead');
      return { cwd: repo.path, role: 'lead', repoId: repo.id };
    }
    const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
    if (!t?.worktree || !t.repoId) throw new Error(`job for ${job.agentId} has no worktree`);
    return { cwd: this.fm.repos.requireWorktree(t.repoId, t.worktree).path, role: 'worker', repoId: t.repoId };
  }

  /** Both native engines and provider runtimes share repository-scoped team permissions. */
  private permissionGate(agentId: string, role: Role, cwd: string, repoId: string, turn: TurnHandle): PermissionGate {
    const gate = this.permissions.canUseTool(agentId, role, cwd, repoId, turn, this.cfg.leadReadCommands);
    return async (name, input, signal, title) => {
      const result = await gate(name, input, { signal, ...(title ? { title } : {}) });
      return result.behavior === 'allow' ? { allow: true } : { allow: false, message: result.message, ...(result.interrupt ? { interrupt: true } : {}) };
    };
  }

  /**
   * Where a sandboxed worker (Codex) may write besides its worktree: exactly what committing and
   * merging on its own branch needs, and the temp dir (scratch files and test runs; the policy
   * allows it too). Never the shared git dir as a whole: its config and hooks would let a worker
   * run code in the user's own git, outside every sandbox, and its refs would let it move the
   * user's branches. Verified against the real Codex Windows sandbox: commit and `git merge`
   * work; writing .git/config, .git/hooks or refs/heads/main is denied.
   *  - objects/                        new commits, trees, blobs (content-addressed, harmless)
   *  - refs/heads/<branch dir>/        this agent's branches only (agentcraft/<agent>/...)
   *  - logs/refs/heads/<branch dir>/   their reflogs
   *  - the worktree's own git dir      its HEAD, index, ORIG_HEAD, MERGE_HEAD (Codex protects the
   *                                    .git pointer's target unless it is granted exactly)
   */
  private async writableRoots(role: Role, job: Job): Promise<string[]> {
    if (role !== 'worker' || !job.taskId) return [];
    const t = this.fm.tasks.require(job.taskId);
    const repo = this.fm.repos.require(t.repoId!);
    const worktree = this.fm.repos.requireWorktree(repo.id, t.worktree!);
    const verified = await this.fm.repos.verifyWorktreeGit(repo, worktree);
    if (!verified.ok) throw new Error(`Cannot grant worktree Git access: ${verified.reason}`);
    const roots = [path.join(verified.commonDir, 'objects'), verified.gitDir, os.tmpdir()];
    const branchDir = path.posix.dirname(worktree.branch);
    if (branchDir !== '.' && !branchDir.split('/').includes('..')) {
      for (const d of [path.join(verified.commonDir, 'refs', 'heads', ...branchDir.split('/')), path.join(verified.commonDir, 'logs', 'refs', 'heads', ...branchDir.split('/'))]) {
        fs.mkdirSync(d, { recursive: true });
        roots.push(d);
      }
    }
    return [...new Set(roots)];
  }

  private async runJob(job: Job): Promise<void> {
    const agentId = job.agentId;
    const abort = new AbortController();
    const entry: Running = { abort, job };
    const turn: TurnHandle = { signal: abort.signal, reason: () => entry.reason };
    // (pump records this turn as lastTurn right after this synchronous part: this is the previous one)
    const previous = this.lastTurn.get(agentId);
    this.running.set(agentId, entry);
    let stats: TurnStats | undefined;
    let cwd = '';
    try {
      // a paused/stopped turn of this agent may still be winding down: never run two CLIs on one
      // agent (they could share a session)
      if (previous?.reaping) await Promise.race([previous.reaping, sleep(10_000)]);
      const where = this.cwdFor(job);
      cwd = where.cwd;
      const role = where.role;
      const engine = this.engineFor(agentId);
      const session = this.fm.store.data.sessions[job.sessionKey];
      // a session belongs to the engine that made it (records from before engines were Claude's)
      const resume = !job.fresh && session?.sessionId && (session.engine ?? session.provider ?? 'claude') === engine.id ? session.sessionId : undefined;
      this.st.inflight[agentId] = { kind: job.kind, sessionKey: job.sessionKey, startedAt: Date.now(), ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.goalId ? { goalId: job.goalId } : {}) };
      this.fm.store.markDirty();

      let systemAppend: string;
      if (role === 'lead') systemAppend = leadSystemPrompt(this.fm, this.team);
      else {
        const t = this.fm.tasks.require(job.taskId!);
        systemAppend = workerSystemPrompt(this.fm, agentId, this.fm.repos.requireWorktree(t.repoId!, t.worktree!));
      }
      const model = engine.model(role);
      this.fm.agentLog(agentId, 'text', `${resume ? 'Resuming' : 'Starting'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (${engine.id === 'claude' ? model : `${engine.label} ${model}`})`);
      if (job.kind === 'followup' || job.resumed) this.fm.agentLog(agentId, 'text', truncate(job.prompt, 400));
      const timer = setTimeout(() => this.abortTurn(entry, 'timeout'), TURN_TIMEOUT_MS);
      timer.unref?.();
      // messages that arrived while the agent was not in a turn ride along with this prompt
      const unread = this.fm.bus.inbox(agentId, { markRead: true });
      const prompt = unread.length ? `${job.prompt}\n\n[New messages]\n${formatInbox(unread, (id) => this.fm.nameOf(id))}` : job.prompt;
      try {
        stats = await engine.runTurn({
          agentId,
          role,
          cwd,
          prompt,
          instructions: systemAppend,
          ...(resume ? { resume } : {}),
          env: agentEnv(process.env, { agentId, cwd }),
          writableRoots: await this.writableRoots(role, job),
          abort,
          turn,
          permission: this.permissionGate(agentId, role, cwd, where.repoId, turn),
          tools: agentTools(this.fm, agentId, role, this.hooks, turn),
          // a stopped turn's whole process tree is ended before its worktree is handed on
          onProcess: (child) => {
            entry.child = child;
            entry.spawnedAt = Date.now();
          },
          onSession: (id) => {
            if (this.fm.store.data.sessions[job.sessionKey]?.sessionId !== id) this.recordSession(job.sessionKey, id, model, engine.id);
          },
          onSteerReady: steer => {
            entry.steer = steer;
            this.steerPending(agentId, entry);
          },
          onModel: (m) => {
            const label = modelLabel(m);
            if (!label) return;
            this.reportedModels.set(agentId, { engine: engine.id, label });
            this.fm.setAgent(agentId, { engine: engine.id, model: label });
          },
        });
      } finally {
        clearTimeout(timer);
      }
      if (stats.sessionId) this.recordSession(job.sessionKey, stats.sessionId, model, engine.id, stats);
      if (stats.authFailed) this.markAuthFailed(engine.authFailedMessage(stats.authFailed));
    } catch (e) {
      const aborted = abort.signal.aborted;
      if (!aborted) {
        const msg = (e as Error).message ?? String(e);
        this.fm.log.error(`${agentId} ${job.kind} failed: ${msg}`);
        this.fm.agentLog(agentId, 'error', `session error: ${truncate(msg, 400)}`);
        if (e instanceof AuthenticationError) this.markAuthFailed(this.engineFor(agentId).authFailedMessage(truncate(msg, 160)));
        stats = { isError: true, errors: [msg] };
      }
    } finally {
      // A failed live delivery must be back in the inbox before follow-up scheduling.
      while (entry.steering) await entry.steering;
      this.running.delete(agentId);
    }

    const reason = entry.reason;
    if (reason === 'shutdown') return; // inflight stays persisted -> resumed next start (stop() reaps)
    // an aborted turn's CLI and its processes must not linger (they would keep working); started
    // before anything is re-queued, so the next turn of this agent waits for it
    if (reason) void this.reap(entry);
    delete this.st.inflight[agentId];
    this.fm.store.markDirty();
    if (reason === 'pause') {
      const next: Job = { ...job, fresh: false, resumed: true, prompt: `${userName()} paused you and has now resumed you. Any question you had open was withdrawn; ask again if you still need it. Continue your current job.` };
      // resume may already have arrived while the aborted turn was unwinding
      if (this.fm.agent(agentId)?.paused) {
        this.pausedJobs.set(agentId, next);
        this.fm.setAgent(agentId, { state: 'idle', activity: 'paused' });
      } else this.enqueue(next);
    } else if (reason === 'stop') {
      if (this.isStopped(agentId)) this.fm.setAgent(agentId, { state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
    } else if (reason === 'cancel') {
      const a = this.fm.agent(agentId);
      if (a?.taskId === job.taskId) this.fm.setAgent(agentId, { state: 'idle', station: 'lounge', activity: 'task cancelled', taskId: null, worktree: null });
    } else if (reason === 'timeout') {
      this.fm.agentLog(agentId, 'error', `turn timed out after ${TURN_TIMEOUT_MS / 60_000} min`);
      await this.afterTurn(job, { isError: true, subtype: 'timeout', errors: ['turn timed out'] }).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    } else {
      await this.afterTurn(job, stats).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    }
    this.pump(agentId);
    // the user's messages that came after the agent's last tool call: answer them now
    if (reason !== 'stop' && reason !== 'pause') this.deliverPending(agentId);
    this.tick();
  }

  /**
   * Messages from the user to this agent that nobody has read yet (they arrived after its last
   * agentcraft tool call, or while it was off shift): start a follow-up turn for them.
   */
  private deliverPending(agentId: string): void {
    if (this.stopping || this.isStopped(agentId) || this.running.has(agentId) || this.pausedJobs.has(agentId) || (this.queues.get(agentId)?.length ?? 0) > 0) return;
    const a = this.fm.agent(agentId);
    if (!a?.active || a.paused) return;
    const fromUser = this.fm.bus.inbox(agentId).filter((m) => m.from === 'user' && m.to === agentId);
    if (!fromUser.length) return;
    this.fm.log.info(`delivering ${fromUser.length} message(s) from ${userName()} to ${agentId} that arrived after its last turn`);
    this.onUserMessage(agentId, fromUser[fromUser.length - 1]!.text);
  }

  private recordSession(key: string, sessionId: string, model: string, engine: EngineId, stats?: TurnStats): void {
    const s = (this.fm.store.data.sessions[key] ??= { turns: 0, costUsd: 0, updatedAt: Date.now() });
    s.sessionId = sessionId;
    s.model = model;
    s.engine = engine;
    s.provider = engine;
    s.updatedAt = Date.now();
    if (stats) {
      s.turns += stats.numTurns ?? 0;
      if (typeof stats.costUsd === 'number') {
        // total_cost_usd is cumulative per session (resumes continue from the saved total)
        const prev = this.lastCost.get(sessionId) ?? s.costUsd;
        const delta = Math.max(0, stats.costUsd - prev);
        this.lastCost.set(sessionId, stats.costUsd);
        s.costUsd = Math.max(s.costUsd, stats.costUsd);
        this.fm.setStatus({ costUsd: Math.round(((this.fm.status.costUsd ?? 0) + delta) * 1000) / 1000 });
      }
      s.lastResult = stats.subtype;
    }
    this.fm.store.markDirty();
  }

  // ---- after a turn -------------------------------------------------------------------------

  private failure(stats: TurnStats | undefined): string {
    return truncate(stats?.errors[0] || stats?.subtype?.replace(/^error_/, '').replace(/_/g, ' ') || 'error', 36);
  }

  private async afterTurn(job: Job, stats: TurnStats | undefined): Promise<void> {
    const failed = !stats || stats.isError;
    if (job.agentId === LEAD) {
      this.fm.setAgent(LEAD, failed ? { state: 'error', station: 'meeting', activity: `turn failed: ${this.failure(stats)}` } : { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
      // any lead turn for a goal that is still planning (plan, or a plan resumed after a
      // restart / an answer) settles the goal: tasks -> active
      const goal = job.goalId ? this.fm.goal(job.goalId) : undefined;
      if (goal && goal.status === 'planning') {
        const n = this.fm.tasks.forGoal(goal.id).length;
        if (n > 0) this.promoteGoal(goal, 'planned');
        else if (failed) {
          this.fm.setGoal(goal.id, { status: 'failed' });
          this.fm.bus.feed('error', `Marlow's planning turn ended without tasks${stats?.errors.length ? `: ${stats.errors.join('; ')}` : ''}`, { agentId: LEAD });
        } else if (job.kind === 'plan') {
          // nothing to do (e.g. the user said "ignore it"): close the goal instead of leaving it
          // "active" at 0% forever; a task the lead adds to it later makes it active again
          this.fm.setGoal(goal.id, { status: 'cancelled', progress: 0 });
          this.fm.bus.feed('goal', `Marlow planned no tasks: goal closed (${truncate(goal.text, 80)})`, { agentId: LEAD });
        }
      }
      if (job.kind === 'review' && job.taskId) {
        const t = this.fm.tasks.get(job.taskId);
        const hasDecision = this.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === job.taskId);
        if (t && t.status === 'review' && !hasDecision) {
          // lead gave no verdict: still surface the merge to the user (never auto-merge)
          this.openMergeDecision(t, `Marlow's review: ${truncate(stats?.resultText ?? '(no verdict)', 300)}`);
        }
      }
      return;
    }
    // worker
    const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
    if (!t) {
      this.fm.setAgent(job.agentId, failed ? { state: 'error', station: 'desk', activity: `turn failed: ${this.failure(stats)}` } : { state: 'idle', station: 'lounge', activity: 'idle' });
      return;
    }
    if (t.status === 'review') {
      await this.afterWorkerDone(t.id);
      return;
    }
    if (t.status === 'doing') {
      const nudges = job.nudges ?? 0;
      if (!failed && nudges < 1) {
        this.enqueue({ ...job, kind: 'followup', fresh: false, nudges: nudges + 1, prompt: `You ended your turn but ${t.id} is still "doing". If the work is complete, call update_task("${t.id}", status "review", summary). If you are stuck, call update_task with status "blocked" and blocked_reason. Otherwise continue.` });
        return;
      }
      const wt = t.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
      if (wt) await this.fm.repos.refresh(t.repoId!);
      if (!failed && wt && wt.files > 0) {
        this.fm.tasks.setStatus(t.id, 'review', { summary: truncate(stats?.resultText ?? 'work complete', 400) });
        await this.afterWorkerDone(t.id);
      } else {
        const failure = [stats?.subtype ?? 'error', ...(stats?.errors ?? [])].join(': ');
        this.fm.tasks.setStatus(t.id, 'blocked', { reason: failed ? `session ended: ${truncate(failure, 1200)}` : 'worker stopped without changes', force: true });
        // a failed turn is an error (red); a worker that gave up is blocked
        this.fm.setAgent(job.agentId, failed ? { state: 'error', station: 'desk', activity: `${t.id}: ${this.failure(stats)}` } : { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
        this.fm.bus.send(job.agentId, LEAD, `${t.id} is blocked: ${this.fm.tasks.get(t.id)?.blockedReason}`);
        this.fm.notify('warn', `${this.fm.nameOf(job.agentId)}: ${t.id} ${failed ? 'failed' : 'is blocked'} (${this.fm.tasks.get(t.id)?.blockedReason ?? ''}) - /task ${t.id} retry when ready`);
      }
      return;
    }
    if (t.status === 'blocked') {
      this.fm.setAgent(job.agentId, { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
      this.fm.notify('warn', `${this.fm.nameOf(job.agentId)} is blocked on ${t.id}: ${t.blockedReason ?? ''}`);
      return;
    }
    this.fm.setAgent(job.agentId, { state: 'idle', station: 'lounge', activity: 'idle' });
  }

  /** A worker finished a task: CI in the worktree, then lead review (or a merge decision). */
  private async afterWorkerDone(taskId: string): Promise<void> {
    if (this.reviewing.has(taskId)) return; // CI already running for it
    this.reviewing.add(taskId);
    try {
      await this.ciThenReview(taskId);
    } finally {
      this.reviewing.delete(taskId);
    }
  }

  private async ciThenReview(taskId: string): Promise<void> {
    const t = this.fm.tasks.get(taskId);
    if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return;
    const worker = t.assignee;
    if (worker) this.fm.setAgent(worker, { state: 'idle', station: 'lounge', activity: `${t.id} in review` });
    let ci: TestResult | undefined;
    try {
      this.fm.tasks.update(t.id, { ci: 'running' });
      this.fm.repos.setCi(t.repoId, 'running');
      if (worker) this.fm.agentLog(worker, 'tool', `CI: ${this.cfg.ciCommand ?? this.fm.repos.detectTestCommand(this.fm.repos.requireWorktree(t.repoId, t.worktree).path) ?? '(no tests)'}`);
      ci = await this.fm.repos.runTests(t.repoId, t.worktree, this.cfg.ciCommand);
      this.fm.tasks.update(t.id, { ci: ci.pass ? 'pass' : 'fail' });
      this.fm.repos.setCi(t.repoId, ci.pass ? 'pass' : 'fail');
      if (worker) this.fm.agentLog(worker, ci.pass ? 'result' : 'error', `CI ${ci.pass ? 'passed' : 'FAILED'} (${(ci.durationMs / 1000).toFixed(1)}s)\n${ci.output.split('\n').slice(-6).join('\n')}`);
      this.fm.bus.feed('ci', `${t.id}: tests ${ci.pass ? 'pass' : 'fail'} (${ci.command})`, { ...(worker ? { agentId: worker } : {}) });
    } catch (e) {
      this.fm.log.warn(`CI for ${t.id}: ${(e as Error).message}`);
    }
    await this.fm.repos.refresh(t.repoId);
    if (ci && !ci.pass && (this.st.ciFixes[t.id] ?? 0) < 1 && worker && !this.isStopped(worker)) {
      this.st.ciFixes[t.id] = (this.st.ciFixes[t.id] ?? 0) + 1;
      this.sendBackToWorker(t.id, `CI failed for ${t.id} (${ci.command}):\n${ci.output}\n\nFix the failures, re-run the tests, then update_task("${t.id}", status "review", summary).`);
      return;
    }
    if (this.cfg.leadReview && !this.isStopped(LEAD)) {
      const diff = await this.fm.repos.diff(t.repoId, t.worktree);
      this.fm.setAgent(LEAD, { state: 'reading', station: 'mergestation', activity: `reviewing ${t.id}` });
      this.enqueue({ kind: 'review', agentId: LEAD, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${LEAD}:${t.goalId ?? 'adhoc'}`, prompt: reviewPrompt(this.fm, this.fm.tasks.require(t.id), renderDiffText(diff.files), diff.stats, ci) });
    } else {
      this.openMergeDecision(t, t.summary ?? 'Work complete.');
    }
  }

  private openMergeDecision(t: Task, summary: string): void {
    const wt = this.fm.repos.requireWorktree(t.repoId!, t.worktree!);
    this.fm.createDecision({
      agentId: LEAD,
      kind: 'merge',
      question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
      options: [...MERGE_OPTIONS],
      context: `${summary}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
      taskId: t.id,
      repoId: t.repoId!,
      worktree: wt.id,
    });
    if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'idle', station: 'mergestation', activity: `awaiting your review of ${t.id}` });
  }

  /** Resume the worker's task session with feedback (lead/user changes, CI failure). */
  private sendBackToWorker(taskId: string, prompt: string): void {
    const t = this.fm.tasks.get(taskId);
    if (!t?.assignee) return;
    if (this.isStopped(t.assignee)) {
      // nobody to send it back to: put it on the board for the next free worker
      this.fm.tasks.setStatus(t.id, 'todo', { force: true, summary: truncate(prompt, 400) });
      this.fm.tasks.update(t.id, { assignee: null });
      this.tick();
      return;
    }
    if (t.status !== 'doing') this.fm.tasks.setStatus(t.id, 'doing', { force: true });
    this.fm.setAgent(t.assignee, { taskId: t.id, state: 'thinking', station: 'desk', activity: `revising ${t.id}`, ...(t.repoId ? { repoId: t.repoId } : {}), ...(t.worktree ? { worktree: t.worktree } : {}) });
    this.enqueue({ kind: 'followup', agentId: t.assignee, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${t.assignee}:${t.id}`, prompt });
  }

  // ---- user intents -------------------------------------------------------------------------

  private steerPending(agentId: string, entry: Running): void {
    if (!entry.steer || entry.steering || entry.abort.signal.aborted || this.running.get(agentId) !== entry) return;
    const messages = this.fm.bus.inbox(agentId).filter(m => m.from === 'user');
    if (!messages.length) return;
    const ids = messages.map(m => m.id);
    // Reserve synchronously so an MCP result cannot deliver the same message during the RPC.
    (this.st.steering ??= {})[agentId] = ids;
    this.fm.bus.markRead(agentId, ids);
    const prompt = `New instructions from ${userName()}:\n${formatInbox(messages, id => this.fm.nameOf(id))}\nAct on these instructions and respond briefly with send_message(to "user").`;
    entry.steering = Promise.resolve().then(() => entry.steer!(prompt)).catch(() => false).then(accepted => {
      if (!accepted) this.fm.bus.markUnread(agentId, ids);
      else this.fm.agentLog(agentId, 'text', 'Your message was delivered to the running agent.');
      delete this.st.steering?.[agentId];
      this.fm.store.markDirty();
      entry.steering = undefined;
      if (accepted) this.steerPending(agentId, entry);
    });
  }

  /** `note`: extra instructions for the agent only (not shown in the feed). */
  onUserMessage(to: string, text: string, note?: string): void {
    const id = to === 'all' ? LEAD : to;
    const a = this.fm.agent(id);
    if (!a) return;
    if (this.isStopped(id)) {
      // stays unread; delivered when the user resumes the agent (deliverPending)
      this.fm.bus.send(id, 'user', `(${this.fm.nameOf(id)} is off shift - /resume @${id} to bring them back; your message is queued.)`);
      return;
    }
    // Runtimes with a live input channel accept messages immediately. Others retain the
    // existing delivery through the next team tool result or a follow-up turn.
    const running = this.running.get(id);
    if (running) { this.steerPending(id, running); return; }
    if (this.pausedJobs.has(id)) return;
    // every unread message from the user to this agent goes into one follow-up
    const mine = this.fm.bus.inbox(id).filter((m) => m.from === 'user' && (m.to === id || (to === 'all' && m.to === 'all')));
    const body = mine.length ? mine.map((m) => m.text).join('\n\n') : text;
    const consume = () => this.fm.bus.markRead(id, mine.map((m) => m.id));
    const prompt = `Message from ${userName()}: ${body}\n\n${note ? `${note}\n\n` : ''}Respond briefly with send_message(to "user") and act on it if needed (lead: create or update tasks; worker: adjust your work).`;
    if (id === LEAD) {
      const goal = this.fm.currentGoal();
      if (!goal) {
        consume();
        this.fm.bus.send(LEAD, 'user', 'No goal yet - type one in the console and I will plan it.');
        return;
      }
      consume();
      this.enqueue({ kind: 'followup', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, prompt });
      return;
    }
    const t = this.fm.tasks.list().filter((x) => x.assignee === id && (x.status === 'doing' || x.status === 'review')).pop();
    consume();
    if (!t) {
      this.fm.bus.send(id, 'user', 'I am not on a task right now - Marlow will pick that up.');
      this.fm.bus.send('user', LEAD, `(for ${this.fm.nameOf(id)}) ${body}`);
      const name = this.fm.nameOf(id);
      this.onUserMessage(
        LEAD,
        `(originally for ${name}) ${body}`,
        `${name} is not on a task, and workers only read messages while they work on one. If this needs ${name} to do something, create a task for it with create_task (assignee "${id}"); a send_message alone will not reach ${name}.`,
      );
      return;
    }
    this.enqueue({ kind: 'followup', agentId: id, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${id}:${t.id}`, prompt });
  }

  onDecisionSettled(d: Decision): void {
    if (d.kind === 'question') {
      // in-process ask_user waiters resolve by themselves; after a restart nobody waits -> resume
      if (!this.waitingUser.has(d.agentId) && !this.running.has(d.agentId) && !this.isStopped(d.agentId)) {
        const ans = [d.answer?.option, d.answer?.text].filter(Boolean).join(' — ') || '(cancelled)';
        const inf = this.st.inflight[d.agentId];
        const t = d.taskId ? this.fm.tasks.get(d.taskId) : undefined;
        const goalId = inf?.goalId ?? t?.goalId ?? (d.agentId === LEAD ? this.fm.currentGoal()?.id : undefined);
        const sessionKey = inf?.sessionKey ?? (d.agentId === LEAD ? `${LEAD}:${goalId ?? 'adhoc'}` : t ? `${d.agentId}:${t.id}` : undefined);
        if (sessionKey) {
          // keep the interrupted job's kind, so its after-turn step (e.g. plan -> active) still runs
          this.enqueue({
            kind: inf?.kind ?? 'followup',
            agentId: d.agentId,
            sessionKey,
            resumed: true,
            ...(t ? { taskId: t.id } : inf?.taskId ? { taskId: inf.taskId } : {}),
            ...(goalId ? { goalId } : {}),
            prompt: `Earlier you asked ${userName()}: "${d.question}". ${userName()} answered: ${ans}. (Your ask_user call was interrupted by an orchestrator restart.) Continue.`,
          });
        }
      }
      return;
    }
    if (d.kind === 'merge' && d.taskId) {
      const t = this.fm.tasks.get(d.taskId);
      if (!t) return;
      if (d.answer?.option === 'Merge' && t.status === 'done') {
        if (t.assignee && this.fm.agent(t.assignee)?.taskId === t.id) this.fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} merged`, taskId: null, worktree: null });
        if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
        const g = t.goalId ? this.fm.goal(t.goalId) : undefined;
        if (g && this.fm.tasks.goalComplete(g.id)) {
          this.fm.bus.send(LEAD, 'user', `Everything for "${truncate(g.text, 80)}" is merged. Nice working with you.`);
          for (const w of this.team) if (!this.isStopped(w)) this.fm.setAgent(w, { state: 'done', station: 'lounge', activity: 'goal done' });
          if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'done', station: 'meeting', activity: 'goal done' });
        }
        this.tick();
      } else if (d.answer?.option === 'Request changes') {
        this.sendBackToWorker(t.id, `${userName()} reviewed ${t.id} and requested changes:\n${d.answer.text ?? '(no details given - ask_user if unclear)'}\n\nMake the changes, re-run the tests, then update_task("${t.id}", status "review", summary).`);
      } else if (d.answer?.option === 'Reject') {
        if (t.assignee && this.fm.agent(t.assignee)?.taskId === t.id) this.fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} rejected`, taskId: null, worktree: null });
        this.tick();
      }
    }
  }

  onMergeConflict(task: Task, info: { base: string; branch: string; files: string[]; reason: string }): boolean {
    if (!task.assignee || this.isStopped(task.assignee)) return false; // the user decides (decision stays open)
    const files = info.files.length ? info.files.join(', ') : '(see git status)';
    this.sendBackToWorker(
      task.id,
      `${userName()} approved merging ${task.id}, but ${info.branch} now conflicts with ${info.base} (other work was merged into ${info.base} after you started) in: ${files}.\n` +
        `In your worktree run \`git merge ${info.base}\`, resolve every conflict so that both sides' changes are kept, run the tests, and commit the merge (git commit --no-edit). ` +
        `Do not rebase, reset or check out other branches. Then update_task("${task.id}", status "review", summary).`,
    );
    return true;
  }

  onTaskAction(task: Task, action: 'reassign' | 'cancel' | 'retry' | 'prioritize'): void {
    if (action === 'cancel' || action === 'reassign') {
      for (const [id, r] of this.running) {
        if (r.job.taskId === task.id && id !== LEAD && (action === 'cancel' || task.assignee !== id)) this.abortTurn(r, 'cancel');
      }
      for (const [id, q] of this.queues) this.queues.set(id, q.filter((j) => j.taskId !== task.id || (action === 'reassign' && task.assignee === id)));
      for (const [id, job] of this.pausedJobs) {
        if (job.taskId === task.id && (action === 'cancel' || (id !== LEAD && task.assignee !== id))) this.pausedJobs.delete(id);
      }
      for (const [id, job] of Object.entries(this.st.inflight)) {
        if (job.taskId === task.id && (action === 'cancel' || (id !== LEAD && task.assignee !== id))) delete this.st.inflight[id];
      }
      this.fm.store.markDirty();
      // reassigned: the new worker continues from the old worker's branch once that turn is over
      if (action === 'reassign' && task.repoId && task.worktree) {
        const wt = this.fm.repos.findWorktree(task.repoId, task.worktree);
        if (wt && wt.status === 'active' && wt.agentId !== task.assignee) this.handOff(task.id, wt.agentId, `reassigned to ${this.fm.nameOf(task.assignee ?? 'user')}`);
      }
    }
    this.tick();
  }

  /** Withdraw an agent's open questions and permission prompts (not merge decisions: those are the user's). */
  private withdrawDecisions(agentId: string, why: string): void {
    for (const d of this.fm.decisions.open().filter((x) => x.agentId === agentId && x.kind !== 'merge')) this.fm.decisions.cancel(d.id, why);
  }

  async onAgentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn'): Promise<void> {
    const r = this.running.get(agentId);
    const name = this.fm.nameOf(agentId);
    if (action === 'pause') {
      if (r) this.abortTurn(r, 'pause');
      this.fm.setAgent(agentId, { state: 'idle', activity: 'paused' });
    } else if (action === 'resume' || action === 'spawn') {
      const wasStopped = this.isStopped(agentId);
      if (action === 'spawn' && agentId !== LEAD && !this.cfg.workers.includes(agentId)) this.cfg.workers.push(agentId);
      if (wasStopped || action === 'spawn') {
        this.setStopped(agentId, false);
        this.fm.setAgent(agentId, { active: true, paused: false, state: 'idle', station: 'lounge', activity: 'ready' });
        if (wasStopped) this.fm.bus.feed('system', `${name} is back on shift`, { agentId });
      }
      const job = this.pausedJobs.get(agentId);
      this.pausedJobs.delete(agentId);
      if (job) this.enqueue(job);
      else this.pump(agentId);
      if (agentId === LEAD && wasStopped) this.reconcile();
      // messages the user sent while the agent was off shift or paused
      this.deliverPending(agentId);
    } else if (action === 'stop') {
      this.setStopped(agentId, true);
      if (r) this.abortTurn(r, 'stop');
      this.queues.delete(agentId);
      this.pausedJobs.delete(agentId);
      delete this.st.inflight[agentId];
      this.withdrawDecisions(agentId, `${name} was stopped`);
      if (agentId !== LEAD) {
        for (const t of this.fm.tasks.list().filter((x) => x.assignee === agentId && x.status === 'doing')) {
          // back on the board, but held until the agent's turn is really over and its work is committed;
          // the next worker then continues from this branch
          this.fm.tasks.setStatus(t.id, 'todo', { force: true });
          this.fm.tasks.update(t.id, { assignee: null });
          this.fm.bus.feed('task', `${t.id} is back on the board (${name} was stopped)`, { agentId: 'user' });
          this.handOff(t.id, agentId, `${name} was stopped`);
        }
      }
      this.fm.setAgent(agentId, { active: false, paused: false, state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
    }
    this.tick();
  }
}
