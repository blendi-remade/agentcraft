// Client intents through Foreman.handle(): acks, errors, task/agent actions, repo.add, routing.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimBackend } from '../src/agents/sim/index.js';
import type { ClientMessage, Outbound } from '../src/protocol.js';
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

type NoV<T> = T extends unknown ? Omit<T, 'v'> : never;

async function send(msg: NoV<ClientMessage>): Promise<Outbound[]> {
  const replies: Outbound[] = [];
  await h.fm.handle({ v: 1, id: 'x', ...msg } as ClientMessage, (m) => replies.push(m));
  return replies;
}
const ack = (r: Outbound[]) => r.find((m) => m.type === 'ack') as Extract<Outbound, { type: 'ack' }>;

describe('client intents', () => {
  it('hello replies with a snapshot only to the sender', async () => {
    const r = await send({ type: 'hello', modVersion: 't', protocol: 1 });
    expect(r[0]!.type).toBe('snapshot');
  });

  it('goal.submit without a repo or backend fails with a clear error', async () => {
    const r = await send({ type: 'goal.submit', text: 'do things' });
    expect(ack(r).ok).toBe(false);
    expect(ack(r).error).toMatch(/no repo connected/);
    expect(r.some((m) => m.type === 'error')).toBe(true);
  });

  it('repo.add registers a repo and acks with its id; bad paths fail', async () => {
    const ok = await send({ type: 'repo.add', path: repoPath });
    expect(ack(ok)).toMatchObject({ ok: true, result: { repoId: 'demo-app' } });
    const bad = await send({ type: 'repo.add', path: path.join(home, 'nope') });
    expect(ack(bad).ok).toBe(false);
  });

  it('user.message routes @name, rejects unknown agents', async () => {
    const r = await send({ type: 'user.message', to: 'all', text: '@Juniper can you look at the CLI?' });
    expect(ack(r).result).toEqual({ to: 'juniper' });
    expect(h.fm.bus.inbox('juniper').at(-1)!.text).toBe('can you look at the CLI?');
    const bad = await send({ type: 'user.message', to: 'all', text: '@nobody hi' });
    expect(ack(bad).error).toMatch(/no agent named "nobody"/);
    const direct = await send({ type: 'user.message', to: 'Kit', text: 'hello' });
    expect(ack(direct).result).toEqual({ to: 'kit' });
  });

  it('task.action cancel / retry / prioritize / reassign', async () => {
    const t = h.fm.tasks.create({ title: 'steerable', createdBy: 'marlow', assignee: 'kit' });
    h.fm.setAgent('kit', { active: true, state: 'error', station: 'desk', activity: 'turn failed', taskId: t.id, repoId: 'demo-app', worktree: 'kit-old' });
    const d = h.fm.createDecision({ agentId: 'kit', kind: 'question', question: 'still needed?', options: ['yes'], taskId: t.id });
    expect(ack(await send({ type: 'task.action', taskId: t.id, action: 'cancel' })).ok).toBe(true);
    expect(h.fm.tasks.get(t.id)!.status).toBe('cancelled');
    expect(h.fm.decisions.get(d.id)!.status).toBe('cancelled');
    expect(h.fm.agent('kit')).toMatchObject({ active: true, state: 'idle', station: 'lounge', activity: 'task cancelled' });
    expect(h.fm.agent('kit')!.taskId).toBeUndefined();
    expect(h.fm.agent('kit')!.worktree).toBeUndefined();
    await send({ type: 'task.action', taskId: t.id, action: 'retry' });
    expect(h.fm.tasks.get(t.id)!.status).toBe('todo');
    await send({ type: 'task.action', taskId: t.id, action: 'prioritize' });
    expect(h.fm.tasks.get(t.id)!.priority).toBeGreaterThan(0);
    await send({ type: 'task.action', taskId: t.id, action: 'prioritize', arg: '-3' });
    expect(h.fm.tasks.get(t.id)!.priority).toBe(-3);
    await send({ type: 'task.action', taskId: t.id, action: 'reassign', arg: '@wren' });
    expect(h.fm.tasks.get(t.id)!.assignee).toBe('wren');
    const lead = await send({ type: 'task.action', taskId: t.id, action: 'reassign', arg: 'marlow' });
    expect(ack(lead).ok).toBe(false);
    const missing = await send({ type: 'task.action', taskId: 't999', action: 'cancel' });
    expect(ack(missing).error).toMatch(/no task t999/);
  });

  it('agent.action pause / resume / spawn update the agent', async () => {
    await send({ type: 'agent.action', agentId: 'rowan', action: 'pause' });
    expect(h.fm.agent('rowan')!.paused).toBe(true);
    await send({ type: 'agent.action', agentId: 'Rowan', action: 'resume' });
    expect(h.fm.agent('rowan')!.paused).toBe(false);
    await send({ type: 'agent.action', agentId: 'tove', action: 'spawn' });
    expect(h.fm.agent('tove')!.active).toBe(true);
    const bad = await send({ type: 'agent.action', agentId: 'ghost', action: 'pause' });
    expect(ack(bad).ok).toBe(false);
  });

  it('agent.action spawn with a task id brings the agent on shift and assigns the task', async () => {
    const t = h.fm.tasks.create({ title: 'for wren', createdBy: 'marlow' });
    const r = await send({ type: 'agent.action', agentId: 'wren', action: 'spawn', arg: t.id });
    expect(ack(r).ok).toBe(true);
    expect(h.fm.agent('wren')!.active).toBe(true);
    expect(h.fm.tasks.get(t.id)!.assignee).toBe('wren');
    expect(ack(await send({ type: 'agent.action', agentId: 'wren', action: 'spawn', arg: 't999' })).error).toMatch(/no task/);
    expect(ack(await send({ type: 'agent.action', agentId: 'marlow', action: 'spawn', arg: t.id })).ok).toBe(false);
  });

  it('agent.action stop takes a sim agent off shift; resume brings it back', async () => {
    h.fm.backend ??= new SimBackend(h.fm, h.cfg.sim); // the backend handles stop (no scenario running)
    await send({ type: 'agent.action', agentId: 'juniper', action: 'stop' });
    expect(h.fm.agent('juniper')!.active).toBe(false);
    expect(h.fm.agent('juniper')!.activity).toMatch(/stopped/);
    await send({ type: 'agent.action', agentId: 'juniper', action: 'resume' });
    expect(h.fm.agent('juniper')!.active).toBe(true);
  });

  it('diff.request for an unknown worktree answers with a diff error, not a crash', async () => {
    const r = await send({ type: 'diff.request', requestId: 'q1', repoId: 'demo-app', worktree: 'nobody-t1' });
    const diff = r.find((m) => m.type === 'diff') as Extract<Outbound, { type: 'diff' }>;
    expect(diff.requestId).toBe('q1');
    expect(diff.error).toMatch(/no worktree/);
  });
});
