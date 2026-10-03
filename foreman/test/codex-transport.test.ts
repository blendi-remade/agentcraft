import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { AppServerTransport } from '../src/agents/codex/transport.js';

function fake() {
  const events = new EventEmitter();
  const stdin = new PassThrough(), stdout = new PassThrough();
  const child = Object.assign(events, { stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  const messages: unknown[] = [];
  stdin.on('data', (chunk) => messages.push(JSON.parse(String(chunk))));
  return { child, stdout, messages, transport: new AppServerTransport(child, 50) };
}

describe('Codex JSONL transport', () => {
  it('frames split UTF-8 JSONL, interleaves notifications and correlates responses', async () => {
    const f = fake(), notified = vi.fn(); f.transport.onNotification = notified;
    const response = f.transport.request('initialize');
    f.stdout.write('{"method":"notice","params":{"text":"hello"}}\n{"id":');
    f.stdout.write('1,"result":{"ready":true}}\n');
    expect(await response).toEqual({ ready: true });
    expect(notified).toHaveBeenCalledWith('notice', { text: 'hello' });
    expect(f.messages).toEqual([{ id: 1, method: 'initialize', params: {} }]);
    f.transport.close();
  });
  it('keeps server/client request ID namespaces separate', async () => {
    const f = fake(); f.transport.onRequest = async () => ({ success: true });
    const response = f.transport.request('initialize');
    f.stdout.write('{"id":1,"method":"item/tool/call","params":{}}\n');
    await new Promise((r) => setImmediate(r));
    expect(f.messages).toContainEqual({ id: 1, result: { success: true } });
    f.stdout.write('{"id":1,"result":{"ready":true}}\n');
    expect(await response).toEqual({ ready: true }); f.transport.close();
  });
  it('does not dispatch queued server requests after close', async () => {
    const f = fake(), handler = vi.fn(async () => ({})); f.transport.onRequest = handler;
    f.stdout.write('{"id":"late","method":"item/tool/call","params":{}}\n');
    expect(f.transport.pendingServerRequests).toBe(1); f.transport.close();
    await new Promise((r) => setImmediate(r)); expect(handler).not.toHaveBeenCalled();
    expect(f.transport.pendingServerRequests).toBe(0);
  });
  it('returns an error for unsupported server requests', async () => {
    const f = fake(); f.stdout.write('{"id":"server-1","method":"unsupported","params":{}}\n');
    await new Promise((r) => setImmediate(r));
    expect(f.messages).toContainEqual({ id: 'server-1', error: { code: -32603, message: 'Unsupported Codex server request: unsupported' } }); f.transport.close();
  });
  it.each(['not-json\n', '[]\n', '{"id":null,"result":{}}\n', '{"method":"bad","params":[]}\n', '{"not":"rpc"}\n'])('fails pending requests on malformed input %s', async (line) => {
    const f = fake(), response = f.transport.request('test'); f.stdout.write(line);
    await expect(response).rejects.toThrow(/Malformed/); expect((await f.transport.closed).message).toMatch(/Malformed/); f.transport.close();
  });
  it('rejects JSON-RPC errors without treating them as results', async () => {
    const f = fake(), response = f.transport.request('thread/start');
    f.stdout.write('{"id":1,"error":{"code":-32602,"message":"unsupported"}}\n');
    await expect(response).rejects.toThrow('unsupported'); f.transport.close();
  });
  it('fails on EOF even when the child exits successfully', async () => {
    const f = fake(), response = f.transport.request('turn/start'); f.stdout.end();
    await expect(response).rejects.toThrow('stdout ended'); f.transport.close();
  });
  it('bounds incomplete messages', async () => {
    const f = fake(), transport = new AppServerTransport(f.child, 50, 10), response = transport.request('test');
    f.stdout.write('12345678901'); await expect(response).rejects.toThrow('size limit'); transport.close(); f.transport.close();
  });
  it('bounds stalled requests and rejects future requests after close', async () => {
    const f = fake(); await expect(f.transport.request('missing')).rejects.toThrow('timed out');
    await expect(f.transport.request('later')).rejects.toThrow('closed'); f.transport.close();
  });
});
