import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBackend } from '../src/agents/codex/index.js';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { SimDirector } from '../src/agents/sim/director.js';
import { reviewPrompt as codexReview } from '../src/agents/codex/prompts.js';
import { reviewPrompt as claudeReview } from '../src/agents/claude/prompts.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  if (h) { await h.fm.close(); rmrf(h.home); }
});
function fixture(kind: 'codex' | 'claude' = 'codex') {
  h = makeForeman(tempDir(), ['--backend', kind]);
  const worktree = { id: 'kit-t1', path: h.home, branch: 'agentcraft/kit/t1', base: 'main', agentId: 'kit', status: 'active' as const, ahead: 0, files: 1, additions: 1, deletions: 0 };
  h.fm.store.data.repos.push({ id: 'fixture', name: 'fixture', path: h.home, branch: 'main', dirty: false, ci: 'unknown', worktrees: [worktree] });
  const task = h.fm.tasks.create({ title: 'CI fixture', createdBy: 'marlow', assignee: 'kit', repoId: 'fixture' });
  h.fm.tasks.update(task.id, { worktree: worktree.id });
  h.fm.tasks.setStatus(task.id, 'review', { force: true });
  return task;
}

describe('CI evidence at review', () => {
  it('does not report success or an exit code when no command was run', async () => {
    fixture();
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(await h.fm.repos.runTests('fixture')).toMatchObject({ pass: null, code: null, command: '(none)', durationMs: 0 });
    }
  });

  it('runs explicit commands and detected tests, retaining their exit status', async () => {
    fixture();
    expect(await h.fm.repos.runTests('fixture', undefined, 'exit 0')).toMatchObject({ pass: true, code: 0 });
    expect(await h.fm.repos.runTests('fixture', undefined, 'exit 7')).toMatchObject({ pass: false, code: 7 });
    fs.writeFileSync(path.join(h.home, 'package.json'), JSON.stringify({ scripts: { test: 'exit 0' } }));
    expect(await h.fm.repos.runTests('fixture')).toMatchObject({ pass: true, code: 0, command: 'npm test --silent' });
  });

  it('sim runs the fallback command it displays instead of treating missing tests as passed', async () => {
    fixture();
    h.fm.setAgent('kit', { active: true });
    const sim = new SimDirector(h.fm, h.cfg.sim, { beat: 0, vars: {} }, () => {});
    sim.instant = true;
    expect(await sim.runTests('kit')).toBe(false);
    expect(h.fm.repos.require('fixture').ci).toBe('fail');
  });

  it.each(['codex', 'claude'] as const)('%s keeps untested work unknown through owner review without a repair turn', async (kind) => {
    const task = fixture(kind);
    h.cfg[kind].leadReview = false;
    const backend = kind === 'codex' ? new CodexBackend(h.fm, h.cfg.codex) : new ClaudeBackend(h.fm, h.cfg.claude);
    // CI and review are production paths; only unrelated Git refresh is isolated.
    vi.spyOn(h.fm.repos, 'refresh').mockResolvedValue(h.fm.repos.require('fixture'));
    await (backend as unknown as { ciThenReview(id: string): Promise<void> }).ciThenReview(task.id);
    expect(h.fm.tasks.require(task.id)).toMatchObject({ ci: 'unknown', status: 'review' });
    expect(h.fm.repos.require('fixture').ci).toBe('unknown');
    expect(h.fm.store.data.decisions.find((d) => d.kind === 'merge')?.context).toContain('tests: unknown');
    expect(h.fm.store.data.feed.filter((f) => f.kind === 'ci').map((f) => f.text).join('\n')).toContain('not run');
    expect((h.fm.store.data.backend[kind] as { ciFixes?: Record<string, number> } | undefined)?.ciFixes?.[task.id]).toBeUndefined();
    const ci = await h.fm.repos.runTests('fixture');
    const prompt = (kind === 'codex' ? codexReview : claudeReview)(h.fm, task, '', { files: 1, additions: 1, deletions: 0 }, ci);
    expect(prompt).toContain('Tests ((none)): not run');
    expect(prompt).not.toContain('PASS');
  });

  it.each(['codex', 'claude'] as const)('%s honors --ci and retries a real failure only once', async (kind) => {
    const task = fixture(kind);
    h.cfg[kind].leadReview = false;
    h.cfg[kind].ciCommand = 'exit 7';
    const backend = kind === 'codex' ? new CodexBackend(h.fm, h.cfg.codex) : new ClaudeBackend(h.fm, h.cfg.claude);
    const internals = backend as unknown as { ciThenReview(id: string): Promise<void>; sendBackToWorker(id: string, prompt: string): void };
    const repair = vi.spyOn(internals, 'sendBackToWorker').mockImplementation(() => {});
    vi.spyOn(h.fm.repos, 'refresh').mockResolvedValue(h.fm.repos.require('fixture'));
    await internals.ciThenReview(task.id);
    expect(h.fm.tasks.require(task.id).ci).toBe('fail');
    expect(repair).toHaveBeenCalledExactlyOnceWith(task.id, expect.stringContaining('CI failed'));
    await internals.ciThenReview(task.id);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(h.fm.store.data.decisions.find((d) => d.kind === 'merge')?.context).toContain('tests: fail');
    h.cfg[kind].ciCommand = 'exit 0';
    await internals.ciThenReview(task.id);
    expect(h.fm.tasks.require(task.id).ci).toBe('pass');
    expect(h.fm.repos.require('fixture').ci).toBe('pass');
  });
});
