// Real subprocess/pipe coverage. The fixture is a Node program, never the user's Codex CLI.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServerTransport, type RpcObject } from '../src/agents/codex/transport.js';
import { CodexDriver } from '../src/agents/codex/driver.js';
import { buildTools, type ToolHooks } from '../src/agents/claude/tools.js';
import type { DriverSpawnOptions, DriverTurnContext } from '../src/agents/driver.js';
import { killSnapshot, type ProcEntry } from '../src/util/proc.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const children: ChildProcess[] = [];
const cleanup: string[] = [];
const clients: AppServerTransport[] = [];
const harnesses: Harness[] = [];
const orphanSnapshots: ProcEntry[] = [];
afterEach(async () => {
  // PID + creation time guards ensure a failing cleanup test can kill only its own orphan.
  await killSnapshot(orphanSnapshots.splice(0));
  for (const h of harnesses.splice(0)) await h.fm.close();
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null, 5000);
  }
  for (const dir of cleanup.splice(0)) rmrf(dir);
});

function launchFixture(mode = 'complete') {
  const dir = tempDir('ac-codex-process-');
  cleanup.push(dir);
  const trace = path.join(dir, 'trace.jsonl');
  const child = spawn(process.execPath, [fixture], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    env: { ...process.env, AGENTCRAFT_FAKE_CODEX_MODE: mode, AGENTCRAFT_FAKE_CODEX_TRACE: trace },
  });
  children.push(child);
  const client = new AppServerTransport(child, 5000);
  clients.push(client);
  const received = () => fs.existsSync(trace)
    ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; message?: RpcObject })
    : [];
  return { child, client, dir, received };
}

