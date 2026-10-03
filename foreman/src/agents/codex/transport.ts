// Versioned Codex app-server JSONL transport. No model requests are made by this class.
import type { ChildProcess } from 'node:child_process';

export type RpcId = number | string;
export type RpcObject = Record<string, unknown>;
export type ServerRequest = (method: string, params: RpcObject) => Promise<unknown>;
export type ServerNotification = (method: string, params: RpcObject) => void;

export function object(value: unknown): value is RpcObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AppServerTransport {
  private sequence = 0;
  private buffer = '';
  private ended = false;
  private serverRequests = 0;
  get pendingServerRequests(): number { return this.serverRequests; }
  private pending = new Map<RpcId, { resolve(value: RpcObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private resolveClosed!: (error: Error) => void;
  readonly closed = new Promise<Error>((resolve) => { this.resolveClosed = resolve; });
  onRequest: ServerRequest = async (method) => { throw new Error(`Unsupported Codex server request: ${method}`); };
  onNotification: ServerNotification = () => {};

  constructor(readonly child: ChildProcess, private timeoutMs = 30_000, private maxLineChars = 8 * 1024 * 1024) {
    if (!child.stdin || !child.stdout) throw new Error('Codex app-server requires piped stdin and stdout');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stdout.on('end', () => this.fail(new Error('Codex app-server stdout ended')));
    child.stdout.on('error', (error) => this.fail(error));
    child.stdin.on('error', (error) => this.fail(error));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`)));
  }

  request(method: string, params: RpcObject = {}, timeoutMs = this.timeoutMs): Promise<RpcObject> {
    if (this.ended) return Promise.reject(new Error('Codex app-server is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server timed out: ${method}`);
        reject(error);
        this.fail(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: RpcObject = {}): void { this.send({ method, params }); }

  private send(message: RpcObject): void {
    if (this.ended) return;
    try { this.child.stdin!.write(`${JSON.stringify(message)}\n`); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private receive(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.length > this.maxLineChars) { this.fail(new Error('Codex JSONL message exceeds size limit')); return; }
      if (!line.trim()) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (!object(message)) throw new Error('Expected a JSON-RPC object');
        this.dispatch(message);
      } catch (error) { this.fail(new Error(`Malformed Codex app-server message: ${(error as Error).message}`)); return; }
      if (this.ended) return;
    }
    if (this.buffer.length > this.maxLineChars) this.fail(new Error('Codex JSONL message exceeds size limit'));
  }

  private dispatch(message: RpcObject): void {
    const id = message.id;
    if (id !== undefined && typeof id !== 'number' && typeof id !== 'string') throw new Error('Invalid JSON-RPC id');
    if (typeof message.method === 'string') {
      if (message.params !== undefined && !object(message.params)) throw new Error('Invalid JSON-RPC params');
      const params = (message.params ?? {}) as RpcObject;
      if (id === undefined) { this.onNotification(message.method, params); return; }
      // Server requests have an independent ID space. Never match them to client requests.
      this.serverRequests++;
      void Promise.resolve().then(() => {
        if (this.ended) throw new Error('Codex app-server is closed');
        return this.onRequest(message.method as string, params);
      }).then(
        (result) => this.send({ id, result }),
        (error: unknown) => this.send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
      ).finally(() => { this.serverRequests--; });
      return;
    }
    if (id === undefined || (!('result' in message) && !('error' in message))) throw new Error('Invalid JSON-RPC response');
    const pending = this.pending.get(id);
    if (!pending) return; // A late response to a cancelled request is harmless.
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (object(message.error)) {
      pending.reject(new Error(`Codex RPC error ${String(message.error.code ?? '')}: ${String(message.error.message ?? 'unknown error')}`));
    } else if (object(message.result)) pending.resolve(message.result);
    else pending.reject(new Error('Invalid Codex RPC result'));
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.resolveClosed(error);
  }

  /** The orchestration layer reaps the process tree; stop the protocol immediately. */
  close(): void {
    this.fail(new Error('Codex app-server closed'));
    this.child.stdin?.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
}
