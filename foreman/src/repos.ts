// RepoManager: registered local git repos, per-worker worktrees, structured diffs, guarded merges.
//
// Safety contract
//  - never pushes (there is no code path that runs `git push`)
//  - worktrees live under <profile>/worktrees, on branches agentcraft/<agent>/<task-slug>
//  - the user's checkout is only ever modified by merge(), which requires an answered `merge`
//    decision whose option is "Merge" and refuses if the merge would conflict or if the checkout
//    that has the base branch checked out has uncommitted tracked changes
//  - the merge commit is built off-tree (merge-tree + commit-tree) and then applied with
//    `merge --ff-only`, so a refused/failed apply leaves the user's working tree untouched
//  - the merge commit is the user's: their git identity, signed if their git config signs
//    (unless signMerges is off); mergeStyle "squash" makes it a single-parent commit
//  - removing a finished worktree's directory never fails an operation (busy dirs are retried
//    later) and never deletes anything outside the worktree root
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from './context.js';
import { parseUnifiedDiff, type ParsedDiff } from './diff.js';
import type { CiStatus, Decision, Repo, Worktree } from './protocol.js';
import { withGitSafety } from './gitsafety.js';
import { ensureDir, isInsideOrEqual } from './util/fsx.js';
import { agentGitIdentity, git, gitConfigGet, gitOut, identityEnv, listWorktrees } from './util/git.js';
import { runShell } from './util/proc.js';
import { slugify, tailLines } from './util/text.js';

export class RepoError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'not_git' | 'no_commits' | 'refused' | 'conflict' | 'dirty' | 'empty' | 'failed' = 'failed',
    /** code 'conflict': the files that would conflict */
    readonly files: string[] = [],
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface DiffResult extends ParsedDiff {
  repoId: string;
  worktree: string;
  base: string;
  branch: string;
}

export interface MergeResult {
  sha: string;
  base: string;
  branch: string;
  files: number;
}

export interface TestResult {
  pass: boolean;
  code: number;
  command: string;
  output: string; // tail
  durationMs: number;
  /** names of failing tests (TAP "not ok" lines / common runner formats), from the full output */
  failures: string[];
  /** e.g. "tests 15, pass 12, fail 3" when the runner prints a summary */
  summary?: string;
}

/**
 * Pull failing test names and a summary line out of common test-runner output: TAP, and the spec
 * reporter `node --test` uses by default on newer Node versions ("ℹ tests 15", "✖ name (1.2ms)").
 */
export function parseTestOutput(text: string): { failures: string[]; summary?: string } {
  const failures: string[] = [];
  for (const m of text.matchAll(/^not ok \d+ - (.+)$/gm)) failures.push(m[1]!.replace(/\\#/g, '#').replace(/\s+#\s*(TODO|SKIP).*$/i, '').trim());
  if (!failures.length) {
    for (const m of text.matchAll(/^\s*(?:✖|×|FAIL)\s+(.+)$/gm)) {
      const name = m[1]!.replace(/\s+\(\d+(?:\.\d+)?m?s\)$/, '').trim();
      if (!/^failing tests:?$/i.test(name)) failures.push(name);
    }
  }
  const nums: string[] = [];
  for (const k of ['tests', 'pass', 'fail']) {
    const m = new RegExp(`^(?:#|ℹ) ${k} (\\d+)$`, 'm').exec(text);
    if (m) nums.push(`${k} ${m[1]}`);
  }
  return { failures: [...new Set(failures)].slice(0, 20), ...(nums.length ? { summary: nums.join(', ') } : {}) };
}

export const BRANCH_PREFIX = 'agentcraft/';

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'by', 'at', 'from']);

