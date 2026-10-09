import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TeamPermissions } from '../src/permissions.js';
import { Store } from '../src/store.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

let h: Harness;
let dir: string;
afterEach(async () => { await h?.fm.close(); if (dir) rmrf(dir); });
function setup() {
  dir = tempDir(); h = makeForeman(dir, ['--backend', 'codex']);
  return new TeamPermissions(h.fm, []);
}
function permission(p: TeamPermissions, agent: string, repo = 'project', role: 'lead' | 'worker' = 'worker') {
  const abort = new AbortController();
  const cwd = path.join(dir, repo, agent);
  fs.mkdirSync(cwd, { recursive: true });
  const use = p.canUseTool(agent, role, cwd, repo, { signal: abort.signal, reason: () => undefined });
  return { abort, run: (command: string) => use('Bash', { command }, { signal: abort.signal }) };
}

it('one team approval releases matching pending workers and survives restart, only in that repository', async () => {
  const p = setup();
  const kit = permission(p, 'kit'), wren = permission(p, 'wren'), other = permission(p, 'juniper', 'other');
  const runs = [kit.run('npm ci'), wren.run('npm ci'), other.run('npm ci')];
  await until(() => h.fm.decisions.open().length === 3);
  const first = h.fm.decisions.open().find(d => d.agentId === 'kit')!;
  expect(first.context).toContain('all agents in repository project');
  await h.fm.answerDecision(first.id, 'Always allow for this team');
  expect((await runs[0]!).behavior).toBe('allow');
  expect((await runs[1]!).behavior).toBe('allow');
  expect(h.fm.decisions.open().map(d => d.agentId)).toEqual(['juniper']);
  h.fm.store.flush();
  const restored = new Store(h.fm.store.dir);
  expect(restored.data.teamPermissionRules.project).toEqual(['Bash:npm ci']);
  expect(restored.data.teamPermissionRules.other).toBeUndefined();
  expect(restored.data.permissionRules).toEqual({});
  await restored.close();
  expect((await wren.run('npm ci')).behavior).toBe('allow');
  expect((await wren.run('git push')).behavior).toBe('deny');
  // Global install is not covered by a project dependency install grant.
  const global = kit.run('npm install -g evil');
  await until(() => h.fm.decisions.open().some(d => d.agentId === 'kit'));
  kit.abort.abort(); other.abort.abort();
  expect((await global).behavior).toBe('deny');
  expect((await runs[2]!).behavior).toBe('deny');
});

it('allow once and old per-agent approvals do not grant access to teammates', async () => {
  const p = setup();
  h.fm.store.data.permissionRules.kit = ['Bash:npm ci'];
  const kit = permission(p, 'kit'), wren = permission(p, 'wren');
  expect((await kit.run('npm ci')).behavior).toBe('allow');
  const first = wren.run('npm ci');
  await until(() => h.fm.decisions.open().length === 1);
  await h.fm.answerDecision(h.fm.decisions.open()[0]!.id, 'Allow once');
  expect((await first).behavior).toBe('allow');
  const again = wren.run('npm ci');
  await until(() => h.fm.decisions.open().length === 1);
  wren.abort.abort();
  expect((await again).behavior).toBe('deny');
  expect(h.fm.store.data.teamPermissionRules).toEqual({});
});

it('team worker grants do not permit the lead to change the checkout', async () => {
  const p = setup();
  h.fm.store.data.teamPermissionRules.project = ['Bash:npm ci'];
  const lead = permission(p, 'marlow', 'project', 'lead');
  const run = lead.run('npm ci');
  await until(() => h.fm.decisions.open().length === 1);
  expect(h.fm.decisions.open()[0]!.context).toContain('lead is read-only');
  lead.abort.abort();
  expect((await run).behavior).toBe('deny');
});

it('honors declared lead read commands without granting worker use or mutation', async () => {
  const p = setup();
  const abort = new AbortController();
  const turn = { signal: abort.signal, reason: () => undefined };
  const lead = p.canUseTool('marlow', 'lead', dir, 'project', turn, ['bd show']);
  expect((await lead('Bash', { command: 'bd show issue-1' }, { signal: abort.signal })).behavior).toBe('allow');
  expect(h.fm.decisions.open()).toEqual([]);
  const worker = p.canUseTool('kit', 'worker', dir, 'project', turn, ['bd show']);
  const runs = [
    worker('Bash', { command: 'bd show issue-1' }, { signal: abort.signal }),
    lead('Bash', { command: 'bd show issue-1 > changed.txt' }, { signal: abort.signal }),
  ];
  await until(() => h.fm.decisions.open().length === 2);
  abort.abort();
  expect((await Promise.all(runs)).map(r => r.behavior)).toEqual(['deny', 'deny']);
});
