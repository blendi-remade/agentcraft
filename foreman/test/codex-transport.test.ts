import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServerTransport, RpcError } from '../src/agents/codex/transport.js';

const connections: AppServerTransport[] = [];
afterEach(() => { for (const rpc of connections.splice(0)) rpc.close(); });
function connection(timeoutMs = 1000, maxChars = 1024) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const sent: any[] = [];
  child.stdin.on('data', chunk => sent.push(JSON.parse(String(chunk))));
  const rpc = new AppServerTransport(child as unknown as ChildProcess, timeoutMs, maxChars);
  connections.push(rpc);
  const receive = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  return { rpc, child, sent, receive };
}

describe('Codex app-server transport', () => {
  it('handles fragmented/coalesced lines, out-of-order replies and colliding server request IDs', async () => {
    const { rpc, child, sent, receive } = connection();
    const notifications: string[] = [];
    rpc.onNotification = method => { notifications.push(method); };
    rpc.onRequest = () => ({ decision: 'decline' });
    const first = rpc.request('thread/start', {});
    const second = rpc.request('turn/start', {});
    child.stdout.write('{"id":2,"result":');
    child.stdout.write('{"turn":"second"}}\n{"method":"progress","params":{}}\n');
    receive({ id: 1, method: 'item/commandExecution/requestApproval', params: {} });
    expect(sent.at(-1)).toEqual({ id: 1, result: { decision: 'decline' } });
    receive({ id: 1, result: { thread: 'first' } });
    expect(await first).toEqual({ thread: 'first' });
    expect(await second).toEqual({ turn: 'second' });
    expect(notifications).toEqual(['progress']);
  });

  it('awaits async server requests without serializing notifications and translates handler failures', async () => {
    const { rpc, sent, receive } = connection();
    let resolve!: (value: unknown) => void;
    rpc.onRequest = () => new Promise(done => { resolve = done; });
    const notifications: string[] = [];
    rpc.onNotification = method => { notifications.push(method); };
    receive({ id: 20, method: 'item/tool/call', params: {} });
    receive({ method: 'progress', params: {} });
    expect(notifications).toEqual(['progress']);
    expect(sent).toEqual([]);
    resolve({ success: true });
    await Promise.resolve();
    expect(sent.at(-1)).toEqual({ id: 20, result: { success: true } });
    rpc.onRequest = async () => { throw new RpcError(-32602, 'bad arguments'); };
    receive({ id: 21, method: 'item/tool/call', params: {} });
    await Promise.resolve();
    expect(sent.at(-1)).toEqual({ id: 21, error: { code: -32602, message: 'bad arguments' } });
  });

  it('returns an RPC rejection without corrupting the connection', async () => {
    const { rpc, receive } = connection();
    const rejected = rpc.request('turn/steer', {}).catch(error => error);
    receive({ id: 1, error: { code: -32600, message: 'turn is complete' } });
    expect(await rejected).toBeInstanceOf(RpcError);
    const next = rpc.request('thread/read', {});
    receive({ id: 2, result: { thread: 'still available' } });
    expect(await next).toEqual({ thread: 'still available' });
  });

  it.each(['not JSON\n', '[]\n', '{"id":1}\n', '{"id":1,"result":[]}\n', 'x'.repeat(1025)])('fails closed on invalid or oversized messages', async message => {
    const { rpc, child } = connection();
    const pending = rpc.request('initialize', {}).catch(error => error);
    child.stdout.write(message);
    expect(await pending).toBeInstanceOf(Error);
    expect(await rpc.closed).toBeInstanceOf(Error);
    await expect(rpc.request('thread/start', {})).rejects.toThrow();
  });

  it('settles all pending requests when the subprocess exits', async () => {
    const { rpc, child } = connection();
    const pending = [rpc.request('one', {}), rpc.request('two', {})].map(p => p.catch(error => error));
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    expect((await Promise.all(pending)).every(error => error instanceof Error)).toBe(true);
    expect((await rpc.closed).message).toContain('exited');
  });

  it('drains a final response and completion notification that arrive after process exit', async () => {
    const { rpc, child, receive } = connection();
    const notifications: string[] = [];
    rpc.onNotification = method => { notifications.push(method); };
    const response = rpc.request('turn/steer', {});
    child.emit('exit', 0, null);
    receive({ id: 1, result: { turnId: 'finished' } });
    receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'finished', status: 'completed' } } });
    child.stdout.end();
    expect(await response).toEqual({ turnId: 'finished' });
    expect(notifications).toEqual(['turn/completed']);
    await rpc.closed;
  });

  it('bounds draining when a descendant holds stdout open after process exit', async () => {
    const { rpc, child } = connection(5000);
    const pending = rpc.request('turn/steer', {}).catch(error => error);
    child.emit('exit', 1, null);
    expect((await pending).message).toContain('exited (1)');
  });

  it('closes an indeterminate connection on request timeout', async () => {
    const { rpc } = connection(10);
    await expect(rpc.request('turn/steer', {})).rejects.toThrow('timed out');
    await expect(rpc.request('turn/start', {})).rejects.toThrow('timed out');
  });
});
