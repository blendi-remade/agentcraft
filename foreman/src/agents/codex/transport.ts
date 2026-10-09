// The stable app-server protocol is JSON-RPC over newline-delimited stdio.
// Keep process ownership and tool execution in the runtime, outside the transport.
import type { ChildProcess } from 'node:child_process';

export type RpcObject = Record<string, unknown>;
export function object(value: unknown): value is RpcObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export class AppServerTransport {
  private sequence = 0;
  private buffer = '';
  private failure?: Error;
  private drainTimer?: NodeJS.Timeout;
  private pending = new Map<number, { resolve(value: RpcObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private finish!: (error: Error) => void;
  readonly closed = new Promise<Error>(resolve => { this.finish = resolve; });
  onNotification: (method: string, params: RpcObject) => void = () => {};
  onRequest: (method: string, params: RpcObject) => unknown = method => { throw new RpcError(-32601, `Unsupported Codex request: ${method}`); };

  constructor(private child: ChildProcess, private timeoutMs = 30_000, private maxMessageChars = 8 * 1024 * 1024) {
    if (!child.stdin || !child.stdout) throw new Error('Codex app-server requires piped stdin/stdout');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stdout.on('end', () => this.fail(new Error('Codex app-server closed before the conversation finished')));
    child.stdout.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    child.on('close', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`)));
    child.on('exit', (code, signal) => {
      // Node can report exit before the last stdout data. Drain it, but do not wait
      // forever if a descendant inherited the pipe and keeps it open after exit.
      if (!this.failure) {
        this.drainTimer = setTimeout(() => this.fail(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`)), 1000);
        this.drainTimer.unref();
      }
    });
  }

  request(method: string, params: RpcObject, timeoutMs = this.timeoutMs): Promise<RpcObject> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Codex app-server timed out: ${method}`)), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: RpcObject = {}): void { this.send({ method, params }); }

  private send(message: RpcObject): void {
    if (this.failure) return;
    try { this.child.stdin!.write(`${JSON.stringify(message)}\n`); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.length > this.maxMessageChars) { this.fail(new Error('Codex app-server message exceeds size limit')); return; }
      if (!line.trim()) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (!object(message)) throw new Error('expected an object');
        this.dispatch(message);
      } catch (error) {
        this.fail(new Error(`Invalid Codex app-server message: ${(error as Error).message}`));
      }
      if (this.failure) return;
    }
    if (this.buffer.length > this.maxMessageChars) this.fail(new Error('Codex app-server message exceeds size limit'));
  }

  private dispatch(message: RpcObject): void {
    const { id } = message;
    if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') throw new Error('invalid request ID');
    if (typeof message.method === 'string') {
      if (message.params !== undefined && !object(message.params)) throw new Error('invalid request parameters');
      const params = (message.params ?? {}) as RpcObject;
      if (id === undefined) { this.onNotification(message.method, params); return; }
      // Server and client request IDs occupy independent namespaces.
      const reject = (error: unknown) => this.send({ id, error: { code: error instanceof RpcError ? error.code : -32603, message: (error as Error).message } });
      try {
        const result = this.onRequest(message.method, params);
        if (result instanceof Promise) void result.then(value => this.send({ id, result: value }), reject);
        else this.send({ id, result });
      } catch (error) { reject(error); }
      return;
    }
    if (id === undefined || ('result' in message) === ('error' in message)) throw new Error('invalid response');
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id as number);
    clearTimeout(pending.timer);
    if (object(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
      pending.reject(new RpcError(message.error.code, message.error.message));
    } else if (object(message.result)) pending.resolve(message.result);
    else {
      const error = new Error('Codex app-server returned an invalid response');
      pending.reject(error);
      this.fail(error);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.finish(error);
  }

  close(): void {
    this.fail(new Error('Codex app-server connection closed'));
    this.child.stdin?.end();
  }
}
