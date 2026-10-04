import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServer } from '../src/agents/codex/app-server.js';
import { CodexBackend } from '../src/agents/codex/index.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const subprocess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), ...subprocess }));

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
/** Only the OS process boundary is fake. The production RPC parser, backend and store run. */
class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  messages: Message[] = [];
  hold = new Set<string>();
  onRequest?: (message: Message) => void;
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      const message = JSON.parse(String(chunk)) as Message;
      this.messages.push(message);
      if (message.method && message.id !== undefined && !this.hold.has(message.method)) {
        const result = message.method.startsWith('thread/') && message.method !== 'thread/unsubscribe'
          ? { thread: { id: message.params?.threadId ?? 'thread-kit', model: 'fake' } }
          : message.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
        this.reply(message, result);
      }
      this.onRequest?.(message);
      done();
    },
    final: (done) => { this.exit(); done(); },
  });
  reply(message: Message, result: unknown) { this.send({ id: message.id, result }); }
  send(message: Message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  exit() {
    if (this.exitCode !== null) return;
    this.exitCode = 1;
    this.emit('exit', 1, null);
    this.stdout.end();
    this.emit('close', 1, null);
  }
  kill() { this.exit(); return true; }
}

let h: Harness | undefined;
let backend: CodexBackend | undefined;
const clients: CodexAppServer[] = [];
const homes: string[] = [];
let child: FakeProcess;
function fake() {
  child = new FakeProcess();
  subprocess.spawn.mockImplementation(() => child);
  subprocess.execFile.mockImplementation((_binary, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '[]', ''));
    return new FakeProcess();
  });
  return child;
}
function client() {
  const server = new CodexAppServer({ binaryPath: 'fake-only', cwd: process.cwd(), env: {}, onNotification: () => {}, onServerRequest: async () => ({}) });
  clients.push(server);
  return server;
}
afterEach(async () => {
  child?.exit();
  await backend?.stop();
  await h?.fm.close();
  await Promise.all(clients.splice(0).map((server) => server.close(0)));
  homes.splice(0).forEach(rmrf);
  backend = undefined;
  h = undefined;
  vi.restoreAllMocks();
  subprocess.spawn.mockReset();
  subprocess.execFile.mockReset();
});

function worker(home = tempDir()) {
  homes.push(home);
  h = makeForeman(home, ['--backend', 'codex', '--workers', 'kit']);
  h.cfg.codex.binaryPath = process.execPath; // existing file; spawn is always intercepted
  h.cfg.codex.leadReview = false;
  const wt = { id: 'kit-t1', path: home, branch: 'agentcraft/kit/t1', base: 'main', agentId: 'kit', status: 'active' as const, ahead: 0, files: 0, additions: 0, deletions: 0 };
  vi.spyOn(h.fm.repos, 'requireWorktree').mockReturnValue(wt);
  vi.spyOn(h.fm.repos, 'findWorktree').mockReturnValue(undefined);
  vi.spyOn(h.fm.repos, 'sweepPendingRemovals').mockResolvedValue(0);
  if (!h.fm.tasks.get('t1')) {
    h.fm.tasks.create({ title: 'Lifecycle fixture', createdBy: 'marlow', assignee: 'kit', repoId: 'fixture' });
    h.fm.tasks.update('t1', { worktree: wt.id });
    h.fm.tasks.setStatus('t1', 'doing', { force: true });
  }
  h.fm.setAgent('kit', { active: true, taskId: 't1', worktree: wt.id, repoId: 'fixture' });
  backend = new CodexBackend(h.fm, h.cfg.codex, { skipAuthCheck: true });
  return { h, backend };
}
function inflight() {
  return (h!.fm.store.data.backend.codex as { inflight: Record<string, { kind: string; taskId: string; sessionKey: string }> }).inflight;
}

describe('Codex app-server transport lifecycle', () => {
  it('rejects a failed request and can serve the next request', async () => {
    fake();
    const server = client();
    await server.start();
    child.hold.add('fail');
    child.onRequest = (message) => { if (message.method === 'fail') child.send({ id: message.id, error: { message: 'fixture rejection' } }); };
    await expect(server.request('fail', {})).rejects.toThrow('fixture rejection');
    await expect(server.request('next', {})).resolves.toEqual({});
  });

  it.each(['exit', 'stdout', 'spawn-error', 'stdin-error', 'close'] as const)('settles every pending request on %s', async (kind) => {
    fake();
    const server = client();
    await server.start();
    child.hold.add('pending');
    const results = Promise.allSettled([server.request('pending', {}), server.request('pending', {})]);
    if (kind === 'exit') child.exit();
    if (kind === 'stdout') child.stdout.end();
    if (kind === 'spawn-error') child.emit('error', new Error('fixture spawn error'));
    if (kind === 'stdin-error') child.stdin.emit('error', new Error('fixture pipe error'));
    if (kind === 'close') await server.close(0);
    await expect(results).resolves.toMatchObject([{ status: 'rejected' }, { status: 'rejected' }]);
    await expect(server.request('after-disconnect', {})).rejects.toThrow(/not running/);
  }, 1500);

  it('settles exited when a failed spawn emits error and close but no exit', async () => {
    fake();
    child.hold.add('initialize');
    const server = client();
    const starting = server.start();
    const rejected = expect(starting).rejects.toThrow('ENOENT');
    await until(() => server.process !== undefined);
    child.emit('error', new Error('ENOENT'));
    child.emit('close', -2, null);
    await rejected;
    await expect(server.exited).resolves.toBeUndefined();
  }, 1500);
});

