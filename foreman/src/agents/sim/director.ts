// SimDirector: the primitives the scripted scenario uses. Every primitive acts on real state:
// real worktrees, real file edits, real `npm test` runs, real decisions and merges. Only the
// "thinking" (which edit to make next) is scripted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SimConfig } from '../../config.js';
import type { CreateDecisionInput } from '../../decisions.js';
import type { Foreman } from '../../foreman.js';
import type { AgentState, Decision, LogKind, Station, Task, TaskStatus, Worktree } from '../../protocol.js';
import { MERGE_OPTIONS } from '../../protocol.js';
import type { CreateTaskInput } from '../../taskgraph.js';
import { git } from '../../util/git.js';
import { run } from '../../util/proc.js';
import { truncate } from '../../util/text.js';
import { toolActivity } from '../activity.js';
import { appendReviewNote, applyPatch, miniDiff, type Patch } from './edits.js';
import { userName } from '../../user.js';

export class Stopped extends Error {
  constructor() {
    super('sim stopped');
  }
}

export interface SimState {
  goalId?: string;
  beat: number;
  vars: Record<string, string | number | boolean>;
  finished?: boolean;
  checkpoint?: string;
}

/** mulberry32: tiny seeded PRNG so jitter and filler lines are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AMBIENT: Record<string, string[]> = {
  marlow: ['Re-reading the plan against the goal', 'Checking dependencies on the task wall', 'Sketching the release notes outline', 'Thinking about what is left for you'],
  kit: ['Thinking through regex edge cases: #, ##, #-', 'Considering Unicode letter classes for tags', 'Re-running the failing case in my head'],
  juniper: ['Reading how run() dispatches commands', 'Comparing flag parsing styles in cli.ts', 'Looking at how the tests build their harness'],
  wren: ['Checking cyan contrast on dark terminals', 'Making sure NO_COLOR is respected', 'Lining up the list columns'],
  rowan: ['Skimming the diffs for naming consistency', 'Looking for dead code paths', 'Re-reading the review checklist'],
  tove: ['Outlining the README Tags section', 'Collecting example commands for the docs', 'Tidying shared memory'],
};

export class SimDirector {
  readonly random: () => number;
  private abort = new AbortController();
  private autoAnswered = new Set<string>();
  instant = false;

  constructor(
    readonly fm: Foreman,
    readonly cfg: SimConfig,
    readonly st: SimState,
    private persist: () => void,
  ) {
    this.random = rng(cfg.seed + st.beat * 7919);
  }

  get vars(): SimState['vars'] {
    return this.st.vars;
  }

  get goalId(): string {
    return this.st.goalId!;
  }

  get repoId(): string {
    const g = this.fm.goal(this.goalId);
    return g?.repoId ?? this.fm.repos.defaultRepo()!.id;
  }

  get repoPath(): string {
    return this.fm.repos.require(this.repoId).path;
  }

  stop(): void {
    this.abort.abort();
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  // ---- time ---------------------------------------------------------------------------------

  /** Sleep `ms` sim-milliseconds (scaled by speed, +-20% seeded jitter). Instant mode: yield only. */
  async sleep(ms: number): Promise<void> {
    if (this.stopped) throw new Stopped();
    const jitter = 0.8 + this.random() * 0.4;
    const real = this.instant ? 0 : (ms * jitter) / this.cfg.speed;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, real);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Stopped());
        },
        { once: true },
      );
    });
  }

  /** Wait while an agent is paused or stopped (off shift): the script continues once resumed. */
  async gate(agentId: string): Promise<void> {
    for (let a = this.fm.agent(agentId); a && (a.paused || !a.active); a = this.fm.agent(agentId)) {
      if (this.stopped) throw new Stopped();
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // ---- presence -----------------------------------------------------------------------------

  act(agentId: string, state: AgentState, station: Station, activity: string): void {
    this.fm.act(agentId, state, station, activity);
  }

  log(agentId: string, kind: LogKind, text: string): void {
    this.fm.agentLog(agentId, kind, text);
  }

  async think(agentId: string, text: string, station?: Station, ms = 1400): Promise<void> {
    await this.gate(agentId);
    const a = this.fm.agent(agentId)!;
    this.act(agentId, 'thinking', station ?? a.station, truncate(text, 48));
    this.log(agentId, 'text', text);
    await this.sleep(ms);
  }

  say(from: string, to: string, text: string): void {
    this.fm.bus.send(from, to, text);
  }

  // ---- tools (real) -------------------------------------------------------------------------

  private async tool(agentId: string, name: string, input: Record<string, unknown>, root?: string): Promise<void> {
    await this.gate(agentId);
    const act = toolActivity(name, input, root);
    this.act(agentId, act.state, act.station, act.activity);
    this.log(agentId, 'tool', act.label);
  }

  async read(agentId: string, root: string, file: string, ms = 900): Promise<string> {
    await this.tool(agentId, 'Read', { file_path: path.join(root, file) }, root);
    await this.sleep(ms / 2);
    const p = path.join(root, file);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const lines = text ? text.replace(/\n$/, '').split('\n').length : 0;
    const exports = [...text.matchAll(/^export (?:function|interface|const|type) (\w+)/gm)].map((m) => m[1]).slice(0, 5);
    this.log(agentId, 'result', `${lines} lines${exports.length ? ` - exports ${exports.join(', ')}` : ''}`);
    await this.sleep(ms / 2);
    return text;
  }

  private walk(root: string, dir: string, out: string[]): void {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) this.walk(root, rel, out);
      else out.push(rel);
    }
  }

  async glob(agentId: string, root: string, pattern: string, ms = 700): Promise<string[]> {
    await this.tool(agentId, 'Glob', { pattern }, root);
    const all: string[] = [];
    this.walk(root, '', all);
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
    const hits = all.filter((f) => re.test(f)).sort();
    await this.sleep(ms / 2);
    this.log(agentId, 'result', hits.length ? hits.join('\n') : 'no files');
    await this.sleep(ms / 2);
    return hits;
  }

  async grep(agentId: string, root: string, pattern: string, ms = 900): Promise<number> {
    await this.tool(agentId, 'Grep', { pattern }, root);
    const re = new RegExp(pattern);
    const files: string[] = [];
    this.walk(root, '', files);
    const hits: string[] = [];
    let count = 0;
    const fileSet = new Set<string>();
    for (const f of files.filter((x) => /\.(ts|md|json)$/.test(x)).sort()) {
      const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (re.test(l)) {
          count++;
          fileSet.add(f);
          if (hits.length < 4) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`);
        }
      });
    }
    await this.sleep(ms / 2);
    this.log(agentId, 'result', `${count} matches in ${fileSet.size} files${hits.length ? '\n' + hits.join('\n') : ''}`);
    await this.sleep(ms / 2);
    return count;
  }

  /** Apply real edits in a worktree, one tool call per patch, with a diff log entry. */
  async patch(agentId: string, root: string, patches: Patch[], msPer = 1300): Promise<void> {
    for (const p of patches) {
      const isCreate = 'create' in p;
      await this.tool(agentId, isCreate ? 'Write' : 'Edit', { file_path: path.join(root, p.file) }, root);
      await this.sleep(msPer * 0.6);
      const r = applyPatch(root, p);
      if (r.changed) this.log(agentId, 'diff', `${p.file}\n${miniDiff(r.before, r.after)}`);
      else this.log(agentId, 'result', `${p.file} already up to date`);
      this.fm.repos.scheduleRefresh(this.repoId);
      await this.sleep(msPer * 0.4);
    }
  }

  async reviewNote(agentId: string, root: string, file: string, note: string, round: number): Promise<void> {
    await this.tool(agentId, 'Edit', { file_path: path.join(root, file) }, root);
    await this.sleep(900);
    const r = appendReviewNote(root, file, note, round);
    if (r.changed) this.log(agentId, 'diff', `${file}\n${miniDiff(r.before, r.after)}`);
    this.fm.repos.scheduleRefresh(this.repoId);
  }

  /** Run the repo's real test command (in a worktree, or the main checkout). Updates CI lamps. */
  async runTests(agentId: string, opts: { taskKey?: string; worktree?: Worktree } = {}): Promise<boolean> {
    const cwd = opts.worktree?.path ?? this.repoPath;
    const cmd = this.fm.repos.detectTestCommand(cwd) ?? 'npm test --silent';
    await this.tool(agentId, 'Bash', { command: cmd.replace(' --silent', '') }, cwd);
    const task = opts.taskKey ? this.task(opts.taskKey) : undefined;
    if (task) this.fm.tasks.update(task.id, { ci: 'running' });
    this.fm.repos.setCi(this.repoId, 'running');
    await this.sleep(800);
    const res = await this.fm.repos.runTests(this.repoId, opts.worktree?.id, cmd);
    const summary = res.summary ?? '';
    const failing = res.failures.slice(0, 4).map((f) => `FAIL ${f}`);
    this.log(agentId, res.pass ? 'result' : 'error', `${res.pass ? 'tests passed' : 'tests FAILED'} (${(res.durationMs / 1000).toFixed(1)}s)${summary ? ` - ${summary}` : ''}${failing.length ? '\n' + failing.join('\n') : ''}`);
    if (task) this.fm.tasks.update(task.id, { ci: res.pass ? 'pass' : 'fail' });
    this.fm.repos.setCi(this.repoId, res.pass ? 'pass' : 'fail');
    this.fm.bus.feed('ci', `${this.fm.nameOf(agentId)}: ${res.pass ? 'tests pass' : 'tests fail'}${task ? ` on ${task.id}` : ''}${summary ? ` (${summary})` : ''}`, { agentId });
    this.act(agentId, 'testing', 'testbench', res.pass ? 'tests pass' : `${failing.length || 'some'} failing`);
    await this.sleep(700);
    return res.pass === true;
  }

  /** Run the real CLI on the main checkout (temp notes file), one Bash call per command. */
  async cli(agentId: string, ...commands: string[][]): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-notes-smoke-'));
    const env = { ...process.env, NOTES_FILE: path.join(tmp, 'notes.json'), NO_COLOR: '1' };
    try {
      for (const args of commands) {
        const label = `notes ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
        await this.tool(agentId, 'Bash', { command: label }, this.repoPath);
        const r = await run(process.execPath, ['src/cli.ts', ...args], { cwd: this.repoPath, env, timeoutMs: 20_000 });
        this.log(agentId, r.code === 0 ? 'result' : 'error', (r.stdout || r.stderr).trim() || `(exit ${r.code})`);
        await this.sleep(600);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async commit(agentId: string, taskKey: string, message: string): Promise<void> {
    const wt = this.wt(taskKey);
    await this.tool(agentId, 'Bash', { command: `git commit -am "${message}"` }, wt.path);
    const made = await this.fm.repos.commitAll(this.repoId, wt.id, message);
    const sha = (await git(wt.path, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    this.log(agentId, 'result', made ? `[${wt.branch} ${sha}] ${message}` : 'nothing to commit, working tree clean');
    await this.fm.repos.refresh(this.repoId);
    await this.sleep(600);
  }

  // ---- tasks --------------------------------------------------------------------------------

  ensureTask(key: string, input: Omit<CreateTaskInput, 'goalId' | 'repoId'>): Task {
    const id = this.vars[`task:${key}`];
    if (typeof id === 'string') {
      const t = this.fm.tasks.get(id);
      if (t) return t;
    }
    const deps = (input.deps ?? []).map((k) => this.task(k).id);
    const t = this.fm.tasks.create({ ...input, deps, goalId: this.goalId, repoId: this.repoId });
    this.vars[`task:${key}`] = t.id;
    this.persist();
    return t;
  }

  task(key: string): Task {
    const id = this.vars[`task:${key}`];
    const t = typeof id === 'string' ? this.fm.tasks.get(id) : undefined;
    if (!t) throw new Error(`sim: task ${key} not created yet`);
    return t;
  }

  setTask(key: string, status: TaskStatus, opts: { reason?: string; summary?: string } = {}): Task {
    const t = this.task(key);
    if (t.status === status) return t;
    return this.fm.tasks.setStatus(t.id, status, { ...opts, force: true });
  }

  wt(taskKey: string): Worktree {
    const t = this.task(taskKey);
    if (!t.worktree) throw new Error(`sim: task ${taskKey} has no worktree`);
    return this.fm.repos.requireWorktree(this.repoId, t.worktree);
  }

  /** Assign + create the real worktree + move to doing. */
  async startTask(agentId: string, key: string): Promise<Worktree> {
    await this.gate(agentId);
    const t = this.task(key);
    this.fm.tasks.update(t.id, { assignee: agentId });
    const wt = await this.fm.repos.createWorktree(this.repoId, agentId, t);
    this.fm.tasks.update(t.id, { branch: wt.branch, worktree: wt.id });
    if (t.status === 'todo') this.fm.tasks.setStatus(t.id, 'doing', { force: true });
    this.fm.setAgent(agentId, { taskId: t.id, repoId: this.repoId, worktree: wt.id });
    this.act(agentId, 'running', 'terminal', `starting ${t.id}`);
    this.log(agentId, 'tool', `$ git worktree add -b ${wt.branch}`);
    this.log(agentId, 'result', `Preparing worktree (new branch '${wt.branch}') from ${wt.base}`);
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} started ${t.id}: ${t.title}`, { agentId });
    await this.sleep(700);
    return wt;
  }

  /** Worker finished a task: off to review. */
  finishTask(agentId: string, key: string, summary: string): void {
    const t = this.setTask(key, 'review', { summary });
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} finished ${t.id} -> review`, { agentId });
  }

  doneNoCode(key: string, summary: string): void {
    this.setTask(key, 'done', { summary });
  }

  memory(agentId: string, scope: string, title: string, body: string, mode: 'replace' | 'append' = 'replace', slug?: string): void {
    const e = this.fm.memory.write({ scope, title, body, author: agentId, mode, ...(slug ? { slug } : {}) });
    this.log(agentId, 'tool', `write_memory "${e.title}"`);
    this.fm.bus.feed('memory', `${this.fm.nameOf(agentId)} wrote memory: ${e.title}`, { agentId });
  }

  // ---- decisions ----------------------------------------------------------------------------

  openDecision(key: string, make: () => CreateDecisionInput): Decision {
    const id = this.vars[`dec:${key}`];
    const existing = typeof id === 'string' ? this.fm.decisions.get(id) : undefined;
    if (existing) {
      this.maybeAutoAnswer(existing, false);
      return existing;
    }
    const d = this.fm.createDecision(make());
    this.vars[`dec:${key}`] = d.id;
    this.persist();
    this.maybeAutoAnswer(d, false);
    return d;
  }

  /**
   * --auto-answer: answer every decision shortly after it opens.
   * Showcase fast-forward (instant): answer only decisions the script blocks on, so decisions
   * opened just before the checkpoint stay open in the static showcase state.
   */
  private maybeAutoAnswer(d: Decision, awaited: boolean): void {
    const auto = this.cfg.autoAnswer || (this.instant && awaited);
    if (d.status !== 'open' || !auto || this.autoAnswered.has(d.id)) return;
    this.autoAnswered.add(d.id);
    const delay = this.instant ? 0 : 1500 / this.cfg.speed;
    const attempt = (n: number) => {
      if (this.stopped || this.fm.decisions.get(d.id)?.status !== 'open') return;
      this.fm
        .answerDecision(d.id, 0)
        .then(() => {
          // a refused merge re-opens the decision: try again a few times
          if (this.fm.decisions.get(d.id)?.status === 'open' && n < 3) setTimeout(() => attempt(n + 1), 500 / this.cfg.speed).unref?.();
        })
        .catch((e) => this.fm.log.warn(`sim auto-answer ${d.id}: ${(e as Error).message}`));
    };
    setTimeout(() => attempt(1), delay).unref?.();
  }

  /** Block until the decision is answered (ambient chatter while waiting). */
  async awaitDecision(key: string): Promise<Decision> {
    const id = this.vars[`dec:${key}`];
    if (typeof id !== 'string') throw new Error(`sim: decision ${key} not opened`);
    let d = this.fm.decisions.get(id);
    if (!d) throw new Error(`sim: decision ${id} vanished`);
    // wait() also covers "answered but side effects (merge) still running"
    {
      this.maybeAutoAnswer(d, true);
      let settled = false;
      const wait = this.fm.decisions.wait(id).then((x) => {
        settled = true;
        return x;
      });
      const stop = new Promise<never>((_, reject) => this.abort.signal.addEventListener('abort', () => reject(new Stopped()), { once: true }));
      const ambient = (async () => {
        let n = 0;
        const wasOpen = d.status === 'open';
        while (wasOpen && !settled && !this.stopped && this.cfg.ambient && !this.instant && n < 12) {
          await new Promise((r) => setTimeout(r, (6000 + this.random() * 5000) / this.cfg.speed));
          if (settled || this.stopped) break;
          const working = this.fm.agents().filter((a) => a.active && ['reading', 'editing', 'testing', 'thinking'].includes(a.state));
          const a = working[Math.floor(this.random() * working.length)];
          const lines = a ? AMBIENT[a.id] : undefined;
          if (a && lines) this.log(a.id, 'text', lines[Math.floor(this.random() * lines.length)]!);
          n++;
        }
      })();
      d = await Promise.race([wait, stop]);
      void ambient;
    }
    return d;
  }

  async decide(key: string, make: () => CreateDecisionInput): Promise<Decision> {
    this.openDecision(key, make);
    return this.awaitDecision(key);
  }

  /** Reviewer looks at the real diff, lead opens a merge decision for the user. */
  async requestMerge(taskKey: string, round: number, review: string): Promise<Decision> {
    const t = this.task(taskKey);
    const wt = this.wt(taskKey);
    const key = `merge:${taskKey}:${round}`;
    if (typeof this.vars[`dec:${key}`] !== 'string') {
      await this.gate('rowan');
      this.act('rowan', 'reading', 'mergestation', `reviewing ${wt.id}`);
      this.log('rowan', 'tool', `diff ${wt.branch}`);
      const diff = await this.fm.repos.diff(this.repoId, wt.id);
      await this.sleep(900);
      this.log('rowan', 'result', `${diff.stats.files} files, +${diff.stats.additions} -${diff.stats.deletions}: ${diff.files.map((f) => f.path).join(', ')}`);
      await this.sleep(1100);
      this.say('rowan', 'marlow', review);
      await this.sleep(700);
      await this.gate('marlow');
      this.act('marlow', 'thinking', 'mergestation', `preparing review of ${t.id}`);
      this.log('marlow', 'tool', `request_merge ${t.id}`);
      await this.sleep(600);
      const stats = `${diff.stats.files} file${diff.stats.files === 1 ? '' : 's'}, +${diff.stats.additions} -${diff.stats.deletions}`;
      this.openDecision(key, () => ({
        agentId: 'marlow',
        kind: 'merge',
        question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
        options: [...MERGE_OPTIONS],
        context: `${t.summary ?? ''}\n${stats} | tests: ${t.ci}\nReviewed by Rowan: ${review}`.trim(),
        taskId: t.id,
        repoId: this.repoId,
        worktree: wt.id,
      }));
      this.act('marlow', 'idle', 'mergestation', `awaiting your review of ${t.id}`);
    }
    return this.fm.decisions.get(this.vars[`dec:${key}`] as string)!;
  }

  /**
   * Wait for the merge decision; handle "Request changes" (worker revises, new round) and
   * "Reject". Returns the final outcome.
   */
  async settleMerge(taskKey: string, worker: string, mainFile: string): Promise<'merged' | 'rejected'> {
    for (let round = 1; round <= 5; round++) {
      const key = `merge:${taskKey}:${round}`;
      if (typeof this.vars[`dec:${key}`] !== 'string') await this.requestMerge(taskKey, round, 'Changes addressed; re-reviewed. Looks good.');
      const d = await this.awaitDecision(key);
      const t = this.task(taskKey);
      if (d.answer?.option === 'Merge' && t.status === 'done') {
        this.say('marlow', worker, `Merged ${t.id} into main. Nice work.`);
        this.act(worker, 'idle', 'lounge', `${t.id} merged`);
        this.fm.setAgent(worker, { taskId: null, worktree: null });
        await this.sleep(800);
        return 'merged';
      }
      if (d.answer?.option === 'Reject' || d.status === 'cancelled') {
        this.say('marlow', 'all', `${userName()} rejected ${t.id}. I'll stop the work that depends on it.`);
        this.act(worker, 'idle', 'lounge', `${t.id} rejected`);
        this.fm.setAgent(worker, { taskId: null, worktree: null });
        this.vars.rejected = true;
        this.persist();
        return 'rejected';
      }
      // Request changes
      const note = d.answer?.text ?? 'please tidy this up';
      this.say('marlow', worker, `${userName()} asked for changes on ${t.id}: "${note}"`);
      await this.sleep(800);
      const wt = this.wt(taskKey);
      await this.think(worker, `Addressing review feedback: ${note}`, 'desk');
      await this.reviewNote(worker, wt.path, mainFile, note, round);
      await this.runTests(worker, { taskKey, worktree: wt });
      await this.commit(worker, taskKey, `Address review (round ${round})`);
      this.setTask(taskKey, 'review', { summary: `${t.summary ?? ''} (revised: ${note})`.trim() });
      this.say(worker, 'marlow', `Done, ${t.id} is ready for another look.`);
    }
    return 'merged';
  }
}