async function initialize(client: AppServerTransport) {
  const result = await client.request('initialize', { clientInfo: { name: 'agentcraft_fixture_test', title: 'AgentCraft fixture test', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  client.notify('initialized');
  return result;
}

describe('Codex app-server real-process JSONL transport', () => {
  it('completes initialize, configuration, thread, dynamic tool and turn over actual pipes', async () => {
    const { child, client, dir, received } = launchFixture();
    const notifications: Array<{ method: string; params: RpcObject }> = [];
    const calls: Array<{ method: string; params: RpcObject }> = [];
    client.onNotification = (method, params) => { notifications.push({ method, params }); };
    client.onRequest = async (method, params) => {
      calls.push({ method, params });
      expect(method).toBe('item/tool/call');
      expect(params.arguments).toEqual({ to: 'user', text: 'Hello from the fake Codex process.' });
      return { success: true, contentItems: [{ type: 'inputText', text: 'Sent to user.' }] };
    };
    expect((await initialize(client)).userAgent).toBe('codex-cli/0.159.2');
    expect(await client.request('config/read', { includeLayers: true })).toHaveProperty('config.mcp_servers', {});
    const thread = await client.request('thread/start', {
      cwd: dir, sandbox: 'read-only', approvalPolicy: 'never',
      dynamicTools: [{ type: 'function', name: 'send_message', description: 'Send a message', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] } }],
    });
    const threadId = (thread.thread as RpcObject).id;
    await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Run the fixture' }] });
    await until(() => notifications.some((n) => n.method === 'turn/completed'));
    expect(calls).toHaveLength(1);
    expect(notifications.find((n) => n.method === 'item/agentMessage/delta')?.params.delta).toBe('Fixture completed.');
    expect((notifications.find((n) => n.method === 'turn/completed')!.params.turn as RpcObject).status).toBe('completed');
    expect(received().filter((r) => r.message?.method).map((r) => r.message!.method)).toEqual(['initialize', 'initialized', 'config/read', 'thread/start', 'turn/start']);
    expect(received().find((r) => r.message?.id === 'fake-tool-request')?.message?.result).toMatchObject({ success: true });
    client.close();
    await until(() => child.exitCode !== null || child.signalCode !== null);
  });

  it('reports abrupt subprocess EOF before any turn completion', async () => {
    const { client, dir } = launchFixture('eof');
    const notifications: string[] = [];
    client.onNotification = (method) => { notifications.push(method); };
    await initialize(client);
    const thread = await client.request('thread/start', { cwd: dir, sandbox: 'read-only', approvalPolicy: 'never' });
    await client.request('turn/start', { threadId: (thread.thread as RpcObject).id, input: [{ type: 'text', text: 'Exit immediately' }] });
    const closed = await client.closed;
    expect(closed.message).toMatch(/stdout ended|exited/);
    expect(notifications).not.toContain('turn/completed');
    await expect(client.request('account/read')).rejects.toThrow(/closed/);
  });
});


function driverHarness(mode = 'complete', role: 'lead' | 'worker' = 'lead') {
  const dir = tempDir('ac-codex-driver-process-');
  cleanup.push(dir);
  const trace = path.join(dir, 'trace.jsonl');
  const writerOutput = path.join(dir, 'orphan-writes.txt');
  const h = makeForeman(dir, ['--backend', 'codex', '--workers', 'kit']);
  harnesses.push(h);
  const processes: ChildProcess[] = [];
  const spawnProcess = (options: DriverSpawnOptions) => {
    // Deliberately ignore the configured executable: only this known Node fixture can run.
    const child = spawn(process.execPath, [fixture, ...options.args], {
      cwd: options.cwd ?? dir, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...options.env, AGENTCRAFT_FAKE_CODEX_MODE: mode, AGENTCRAFT_FAKE_CODEX_TRACE: trace, AGENTCRAFT_FAKE_CODEX_WRITER: writerOutput },
    });
    processes.push(child);
    children.push(child);
    return child;
  };
  const readTrace = () => fs.existsSync(trace)
    ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; message?: RpcObject })
    : [];
  const driver = new CodexDriver({ ...h.cfg.codex, executable: 'fixture-codex-only' }, { spawnProcess, requestTimeoutMs: 5000, shutdownTimeoutMs: 100 });
  const abortController = new AbortController();
  const hooks: ToolHooks = { onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {}, onWaiting() {} };
  const turn = { signal: abortController.signal, reason: () => abortController.signal.aborted ? 'pause' : undefined };
  const agentId = role === 'lead' ? 'marlow' : 'kit';
  const sessions: string[] = [];
  let sessionBeforeTurn = false;
  const permission = vi.fn(async (_name: string, input: Record<string, unknown>) => ({ behavior: 'allow' as const, updatedInput: input }));
  const ctx: DriverTurnContext = {
    fm: h.fm, agentId, role, cwd: dir, prompt: 'Send the fixture message and finish.', systemAppend: 'Fixture instructions.',
    model: '', effort: 'medium', maxTurns: 5, turn, abortController,
    tools: buildTools(h.fm, agentId, role, hooks, turn), canUseTool: permission, spawnProcess,
    onSession(id) {
      sessions.push(id);
      sessionBeforeTurn = !readTrace().some((row) => row.message?.method === 'turn/start');
    },
  };
  return { h, driver, ctx, processes, sessions, permission, readTrace, writerOutput, sessionBeforeTurn: () => sessionBeforeTurn };
}