/** "Tag parser module (src/tags.ts)" -> "tag-parser-module": drop parentheticals, cut at a word boundary. */
export function branchSlug(title: string, max = 24): string {
  const base = slugify(title.replace(/\([^)]*\)/g, ' ').replace(/`/g, ''), 64);
  let out = base;
  if (base.length > max) {
    const cut = base.slice(0, max + 1);
    const i = cut.lastIndexOf('-');
    out = (i >= 8 ? cut.slice(0, i) : base.slice(0, max)).replace(/-+$/, '');
  }
  // drop dangling stop words ("readme-help-text-for" -> "readme-help-text")
  const parts = out.split('-');
  while (parts.length > 1 && STOP_WORDS.has(parts[parts.length - 1]!)) parts.pop();
  return parts.join('-');
}

const agentIdentity = agentGitIdentity;
const TAMPERED = 'AgentCraft will not run git in worktree';

/** Real path (8.3 names, links, case) when it exists, else the resolved path. */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = (p: string) => {
    const r = realPath(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase().replace(/\//g, '\\') : r;
  };
  return n(a) === n(b);
}

export interface RepoOptions {
  /** merge: a merge commit that keeps the agents' commits; squash: one commit with the changes */
  mergeStyle?: 'merge' | 'squash';
  /** sign the approved merge commit if the repo's git config says commit.gpgsign=true */
  signMerges?: boolean;
}

/** the user's git identity as their own git sees it in that repo (falls back to AgentCraft). */
async function userIdentity(repoPath: string): Promise<{ env: NodeJS.ProcessEnv; who: string }> {
  const name = await gitConfigGet(repoPath, 'user.name');
  const email = await gitConfigGet(repoPath, 'user.email');
  if (name && email) return { env: identityEnv(name, email), who: `${name} <${email}>` };
  return { env: agentIdentity('user'), who: 'AgentCraft <user@agentcraft.local>' };
}

export class RepoManager {
  readonly worktreeRoot: string;
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  /** per-repo queue: merges / worktree add+remove never run concurrently on one repo */
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private ctx: Ctx,
    worktreeRoot: string,
    private opts: RepoOptions = {},
  ) {
    this.worktreeRoot = ensureDir(worktreeRoot);
  }

  private serial<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(repoId, settled);
    void settled.then(() => {
      if (this.locks.get(repoId) === settled) this.locks.delete(repoId);
    });
    return next;
  }

  private get repos(): Repo[] {
    return this.ctx.store.data.repos;
  }

  list(): Repo[] {
    return this.repos;
  }

  get(id: string): Repo | undefined {
    return this.repos.find((r) => r.id === id);
  }

  require(id: string): Repo {
    const r = this.get(id);
    if (!r) throw new RepoError(`no repo ${id}`, 'not_found');
    return r;
  }

  /** Default repo for goals without an explicit repoId: the most recently added. */
  defaultRepo(): Repo | undefined {
    return this.repos[this.repos.length - 1];
  }

  findWorktree(repoId: string, worktreeOrAgent: string): Worktree | undefined {
    const r = this.get(repoId);
    if (!r) return undefined;
    return (
      r.worktrees.find((w) => w.id === worktreeOrAgent) ??
      r.worktrees.find((w) => w.branch === worktreeOrAgent) ??
      [...r.worktrees].reverse().find((w) => w.agentId === worktreeOrAgent && w.status === 'active') ??
      [...r.worktrees].reverse().find((w) => w.agentId === worktreeOrAgent)
    );
  }

  requireWorktree(repoId: string, wt: string): Worktree {
    const w = this.findWorktree(repoId, wt);
    if (!w) throw new RepoError(`no worktree ${wt} in ${repoId}`, 'not_found');
    return w;
  }

  /** Register a local git repo (idempotent by path). */
  async add(p: string): Promise<Repo> {
    const abs = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fs.existsSync(abs)) throw new RepoError(`path does not exist: ${abs}`, 'not_found');
    const top = await git(abs, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (top.code !== 0) throw new RepoError(`not a git repository: ${abs}`, 'not_git');
    const root = path.resolve(top.stdout.trim());
    // a folder inside some other repository is not that repository: registering the enclosing
    // repo silently would make it the merge target (e.g. a new folder under a project)
    const real = (p: string) => {
      try {
        return path.resolve(fs.realpathSync.native(p)).toLowerCase();
      } catch {
        return path.resolve(p).toLowerCase();
      }
    };
    if (real(abs) !== real(root)) {
      throw new RepoError(`${abs} is not a repository root: it is inside the git repository ${root}. Add the repository itself (/repo add ${root}) or run \`git init\` in ${abs} first.`, 'not_git');
    }
    const existing = this.repos.find((r) => path.resolve(r.path).toLowerCase() === root.toLowerCase());
    if (existing) {
      await this.refresh(existing.id);
      return existing;
    }
    const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    if (head.code !== 0) throw new RepoError(`repository has no commits yet: ${root}`, 'no_commits');
    const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })).stdout.trim();
    if (!branch) throw new RepoError(`repository is in detached HEAD state; check out a branch first: ${root}`, 'refused');
    let id = slugify(path.basename(root), 24);
    for (let i = 2; this.get(id); i++) id = `${slugify(path.basename(root), 20)}-${i}`;
    const repo: Repo = { id, name: path.basename(root), path: root, branch, dirty: false, worktrees: [], ci: 'unknown' };
    this.repos.push(repo);
    await this.refresh(id);
    return repo;
  }

  private emitRepo(r: Repo): void {
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'repo.upsert', repo: { ...r, worktrees: r.worktrees.map((w) => ({ ...w })) } });
  }

  setCi(repoId: string, ci: CiStatus): void {
    const r = this.require(repoId);
    if (r.ci === ci) return;
    r.ci = ci;
    this.emitRepo(r);
  }

  /** Update head/dirty and worktree stats, then broadcast. */
  async refresh(repoId: string): Promise<Repo> {
    const r = this.require(repoId);
    const h = await git(r.path, ['rev-parse', '--short', `refs/heads/${r.branch}`], { allowFail: true });
    if (h.code === 0) r.head = h.stdout.trim();
    r.dirty = await this.isDirty(r.path);
    for (const w of r.worktrees) {
      if (w.status !== 'active') continue;
      try {
        await this.updateWorktreeStats(r, w);
      } catch (e) {
        this.ctx.log.warn(`refresh ${w.id}: ${(e as Error).message}`);
      }
    }
    this.emitRepo(r);
    return r;
  }

  /**
   * Cheap check of the main checkout (head + dirty) that broadcasts only when something changed,
   * so `repo.dirty` follows the user's own edits even when no agent touches the repo.
   */
  async pollStatus(repoId: string): Promise<boolean> {
    const r = this.get(repoId);
    if (!r || !fs.existsSync(r.path)) return false;
    const h = await git(r.path, ['rev-parse', '--short', `refs/heads/${r.branch}`], { allowFail: true });
    const head = h.code === 0 ? h.stdout.trim() : r.head;
    const dirty = await this.isDirty(r.path);
    if (head === r.head && dirty === r.dirty) return false;
    if (head) r.head = head;
    r.dirty = dirty;
    this.emitRepo(r);
    return true;
  }

  private pollTimer: NodeJS.Timeout | undefined;

  startPolling(intervalMs = 10_000): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      for (const r of this.repos) this.pollStatus(r.id).catch((e) => this.ctx.log.debug(`poll ${r.id}: ${(e as Error).message}`));
      this.sweepPendingRemovals().catch((e) => this.ctx.log.debug(`sweep: ${(e as Error).message}`));
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
  }

  /** Coalesce frequent refresh requests (e.g. after every agent edit). */
  scheduleRefresh(repoId: string, delayMs = 400): void {
    if (this.refreshTimers.has(repoId)) return;
    const t = setTimeout(() => {
      this.refreshTimers.delete(repoId);
      this.refresh(repoId).catch((e) => this.ctx.log.warn(`refresh ${repoId}: ${(e as Error).message}`));
    }, delayMs);
    t.unref?.();
    this.refreshTimers.set(repoId, t);
  }

  /** Tracked changes (staged or unstaged) in a checkout. Untracked files do not count. */
  async isDirty(checkout: string): Promise<boolean> {
    const s = await git(checkout, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true });
    return s.code !== 0 || s.stdout.trim().length > 0;
  }

  branchName(agentId: string, taskId: string, title: string): string {
    return `${BRANCH_PREFIX}${agentId}/${taskId}-${branchSlug(title)}`;
  }

  /**
   * Create (or reuse) the worktree for agent+task. New branches start from the repo's base branch.
   * Returns the existing active worktree if one already exists for that task.
   */
  createWorktree(repoId: string, agentId: string, task: { id: string; title: string }, opts: { startPoint?: string } = {}): Promise<Worktree> {
    return this.serial(repoId, () => this.doCreateWorktree(repoId, agentId, task, opts.startPoint));
  }

  /**
   * `startPoint`: continue from another branch (a task handed over from a stopped/reassigned
   * worker) instead of the base branch. An existing branch of this agent is only moved forward
   * to it (never rewound); if the histories diverged a fresh branch name is used instead.
   */
  private async doCreateWorktree(repoId: string, agentId: string, task: { id: string; title: string }, startPoint?: string): Promise<Worktree> {
    const r = this.require(repoId);
    const id = `${agentId}-${task.id}`;
    const existing = r.worktrees.find((w) => w.id === id);
    if (existing && existing.status === 'active' && fs.existsSync(existing.path)) return existing;
    let branch = existing?.branch ?? this.branchName(agentId, task.id, task.title);
    let wtPath = path.join(this.worktreeRoot, r.id, id);
    ensureDir(path.dirname(wtPath));
    await git(r.path, ['worktree', 'prune'], { allowFail: true });
    const known = async (p: string) => (await listWorktrees(r.path)).some((e) => path.resolve(e.path).toLowerCase() === path.resolve(p).toLowerCase());
    if (fs.existsSync(wtPath) && !(await known(wtPath))) {
      // stale directory (crash, or still busy when it was abandoned): remove it, or if something
      // still holds it, use a fresh directory next to it
      try {
        fs.rmSync(wtPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (e) {
        let n = 2;
        while (fs.existsSync(`${wtPath}-${n}`) && n < 50) n++;
        this.ctx.log.warn(`${wtPath} is busy (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); using ${wtPath}-${n}`);
        wtPath = `${wtPath}-${n}`;
      }
    }
    if (!fs.existsSync(wtPath)) {
      const exists = async (b: string) => (await git(r.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true })).code === 0;
      let branchExists = await exists(branch);
      if (startPoint && branchExists && branch !== startPoint) {
        const ancestor = (await git(r.path, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, startPoint], { allowFail: true })).code === 0;
        if (ancestor) {
          await git(r.path, ['branch', '-f', branch, startPoint]); // fast-forward only: nothing is lost
        } else {
          let n = 2;
          while (await exists(`${branch}-${n}`)) if (++n > 50) throw new RepoError(`no free branch name for ${branch}`);
          branch = `${branch}-${n}`;
          branchExists = false;
        }
      }
      // agent worktrees hold the repository's bytes as committed (no CRLF conversion), so agents,
      // their edits and the Foreman's diffs all see the same content
      const lf = ['-c', 'core.autocrlf=false'];
      if (branchExists) await git(r.path, [...lf, 'worktree', 'add', wtPath, branch]);
      else await git(r.path, [...lf, 'worktree', 'add', '-b', branch, wtPath, startPoint ?? r.branch]);
    }
    const w: Worktree = {
      id,
      agentId,
      taskId: task.id,
      branch,
      base: r.branch,
      path: wtPath,
      status: 'active',
      ahead: 0,
      files: 0,
      additions: 0,
      deletions: 0,
    };
    if (existing) Object.assign(existing, w);
    else r.worktrees.push(w);
    this.ctx.store.data.worktreeMeta[`${r.id}/${id}`] ??= { createdAt: this.ctx.now() };
    await this.updateWorktreeStats(r, existing ?? w);
    this.emitRepo(r);
    return existing ?? w;
  }

  private async updateWorktreeStats(r: Repo, w: Worktree): Promise<void> {
    if (!fs.existsSync(w.path)) return;
    const ahead = await git(w.path, ['rev-list', '--count', `${w.base}..HEAD`], { allowFail: true });
    w.ahead = ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
    const d = await this.rawWorkingDiff(r, w, ['--numstat']);
    let files = 0;
    let add = 0;
    let del = 0;
    for (const line of d.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files++;
      add += m[1] === '-' ? 0 : Number(m[1]);
      del += m[2] === '-' ? 0 : Number(m[2]);
    }
    w.files = files;
    w.additions = add;
    w.deletions = del;
  }

  /**
   * Diff of the worktree's working tree (including uncommitted + untracked files, respecting
   * .gitignore) against merge-base(base, HEAD). Uses a throwaway index so the agent's own index
   * is untouched.
   */
  private async rawWorkingDiff(_r: Repo, w: Worktree, extra: string[]): Promise<string> {
    const mb = await gitOut(w.path, ['merge-base', w.base, 'HEAD']);
    const tmpIndex = path.join(os.tmpdir(), `agentcraft-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await git(w.path, ['read-tree', 'HEAD'], { env });
      await git(w.path, ['add', '-A'], { env });
      const res = await git(w.path, ['diff', '--cached', '-M', '--no-ext-diff', '--unified=3', ...extra, mb], { env });
      return res.stdout;
    } finally {
      fs.rmSync(tmpIndex, { force: true });
      fs.rmSync(`${tmpIndex}.lock`, { force: true });
    }
  }

  async diff(repoId: string, worktreeId: string): Promise<DiffResult> {
    const r = this.require(repoId);
    const w = this.requireWorktree(repoId, worktreeId);
    let text: string;
    if (w.status === 'active' && fs.existsSync(w.path)) {
      const v = await this.verifyWorktreeGit(r, w);
      if (!v.ok) throw new RepoError(`cannot show the diff of ${w.id}: ${v.reason}`, 'refused');
      text = await this.rawWorkingDiff(r, w, []);
    } else {
      const meta = this.ctx.store.data.worktreeMeta[`${r.id}/${w.id}`];
      const from = meta?.mergedBaseSha ?? (await gitOut(r.path, ['merge-base', w.base, w.branch]));
      text = (await git(r.path, ['diff', '-M', '--no-ext-diff', '--unified=3', from, w.branch])).stdout;
    }
    const parsed = parseUnifiedDiff(text);
    return { ...parsed, repoId: r.id, worktree: w.id, base: w.base, branch: w.branch };
  }

  /**
   * Is the worktree's git still this repository's worktree at w.path? An agent can rewrite the
   * `.git` link file (to the user's checkout, another worktree or another repo) or delete it (git
   * then walks up to an enclosing repository). Checked before the Foreman writes with git in a
   * worktree (commits) or shows its diff for review. `head` is the symbolic ref HEAD points at.
   */
  async verifyWorktreeGit(r: Repo, w: Worktree): Promise<{ ok: true; head: string; gitDir: string; commonDir: string } | { ok: false; reason: string }> {
    if (!fs.existsSync(w.path)) return { ok: false, reason: `${w.path} does not exist` };
    const res = await git(w.path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { allowFail: true });
    if (res.code !== 0) return { ok: false, reason: `git finds no repository at ${w.path} (its .git link is missing or broken)` };
    const [gitDir = '', commonDir = '', top = ''] = res.stdout.trim().split(/\r?\n/);
    const repoCommon = (await git(r.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true })).stdout.trim();
    if (!samePath(top, w.path)) return { ok: false, reason: `git in ${w.path} works on ${top} instead (its .git link was removed or changed)` };
    if (!repoCommon || !samePath(commonDir, repoCommon)) return { ok: false, reason: `${w.path} now belongs to another repository (${commonDir})` };
    if (samePath(gitDir, commonDir) || !isInsideOrEqual(realPath(gitDir), realPath(path.join(repoCommon, 'worktrees')))) {
      return { ok: false, reason: `${w.path}/.git points at ${gitDir}, not at the worktree's own entry` };
    }
    let back = '';
    try {
      back = fs.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
    } catch {
      /* checked below */
    }
    if (!back || !samePath(path.dirname(back), w.path)) return { ok: false, reason: `${w.path}/.git points at the worktree entry of ${back ? path.dirname(back) : 'another directory'}` };
    const head = (await git(w.path, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })).stdout.trim();
    return { ok: true, head, gitDir: path.resolve(gitDir), commonDir: path.resolve(commonDir) };
  }

  /**
   * Commit everything in the worktree (agent identity) on the agent's own branch. Returns true if
   * a commit was made. Only ever moves refs/heads/agentcraft/...: if the agent left HEAD on
   * another branch or a detached commit, the working tree is snapshotted onto its own branch
   * without touching HEAD's branch. Refuses if the worktree's .git link was tampered with.
   */
  async commitAll(repoId: string, worktreeId: string, message: string): Promise<boolean> {
    const r = this.require(repoId);
    const w = this.requireWorktree(repoId, worktreeId);
    if (w.status !== 'active') return false;
    if (!w.branch.startsWith(BRANCH_PREFIX)) throw new RepoError(`refusing to commit on ${w.branch}: not an AgentCraft branch`, 'refused');
    const v = await this.verifyWorktreeGit(r, w);
    if (!v.ok) throw new RepoError(`${TAMPERED} ${w.id}: ${v.reason}`, 'refused');
    const ref = `refs/heads/${w.branch}`;
    const identity = agentIdentity(w.agentId);
    if (v.head === ref) {
      await git(w.path, ['add', '-A']);
      const st = await git(w.path, ['diff', '--cached', '--quiet'], { allowFail: true });
      if (st.code === 0) return false;
      await git(w.path, ['commit', '-q', '--no-verify', '-m', message], { env: identity });
      return true;
    }
    // HEAD is elsewhere: commit a snapshot of the working tree onto the agent's branch
    this.ctx.log.warn(`worktree ${w.id} is on ${v.head || 'a detached HEAD'}, not ${w.branch}: committing a snapshot onto ${w.branch}`);
    const tmpIndex = path.join(os.tmpdir(), `agentcraft-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await git(w.path, ['read-tree', ref], { env });
      await git(w.path, ['add', '-A'], { env });
      const tree = await gitOut(w.path, ['write-tree'], { env });
      const tip = await gitOut(w.path, ['rev-parse', ref]);
      if (tree === (await gitOut(w.path, ['rev-parse', `${tip}^{tree}`]))) return false;
      const sha = await gitOut(w.path, ['commit-tree', tree, '-p', tip, '-m', `${message}\n\n(snapshot of the working tree; HEAD was on ${v.head || 'a detached commit'})`], { env: identity });
      await git(w.path, ['update-ref', ref, sha, tip]);
      return true;
    } finally {
      fs.rmSync(tmpIndex, { force: true });
      fs.rmSync(`${tmpIndex}.lock`, { force: true });
    }
  }

  /** Where (if anywhere) a branch is checked out. */
  private async checkoutOf(r: Repo, branch: string): Promise<string | undefined> {
    const list = await listWorktrees(r.path);
    return list.find((e) => e.branch === branch)?.path;
  }

  /** Check a merge without performing it. */
  async canMerge(repoId: string, worktreeId: string): Promise<{ ok: true } | { ok: false; reason: string; code: RepoError['code']; files?: string[] }> {
    const r = this.require(repoId);
    const w = this.requireWorktree(repoId, worktreeId);
    if (w.status !== 'active') return { ok: false, reason: `worktree ${w.id} is ${w.status}`, code: 'refused' };
    const target = await this.checkoutOf(r, w.base);
    if (target && (await this.isDirty(target))) {
      return { ok: false, reason: `the checkout at ${target} (${w.base}) has uncommitted changes — commit or stash them, then approve again`, code: 'dirty' };
    }
    const mt = await git(r.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', w.base, w.branch], { allowFail: true });
    if (mt.code === 1) {
      const files = mt.stdout.trim().split('\n').slice(1).filter(Boolean);
      return { ok: false, reason: `merge would conflict in: ${files.join(', ') || '(unknown files)'}`, code: 'conflict', files };
    }
    if (mt.code !== 0) return { ok: false, reason: `merge-tree failed: ${mt.stderr.trim()}`, code: 'failed' };
    return { ok: true };
  }

  /**
   * Merge a worker branch into the repo's base branch. ONLY with an answered merge decision whose
   * option is "Merge" and that targets this worktree.
   */
  /** `commitMessage` is used if the agent left uncommitted work (e.g. "t1: Add --version flag"). */
  merge(decision: Decision, opts: { commitMessage?: string } = {}): Promise<MergeResult> {
    return this.serial(decision.repoId ?? '?', () => this.doMerge(decision, opts.commitMessage));
  }

  private async doMerge(decision: Decision, commitMessage?: string): Promise<MergeResult> {
    if (decision.kind !== 'merge') throw new RepoError('merge requires a merge decision', 'refused');
    if (decision.status !== 'answered' || decision.answer?.option !== 'Merge') {
      throw new RepoError(`decision ${decision.id} does not approve a merge`, 'refused');
    }
    if (!decision.repoId || !decision.worktree) throw new RepoError(`decision ${decision.id} names no repo/worktree`, 'refused');
    const r = this.require(decision.repoId);
    const w = this.requireWorktree(r.id, decision.worktree);
    if (w.id !== decision.worktree) throw new RepoError(`decision ${decision.id} targets ${decision.worktree}, not ${w.id}`, 'refused');
    if (w.status !== 'active') throw new RepoError(`worktree ${w.id} is ${w.status}`, 'refused');

    // 1. make sure the agent's work is committed on its branch
    await this.commitAll(r.id, w.id, commitMessage ?? `agentcraft: ${w.taskId ?? w.id}`);
    const ahead = Number(await gitOut(r.path, ['rev-list', '--count', `${w.base}..${w.branch}`]));
    if (!ahead) throw new RepoError(`${w.branch} has no changes to merge`, 'empty');

    // 2. safety checks: conflicts + dirty target checkout
    const check = await this.canMerge(r.id, w.id);
    if (!check.ok) throw new RepoError(check.reason, check.code, check.files);

    // 3. build the merge commit off-tree, as the user (they approved it): their git identity, and
    //    signed if his git config signs commits (commit-tree ignores commit.gpgsign by itself)
    const baseSha = await gitOut(r.path, ['rev-parse', `refs/heads/${w.base}`]);
    const branchSha = await gitOut(r.path, ['rev-parse', `refs/heads/${w.branch}`]);
    const tree = (await gitOut(r.path, ['merge-tree', '--write-tree', '--no-messages', w.base, w.branch])).split('\n')[0]!.trim();
    const approved = `Approved in AgentCraft (decision ${decision.id}${w.taskId ? `, task ${w.taskId}` : ''}).`;
    const squash = this.opts.mergeStyle === 'squash';
    let msg: string;
    if (squash) {
      const authors = [...new Set((await gitOut(r.path, ['log', '--format=%an <%ae>', `${baseSha}..${branchSha}`])).split('\n').filter(Boolean))];
      msg = `${(commitMessage ?? `agentcraft: ${w.taskId ?? w.id}`).trim()}\n\nSquashed from ${w.branch}. ${approved}${authors.length ? `\n\n${authors.map((a) => `Co-authored-by: ${a}`).join('\n')}` : ''}`;
    } else msg = `Merge ${w.branch} into ${w.base}\n\n${approved}`;
    const sign = !!this.opts.signMerges && (await gitConfigGet(r.path, 'commit.gpgsign', 'bool')) === 'true';
    const { env } = await userIdentity(r.path);
    const parents = squash ? ['-p', baseSha] : ['-p', baseSha, '-p', branchSha];
    const ct = await git(r.path, ['commit-tree', ...(sign ? ['-S'] : []), tree, ...parents, '-m', msg], { env, allowFail: true, timeoutMs: 120_000 });
    if (ct.code !== 0) {
      const why = (ct.stderr || ct.stdout).trim().split('\n').slice(-2).join(' ');
      throw new RepoError(sign ? `signing the merge commit failed (your git config has commit.gpgsign=true): ${why}` : `could not create the merge commit: ${why}`, 'failed');
    }
    const mergeSha = ct.stdout.trim();

    // 4. apply: fast-forward the checkout that has base checked out, or move the ref if none does
    const target = await this.checkoutOf(r, w.base);
    if (target) {
      const ff = await git(target, ['merge', '--ff-only', '-q', mergeSha], { allowFail: true });
      if (ff.code !== 0) {
        throw new RepoError(`could not update ${target}: ${(ff.stderr || ff.stdout).trim().split('\n').slice(-2).join(' ')}`, 'refused');
      }
    } else {
      await git(r.path, ['update-ref', `refs/heads/${w.base}`, mergeSha, baseSha]);
    }

    // 5. bookkeeping: keep the branch (no data loss); remove the worktree directory
    const files = Number((await gitOut(r.path, ['diff', '--name-only', baseSha, mergeSha])).split('\n').filter(Boolean).length);
    // fork point of the branch, so the merged diff shows exactly the branch's own changes
    const forkPoint = await gitOut(r.path, ['merge-base', baseSha, branchSha]);
    this.ctx.store.data.worktreeMeta[`${r.id}/${w.id}`] = {
      ...(this.ctx.store.data.worktreeMeta[`${r.id}/${w.id}`] ?? { createdAt: this.ctx.now() }),
      mergedBaseSha: forkPoint,
      mergedSha: mergeSha,
    };
    w.status = 'merged';
    await this.removeWorktreeDir(r, w);
    await this.refresh(r.id);
    return { sha: mergeSha.slice(0, 7), base: w.base, branch: w.branch, files };
  }

  /**
   * Abandon a worktree (user rejected, or the task moved to another worker): uncommitted work is
   * committed on the branch, the directory removed, the branch kept.
   */
  abandon(repoId: string, worktreeId: string, message?: string): Promise<void> {
    return this.serial(repoId, () => this.doAbandon(repoId, worktreeId, message));
  }

  private async doAbandon(repoId: string, worktreeId: string, message?: string): Promise<void> {
    const r = this.require(repoId);
    const w = this.requireWorktree(repoId, worktreeId);
    if (w.status !== 'active') return;
    let tampered = false;
    await this.commitAll(r.id, w.id, message ?? `agentcraft: ${w.taskId ?? w.id} (abandoned)`).catch((e: Error) => {
      tampered = e instanceof RepoError && e.message.startsWith(TAMPERED);
      this.ctx.log.warn(`abandon ${w.id}: could not commit its work: ${e.message}`);
      return false;
    });
    w.status = 'abandoned';
    // a worktree whose .git was tampered with is left in place for the user to look at
    if (tampered) this.ctx.log.error(`worktree ${w.id}: left in place at ${w.path} (its git link was changed; nothing was committed)`);
    else await this.removeWorktreeDir(r, w);
    await this.refresh(r.id);
  }

  /**
   * Remove a finished worktree's directory. Never throws: on Windows a directory is "busy" while
   * any process still has it as its cwd (a stopped agent's CLI takes a moment to exit), so this
   * retries for a while and otherwise leaves it for the background sweep. The branch (the work)
   * is never touched. Only ever deletes inside our own worktree root.
   */
  private async removeWorktreeDir(r: Repo, w: Worktree, attempts = 6): Promise<boolean> {
    if (!isInsideOrEqual(w.path, this.worktreeRoot) || path.resolve(w.path) === path.resolve(this.worktreeRoot)) {
      this.ctx.log.error(`refusing to remove ${w.path}: not inside ${this.worktreeRoot}`);
      return false;
    }
    const key = `${r.id}/${w.id}`;
    let lastError = '';
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((res) => setTimeout(res, 250 * 2 ** Math.min(i - 1, 3)));
      if (fs.existsSync(w.path)) {
        const res = await git(r.path, ['worktree', 'remove', '--force', w.path], { allowFail: true });
        if (res.code !== 0 && fs.existsSync(w.path)) {
          try {
            fs.rmSync(w.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          } catch (e) {
            lastError = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
          }
        }
      }
      if (!fs.existsSync(w.path)) {
        await git(r.path, ['worktree', 'prune'], { allowFail: true });
        const meta = this.ctx.store.data.worktreeMeta[key];
        if (meta?.pendingRemoval) {
          delete meta.pendingRemoval;
          this.ctx.store.markDirty();
        }
        return true;
      }
    }
    const meta = (this.ctx.store.data.worktreeMeta[key] ??= { createdAt: this.ctx.now() });
    meta.pendingRemoval = true;
    this.ctx.store.markDirty();
    this.ctx.log.warn(`worktree dir ${w.path} is still in use (${lastError || 'busy'}); will remove it later (the branch ${w.branch} is kept)`);
    return false;
  }

  /** Retry removing directories of finished worktrees that were busy before (poll timer / start). */
  async sweepPendingRemovals(): Promise<number> {
    let n = 0;
    for (const r of this.repos) {
      for (const w of r.worktrees) {
        if (w.status === 'active' || !this.ctx.store.data.worktreeMeta[`${r.id}/${w.id}`]?.pendingRemoval) continue;
        if (await this.serial(r.id, () => this.removeWorktreeDir(r, w, 1))) n++;
      }
    }
    return n;
  }

  /** Commits on `branch` that `base` does not have (0 if the branch is gone). */
  async commitsAhead(repoId: string, branch: string, base: string): Promise<number> {
    const r = this.require(repoId);
    const res = await git(r.path, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${branch}`], { allowFail: true });
    return res.code === 0 ? Number(res.stdout.trim()) || 0 : 0;
  }

  /** Run the repo's test command in a worktree (or the main checkout). */
  async runTests(repoId: string, worktreeId?: string, command?: string, timeoutMs = 300_000): Promise<TestResult> {
    const r = this.require(repoId);
    const cwd = worktreeId ? this.requireWorktree(repoId, worktreeId).path : r.path;
    const cmd = command ?? this.detectTestCommand(cwd);
    if (!cmd) return { pass: true, code: 0, command: '(none)', output: 'no test command found', durationMs: 0, failures: [] };
    const t0 = Date.now();
    // the worktree's test scripts are agent-editable code: run them with git transports disabled
    // (a `git push` inside a test script fails) and kill the whole process tree on timeout
    const res = await runShell(cmd, { cwd, timeoutMs, env: withGitSafety(process.env, { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, { ceiling: path.dirname(path.resolve(cwd)) }) });
    const full = `${res.stdout}\n${res.stderr}${res.timedOut ? `\n(timed out after ${Math.round(timeoutMs / 1000)}s; process tree killed)` : ''}`;
    const output = tailLines(full, 40, 3000);
    return { pass: res.code === 0 && !res.timedOut, code: res.code, command: cmd, output, durationMs: Date.now() - t0, ...parseTestOutput(full) };
  }

  detectTestCommand(dir: string): string | undefined {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> };
        if (j.scripts?.test && !/no test specified/.test(j.scripts.test)) return 'npm test --silent';
      } catch {
        /* ignore */
      }
    }
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'cargo test';
    if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go test ./...';
    if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini'))) return 'python -m pytest -q';
    return undefined;
  }
}
