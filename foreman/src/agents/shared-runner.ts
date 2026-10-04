// One scheduling and approval authority for all real harnesses.
import type { Foreman } from '../foreman.js';
import { ClientError } from '../foreman.js';
import type { ChildProcess } from 'node:child_process';
import { classifyToolUse, describeRuleKey, describeToolCall } from '../policy.js';
import type { Decision, Goal, Task } from '../protocol.js';
import { MERGE_OPTIONS, PERMISSION_OPTIONS } from '../protocol.js';
import type { TestResult } from '../repos.js';
import { renderDiffText } from '../diff.js';
import { formatInbox } from '../bus.js';
import { descendantsOf, killSnapshot, killTree, orphansOf, processTable, type ProcEntry } from '../util/proc.js';
import { truncate } from '../util/text.js';
import { leadSystemPrompt, planPrompt, RESUME_PROMPT, reviewPrompt, workerSystemPrompt, workPrompt } from './claude/prompts.js';
import type { ToolHooks, TurnHandle } from './claude/tools.js';
import { userName } from '../user.js';
import { validateSelection, type ModelChoice, type ModelSelection } from './codex/model-settings.js';
import type { Backend } from '../foreman.js';
import type { ExecutionState, ExecutionRole, ExecutionProvider, ExecutionSetupState, ExecutionAgentOverride, RoleSelection, Job, Running, TurnStats, SharedRunnerOptions, AbortReason } from './execution-types.js';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function alive(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}
const TURN_TIMEOUT_MS = 45 * 60_000;
const LEAD = 'marlow';
const NO_GOAL_CONVERSATION_INSTRUCTIONS = `

# Owner conversation with no active goal
This is an ordinary in-game conversation, not a task-planning request. Answer the owner directly and briefly with agentcraft.send_message(to "user"). Do not create tasks, write plans or memory, or run commands for casual chat. If the owner explicitly asks you to start repository work, ask them to submit it as an AgentCraft goal; do not create an unscheduled task.`;

export class SharedRunner implements Backend {
  private queues = new Map<string, Job[]>();
  private running = new Map<string, Running>();
  private pausedJobs = new Map<string, Job>();
  private tickTimer: NodeJS.Timeout | undefined;
  private readonly failedProviders = new Map<ExecutionProvider, string>();
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
  private scheduling = false;

