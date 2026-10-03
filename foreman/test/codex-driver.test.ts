import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CodexDriver, threadOverrides, validateExecutable } from '../src/agents/codex/driver.js';
import type { CodexConfig } from '../src/config.js';
import type { Foreman } from '../src/foreman.js';
import type { DriverSpawnOptions, DriverTurnContext } from '../src/agents/driver.js';
import type { RpcObject } from '../src/agents/codex/transport.js';

const cfg = { executable: 'codex', leadModel: '', workerModel: '' } as CodexConfig;
function setup(options: { role?: 'lead' | 'worker'; config?: RpcObject; version?: string; resume?: string; maxTurns?: number; onStart?: (f: ReturnType<typeof setup>) => void } = {}) {
  const sent: RpcObject[] = [], spawned: DriverSpawnOptions[] = [];
  let server: ChildProcess;
  const control = new AbortController();
  const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  const fm = { agentLog: vi.fn(), setAgent: vi.fn(), setStatus: vi.fn(), agent: vi.fn(() => undefined), repos: { scheduleRefresh: vi.fn() } } as unknown as Foreman;
  function child(): ChildProcess {
    const events = new EventEmitter();
    const out = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn((signal: NodeJS.Signals) => { out.signalCode = signal; out.emit('exit', null, signal); out.emit('close', null, signal); return true; }) });
    return out as unknown as ChildProcess;
  }
  const notify = (method: string, params: RpcObject) => server.stdout!.emit('data', `${JSON.stringify({ method, params })}\n`);
  const reply = (id: unknown, result: unknown) => server.stdout!.emit('data', `${JSON.stringify({ id, result })}\n`);
  const serverRequest = (id: string, method: string, params: RpcObject) => server.stdout!.emit('data', `${JSON.stringify({ id, method, params })}\n`);
  const complete = (status = 'completed', error?: RpcObject) => notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status, error } });
  const spawnProcess = (o: DriverSpawnOptions) => {
    spawned.push(o);
    const c = child();
    if (o.args[0] === '--version') {
      queueMicrotask(() => { c.stdout!.emit('data', `codex-cli ${options.version ?? '0.159.2'}\n`); Object.assign(c, { exitCode: 0 }); c.emit('exit', 0, null); c.emit('close', 0, null); });
      return c;
    }
    server = c;
    c.stdin!.on('data', (chunk) => {
      const msg = JSON.parse(String(chunk)) as RpcObject; sent.push(msg);
      if (!msg.method) return;
      queueMicrotask(() => {
        if (msg.method === 'initialize') reply(msg.id, {});
        if (msg.method === 'config/read') reply(msg.id, { config: options.config ?? {} });
        if (msg.method === 'account/read') reply(msg.id, { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
        if (msg.method === 'thread/start' || msg.method === 'thread/resume') reply(msg.id, { thread: { id: 'thread-1' }, cwd: '/repo', approvalPolicy: 'never', sandbox: options.role === 'worker' ? { type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: false } });
        if (msg.method === 'turn/start') {
          reply(msg.id, { turn: { id: 'turn-1', status: 'inProgress' } });
          notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } });
          setImmediate(() => options.onStart ? options.onStart(f) : complete());
        }
        if (msg.method === 'turn/interrupt') reply(msg.id, {});
      });
    });
    return c;
  };
  const ctx: DriverTurnContext = {
    fm, agentId: 'marlow', role: options.role ?? 'lead', cwd: '/repo', prompt: 'hello', systemAppend: 'instructions', model: '', effort: 'high', maxTurns: options.maxTurns ?? 10,
    ...(options.resume ? { resume: options.resume } : {}), turn: { signal: control.signal, reason: () => undefined }, abortController: control,
    tools: [{ name: 'send_message', description: 'Send a message', inputSchema: { text: z.string() }, handler }],
    canUseTool: vi.fn(async (_tool, input) => ({ behavior: 'allow' as const, updatedInput: input })), spawnProcess, onSession: vi.fn(),
  };
  const driver = new CodexDriver(cfg, { spawnProcess, requestTimeoutMs: 100, shutdownTimeoutMs: 1 });
  const f = { driver, ctx, handler, spawned, sent, notify, reply, serverRequest, complete, control, get server() { return server; } };
  return f;
}
const flush = () => new Promise((r) => setImmediate(r));
const validCall = { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'mcp__agentcraft__send_message', arguments: { text: 'hello' } };

