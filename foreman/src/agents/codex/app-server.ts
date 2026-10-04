import { codexCommand } from './launch.js';
import { spawn, execFile, type ChildProcess } from 'node:child_process';

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexAppServerOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onServerRequest: (request: CodexServerRequest) => Promise<unknown>;
  onStderr?: (text: string) => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** JSON-RPC stdio client for the installed Codex app-server. */
export class CodexAppServer {
  private child?: ChildProcess;
  private starting = false;
  private readonly probeAbort = new AbortController();
  private sequence = 0;
  private buffer = '';
  private closed = false;
  private disabledMcpServers: string[] = [];
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private exitPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private resolveDisconnected!: () => void;
  readonly disconnected = new Promise<void>((resolve) => { this.resolveDisconnected = resolve; });

  constructor(private readonly options: CodexAppServerOptions) {}

  get exited(): Promise<void> {
    return this.exitPromise ?? Promise.resolve();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get process(): ChildProcess | undefined {
    return this.child;
  }

  get exitCode(): number | null | undefined {
    return this.child?.exitCode;
  }

  get disabledMcpServerCount(): number {
    return this.disabledMcpServers.length;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Codex app-server is closed');
    if (this.child || this.starting) throw new Error('Codex app-server already started');
    this.starting = true;
    try {
      this.disabledMcpServers = await this.readConfiguredMcpServers();
    } finally {
      this.starting = false;
    }
    if (this.closed) throw new Error('Codex app-server is closed');
    const inertCommand = process.platform === 'win32' ? (this.options.env.COMSPEC ?? 'cmd.exe') : '/usr/bin/true';
    const inertArgs = process.platform === 'win32' ? ['/c', 'exit', '0'] : [];
    const mcpOverride = `mcp_servers={${this.disabledMcpServers.map((name) => `${JSON.stringify(name)}={command=${JSON.stringify(inertCommand)},args=${JSON.stringify(inertArgs)},enabled=false}`).join(',')}}`;
    const launch = codexCommand(this.options.binaryPath, ['app-server', '--listen', 'stdio://', '-c', 'features.apps=false', '-c', mcpOverride]);
    const child = spawn(launch.command, launch.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      const done = () => {
        child.removeListener('exit', done);
        child.removeListener('close', done);
        resolve();
      };
      child.once('exit', done);
      child.once('close', done); // failed spawns emit close without exit
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.read(chunk));
    child.stdout?.on('end', () => this.disconnect(new Error('Codex app-server output disconnected')));
    child.stdout?.on('error', (error) => this.disconnect(error));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.options.onStderr?.(chunk));
    child.stdin?.on('error', (error) => this.disconnect(error));
    child.on('error', (error) => this.disconnect(error));
    child.on('exit', (code, signal) => {
      this.disconnect(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})`));
    });
    child.on('close', () => this.disconnect(new Error('Codex app-server process closed')));

    await this.request('initialize', {
      clientInfo: { name: 'agentcraft-foreman', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
  }

  private async readConfiguredMcpServers(): Promise<string[]> {
    // A slow CLI must not freeze every agent and connected game client. Bound output and
    // kill on timeout/close; failure still prevents starting with inherited tool servers.
    const stdout = await new Promise<string>((resolve, reject) => {
      const launch = codexCommand(this.options.binaryPath, ['mcp', 'list', '--json']);
      execFile(launch.command, launch.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL',
        signal: this.probeAbort.signal,
        windowsHide: true,
      }, (error, output) => {
        if (error) reject(new Error('Could not inspect Codex MCP configuration; refusing to start with inherited tool servers.'));
        else resolve(output);
      });
    });
    let configured: unknown;
    try {
      configured = JSON.parse(stdout);
    } catch {
      throw new Error('Codex MCP configuration output was invalid; refusing to start with inherited tool servers.');
    }
    if (!Array.isArray(configured) || configured.some((item) => !item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string')) {
      throw new Error('Codex MCP configuration could not be parsed; refusing to start with inherited tool servers.');
    }
    const names = [...new Set(configured.map((item) => (item as { name: string }).name))];
    if (names.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error('A configured Codex MCP server has a name that cannot be safely disabled.');
    return names;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || this.closed) return Promise.reject(new Error('Codex app-server is not running'));
    const id = ++this.sequence;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Codex app-server request ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve, reject, timer });
      try {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
          if (!error) return;
          const pending = this.pending.get(key);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(key);
          pending.reject(error);
        });
      } catch (error) {
        const pending = this.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const child = this.child;
    if (!child?.stdin || this.closed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId }, 10_000).catch(() => undefined);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.request('thread/unsubscribe', { threadId }, 10_000);
  }

  close(graceMs = 1200): Promise<void> {
    return this.closePromise ??= this.doClose(graceMs);
  }

  private async doClose(graceMs: number): Promise<void> {
    this.disconnect(new Error('Codex app-server closed'));
    this.probeAbort.abort();
    this.child?.stdin?.end();
    const child = this.child;
    if (!child) return;
    await Promise.race([this.exitPromise ?? Promise.resolve(), delay(graceMs)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([this.exitPromise ?? Promise.resolve(), delay(1000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.receive(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.options.onStderr?.(`ignored non-JSON app-server output: ${line.slice(0, 300)}`);
      return;
    }
    if (message.method && message.id !== undefined) {
      const request = { id: message.id, method: message.method, params: message.params };
      void this.options.onServerRequest(request).then(
        (result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
        (error) => this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
      );
      return;
    }
    if (message.id !== undefined) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.options.onNotification(message.method, message.params ?? {});
  }

  private write(message: Record<string, unknown>): void {
    if (!this.closed) this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }

  private disconnect(error: Error): void {
    this.closed = true;
    this.failAll(error);
    this.resolveDisconnected();
  }
}
