import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexBackend } from '../src/agents/codex/index.js';
import { MERGE_OPTIONS } from '../src/protocol.js';
import { demoRepo, makeForeman, rmrf, tempDir } from './helpers.js';

it('leaves a conflicting Codex merge open for local resolution without retrying a sandbox-forbidden git merge', async () => {
  const home = tempDir();
  const repo = await demoRepo();
  const h = makeForeman(home, ['--backend', 'codex', '--repo', repo, '--workers', 'kit', '--no-resume']);
  const runTurn = vi.fn(async () => { throw new Error('No Codex turn should be scheduled'); });
  const backend = new CodexBackend(h.fm, h.cfg.codex, { skipAuthCheck: true, driver: { name: 'codex', label: 'Codex', checkAuth: async () => true, runTurn } });
  try {
    await h.fm.start(backend);
    const task = h.fm.tasks.create({ title: 'Update README', assignee: 'kit', createdBy: 'marlow', repoId: 'demo-app' });
    h.fm.tasks.setStatus(task.id, 'blocked', { force: true, reason: 'Preparing fixture' });
    const wt = await h.fm.repos.createWorktree('demo-app', 'kit', task);
    h.fm.tasks.update(task.id, { worktree: wt.id, branch: wt.branch });
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'worker version\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base version\n');
    const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    git(['add', 'README.md']);
    git(['commit', '-m', 'Conflicting base update']);
    const head = git(['rev-parse', 'HEAD']);
    h.fm.tasks.setStatus(task.id, 'review', { force: true });
    const decision = h.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [...MERGE_OPTIONS], repoId: 'demo-app', worktree: wt.id, taskId: task.id });
    await h.fm.answerDecision(decision.id, 'Merge');
    expect(h.fm.decisions.get(decision.id)!.status).toBe('open');
    expect(h.fm.decisions.get(decision.id)!.context).toContain('Merge refused:');
    expect(h.fm.tasks.get(task.id)!.status).toBe('review');
    expect(h.fm.store.data.feed.some((entry) => entry.text.includes('Codex cannot automatically resolve'))).toBe(true);
    expect(runTurn).not.toHaveBeenCalled();
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('base version\n');
  } finally {
    await h.fm.close();
    rmrf(home);
    rmrf(path.dirname(repo));
  }
});