describe('Codex driver', () => {
  it('starts a hardened thread and turn, preserves CLI model and records session before completion', async () => {
    const f = setup(); const result = await f.driver.runTurn(f.ctx);
    expect(result).toMatchObject({ isError: false, subtype: 'success', sessionId: 'thread-1' }); expect(result.costUsd).toBeUndefined();
    expect(f.ctx.onSession).toHaveBeenCalledWith('thread-1');
    const start = f.sent.find((m) => m.method === 'thread/start')!.params as RpcObject;
    expect(start).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', environments: [] }); expect(start.model).toBeUndefined();
    expect((start.dynamicTools as RpcObject[])[0]).toMatchObject({ type: 'function', name: 'mcp__agentcraft__send_message' });
    expect(f.sent.find((m) => m.method === 'turn/start')!.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
    expect(f.server.kill).toHaveBeenCalled();
  });
  it('resumes only the saved Codex thread and reapplies worker sandbox', async () => {
    const f = setup({ role: 'worker', resume: 'thread-1' }); expect((await f.driver.runTurn(f.ctx)).isError).toBe(false);
    expect(f.sent.find((m) => m.method === 'thread/resume')!.params).toMatchObject({ threadId: 'thread-1', sandbox: 'workspace-write' });
    expect(f.sent.some((m) => m.method === 'thread/start')).toBe(false);
  });
  it('validates dynamic tools, asks shared policy, and returns success/error content', async () => {
    const f = setup({ onStart: (f) => { f.serverRequest('request-1', 'item/tool/call', validCall); } });
    const run = f.driver.runTurn(f.ctx); await flush(); await flush(); await flush();
    expect(f.handler).toHaveBeenCalledTimes(1); expect(f.ctx.canUseTool).toHaveBeenCalled();
    expect(f.sent).toContainEqual({ id: 'request-1', result: { contentItems: [{ type: 'inputText', text: 'ok' }], success: true } });
    f.complete(); expect((await run).isError).toBe(false);
  });
  it.each([
    { ...validCall, tool: 'unknown' }, { ...validCall, namespace: 'elsewhere' }, { ...validCall, threadId: 'other' },
    { ...validCall, turnId: 'old' }, { ...validCall, arguments: { text: 4 } }, { ...validCall, arguments: { text: 'ok', unexpected: true } },
  ])('denies invalid/stale dynamic tool without mutations: %j', async (call) => {
    const f = setup({ onStart: (f) => f.serverRequest('r', 'item/tool/call', call) }); const run = f.driver.runTurn(f.ctx);
    await flush(); await flush(); await flush(); expect(f.handler).not.toHaveBeenCalled();
    expect(f.sent.find((m) => m.id === 'r')!.result).toMatchObject({ success: false }); f.complete(); await run;
  });
  it('does not repeat duplicate call IDs', async () => {
    const f = setup({ onStart: (f) => { f.serverRequest('r1', 'item/tool/call', validCall); f.serverRequest('r2', 'item/tool/call', validCall); } });
    const run = f.driver.runTurn(f.ctx); await flush(); await flush(); await flush(); expect(f.handler).toHaveBeenCalledTimes(1); f.complete(); await run;
  });
  it('denies all native sandbox expansion and unknown requests', async () => {
    const f = setup({ onStart: (f) => {
      f.serverRequest('command', 'item/commandExecution/requestApproval', validCall);
      f.serverRequest('file', 'item/fileChange/requestApproval', validCall);
      f.serverRequest('permissions', 'item/permissions/requestApproval', validCall);
      f.serverRequest('unknown', 'surprise/request', validCall);
    } });
    const run = f.driver.runTurn(f.ctx); await flush(); await flush(); await flush();
    expect(f.sent).toContainEqual({ id: 'command', result: { decision: 'decline' } });
    expect(f.sent).toContainEqual({ id: 'file', result: { decision: 'decline' } });
    expect(f.sent).toContainEqual({ id: 'permissions', result: { permissions: {}, scope: 'turn' } });
    expect(f.sent.find((m) => m.id === 'unknown')!.error).toBeDefined(); f.complete(); await run;
  });
  it('rejects unsupported version before starting app-server', async () => {
    const f = setup({ version: '0.158.0' }); await expect(f.driver.runTurn(f.ctx)).rejects.toThrow('unsupported'); expect(f.spawned).toHaveLength(1);
  });
  it('counts completed work items and interrupts at the local step cap', async () => {
    const f = setup({ maxTurns: 1, onStart: (f) => f.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', status: 'completed' } }) });
    const result = await f.driver.runTurn(f.ctx); expect(result).toMatchObject({ isError: true, subtype: 'max_steps', numTurns: 1 });
    expect(f.sent.some((m) => m.method === 'turn/interrupt')).toBe(true);
  });
  it('treats EOF and failed turn status as errors, never success', async () => {
    const eof = setup({ onStart: (f) => f.server.stdout!.emit('end') }); expect((await eof.driver.runTurn(eof.ctx)).isError).toBe(true);
    const failed = setup({ onStart: (f) => f.complete('failed', { message: 'Unauthorized' }) });
    expect(await failed.driver.runTurn(failed.ctx)).toMatchObject({ isError: true, subtype: 'failed', authFailed: 'Unauthorized' });
  });
  it('cancels active turn and never runs a subsequent dynamic call', async () => {
    const f = setup({ onStart: (f) => { f.control.abort(); f.serverRequest('late', 'item/tool/call', validCall); } });
    expect((await f.driver.runTurn(f.ctx)).isError).toBe(true); expect(f.handler).not.toHaveBeenCalled();
    expect(f.sent.some((m) => m.method === 'turn/interrupt')).toBe(true);
  });
  it('fails premature terminal events with queued dynamic calls and prevents late effects', async () => {
    const f = setup({ onStart: (f) => { f.serverRequest('pending', 'item/tool/call', validCall); f.complete(); } });
    const result = await f.driver.runTurn(f.ctx);
    expect(result.isError).toBe(true); expect(result.errors.join(' ')).toContain('dynamic tool was pending');
    expect(f.handler).not.toHaveBeenCalled(); expect(f.control.signal.aborted).toBe(true);
  });
  it('does not execute a policy-delayed dynamic call after protocol failure', async () => {
    let allow!: (value: { behavior: 'allow' }) => void;
    const f = setup({ onStart: (f) => f.serverRequest('pending', 'item/tool/call', validCall) });
    f.ctx.canUseTool = vi.fn(() => new Promise<{ behavior: 'allow' }>((resolve) => { allow = resolve; }));
    const running = f.driver.runTurn(f.ctx); await flush(); await flush(); await flush();
    f.server.stdout!.emit('end'); expect((await running).isError).toBe(true);
    allow({ behavior: 'allow' }); await flush(); expect(f.handler).not.toHaveBeenCalled();
  });
  it('probes auth without starting any thread or turn', async () => {
    const f = setup(); expect(await f.driver.checkAuth(f.ctx.fm)).toBe(true);
    expect(f.sent.some((m) => m.method === 'account/read')).toBe(true); expect(f.sent.some((m) => String(m.method).startsWith('thread/') || String(m.method).startsWith('turn/'))).toBe(false);
  });
});

describe('Codex safety configuration', () => {
  const who = { role: 'worker' as const, cwd: '/repo', agentId: 'kit' };
  it('disables inherited MCP individually and constrains shell env and writable roots', () => {
    const config = threadOverrides({ mcp_servers: { normal: {} } }, who);
    expect(config['mcp_servers.normal.enabled']).toBe(false); expect(config['shell_environment_policy.inherit']).toBe('none');
    expect(config['shell_environment_policy.set']).toMatchObject({ GIT_ALLOW_PROTOCOL: 'agentcraft-none', GIT_CEILING_DIRECTORIES: path.dirname(path.resolve('/repo')) });
    expect(config['shell_environment_policy.set']).not.toHaveProperty('GIT_DIR');
    expect(config['sandbox_workspace_write.writable_roots']).toEqual([path.resolve('/repo')]);
  });
  it.each(['set', 'filters', 'include_only', 'exclude'])('rejects ambiguous inherited %s configuration', (key) => {
    expect(() => threadOverrides({ shell_environment_policy: { [key]: key === 'set' || key === 'filters' ? { unsafe: 'value' } : ['*'] } }, who)).toThrow('cannot safely merge');
  });
  it.each(['bad.name', 'bad"name', 'bad\nname'])('rejects ambiguous dotted MCP IDs %s', (name) => {
    expect(() => threadOverrides({ mcp_servers: { [name]: {} } }, who)).toThrow('cannot be safely overridden');
  });
  it('never uses Windows shell shims', () => { expect(() => validateExecutable('C:\\bin\\codex.cmd', 'win32')).toThrow('native codex.exe'); expect(() => validateExecutable('C:\\bin\\codex.exe', 'win32')).not.toThrow(); });
});
