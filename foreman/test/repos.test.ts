import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Decision } from '../src/protocol.js';
import { MERGE_OPTIONS } from '../src/protocol.js';
import { parseTestOutput } from '../src/repos.js';
import { git, gitOut } from '../src/util/git.js';
import { demoRepo, makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
let home: string;
let repoPath: string;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  h = makeForeman(home, ['--backend', 'sim']);
});
afterAll(async () => {
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

function mergeDecision(repoId: string, worktree: string, taskId?: string): Decision {
  return h.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: `Merge ${worktree}?`, options: [...MERGE_OPTIONS], repoId, worktree, ...(taskId ? { taskId } : {}) });
}

describe('RepoManager', () => {
  it('registers a repo and refuses non-git paths', async () => {
    const r = await h.fm.repos.add(repoPath);
    expect(r.id).toBe('demo-app');
    expect(r.branch).toBe('main');
    expect(r.head).toMatch(/^[0-9a-f]{7}$/);
    expect(r.dirty).toBe(false);
    expect((await h.fm.repos.add(repoPath)).id).toBe('demo-app'); // idempotent
    const notGit = tempDir();
    await expect(h.fm.repos.add(notGit)).rejects.toThrow(/not a git repository/);
    await expect(h.fm.repos.add(path.join(notGit, 'missing'))).rejects.toThrow(/does not exist/);
    rmrf(notGit);
    // a folder inside a repo is refused instead of silently registering the enclosing repo
    const sub = path.join(repoPath, 'new-folder');
    fs.mkdirSync(sub, { recursive: true });
    await expect(h.fm.repos.add(sub)).rejects.toThrow(/not a repository root: it is inside the git repository/);
    await expect(h.fm.repos.add(path.join(repoPath, 'src'))).rejects.toThrow(/not a repository root/);
    fs.rmSync(sub, { recursive: true, force: true });
    expect(h.fm.repos.list().map((r) => r.id)).toEqual(['demo-app']);
  });

  it('creates a per-worker worktree on agentcraft/<agent>/<task-slug>', async () => {
    const t = h.fm.tasks.create({ title: 'Tag parser module (src/tags.ts)', createdBy: 'marlow', repoId: 'demo-app', assignee: 'kit' });
    const wt = await h.fm.repos.createWorktree('demo-app', 'kit', t);
    expect(wt.id).toBe(`kit-${t.id}`);
    expect(wt.branch).toBe(`agentcraft/kit/${t.id}-tag-parser-module`);
    expect(fs.existsSync(path.join(wt.path, 'src', 'cli.ts'))).toBe(true);
    expect(path.resolve(wt.path).startsWith(path.resolve(h.cfg.dataDir))).toBe(true);
    const again = await h.fm.repos.createWorktree('demo-app', 'kit', t);
    expect(again.path).toBe(wt.path);
    // the user's checkout is untouched
    expect(await gitOut(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect((await git(repoPath, ['status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('produces a structured diff incl. uncommitted and untracked files, without touching the agent index', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    fs.writeFileSync(path.join(wt.path, 'src', 'tags.ts'), 'export const TAG = 1;\nexport const OTHER = 2;\n');
    const notes = path.join(wt.path, 'src', 'notes.ts');
    fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace('  all?: boolean;', '  all?: boolean;\n  tag?: string;'));
    const d = await h.fm.repos.diff('demo-app', wt.id);
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(byPath['src/tags.ts']!.status).toBe('added');
    expect(byPath['src/tags.ts']!.additions).toBe(2);
    expect(byPath['src/notes.ts']!.status).toBe('modified');
    const hunk = byPath['src/notes.ts']!.hunks[0]!;
    expect(hunk.lines.some((l) => l.kind === 'add' && l.text === '  tag?: string;' && typeof l.newNo === 'number')).toBe(true);
    expect(hunk.lines.some((l) => l.kind === 'ctx' && typeof l.oldNo === 'number' && typeof l.newNo === 'number')).toBe(true);
    expect(d.stats).toEqual({ files: 2, additions: 3, deletions: 0 });
    // agent's own index untouched: the new file is still untracked
    expect((await git(wt.path, ['status', '--porcelain'])).stdout).toMatch(/\?\? src\/tags\.ts/);
    await h.fm.repos.refresh('demo-app');
    expect(h.fm.repos.findWorktree('demo-app', wt.id)!.files).toBe(2);
  });

  it('refuses to merge without an answered "Merge" decision for that worktree', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    const open = mergeDecision('demo-app', wt.id);
    await expect(h.fm.repos.merge(open)).rejects.toThrow(/does not approve/);
    const q = h.fm.createDecision({ agentId: 'marlow', kind: 'question', question: 'merge?', options: ['Merge'], repoId: 'demo-app', worktree: wt.id });
    h.fm.decisions.answer(q.id, 'Merge');
    await expect(h.fm.repos.merge(h.fm.decisions.get(q.id)!)).rejects.toThrow(/requires a merge decision/);
    const rej = mergeDecision('demo-app', wt.id);
    h.fm.decisions.answer(rej.id, 'Reject');
    await expect(h.fm.repos.merge(h.fm.decisions.get(rej.id)!)).rejects.toThrow(/does not approve/);
    const wrong = mergeDecision('demo-app', 'nobody-t99');
    h.fm.decisions.answer(wrong.id, 'Merge');
    await expect(h.fm.repos.merge(h.fm.decisions.get(wrong.id)!)).rejects.toThrow(/no worktree/);
    expect(await gitOut(repoPath, ['rev-list', '--count', 'main'])).toBe('4');
  });

  it('refuses to merge into a dirty checkout and leaves the user tree untouched', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    const readme = path.join(repoPath, 'README.md');
    const original = fs.readFileSync(readme, 'utf8');
    fs.writeFileSync(readme, original + '\nuser edit in progress\n');
    const headBefore = await gitOut(repoPath, ['rev-parse', 'HEAD']);
    const d = mergeDecision('demo-app', wt.id);
    h.fm.decisions.answer(d.id, 'Merge');
    await expect(h.fm.repos.merge(h.fm.decisions.get(d.id)!)).rejects.toThrow(/uncommitted changes/);
    expect(await gitOut(repoPath, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(fs.readFileSync(readme, 'utf8')).toContain('user edit in progress');
    fs.writeFileSync(readme, original);
  });

  it('refuses a conflicting merge', async () => {
    const t = h.fm.tasks.create({ title: 'Conflicting change', createdBy: 'marlow', repoId: 'demo-app', assignee: 'wren' });
    const wt = await h.fm.repos.createWorktree('demo-app', 'wren', t);
    const fmt = 'src/format.ts';
    const line = '// Human-friendly rendering of notes for the terminal.';
    fs.writeFileSync(path.join(wt.path, fmt), fs.readFileSync(path.join(wt.path, fmt), 'utf8').replace(line, '// Terminal rendering (agent version).'));
    // the user commits a different change to the same line on main
    fs.writeFileSync(path.join(repoPath, fmt), fs.readFileSync(path.join(repoPath, fmt), 'utf8').replace(line, '// Terminal rendering (user version).'));
    await git(repoPath, ['-c', 'user.name=U', '-c', 'user.email=u@x', 'commit', '-qam', 'user change']);
    const headBefore = await gitOut(repoPath, ['rev-parse', 'HEAD']);
    const d = mergeDecision('demo-app', wt.id);
    h.fm.decisions.answer(d.id, 'Merge');
    await expect(h.fm.repos.merge(h.fm.decisions.get(d.id)!)).rejects.toThrow(/conflict in: src\/format\.ts/);
    expect(await gitOut(repoPath, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect((await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()).toBe('');
  });

  it('merges an approved branch with a merge commit and keeps the branch + diff', async () => {
    const wt = h.fm.repos.findWorktree('demo-app', 'kit')!;
    const t = h.fm.tasks.get(wt.taskId!)!;
    h.fm.tasks.update(t.id, { worktree: wt.id });
    h.fm.tasks.setStatus(t.id, 'doing');
    h.fm.tasks.setStatus(t.id, 'review');
    const d = mergeDecision('demo-app', wt.id, t.id);
    // through the Foreman: answer -> merge -> task done
    await h.fm.answerDecision(d.id, 'Merge');
    expect(h.fm.tasks.get(t.id)!.status).toBe('done');
    const parents = (await gitOut(repoPath, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ');
    expect(parents).toHaveLength(3); // merge commit: self + 2 parents
    // made as the user (the repo's own git identity), not as a placeholder
    expect(await gitOut(repoPath, ['log', '-1', '--format=%an <%ae> | %cn <%ce>'])).toBe('Demo Author <demo@example.com> | Demo Author <demo@example.com>');
    expect(fs.readFileSync(path.join(repoPath, 'src', 'tags.ts'), 'utf8')).toContain('TAG = 1');
    expect((await git(repoPath, ['status', '--porcelain'])).stdout.trim()).toBe('');
    const merged = h.fm.repos.findWorktree('demo-app', wt.id)!;
    expect(merged.status).toBe('merged');
    expect(fs.existsSync(merged.path)).toBe(false);
    expect((await git(repoPath, ['rev-parse', '--verify', `refs/heads/${merged.branch}`], { allowFail: true })).code).toBe(0);
    const after = await h.fm.repos.diff('demo-app', wt.id);
    expect(after.files.map((f) => f.path).sort()).toEqual(['src/notes.ts', 'src/tags.ts']);
    // merging again is refused
    const again = mergeDecision('demo-app', wt.id);
    h.fm.decisions.answer(again.id, 'Merge');
    await expect(h.fm.repos.merge(h.fm.decisions.get(again.id)!)).rejects.toThrow(/merged/);
  });

  it('a refused merge re-opens the decision with the reason', async () => {
    const t = h.fm.tasks.create({ title: 'Docs tweak', createdBy: 'marlow', repoId: 'demo-app', assignee: 'tove' });
    const wt = await h.fm.repos.createWorktree('demo-app', 'tove', t);
    fs.writeFileSync(path.join(wt.path, 'NOTES.md'), 'hello\n');
    const readme = path.join(repoPath, 'README.md');
    const original = fs.readFileSync(readme, 'utf8');
    fs.writeFileSync(readme, original + 'dirty\n');
    const d = mergeDecision('demo-app', wt.id, t.id);
    const mark = h.events.length;
    await h.fm.answerDecision(d.id, 'Merge');
    const after = h.fm.decisions.get(d.id)!;
    expect(after.status).toBe('open');
    expect(after.context).toMatch(/Merge refused: .*uncommitted changes/);
    // the mod learns why: the repo is broadcast as dirty
    expect(h.events.slice(mark).some((e) => e.type === 'repo.upsert' && e.repo.id === 'demo-app' && e.repo.dirty)).toBe(true);
    fs.writeFileSync(readme, original);
    await h.fm.answerDecision(d.id, 'Merge');
    expect(h.fm.decisions.get(d.id)!.status).toBe('answered');
    expect(fs.existsSync(path.join(repoPath, 'NOTES.md'))).toBe(true);
  });

  it('when the user has another branch checked out, merges only move the base ref', async () => {
    await git(repoPath, ['checkout', '-q', '-b', 'user-feature']);
    fs.writeFileSync(path.join(repoPath, 'user.txt'), 'mine\n');
    const t = h.fm.tasks.create({ title: 'Small change', createdBy: 'marlow', repoId: 'demo-app', assignee: 'juniper' });
    const wt = await h.fm.repos.createWorktree('demo-app', 'juniper', t);
    fs.writeFileSync(path.join(wt.path, 'CHANGELOG.md'), '# 0.3.0\n');
    const mainBefore = await gitOut(repoPath, ['rev-parse', 'main']);
    const d = mergeDecision('demo-app', wt.id, t.id);
    await h.fm.answerDecision(d.id, 'Merge');
    expect(await gitOut(repoPath, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(await gitOut(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('user-feature');
    expect(fs.existsSync(path.join(repoPath, 'CHANGELOG.md'))).toBe(false); // user's tree untouched
    expect(fs.readFileSync(path.join(repoPath, 'user.txt'), 'utf8')).toBe('mine\n');
    await git(repoPath, ['checkout', '-q', 'main']);
  });

  it('polls the main checkout and broadcasts dirty/clean changes only when they happen', async () => {
    const readme = path.join(repoPath, 'README.md');
    const original = fs.readFileSync(readme, 'utf8');
    await h.fm.repos.pollStatus('demo-app');
    expect(await h.fm.repos.pollStatus('demo-app')).toBe(false); // nothing changed
    fs.writeFileSync(readme, original + '\nAlex is editing\n');
    expect(await h.fm.repos.pollStatus('demo-app')).toBe(true);
    expect(h.fm.repos.get('demo-app')!.dirty).toBe(true);
    fs.writeFileSync(readme, original);
    expect(await h.fm.repos.pollStatus('demo-app')).toBe(true);
    expect(h.fm.repos.get('demo-app')!.dirty).toBe(false);
  });

  it('a handed-over task continues from the previous branch (start point)', async () => {
    const t = h.fm.tasks.create({ title: 'Handed over', createdBy: 'marlow', repoId: 'demo-app', assignee: 'kit' });
    const first = await h.fm.repos.createWorktree('demo-app', 'kit', t);
    fs.writeFileSync(path.join(first.path, 'PARTIAL.md'), 'kit was here\n');
    await h.fm.repos.abandon('demo-app', first.id, `agentcraft: ${t.id} work in progress (handed to Rowan)`);
    const second = await h.fm.repos.createWorktree('demo-app', 'rowan', t, { startPoint: first.branch });
    expect(second.branch).toBe(`agentcraft/rowan/${t.id}-handed-over`);
    expect(fs.readFileSync(path.join(second.path, 'PARTIAL.md'), 'utf8')).toBe('kit was here\n');
    const d = await h.fm.repos.diff('demo-app', second.id);
    expect(d.files.map((f) => f.path)).toEqual(['PARTIAL.md']);
  });

  it('respects the checkout\'s line-ending config (autocrlf=true): not falsely dirty, merges write CRLF, worktrees stay LF', async () => {
    const repo2 = await demoRepo();
    try {
      // the user's checkout uses autocrlf=true (the Git for Windows default): files are CRLF on disk.
      // Set up with plain git, the way the user's own git would do it.
      const plainGit = (...args: string[]) => execFileSync('git', args, { cwd: repo2, stdio: 'pipe' });
      plainGit('config', 'core.autocrlf', 'true');
      for (const f of ['README.md', 'src/format.ts']) fs.rmSync(path.join(repo2, f));
      plainGit('checkout', '--', '.');
      expect(fs.readFileSync(path.join(repo2, 'README.md'), 'utf8')).toContain('\r\n');
      const r = await h.fm.repos.add(repo2);
      // an editor saves README.md without changing it: still clean for the user's git and the Foreman
      const readme = path.join(repo2, 'README.md');
      fs.writeFileSync(readme, fs.readFileSync(readme));
      expect(await h.fm.repos.isDirty(repo2)).toBe(false);
      // the agent worktree has the repository bytes (LF)
      const t = h.fm.tasks.create({ title: 'Line endings', createdBy: 'marlow', repoId: r.id, assignee: 'kit' });
      const wt = await h.fm.repos.createWorktree(r.id, 'kit', t);
      const fmt = path.join(wt.path, 'src', 'format.ts');
      expect(fs.readFileSync(fmt, 'utf8')).not.toContain('\r\n');
      fs.writeFileSync(fmt, fs.readFileSync(fmt, 'utf8').replace('// Human-friendly rendering of notes for the terminal.', '// Rendering of notes for the terminal.'));
      const d = h.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [...MERGE_OPTIONS], repoId: r.id, worktree: wt.id, taskId: t.id });
      await h.fm.answerDecision(d.id, 'Merge');
      expect(h.fm.decisions.get(d.id)!.status).toBe('answered'); // not refused as dirty
      const merged = fs.readFileSync(path.join(repo2, 'src', 'format.ts'), 'utf8');
      expect(merged).toContain('// Rendering of notes for the terminal.');
      expect(merged).toContain('\r\n'); // written the way the user's git writes it
      expect(plainGit('status', '--porcelain').toString().trim()).toBe('');
    } finally {
      rmrf(path.dirname(repo2));
    }
  });

  it.each([
    ['diff.mnemonicPrefix', 'true'],
    ['diff.noprefix', 'true'],
    ['diff.srcPrefix', 'SRC/'],
  ])('reports repo-relative paths when the user sets %s=%s', async (key, value) => {
    const repo = await demoRepo();
    try {
      execFileSync('git', ['config', key, value], { cwd: repo, stdio: 'pipe' });
      const r = await h.fm.repos.add(repo);
      const t = h.fm.tasks.create({ title: 'Prefix config', createdBy: 'marlow', repoId: r.id, assignee: 'kit' });
      const wt = await h.fm.repos.createWorktree(r.id, 'kit', t);
      fs.appendFileSync(path.join(wt.path, 'src', 'cli.ts'), '// changed\n');
      fs.rmSync(path.join(wt.path, 'README.md'));
      fs.mkdirSync(path.join(wt.path, 'b'));
      fs.writeFileSync(path.join(wt.path, 'b', 'notes.md'), 'new\n');
      const d = await h.fm.repos.diff(r.id, wt.id);
      expect(d.files.map((f) => [f.path, f.status])).toEqual([['README.md', 'deleted'], ['b/notes.md', 'added'], ['src/cli.ts', 'modified']]);
    } finally {
      rmrf(path.dirname(repo));
    }
  });

  it('runs the repo test command and reports failures', async () => {
    const res = await h.fm.repos.runTests('demo-app');
    expect(res.pass).toBe(true);
    expect(res.summary).toMatch(/pass \d+/);
    expect(res.failures).toEqual([]);
  });
});

describe('parseTestOutput', () => {
  it('reads TAP output', () => {
    const out = parseTestOutput('ok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1\n');
    expect(out).toEqual({ failures: ['b'], summary: 'tests 2, pass 1, fail 1' });
  });

  it('reads the node --test spec reporter', () => {
    const out = parseTestOutput('✔ a (0.27ms)\n✖ b (0.08ms)\nℹ tests 2\nℹ suites 0\nℹ pass 1\nℹ fail 1\n\n✖ failing tests:\n\ntest at t.test.mjs:3:1\n✖ b (0.08ms)\n  Error: x\n');
    expect(out).toEqual({ failures: ['b'], summary: 'tests 2, pass 1, fail 1' });
  });
});

describe('approved merges are made as the user', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(rmrf));

  async function mergeOnce(args: string[], setup: (repo: string) => void) {
    const home2 = tempDir();
    const repo = await demoRepo();
    dirs.push(home2, path.dirname(repo));
    setup(repo);
    const h2 = makeForeman(home2, ['--backend', 'claude', ...args]);
    const r = await h2.fm.repos.add(repo);
    const t = h2.fm.tasks.create({ title: 'Signed change', createdBy: 'marlow', repoId: r.id, assignee: 'kit' });
    const wt = await h2.fm.repos.createWorktree(r.id, 'kit', t);
    fs.writeFileSync(path.join(wt.path, 'CHANGELOG.md'), '# 0.2.0\n');
    await h2.fm.repos.commitAll(r.id, wt.id, 'Add changelog');
    const d = h2.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [...MERGE_OPTIONS], repoId: r.id, worktree: wt.id, taskId: t.id });
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    await h2.fm.answerDecision(d.id, 'Merge');
    const out = { repo, d: h2.fm.decisions.get(d.id)!, headBefore, head: await gitOut(repo, ['rev-parse', 'HEAD']) };
    await h2.fm.close();
    return out;
  }

  // a stand-in for gpg: reads the payload, reports success, prints a (fake) signature
  function fakeSigner(dir: string, works: boolean): string {
    const p = path.join(dir, works ? 'fake-gpg.sh' : 'broken-gpg.sh');
    fs.writeFileSync(
      p,
      works
        ? ['#!/bin/sh', 'cat >/dev/null', 'echo "" >&2', 'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0" >&2', 'echo "-----BEGIN PGP SIGNATURE-----"', 'echo "ZmFrZQ=="', 'echo "-----END PGP SIGNATURE-----"', ''].join('\n')
        : ['#!/bin/sh', 'cat >/dev/null', 'echo "no secret key" >&2', 'exit 2', ''].join('\n'),
    );
    fs.chmodSync(p, 0o755);
    return p.split(path.sep).join('/');
  }

  const signing = (signer: string) => (repo: string) => {
    const kv: Array<[string, string]> = [['commit.gpgsign', 'true'], ['gpg.format', 'openpgp'], ['gpg.program', signer], ['user.signingkey', 'TESTKEY']];
    for (const [k, v] of kv) execFileSync('git', ['config', '--local', k, v], { cwd: repo });
  };

  it('signs the merge commit when the repo signs commits', async () => {
    const dir = tempDir('ac-gpg-');
    dirs.push(dir);
    const { repo, d } = await mergeOnce([], signing(fakeSigner(dir, true)));
    expect(d.status).toBe('answered');
    expect((await gitOut(repo, ['cat-file', '-p', 'HEAD'])).includes('gpgsig -----BEGIN PGP SIGNATURE-----')).toBe(true);
  });

  it('refuses (decision re-opens, checkout untouched) when signing fails', async () => {
    const dir = tempDir('ac-gpg-');
    dirs.push(dir);
    const { d, head, headBefore } = await mergeOnce([], signing(fakeSigner(dir, false)));
    expect(d.status).toBe('open');
    expect(d.context).toMatch(/Merge refused: signing the merge commit failed/);
    expect(head).toBe(headBefore);
  });

  it('--no-sign-merges never signs; --merge-style squash makes one commit with co-authors', async () => {
    const dir = tempDir('ac-gpg-');
    dirs.push(dir);
    const { repo, d } = await mergeOnce(['--no-sign-merges', '--merge-style', 'squash'], signing(fakeSigner(dir, false)));
    expect(d.status).toBe('answered');
    const raw = await gitOut(repo, ['cat-file', '-p', 'HEAD']);
    expect(raw.includes('gpgsig')).toBe(false);
    expect((await gitOut(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ')).toHaveLength(2); // one parent
    expect(await gitOut(repo, ['log', '-1', '--format=%an'])).toBe('Demo Author');
    expect(raw).toMatch(/Co-authored-by: AgentCraft Kit <kit@agentcraft\.local>/);
    expect(fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('# 0.2.0\n');
  });
});

// An agent can rewrite or delete its worktree's `.git` link (or move HEAD). The Foreman's own git
// writes in a worktree (commitAll: at merge, abandon and hand-off) must never follow it into
// the user's checkout or another repository, and must only ever move the agent's own branch.
describe('worktree .git tampering and a moved HEAD', () => {
  let outer: string;
  let h3: Harness;
  let repo: string;
  // .git link files are hidden on Windows: overwrite in place (a plain write is refused with EPERM)
  const overwrite = (file: string, text: string) => {
    const fd = fs.openSync(file, 'r+');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text, 0);
    fs.closeSync(fd);
  };
  const userState = async () => ({ head: await gitOut(repo, ['rev-parse', 'refs/heads/main']), status: (await git(repo, ['status', '--porcelain'])).stdout.trim() });

  beforeAll(async () => {
    // the Foreman's home sits inside another git repository, so a worktree without its .git link
    // would make git walk up into that one (as .agentcraft-home inside C:\Projects\agentcraft does)
    outer = tempDir('ac-outer-');
    execFileSync('git', ['init', '-q', '-b', 'main', outer]);
    execFileSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@o', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'outer'], { cwd: outer });
    repo = await demoRepo();
    h3 = makeForeman(path.join(outer, 'home'), ['--backend', 'sim']);
    await h3.fm.repos.add(repo);
  });
  afterAll(async () => {
    await h3.fm.close();
    rmrf(outer);
    rmrf(path.dirname(repo));
  });

  async function worktreeWithWork(title: string) {
    const t = h3.fm.tasks.create({ title, createdBy: 'marlow', repoId: 'demo-app', assignee: 'kit' });
    const wt = await h3.fm.repos.createWorktree('demo-app', 'kit', t);
    fs.writeFileSync(path.join(wt.path, 'WORK.md'), `${title}\n`);
    return wt;
  }

  it('.git rewritten to point at the user checkout: no commit, no diff, user branch untouched, dir kept', async () => {
    const wt = await worktreeWithWork('hijack via gitdir');
    const before = await userState();
    overwrite(path.join(wt.path, '.git'), `gitdir: ${path.join(repo, '.git').split(path.sep).join('/')}\n`);
    await expect(h3.fm.repos.commitAll('demo-app', wt.id, 'x')).rejects.toThrow(/will not run git in worktree .*its \.git link was removed or changed|points at/);
    await expect(h3.fm.repos.diff('demo-app', wt.id)).rejects.toThrow(/cannot show the diff/);
    await h3.fm.repos.abandon('demo-app', wt.id);
    expect(fs.existsSync(wt.path)).toBe(true); // left for inspection
    expect(await userState()).toEqual(before);
  });

  it('.git removed (git would walk up into the enclosing repo): refused, enclosing repo untouched', async () => {
    const wt = await worktreeWithWork('hijack via walk-up');
    const outerHead = await gitOut(outer, ['rev-parse', 'HEAD']);
    const before = await userState();
    fs.rmSync(path.join(wt.path, '.git'));
    await expect(h3.fm.repos.commitAll('demo-app', wt.id, 'x')).rejects.toThrow(/works on .* instead/);
    expect(await gitOut(outer, ['rev-parse', 'HEAD'])).toBe(outerHead);
    expect((await git(outer, ['status', '--porcelain'])).stdout).not.toMatch(/WORK\.md/); // nothing staged there
    expect(await userState()).toEqual(before);
  });

  it(".git pointing at another worktree's entry is refused", async () => {
    const a = await worktreeWithWork('worktree a');
    const t = h3.fm.tasks.create({ title: 'worktree b', createdBy: 'marlow', repoId: 'demo-app', assignee: 'juniper' });
    const b = await h3.fm.repos.createWorktree('demo-app', 'juniper', t);
    const bLink = fs.readFileSync(path.join(b.path, '.git'), 'utf8');
    const bBranch = await gitOut(repo, ['rev-parse', `refs/heads/${b.branch}`]);
    overwrite(path.join(a.path, '.git'), bLink);
    await expect(h3.fm.repos.commitAll('demo-app', a.id, 'x')).rejects.toThrow(/points at the worktree entry of/);
    expect(await gitOut(repo, ['rev-parse', `refs/heads/${b.branch}`])).toBe(bBranch);
  });

  it("HEAD moved to another branch: the work is committed on the agent's own branch, the other branch is untouched", async () => {
    const wt = await worktreeWithWork('moved head');
    await git(wt.path, ['checkout', '-q', '-b', 'alex-feature']);
    const other = await gitOut(repo, ['rev-parse', 'refs/heads/alex-feature']);
    const own = await gitOut(repo, ['rev-parse', `refs/heads/${wt.branch}`]);
    const before = await userState();
    expect(await h3.fm.repos.commitAll('demo-app', wt.id, 'agentcraft: snapshot test')).toBe(true);
    expect(await gitOut(repo, ['rev-parse', 'refs/heads/alex-feature'])).toBe(other);
    expect(await gitOut(wt.path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/alex-feature');
    const tip = await gitOut(repo, ['rev-parse', `refs/heads/${wt.branch}`]);
    expect(tip).not.toBe(own);
    expect(await gitOut(repo, ['rev-parse', `${tip}^`])).toBe(own);
    expect(await gitOut(repo, ['show', `${tip}:WORK.md`])).toBe('moved head');
    expect(await gitOut(repo, ['log', '-1', '--format=%an <%ae>', tip])).toBe('AgentCraft Kit <kit@agentcraft.local>');
    expect(await userState()).toEqual(before);
    // nothing new: no second commit
    expect(await h3.fm.repos.commitAll('demo-app', wt.id, 'again')).toBe(false);
  });

  it('an intact worktree still commits normally', async () => {
    const wt = await worktreeWithWork('normal');
    expect(await h3.fm.repos.commitAll('demo-app', wt.id, 'agentcraft: normal')).toBe(true);
    expect((await git(wt.path, ['status', '--porcelain'])).stdout.trim()).toBe('');
    expect(await gitOut(wt.path, ['log', '-1', '--format=%s'])).toBe('agentcraft: normal');
  });
});

// Node 26 uses the spec reporter even when stdout is piped; Node 22 used TAP.
describe('test output summaries', () => {
  it('recognizes both TAP and Node spec summaries', async () => {
    const { parseTestOutput } = await import('../src/repos.js');
    for (const prefix of ['#', 'ℹ']) {
      expect(parseTestOutput(`${prefix} tests 2\n${prefix} pass 1\n${prefix} fail 1\n`).summary).toBe('tests 2, pass 1, fail 1');
    }
  });
});