describe('Codex driver with real fake-app-server subprocesses', () => {
  it('probes auth through initialize/account only and always terminates its subprocesses', async () => {
    const { h, driver, processes, readTrace } = driverHarness();
    expect(await driver.checkAuth(h.fm)).toBe(true);
    expect(h.fm.status.auth).toBe('ok');
    expect(h.fm.status.account).toBe('ChatGPT login');
    expect(readTrace().filter((row) => row.message?.method).map((row) => row.message!.method)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(processes).toHaveLength(2); // A separate --version probe and app-server.
    expect(processes.every((p) => p.exitCode !== null || p.signalCode !== null)).toBe(true);
  });

  it('runs the complete driver, persists the session early and calls real shared team tools', async () => {
    const { h, driver, ctx, processes, sessions, permission, readTrace, sessionBeforeTurn } = driverHarness();
    const stats = await driver.runTurn(ctx);
    expect(stats.isError).toBe(false);
    expect(stats.subtype).toBe('success');
    expect(stats.resultText).toBe('Fixture completed.');
    expect(stats.costUsd).toBeUndefined();
    expect(sessions).toEqual(['019a0000-0000-7000-8000-000000000001']);
    expect(sessionBeforeTurn()).toBe(true);
    expect(permission).toHaveBeenCalledExactlyOnceWith('mcp__agentcraft__send_message', { to: 'user', text: 'Hello from the fake Codex process.' }, { signal: ctx.turn.signal });
    expect(h.fm.bus.inbox('user').some((m) => m.text === 'Hello from the fake Codex process.')).toBe(true);
    const sent = readTrace().filter((row) => row.message?.method).map((row) => row.message!);
    expect(sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'config/read', 'thread/start', 'turn/start']);
    const params = sent.find((m) => m.method === 'thread/start')!.params as RpcObject;
    expect(params.sandbox).toBe('read-only');
    expect(params.approvalPolicy).toBe('never');
    expect(params.environments).toEqual([]);
    expect(params.model).toBeUndefined();
    expect((params.config as RpcObject)['features.plugins']).toBe(false);
    expect((params.config as RpcObject)['shell_environment_policy.inherit']).toBe('none');
    expect(processes.every((p) => p.exitCode !== null || p.signalCode !== null)).toBe(true);
  });

  it('uses workspace-only policy for a worker and can resume the same saved thread', async () => {
    const { driver, ctx, readTrace } = driverHarness('complete', 'worker');
    ctx.resume = '019a0000-0000-7000-8000-000000000001';
    const stats = await driver.runTurn(ctx);
    expect(stats.isError).toBe(false);
    const sent = readTrace().filter((row) => row.message?.method).map((row) => row.message!);
    expect(sent.some((m) => m.method === 'thread/start')).toBe(false);
    const params = sent.find((m) => m.method === 'thread/resume')!.params as RpcObject;
    expect(params.threadId).toBe(ctx.resume);
    expect(params.sandbox).toBe('workspace-write');
    const turn = sent.find((m) => m.method === 'turn/start')!.params as RpcObject;
    expect(turn.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [ctx.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  });

  it('fails closed when app-server exits without a terminal turn event', async () => {
    const { driver, ctx, processes } = driverHarness('eof');
    const stats = await driver.runTurn(ctx);
    expect(stats.isError).toBe(true);
    expect(stats.subtype).not.toBe('success');
    expect(stats.errors.join(' ')).toMatch(/stdout ended|exited/);
    expect(processes.every((p) => p.exitCode !== null || p.signalCode !== null)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('stops an orphan writer before returning from an abrupt server crash', async () => {
    const { driver, ctx, readTrace, writerOutput } = driverHarness('eof-orphan');
    const stats = await driver.runTurn(ctx);
    const orphan = readTrace().find((row) => row.event === 'orphan') as unknown as { pid: number; ppid: number; created: string };
    expect(orphan).toBeDefined();
    expect(orphan.created).not.toBe('');
    orphanSnapshots.push({ ...orphan, createdMs: Date.parse(orphan.created) });
    // A zombie has exited and cannot write; its adoption/reaping belongs to the host's PID 1.
    const status = spawnSync('ps', ['-p', String(orphan.pid), '-o', 'stat='], { encoding: 'utf8' });
    const runningAtReturn = status.status === 0 && !status.stdout.trim().startsWith('Z');
    const atReturn = fs.readFileSync(writerOutput, 'utf8');
    expect(atReturn).toContain('started');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stats.isError).toBe(true);
    expect(stats.errors.join(' ')).toMatch(/stdout ended|exited/);
    expect(runningAtReturn).toBe(false);
    expect(fs.readFileSync(writerOutput, 'utf8')).toBe(atReturn);
  });

  it('interrupts and terminates an in-progress process when the turn is cancelled', async () => {
    const { driver, ctx, processes, readTrace, permission } = driverHarness('hang');
    const running = driver.runTurn(ctx);
    await until(() => readTrace().some((row) => row.message?.method === 'turn/start'));
    ctx.abortController.abort();
    const stats = await running;
    expect(stats.isError).toBe(true);
    expect(stats.subtype).toBe('interrupted');
    expect(stats.errors.join(' ')).toContain('stopped');
    expect(permission).not.toHaveBeenCalled();
    expect(processes.every((p) => p.exitCode !== null || p.signalCode !== null)).toBe(true);
  });
});