  readonly name: ExecutionProvider;
  protected cfg: SharedRunnerOptions['config'];
  constructor(protected fm: Foreman, protected options: SharedRunnerOptions) {
    this.name = options.provider;
    this.cfg = options.config;
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

  private get st(): ExecutionState {
    const b = this.fm.store.data.backend;
    let s = b.execution as ExecutionState | undefined;
    if (!s) {
      const origins = (['codex','claude'] as const).filter(provider => {
        const data = b[provider] as Partial<ExecutionState> | undefined;
        return data?.inflight !== undefined;
      });
      if (origins.length > 1) throw new ClientError('Both legacy providers have orchestration state. Choose a separate profile; session ownership is ambiguous.');
      const origin = origins[0] ?? this.name;
      const legacy = b[origin] as ExecutionState | undefined;
      s = { inflight: {...legacy?.inflight}, ciFixes: {...legacy?.ciFixes}, stopped: [...(legacy?.stopped ?? [])], legacyProvider: origin };
      for (const [agentId, inf] of Object.entries(s.inflight)) {
        const namespace = /^(codex|claude):/.exec(inf.sessionKey)?.[1];
        if ((namespace && namespace !== origin) || (inf.selection && inf.selection.provider !== origin)) {
          throw new ClientError(`Legacy ${origin} inflight job for ${agentId} refers to a foreign provider; session ownership is ambiguous.`);
        }
        const role = inf.role ?? (inf.kind === 'review' ? 'reviewer' : agentId === LEAD ? 'lead' : 'worker');
        const saved = origin === 'codex'
          ? (legacy as ExecutionState & {modelSettings?: Record<string, ModelSelection>})?.modelSettings?.[agentId] : undefined;
        // Session records and interrupted jobs must move to the same namespace together.
        // Recovery must retain the original job even if the team's default provider changed.
        s.inflight[agentId] = {...inf, role, sessionKey: namespace ? inf.sessionKey : `${origin}:${inf.sessionKey}`,
          selection: inf.selection ? {...inf.selection} : {...this.providerDefaults(origin, role), ...saved}};
      }
      // Session ids contain no provider tag. Only an existing scheduler namespace is evidence
      // of ownership; retain unknown records without ever handing them to a foreign harness.
      if (origins.length === 1) {
        for (const [key, session] of Object.entries(this.fm.store.data.sessions)) {
          if (/^(codex|claude):/.test(key)) continue;
          this.fm.store.data.sessions[`${origin}:${key}`] ??= {...session};
          if (!this.options.legacySessions) delete this.fm.store.data.sessions[key];
        }
      }
      b.execution = s;
    }
    if (this.options.legacySessions) {
      const legacy = (b[this.name] ??= {}) as Record<string, unknown>;
      legacy.inflight = s.inflight; legacy.ciFixes = s.ciFixes; legacy.stopped = s.stopped;
    }
    return s;
  }
  get team(): string[] {
    return this.cfg.workers.filter((w) => this.fm.agent(w));
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
    for (const a of this.fm.agents()) {
      const onTeam = (a.id === LEAD || this.team.includes(a.id)) && !this.isStopped(a.id);
      this.fm.setAgent(a.id, { active: onTeam });
      if (!onTeam) this.fm.setAgent(a.id, { state: 'idle', station: 'lounge', activity: this.isStopped(a.id) ? 'stopped - off shift' : 'off shift' });
      else if (a.activity === 'off shift' || a.activity.startsWith('stopped')) this.fm.setAgent(a.id, { activity: 'ready' });
    }
    // the spend survives restarts: every session's cost is persisted, so the total is their sum
    const spent = Object.entries(this.fm.store.data.sessions).filter(([key]) => !this.fm.store.data.sessions[`${this.name}:${key}`]).map(([,s]) => s).reduce((sum, s) => sum + (s.costUsd || 0), 0);
    if (spent > 0) this.fm.setStatus({ costUsd: Math.round(spent * 1000) / 1000 });
    await this.checkAuth();
    for (const d of this.fm.decisions.open().filter(x => x.kind === 'permission')) this.fm.decisions.cancel(d.id, 'Foreman restarted');
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
    const providers = new Set<ExecutionProvider>([
      ...(['lead','worker','reviewer'] as const).map(role => this.roleSelection(role).provider),
      ...Object.entries(this.st.agentProviders ?? {}).filter(([id]) => this.fm.agent(id)?.active).map(([,provider]) => provider),
      ...Object.values(this.st.inflight).flatMap(inf => inf.selection ? [inf.selection.provider] : []),
    ]);
    for (const provider of this.failedProviders.keys()) if (!providers.has(provider)) this.failedProviders.delete(provider);
    for (const provider of providers) {
      this.failedProviders.set(provider, 'Checking authentication');
      try {
        const capability = this.options.capabilities ? await this.options.capabilities(provider) : undefined;
        const adapter = this.options.adapters[provider];
        if (!adapter || (capability && !capability.available)) {
          this.markAuthFailed(capability?.reason ?? `${provider} is unavailable`, provider);
        } else if (!await adapter.checkAuth(capability)) {
          this.markAuthFailed(this.fm.status.message ?? `${provider} authentication failed`, provider);
        } else {
          this.failedProviders.delete(provider);
        }
      } catch (error) {
        this.markAuthFailed(`${provider} authentication check failed`, provider);
      }
    }
    this.publishTeamStatus();
    return this.failedProviders.size === 0;
  }

  private publishTeamStatus(): void {
    const roles = this.roleSelections();
    const message = (['lead', 'worker', 'reviewer'] as const).map(role => {
      const selection = roles[role];
      return `${role}: ${[selection.provider, selection.model, selection.effort].filter(Boolean).join(' / ')}`;
    }).join(' · ');
    const unavailable = [...this.failedProviders].map(([provider, reason]) => `${provider}: ${reason}`).join('; ');
    this.fm.setStatus({ auth: this.failedProviders.has(this.selectionFor(LEAD, 'lead').provider) ? 'failed' : 'ok',
      message: `Team roles · ${message}${unavailable ? ` · Unavailable: ${unavailable}` : ''}` });
  }

  private async settingsChanged(): Promise<void> {
    if (this.failedProviders.size) await this.checkAuth();
    else this.publishTeamStatus();
    // Some providers may have recovered even if another still needs attention.
    this.tick();
  }

  private markAuthFailed(message: string, provider: ExecutionProvider): void {
    this.failedProviders.set(provider, message);
    this.publishTeamStatus();
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
    for (const [agentId, inf] of Object.entries(st.inflight)) {
      if (this.isStopped(agentId) || !this.fm.agent(agentId)) {
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
        this.enqueue({ kind: inf.kind, agentId, sessionKey: inf.sessionKey, selection: inf.selection, role: inf.role, prompt: RESUME_PROMPT, resumed: true, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
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
        this.enqueue({ kind: 'plan', agentId: LEAD, goalId: g.id, sessionKey: `${LEAD}:${g.id}`, prompt: planPrompt(this.fm, g, repo.path, repo.branch) });
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
    await Promise.allSettled(Object.values(this.options.adapters).map(adapter => adapter?.close?.()));
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

  /** Abort a turn, request an app-server interruption, and snapshot the process tree. */
  private abortTurn(r: Running, reason: AbortReason): void {
    r.reason = reason;
    const pid = r.child?.pid;
    if (pid && alive(r.child) && !r.tree) r.tree = processTable().then((t) => (t ? descendantsOf(t, pid) : undefined)).catch(() => undefined);
    r.abort.abort();
    r.interrupt?.();
  }

  /**
   * Make sure an aborted turn's app-server process and everything it started are gone. The server
   * gets a short grace period; after that its tree is killed. Processes that outlived the server
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
    if (this.failedProviders.has(this.selectionFor(LEAD, 'lead').provider)) {
      this.fm.setGoal(goal.id, { status: 'failed' });
      throw new ClientError(`Execution is not available: ${this.fm.status.message ?? 'auth failed'}`);
    }
    const repo = this.fm.repos.require(goal.repoId!);
    if (this.isStopped(LEAD)) {
      this.setStopped(LEAD, false);
      this.fm.bus.feed('system', 'Marlow is back on shift for the new goal', { agentId: LEAD });
    }
    for (const w of [LEAD, ...this.team]) if (!this.isStopped(w)) this.fm.setAgent(w, { active: true });
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal', repoId: repo.id });
    this.enqueue({ kind: 'plan', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, fresh: true, prompt: planPrompt(this.fm, goal, repo.path, repo.branch) });
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
    if (this.failedProviders.has(this.selectionFor(w, 'worker').provider)) return false;
    if (this.running.has(w) || (this.queues.get(w)?.length ?? 0) > 0) return false;
    return !this.fm.tasks.list().some((t) => t.assignee === w && t.status === 'doing');
  }

  private async schedule(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try { await this.dispatchReady(); }
    finally { this.scheduling = false; }
  }

  private async dispatchReady(): Promise<void> {
    if (this.stopping) return;
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
    const wt = await this.fm.repos.createWorktree(t.repoId!, agentId, t, startPoint ? { startPoint } : {});
    this.fm.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    this.fm.tasks.setStatus(t.id, 'doing');
    this.fm.setAgent(agentId, { taskId: t.id, repoId: t.repoId!, worktree: wt.id, state: 'thinking', station: 'desk', activity: `starting ${t.id}` });
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} started ${t.id}: ${t.title}`, { agentId });
    const inbox = formatInbox(this.fm.bus.inbox(agentId, { markRead: true }), (id) => this.fm.nameOf(id));
    this.enqueue({ kind: 'work', agentId, taskId: t.id, goalId: goal.id, sessionKey: `${agentId}:${t.id}`, prompt: workPrompt(this.fm, t, goal, wt, inbox, continuesFrom) });
  }

  // ---- job queue ----------------------------------------------------------------------------

  private enqueue(job: Job): void {
    const q = this.queues.get(job.agentId) ?? [];
    q.push(job);
    this.queues.set(job.agentId, q);
    this.pump(job.agentId);
  }

  private pump(agentId: string): void {
    if (this.stopping) return;
    if (this.running.has(agentId)) return;
    const a = this.fm.agent(agentId);
    if (!a || a.paused || !a.active || this.isStopped(agentId)) return;
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (agentId !== LEAD && this.workersRunning() >= this.cfg.maxConcurrent) return;
    const index = q.findIndex(job => !this.failedProviders.has((job.selection ?? this.selectionFor(job.agentId,
      job.role ?? (job.kind === 'review' ? 'reviewer' : job.agentId === LEAD ? 'lead' : 'worker'))).provider));
    if (index < 0) return;
    const [job] = q.splice(index, 1);
    const p = this.runJob(job!).finally(() => {
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

  private cwdFor(job: Job): { cwd: string; role: 'lead' | 'worker' } {
    if (job.agentId === LEAD) {
      const goal = job.goalId ? this.fm.goal(job.goalId) : this.fm.currentGoal();
      const repo = goal?.repoId ? this.fm.repos.get(goal.repoId) : this.fm.repos.defaultRepo();
      if (!repo) throw new Error('no repo for the lead');
      return { cwd: repo.path, role: 'lead' };
    }
    const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
    if (!t?.worktree || !t.repoId) throw new Error(`job for ${job.agentId} has no worktree`);
    return { cwd: this.fm.repos.requireWorktree(t.repoId, t.worktree).path, role: 'worker' };
  }

  private async permissionGranted(agentId: string, role: 'lead' | 'worker', cwd: string, turn: TurnHandle, toolName: string, input: Record<string, unknown>, reason?: string, mcpServer?: string, requestSignal?: AbortSignal): Promise<boolean> {
    if (requestSignal) turn = {...turn, signal: AbortSignal.any([turn.signal, requestSignal])};
    if (turn.signal.aborted) return false;
    const verdict = classifyToolUse(toolName, input, {
      role,
      cwd,
      ...(mcpServer ? {mcpServer} : {}),
      readDirs: [this.fm.memory.dir],
      alwaysAllow: this.fm.store.data.permissionRules[agentId] ?? [],
    });
    if (verdict.action === 'allow') return true;
    if (verdict.action === 'deny') {
      this.fm.agentLog(agentId, 'error', `blocked: ${describeToolCall(toolName, input)} (${verdict.reason})`);
      return false;
    }
    const previous = this.fm.agent(agentId);
    const previousState = previous ? { state: previous.state, station: previous.station, activity: previous.activity } : undefined;
    const taskId = previous?.taskId;
    const d = this.fm.createDecision({
      agentId,
      kind: 'permission',
      tool: toolName,
      question: `${this.fm.nameOf(agentId)} wants to run ${truncate(describeToolCall(toolName, input), 160)}`,
      options: [...PERMISSION_OPTIONS],
      context: `${verdict.reason}${reason ? `\nHarness reason: ${truncate(reason, 240)}` : ''}\ncwd: ${cwd}\n"${PERMISSION_OPTIONS[1]}" covers: ${[...new Set(verdict.ruleKeys.map(describeRuleKey))].join('; ')}`,
      ...(taskId ? { taskId } : {}),
    });
    this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'asking permission' });
    this.hooks.onWaiting(agentId, true);
    this.fm.agentLog(agentId, 'tool', `permission? ${describeToolCall(toolName, input)}`);
    const onAbort = () => this.fm.decisions.cancel(d.id, 'turn stopped');
    if (turn.signal.aborted) onAbort();
    else turn.signal.addEventListener('abort', onAbort, { once: true });
    const result = await this.fm.decisions.wait(d.id);
    turn.signal.removeEventListener('abort', onAbort);
    this.hooks.onWaiting(agentId, false);
    if (turn.signal.aborted) return false;
    if (previousState) this.fm.setAgent(agentId, previousState);
    const option = result.answer?.option;
    if (result.status === 'answered' && (option === PERMISSION_OPTIONS[0] || option === PERMISSION_OPTIONS[1])) {
      if (option === PERMISSION_OPTIONS[1]) {
        const rules = (this.fm.store.data.permissionRules[agentId] ??= []);
        for (const key of verdict.ruleKeys) if (!rules.includes(key)) rules.push(key);
        this.fm.store.markDirty();
      }
      this.fm.agentLog(agentId, 'result', `${userName()} allowed: ${describeToolCall(toolName, input)}`);
      return true;
    }
    this.fm.agentLog(agentId, 'error', `${result.status === 'cancelled' ? 'Permission request withdrawn' : `${userName()} denied`}: ${describeToolCall(toolName, input)}`);
    return false;
  }

  private async askUser(agentId: string, question: string, options: string[], turn: TurnHandle): Promise<string | undefined> {
    const previous = this.fm.agent(agentId);
    const previousState = previous ? { state: previous.state, station: previous.station, activity: previous.activity } : undefined;
    const d = this.fm.createDecision({ agentId, kind: 'question', question, options: options.slice(0, 6), ...(previous?.taskId ? { taskId: previous.taskId } : {}) });
    this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
    this.hooks.onWaiting(agentId, true);
    const onAbort = () => {
      if (turn.reason() !== 'shutdown') this.fm.decisions.cancel(d.id, `${this.fm.nameOf(agentId)}'s turn was stopped`);
    };
    if (turn.signal.aborted) onAbort();
    else turn.signal.addEventListener('abort', onAbort, { once: true });
    const result = await this.fm.decisions.wait(d.id);
    turn.signal.removeEventListener('abort', onAbort);
    this.hooks.onWaiting(agentId, false);
    if (turn.signal.aborted || result.status === 'cancelled') return undefined;
    if (previousState) this.fm.setAgent(agentId, { state: previousState.state, station: previousState.station, activity: 'got your answer' });
    return [result.answer?.option, result.answer?.text].filter(Boolean).join(' — ') || undefined;
  }


  private roleSelection(role: ExecutionRole): RoleSelection {
    const roles = {...this.options.execution?.roles, ...this.st.roles};
    const selected = roles[role] ?? (role === 'reviewer' ? roles.lead : undefined);
    const provider = selected?.provider ?? this.name;
    const cfg = provider === this.name ? this.cfg : this.fm.config[provider];
    const lead = role !== 'worker';
    return {
      provider,
      model: selected?.model ?? (lead ? cfg.leadModel : cfg.workerModel) ?? ('model' in cfg ? cfg.model : undefined),
      effort: selected?.effort ?? (lead ? cfg.leadEffort : undefined) ?? cfg.effort,
    };
  }

  /** Resolved next-turn choices; callers cannot mutate the saved selections. */
  roleSelections(): Record<ExecutionRole, RoleSelection> {
    return {lead: this.roleSelection('lead'), worker: this.roleSelection('worker'), reviewer: this.roleSelection('reviewer')};
  }

  setupState(): ExecutionSetupState {
    const state = this.st;
    const legacy = (this.fm.store.data.backend.codex as {modelSettings?: Record<string, ModelSelection>} | undefined)?.modelSettings ?? {};
    const ids = new Set([...Object.keys(legacy), ...Object.keys(state.agentSettings ?? {}), ...Object.keys(state.agentProviders ?? {})]);
    const agentOverrides: Record<string, ExecutionAgentOverride> = {};
    for (const id of ids) {
      const models: ExecutionAgentOverride['models'] = {...(legacy[id] ? {codex:{...legacy[id]}} : {})};
      for (const provider of ['codex','claude'] as const) {
        const selected = state.agentSettings?.[id]?.[provider];
        if (selected) models[provider] = {...selected};
      }
      const provider = state.agentProviders?.[id];
      if (provider || Object.keys(models).length) agentOverrides[id] = {models, ...(provider ? {provider} : {})};
    }
    return {roles:this.roleSelections(),setupComplete:state.setupComplete ?? false,
      hasAgentOverrides:Object.keys(agentOverrides).length > 0,agentOverrides};
  }

  /** Setup is one transaction: a failed discovery/selection never saves a partial team. */
  async configureTeam(roles: Record<ExecutionRole, RoleSelection>, resetAgentOverrides = false): Promise<ExecutionSetupState & {setupComplete:true}> {
    const selected = {} as Record<ExecutionRole, RoleSelection>;
    for (const role of ['lead','worker','reviewer'] as const) {
      if (!roles?.[role]) throw new ClientError(`Choose a ${role} provider, model and reasoning level.`);
      selected[role] = {...roles[role]};
    }
    await Promise.all(Object.values(selected).map(selection => this.validate(selection)));
    const state = this.st;
    for (const role of ['lead','worker','reviewer'] as const) {
      const previous = state.roles?.[role] ?? this.options.execution?.roles?.[role];
      const profiles = ((state.roleSettings ??= {})[role] ??= {});
      if (previous) profiles[previous.provider] = {...previous};
      profiles[selected[role].provider] = {...selected[role]};
    }
    if (resetAgentOverrides) {
      state.agentSettings = {};
      state.agentProviders = {};
      const legacy = this.fm.store.data.backend.codex as {modelSettings?: Record<string, ModelSelection>} | undefined;
      if (legacy) delete legacy.modelSettings;
    }
    state.roles = selected;
    state.setupComplete = true;
    this.fm.store.markDirty();
    await this.settingsChanged();
    return {...this.setupState(),setupComplete:true};
  }

  protected async availableModels(provider: ExecutionProvider = this.name): Promise<ModelChoice[]> {
    if (this.stopping) throw new ClientError('Foreman is stopping.');
    if (this.options.capabilities) {
      const capability = await this.options.capabilities(provider);
      if (!capability.available) throw new ClientError(capability.reason ?? `${provider} is unavailable.`);
      return capability.models;
    }
    const adapter = this.options.adapters[provider];
    if (!adapter) throw new ClientError(`${provider} is unavailable.`);
    if (!adapter.models) throw new ClientError(`${provider} model discovery is unavailable.`);
    return adapter.models();
  }

  private async validate(selection: RoleSelection): Promise<void> {
    if (selection.provider !== 'codex' && selection.provider !== 'claude') throw new ClientError('Unknown execution provider.');
    if (!this.options.adapters[selection.provider]) throw new ClientError(`${selection.provider} is unavailable.`);
    if (selection.model !== undefined || selection.effort !== undefined) {
      try { validateSelection(await this.availableModels(selection.provider), selection.model, selection.effort); }
      catch (e) { throw new ClientError((e as Error).message); }
    } else if (this.options.capabilities) {
      const capability = await this.options.capabilities(selection.provider);
      if (!capability.available) throw new ClientError(capability.reason ?? `${selection.provider} is unavailable.`);
    }
  }

  async configureRole(role: ExecutionRole, selection: RoleSelection): Promise<Record<ExecutionRole, RoleSelection>> {
    if (!['lead', 'worker', 'reviewer'].includes(role)) throw new ClientError('Unknown execution role.');
    const saved = this.st.roleSettings?.[role]?.[selection.provider];
    selection = {...saved, ...selection};
    await this.validate(selection);
    const previous = this.st.roles?.[role] ?? this.options.execution?.roles?.[role];
    const profiles = ((this.st.roleSettings ??= {})[role] ??= {});
    if (previous) profiles[previous.provider] = {...previous};
    profiles[selection.provider] = {...selection};
    (this.st.roles ??= {})[role] = {...selection};
    this.fm.store.markDirty();
    this.fm.bus.feed('system', `${role} settings saved for the next turn: ${selection.provider}${selection.model ? ` / ${selection.model}` : ''}${selection.effort ? ` / ${selection.effort}` : ''}.`);
    await this.settingsChanged();
    return this.roleSelections();
  }

  private selectionFor(agentId: string, role: ExecutionRole): RoleSelection {
    const base = this.roleSelection(role);
    // A reviewer selection belongs to the review job, independent of the lead's provider override.
    const explicitReviewer = role === 'reviewer' && (this.st.roles?.reviewer ?? this.options.execution?.roles?.reviewer);
    const provider = explicitReviewer ? base.provider : this.st.agentProviders?.[agentId] ?? base.provider;
    const defaults = provider === base.provider ? base : this.providerDefaults(provider, role);
    const legacy = (this.fm.store.data.backend.codex as {modelSettings?: Record<string, ModelSelection>} | undefined)?.modelSettings?.[agentId];
    const selected = this.st.agentSettings?.[agentId]?.[provider] ?? (provider === 'codex' ? legacy : undefined);
    return {...defaults, provider, ...(explicitReviewer ? {} : selected)};
  }

  private providerDefaults(provider: ExecutionProvider, role: ExecutionRole): RoleSelection {
    const cfg = provider === this.name ? this.cfg : this.fm.config[provider];
    return {provider, model: (role === 'worker' ? cfg.workerModel : cfg.leadModel) ?? ('model' in cfg ? cfg.model : undefined),
      effort: (role === 'worker' ? undefined : cfg.leadEffort) ?? cfg.effort};
  }

  private agentModelSettings(agentId: string): Record<string, unknown> {
    const role = agentId === LEAD ? 'lead' : 'worker';
    const next = this.selectionFor(agentId, role);
    const legacy = (this.fm.store.data.backend.codex as {modelSettings?: Record<string, ModelSelection>} | undefined)?.modelSettings?.[agentId];
    const selected = this.st.agentSettings?.[agentId]?.[next.provider] ?? (next.provider === 'codex' ? legacy : undefined);
    const running = this.running.get(agentId);
    return {agentId, provider: next.provider, selection: selected ?? null,
      next: {provider: next.provider, model: next.model ?? null, effort: next.effort ?? null},
      active: running ? {provider: running.job.selection?.provider, model: running.model ?? null, effort: running.effort ?? null} : null};
  }

  async agentModels(agentId: string, provider?: ExecutionProvider): Promise<Record<string, unknown>> {
    const settings = this.agentModelSettings(agentId);
    const catalogProvider = provider ?? settings.provider as ExecutionProvider;
    if (catalogProvider !== 'codex' && catalogProvider !== 'claude') throw new ClientError('Unknown execution provider.');
    return {...settings, catalogProvider, models: await this.availableModels(catalogProvider)};
  }

  async configureAgent(agentId: string, model?: string, effort?: string, provider?: ExecutionProvider): Promise<Record<string, unknown>> {
    if (!this.fm.agent(agentId)) throw new ClientError('Unknown agent.');
    if (model === undefined && effort === undefined && provider === undefined) {
      // "Role defaults" resets routing as well as models. It must remain usable even when
      // the previously selected provider is unavailable.
      delete this.st.agentSettings?.[agentId];
      delete this.st.agentProviders?.[agentId];
      const legacy = this.fm.store.data.backend.codex as {modelSettings?: Record<string, ModelSelection>} | undefined;
      delete legacy?.modelSettings?.[agentId];
      this.fm.store.markDirty();
      this.fm.bus.feed('system', `${this.fm.nameOf(agentId)} model settings saved for the next turn: role defaults.`);
      await this.settingsChanged();
      return this.agentModelSettings(agentId);
    }
    const chosen = provider ?? this.selectionFor(agentId, agentId === LEAD ? 'lead' : 'worker').provider;
    await this.validate({provider: chosen, model, effort});
    const settings = ((this.st.agentSettings ??= {})[agentId] ??= {});
    if (model !== undefined && effort !== undefined) settings[chosen] = {model, effort};
    else if (!provider) delete settings[chosen];
    if (provider) (this.st.agentProviders ??= {})[agentId] = chosen;
    if (chosen === 'codex') {
      const legacy = (this.fm.store.data.backend.codex ??= {}) as {modelSettings?: Record<string, ModelSelection>};
      const saved = legacy.modelSettings ??= {};
      if (model !== undefined && effort !== undefined) saved[agentId] = {model, effort};
      else if (!provider) delete saved[agentId];
    }
    this.fm.store.markDirty();
    this.fm.bus.feed('system', `${this.fm.nameOf(agentId)} model settings saved for the next turn: ${model ? `${chosen} / ${model} / ${effort}` : `${chosen} role defaults`}.`);
    await this.settingsChanged();
    return this.agentModelSettings(agentId);
  }

  private namespacedSession(job: Job, selection: RoleSelection): string {
    const logical = job.sessionKey.replace(/^(codex|claude):/, '');
    const key = `${selection.provider}:${logical}`;
    const sessions = this.fm.store.data.sessions;
    if (!sessions[key] && selection.provider === this.st.legacyProvider && this.options.legacySessions && sessions[logical]) {
      sessions[key] = {...sessions[logical]!};
      if (!this.options.legacySessions) delete sessions[logical];
      this.fm.store.markDirty();
    }
    const role = job.role ?? (job.kind === 'review' ? 'reviewer' : job.agentId === LEAD ? 'lead' : 'worker');
    const trackingKey = `${role}:${logical}`;
    const previousProvider = this.st.sessionProviders?.[trackingKey];
    if (previousProvider && previousProvider !== selection.provider) {
      this.fm.agentLog(job.agentId, 'text', `Provider changed to ${selection.provider}; ${sessions[key]?.sessionId ? 'resuming its saved session' : 'starting a separate session'}. The other provider's session is preserved.`);
    }
    (this.st.sessionProviders ??= {})[trackingKey] = selection.provider;
    return key;
  }

  private async runJob(job: Job): Promise<void> {
    const agentId = job.agentId;
    const abort = new AbortController();
    const role = job.role ?? (job.kind === 'review' ? 'reviewer' : agentId === LEAD ? 'lead' : 'worker');
    // Freeze synchronously at dispatch, before discovery or transport awaits.
    job = {...job, role, selection: job.selection ?? this.selectionFor(agentId, role)};
    job.sessionKey = this.namespacedSession(job, job.selection!);
    const entry: Running = {abort, job, model: job.selection!.model, effort: job.selection!.effort};
    const turn: TurnHandle = {signal: abort.signal, reason: () => entry.reason};
    const previous = this.lastTurn.get(agentId);
    this.running.set(agentId, entry);
    this.st.inflight[agentId] = {kind: job.kind, sessionKey: job.sessionKey, selection: {...job.selection!}, role, startedAt: Date.now(),
      ...(job.taskId ? {taskId: job.taskId} : {}), ...(job.goalId ? {goalId: job.goalId} : {})};
    this.fm.store.markDirty();
    let stats: TurnStats | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (previous?.reaping) await Promise.race([previous.reaping, sleep(10_000)]);
      abort.signal.throwIfAborted();
      const selection = job.selection!;
      const capability = this.options.capabilities ? await this.options.capabilities(selection.provider) : undefined;
      if (capability) {
        if (!capability.available) throw new Error(capability.reason ?? `${selection.provider} is unavailable.`);
        if (selection.model) {
          const model = capability.models.find(choice => choice.model === selection.model);
          if (!model) throw new Error(`${selection.provider} model ${selection.model} is unavailable.`);
          if (selection.effort && !model.efforts.includes(selection.effort)) throw new Error(`${selection.provider} model ${selection.model} does not support ${selection.effort}.`);
        } else if (selection.effort && !capability.models.some(model => model.efforts.includes(selection.effort!))) {
          throw new Error(`${selection.provider} does not support ${selection.effort}.`);
        }
      }
      const adapter = this.options.adapters[selection.provider];
      if (!adapter) throw new Error(`${selection.provider} is unavailable.`);
      abort.signal.throwIfAborted();
      const {cwd, role: policyRole} = this.cwdFor(job);
      const session = this.fm.store.data.sessions[job.sessionKey];
      const resume = !job.fresh ? session?.sessionId : undefined;
      let systemAppend = policyRole === 'lead' ? leadSystemPrompt(this.fm, this.team) :
        workerSystemPrompt(this.fm, agentId, this.fm.repos.requireWorktree(this.fm.tasks.require(job.taskId!).repoId!, this.fm.tasks.require(job.taskId!).worktree!));
      if (policyRole === 'lead' && job.kind === 'followup' && !job.goalId) systemAppend += NO_GOAL_CONVERSATION_INSTRUCTIONS;
      const unread = this.fm.bus.inbox(agentId, {markRead: true});
      const prompt = unread.length ? `${job.prompt}\n\n[New messages]\n${formatInbox(unread, id => this.fm.nameOf(id))}` : job.prompt;
      timer = setTimeout(() => this.abortTurn(entry, 'timeout'), TURN_TIMEOUT_MS);
      timer.unref?.();
      stats = await adapter.execute({entry, turn, cwd, policyRole, selection, capabilities: capability, resume, systemAppend, prompt, hooks: this.hooks,
        recordSession: (id, model, result) => this.recordSession(job.sessionKey, id, model, result),
        permissionGranted: (tool, input, reason, mcpServer, signal) => this.permissionGranted(agentId, policyRole, cwd, turn, tool, input, reason, mcpServer, signal),
        askUser: (question, choices) => this.askUser(agentId, question, choices, turn),
        markAuthFailed: message => this.markAuthFailed(message, selection.provider)});
      if (stats.sessionId) this.recordSession(job.sessionKey, stats.sessionId, stats.model ?? selection.model, stats);
    } catch (e) {
      if (!abort.signal.aborted) {
        const raw = (e as Error).message ?? String(e);
        const auth = /\bauth\b|authentication|login|credential|(?:access|refresh|auth) token|\b401\b|api key/i.test(raw);
        const message = auth ? `${job.selection!.provider} session failed; check the local sign-in.` : truncate(raw, 400);
        this.fm.log.error(`${agentId} ${job.kind} failed: ${message}`);
        this.fm.agentLog(agentId, 'error', `session error: ${message}`);
        if (auth) this.markAuthFailed(message, job.selection!.provider);
        stats = {isError: true, errors: [message]};
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(agentId);
    }

    const reason = entry.reason;
    if (reason === 'shutdown') return;
    if (reason) void this.reap(entry);
    delete this.st.inflight[agentId];
    this.fm.store.markDirty();
    if (reason === 'pause') {
      const next: Job = {...job, selection: undefined, fresh: false, resumed: true, prompt: `${userName()} paused you and has now resumed you. Any question you had open was withdrawn; ask again if you still need it. Continue your current job.`};
      if (this.fm.agent(agentId)?.paused) { this.pausedJobs.set(agentId, next); this.fm.setAgent(agentId, {state:'idle', activity:'paused'}); }
      else this.enqueue(next);
    } else if (reason === 'stop') {
      if (this.isStopped(agentId)) this.fm.setAgent(agentId, {state:'idle', station:'lounge', activity:'stopped - off shift', taskId:null, worktree:null});
    } else if (reason === 'cancel') {
      if (this.fm.agent(agentId)?.taskId === job.taskId) this.fm.setAgent(agentId, {state:'idle', station:'lounge', activity:'task cancelled', taskId:null, worktree:null});
    } else {
      await this.afterTurn(job, reason === 'timeout' ? {isError:true, subtype:'timeout', errors:['turn timed out']} : stats)
        .catch(e => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    }
    this.pump(agentId);
    if (reason !== 'stop' && reason !== 'pause') this.deliverPending(agentId);
    this.tick();
  }
  private deliverPending(agentId: string): void {
    if (this.stopping || this.isStopped(agentId) || this.running.has(agentId) || this.pausedJobs.has(agentId) || (this.queues.get(agentId)?.length ?? 0) > 0) return;
    const a = this.fm.agent(agentId);
    if (!a?.active || a.paused) return;
    const fromUser = this.fm.bus.inbox(agentId).filter((m) => m.from === 'user' && m.to === agentId);
    if (!fromUser.length) return;
    this.fm.log.info(`delivering ${fromUser.length} message(s) from ${userName()} to ${agentId} that arrived after its last turn`);
    this.onUserMessage(agentId, fromUser[fromUser.length - 1]!.text);
  }

  private recordSession(key: string, sessionId: string, model?: string, stats?: TurnStats): void {
    const s = (this.fm.store.data.sessions[key] ??= { turns: 0, costUsd: 0, updatedAt: Date.now() });
    s.sessionId = sessionId;
    if (model ?? stats?.model) s.model = model ?? stats?.model;
    s.updatedAt = Date.now();
    if (stats) {
      s.turns += stats.numTurns ?? 0;
      if (typeof stats.costUsd === 'number') {
        // total_cost_usd is cumulative per session (resumes continue from the saved total)
        const costKey = `${key.split(':')[0]}:${sessionId}`;
        const prev = this.lastCost.get(costKey) ?? s.costUsd;
        const delta = Math.max(0, stats.costUsd - prev);
        this.lastCost.set(costKey, stats.costUsd);
        s.costUsd = Math.max(s.costUsd, stats.costUsd);
        this.fm.setStatus({ costUsd: Math.round(((this.fm.status.costUsd ?? 0) + delta) * 1000) / 1000 });
      }
      s.lastResult = stats.subtype;
    }
    if (this.options.legacySessions && key.startsWith(`${this.name}:`)) this.fm.store.data.sessions[key.slice(this.name.length + 1)] = s;
    this.fm.store.markDirty();
  }

  private failure(stats: TurnStats | undefined): string {
    return truncate(stats?.subtype && stats.subtype !== 'completed' ? stats.subtype.replace(/^error_/, '').replace(/_/g, ' ') : (stats?.errors[0] ?? 'error'), 36);
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
        this.enqueue({ ...job, selection: undefined, kind: 'followup', fresh: false, nudges: nudges + 1, prompt: `You ended your turn but ${t.id} is still "doing". If the work is complete, call update_task("${t.id}", status "review", summary). If you are stuck, call update_task with status "blocked" and blocked_reason. Otherwise continue.` });
        return;
      }
      const wt = t.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
      if (wt) await this.fm.repos.refresh(t.repoId!);
      if (!failed && wt && wt.files > 0) {
        this.fm.tasks.setStatus(t.id, 'review', { summary: truncate(stats?.resultText ?? 'work complete', 400) });
        await this.afterWorkerDone(t.id);
      } else {
        this.fm.tasks.setStatus(t.id, 'blocked', { reason: failed ? `session ended: ${stats?.subtype ?? stats?.errors.join('; ') ?? 'error'}` : 'worker stopped without changes', force: true });
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
      const status = ci.pass === null ? 'unknown' : ci.pass ? 'pass' : 'fail';
      this.fm.tasks.update(t.id, { ci: status });
      this.fm.repos.setCi(t.repoId, status);
      if (worker) this.fm.agentLog(worker, ci.pass === false ? 'error' : 'result', `CI ${ci.pass === null ? 'not run' : ci.pass ? 'passed' : 'FAILED'} (${(ci.durationMs / 1000).toFixed(1)}s)\n${ci.output.split('\n').slice(-6).join('\n')}`);
      this.fm.bus.feed('ci', `${t.id}: tests ${ci.pass === null ? 'not run' : status} (${ci.command})`, { ...(worker ? { agentId: worker } : {}) });
    } catch (e) {
      this.fm.log.warn(`CI for ${t.id}: ${(e as Error).message}`);
    }
    await this.fm.repos.refresh(t.repoId);
    if (this.stopping || this.fm.tasks.get(taskId)?.status !== 'review') return;
    if (ci && ci.pass === false && (this.st.ciFixes[t.id] ?? 0) < 1 && worker && !this.isStopped(worker)) {
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
    if (this.stopping || t.status !== 'review' || this.fm.decisions.open().some(d => d.kind === 'merge' && d.taskId === t.id)) return;
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
    // in a turn: delivered with its next agentcraft tool result, or right after the turn ends
    // (deliverPending). Paused mid-turn: delivered with the resumed job's prompt.
    if (this.running.has(id) || this.pausedJobs.has(id)) return;
    // every unread message from the user to this agent goes into one follow-up
    const mine = this.fm.bus.inbox(id).filter((m) => m.from === 'user' && (m.to === id || (to === 'all' && m.to === 'all')));
    const body = mine.length ? mine.map((m) => m.text).join('\n\n') : text;
    const consume = () => this.fm.bus.markRead(id, mine.map((m) => m.id));
    if (id === LEAD) {
      const current = this.fm.currentGoal();
      const goal = current && (current.status === 'planning' || current.status === 'active') ? current : undefined;
      consume();
      const prompt = goal
        ? `Message from ${userName()}: ${body}\n\n${note ? `${note}\n\n` : ''}Respond briefly with send_message(to "user") and act on it if needed (create or update tasks).`
        : `Message from ${userName()}: ${body}\n\n${note ? `${note}\n\n` : ''}This is an ordinary conversation with no active goal. Reply directly to ${userName()} with agentcraft.send_message(to "user"), then end your turn. Do not create tasks for this conversation.`;
      this.enqueue({ kind: 'followup', agentId: LEAD, ...(goal ? { goalId: goal.id } : {}), sessionKey: goal ? `${LEAD}:${goal.id}` : `${LEAD}:conversation`, prompt });
      return;
    }
    const prompt = `Message from ${userName()}: ${body}\n\n${note ? `${note}\n\n` : ''}Respond briefly with send_message(to "user") and act on it if needed (worker: adjust your work).`;
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
            selection: inf?.selection,
            role: inf?.role,
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
        if (r.job.taskId === task.id && (action === 'cancel' || (id !== LEAD && task.assignee !== id))) this.abortTurn(r, 'cancel');
      }
      for (const [id, q] of this.queues) this.queues.set(id, q.filter((j) => j.taskId !== task.id || (action === 'reassign' && task.assignee === id)));
      for (const [id, job] of this.pausedJobs) {
        if (job.taskId !== task.id || (action === 'reassign' && task.assignee === id)) continue;
        this.pausedJobs.delete(id);
        if (this.fm.agent(id)?.taskId === task.id) this.fm.setAgent(id, { state: 'idle', station: 'lounge', activity: 'task cancelled', taskId: null, worktree: null });
      }
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