describe('Codex backend lifecycle through fake stdio', () => {
  it('keeps the active model while applying an in-game choice to the next turn', async () => {
    fake();
    const { h, backend } = worker();
    vi.spyOn(backend as unknown as { availableModels(): Promise<import('../src/agents/codex/model-settings.js').ModelChoice[]> }, 'availableModels')
      .mockResolvedValue([{ model: 'sol', label: 'Sol', efforts: ['high'], defaultEffort: 'high' }]);
    backend.onUserMessage('kit', 'Continue');
    await until(() => child.messages.some(m => m.method === 'turn/start'));
    const original = child;
    const result = await backend.configureAgent('kit', 'sol', 'high');
    expect(result).toMatchObject({ next: { model: 'sol', effort: 'high' }, active: { model: 'fake' } });
    expect(original.messages.filter(m => m.method === 'turn/start')).toHaveLength(1);
    expect(original.messages.some(m => m.method === 'turn/interrupt')).toBe(false);
    h.fm.setAgent('kit', { paused: true });
    await backend.onAgentAction('kit', 'pause');
    await until(() => !inflight().kit);
    const resumed = fake();
    h.fm.setAgent('kit', { paused: false });
    await backend.onAgentAction('kit', 'resume');
    await until(() => resumed.messages.some(m => m.method === 'turn/start'));
    expect(resumed.messages.find(m => m.method === 'turn/start')?.params).toMatchObject({ model: 'sol', effort: 'high' });
  });

  it.each(['thread/resume', 'turn/start', 'exit', 'stdout'] as const)('blocks failed worker work after %s and releases inflight state', async (failure) => {
    fake();
    const { h, backend } = worker();
    h.fm.store.data.sessions['kit:t1'] = { sessionId: 'saved-thread', turns: 2, costUsd: 0, updatedAt: 1 };
    if (failure !== 'exit') child.hold.add(failure);
    child.onRequest = (message) => {
      if (message.method === failure) child.send({ id: message.id, error: { message: 'fixture failure' } });
      if (failure === 'exit' && message.method === 'turn/start') queueMicrotask(() => child.exit());
      if (failure === 'stdout' && message.method === 'turn/start') queueMicrotask(() => child.stdout.end());
    };
    backend.onUserMessage('kit', 'Continue');
    await until(() => h.fm.tasks.get('t1')?.status === 'blocked', 1500);
    expect(h.fm.agent('kit')?.state).toBe('error');
    expect(inflight().kit).toBeUndefined();
    expect(h.fm.store.data.sessions['kit:t1']?.sessionId).toBe('saved-thread');
    expect(child.messages.some((m) => m.method === 'thread/start')).toBe(false);
  });

  it.each(['initialize', 'thread/start', 'turn/start', 'active'] as const)('cancels during %s without leaving an agent stuck', async (stage) => {
    fake();
    const { h, backend } = worker();
    if (stage !== 'active') child.hold.add(stage);
    backend.onUserMessage('kit', 'Continue');
    await until(() => child.messages.some((m) => m.method === (stage === 'active' ? 'turn/start' : stage)), 1500);
    h.fm.tasks.setStatus('t1', 'cancelled', { force: true });
    backend.onTaskAction(h.fm.tasks.require('t1'), 'cancel');
    await until(() => !inflight().kit, 1500);
    expect(h.fm.agent('kit')).toMatchObject({ state: 'idle', activity: 'task cancelled' });
    expect(child.exitCode).not.toBeNull();
  });

  it('pause and resume preserve the task and session', async () => {
    fake();
    const { h, backend } = worker();
    backend.onUserMessage('kit', 'Continue');
    await until(() => child.messages.some((m) => m.method === 'turn/start'));
    h.fm.setAgent('kit', { paused: true });
    await backend.onAgentAction('kit', 'pause');
    await until(() => !inflight().kit, 1500);
    const resumed = fake();
    h.fm.setAgent('kit', { paused: false });
    await backend.onAgentAction('kit', 'resume');
    await until(() => resumed.messages.some((m) => m.method === 'turn/start'), 1500);
    expect(resumed.messages.find((m) => m.method === 'thread/resume')?.params?.threadId).toBe('thread-kit');
    expect(inflight().kit).toMatchObject({ kind: 'followup', taskId: 't1', sessionKey: 'codex:kit:t1' });
    expect(h.fm.tasks.require('t1')).toMatchObject({ assignee: 'kit', status: 'doing', worktree: 'kit-t1' });
  });

  it('does not resume a cancelled task that was paused', async () => {
    fake();
    const { h, backend } = worker();
    backend.onUserMessage('kit', 'Continue');
    await until(() => child.messages.some((m) => m.method === 'turn/start'));
    h.fm.setAgent('kit', { paused: true });
    await backend.onAgentAction('kit', 'pause');
    await until(() => !inflight().kit);
    h.fm.tasks.setStatus('t1', 'cancelled', { force: true });
    backend.onTaskAction(h.fm.tasks.require('t1'), 'cancel');
    fake();
    h.fm.setAgent('kit', { paused: false });
    await backend.onAgentAction('kit', 'resume');
    expect(subprocess.spawn).toHaveBeenCalledTimes(1);
    expect(inflight().kit).toBeUndefined();
    expect(h.fm.agent('kit')?.taskId).toBeUndefined();
  });

  it('cancels a resumed job before its startup listener is installed', async () => {
    fake();
    const { h, backend } = worker();
    backend.onUserMessage('kit', 'Continue');
    await until(() => child.messages.some((m) => m.method === 'turn/start'));
    h.fm.setAgent('kit', { paused: true });
    await backend.onAgentAction('kit', 'pause');
    await until(() => !inflight().kit);
    fake().hold.add('initialize');
    h.fm.setAgent('kit', { paused: false });
    const resuming = backend.onAgentAction('kit', 'resume');
    // runJob awaits the prior turn's cleanup before installing its abort listener.
    h.fm.tasks.setStatus('t1', 'cancelled', { force: true });
    backend.onTaskAction(h.fm.tasks.require('t1'), 'cancel');
    await resuming;
    await until(() => h.fm.agent('kit')?.activity === 'task cancelled', 1500);
    expect(inflight().kit).toBeUndefined();
    expect(subprocess.spawn).toHaveBeenCalledTimes(1);
  });

  it('restarts an interrupted work job from the persisted task session and kind', async () => {
    fake();
    let fixture = worker();
    const home = fixture.h.home;
    fixture.h.fm.store.data.sessions['kit:t1'] = { sessionId: 'saved-thread', turns: 2, costUsd: 0, updatedAt: 1 };
    fixture.h.fm.store.data.backend.codex = { inflight: { kit: { kind: 'work', taskId: 't1', sessionKey: 'kit:t1', startedAt: 1 } }, stopped: [], ciFixes: {} };
    await fixture.backend.start();
    await until(() => child.messages.some((m) => m.method === 'turn/start'));
    await fixture.backend.stop();
    await fixture.h.fm.close();
    fake();
    fixture = worker(home);
    await fixture.backend.start();
    await until(() => child.messages.some((m) => m.method === 'turn/start'));
    expect(child.messages.find((m) => m.method === 'thread/resume')?.params?.threadId).toBe('saved-thread');
    expect(child.messages.find((m) => m.method === 'turn/start')?.params?.input).toEqual([expect.objectContaining({ text: expect.stringContaining('orchestrator restarted') })]);
    expect(inflight().kit).toMatchObject({ kind: 'work', taskId: 't1', sessionKey: 'codex:kit:t1' });
    expect(fixture.h.fm.tasks.require('t1')).toMatchObject({ assignee: 'kit', status: 'doing', worktree: 'kit-t1' });
    child.send({ id: 'finish-task', method: 'item/tool/call', params: { threadId: 'saved-thread', tool: 'update_task', arguments: { task_id: 't1', status: 'blocked', blocked_reason: 'fixture complete' } } });
    await until(() => child.messages.some((m) => m.id === 'finish-task'));
    expect(child.messages.find((m) => m.id === 'finish-task')?.result).toMatchObject({ success: true });
    child.send({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'turn-1', status: 'completed' } } });
    await until(() => !inflight().kit);
    expect(fixture.h.fm.store.data.sessions['kit:t1']).toMatchObject({ sessionId: 'saved-thread', turns: 3, lastResult: 'completed' });
    expect(fixture.h.fm.agent('kit')?.state).toBe('blocked');
  });
});
