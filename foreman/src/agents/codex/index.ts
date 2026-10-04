import { codexCommand } from './launch.js';
import { modelChoices, type ModelChoice } from './model-settings.js';
import { resumeThread } from './thread-session.js';
// Codex RPC transport; SharedRunner owns queues, worktrees, approvals, CI and review.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodexConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import { ClientError, type Foreman } from '../../foreman.js';
import { withGitSafety } from '../../gitsafety.js';
import { agentGitIdentity } from '../../util/git.js';
import { truncate } from '../../util/text.js';
import { CodexAppServer, type CodexServerRequest } from './app-server.js';
import { CodexStreamMapper, codexToolResult, codexToolStarted } from './stream.js';
import { buildCodexTools } from './tools.js';
import type { TurnHandle } from '../claude/tools.js';

import { SharedRunner } from '../shared-runner.js';
import type { ExecutionAdapter, ExecutionProvider, ProviderCapabilities, Running, TurnContext, TurnStats } from '../execution-types.js';
interface CodexRunning extends Running { server?: CodexAppServer; threadId?: string; turnId?: string }
/**
 * Environment for an agent's CLI process (and every command it runs): git refuses all
 * transports (no push, ever) and never signs; git does not walk up out of the agent's cwd; the
 * agent's commits carry its own placeholder identity ("AgentCraft Kit <kit@agentcraft.local>"),
 * never the user's; and each Bash call starts in the agent's own cwd, so a `cd` in one command
 * cannot carry the next one out of the worktree.
 */
export function codexEnv(base: NodeJS.ProcessEnv = process.env, who: { agentId?: string; cwd?: string } = {}): NodeJS.ProcessEnv {
  return withGitSafety(
    base,
    {
      AGENTCRAFT_FOREMAN_VERSION: FOREMAN_VERSION,
      ...(who.agentId ? { AGENTCRAFT_AGENT_ID: who.agentId } : {}),
      ...(who.agentId ? (agentGitIdentity(who.agentId) as Record<string, string>) : {}),
    },
    who.cwd ? { ceiling: path.dirname(path.resolve(who.cwd)) } : {},
  );
}

export interface CodexBackendOptions {
  /** skip the startup auth probe (tests) */
  skipAuthCheck?: boolean;
}

export class CodexAdapter implements ExecutionAdapter {
  readonly provider = 'codex' as const;
  private codexPath?: string;
  private stopping = false;
  constructor(private fm: Foreman, private cfg: CodexConfig, private opts: CodexBackendOptions = {}) {}
  private catalog?: { at: number; models: ModelChoice[] };
  private catalogPending?: Promise<ModelChoice[]>;
  private catalogServer?: CodexAppServer;

  private availableModels(): Promise<ModelChoice[]> {
    if (this.stopping) return Promise.reject(new ClientError("Foreman is stopping."));
    if (this.catalog && Date.now() - this.catalog.at < 30_000) return Promise.resolve(this.catalog.models);
    if (this.catalogPending) return this.catalogPending;
    this.catalogPending = (async () => {
      const binaryPath = this.codexPath ?? this.resolveCodexBinary();
      if (!binaryPath) throw new ClientError('Codex CLI was not found.');
      const server = new CodexAppServer({binaryPath,cwd:os.tmpdir(),env:process.env,
        onNotification:()=>{},onServerRequest:async()=>{throw new Error('No active agent turn');}});
      this.catalogServer = server;
      try {
        await server.start();
        const models: ModelChoice[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const response = await server.request('model/list', {limit:100, ...(cursor ? {cursor} : {})}) as { data?: unknown; nextCursor?: string };
          models.push(...modelChoices(response.data));
          cursor = response.nextCursor || undefined;
          if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new ClientError('Codex model catalog pagination failed.');
          if (cursor) seen.add(cursor);
        } while (cursor);
        this.catalog = {at:Date.now(), models};
        return models;
      } finally { await server.close(); this.catalogServer = undefined; }
    })().finally(() => { this.catalogPending = undefined; });
    return this.catalogPending;
  }

  async checkAuth(capabilities?: ProviderCapabilities): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.codexPath = capabilities?.binaryPath ?? this.resolveCodexBinary();
      this.fm.setStatus({ auth: 'ok', account: 'ChatGPT', message: `Codex app-server${this.cfg.model ? ` (${this.cfg.model})` : ''}` });
      return true;
    }
    this.fm.setStatus({ auth: 'checking', message: 'Checking local Codex login...' });
    try {
      const binary = capabilities?.binaryPath ?? this.resolveCodexBinary();
      if (!binary) throw new Error('Codex CLI was not found');
      this.codexPath = binary;
      const launch = codexCommand(binary, ['login', 'status']);
      const result = spawnSync(launch.command, launch.args, { cwd: os.tmpdir(), env: process.env, encoding: 'utf8', timeout: 20_000, windowsHide: true });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.error || result.status !== 0 || !/logged in/i.test(output) || /not logged in|logged out/i.test(output)) throw new Error('the local Codex login is unavailable');
      // Status is visible in Minecraft: expose the provider only, never account identifiers.
      this.fm.setStatus({ auth: 'ok', account: 'ChatGPT', message: `Codex app-server${this.cfg.model ? ` (${this.cfg.model})` : ''}` });
      this.fm.log.info('Codex ChatGPT login is available');
      return true;
    } catch {
      this.markAuthFailed("Codex login check failed. Install Codex CLI and sign in with 'codex login', then restart the Foreman.");
      return false;
    }
  }

  private resolveCodexBinary(): string | undefined {
    const explicit = [this.cfg.binaryPath, process.env.CODEX_CLI_PATH].filter((value): value is string => !!value);
    const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
    const candidates = [
      ...explicit,
      ...pathEntries.flatMap((entry) => names.map((name) => path.join(entry, name))),
      path.join(os.homedir(), '.local', 'bin', 'codex'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile() || fs.statSync(candidate).isSymbolicLink()) return candidate;
      } catch {
        /* try the next installed location */
      }
    }
    return undefined;
  }

  private markAuthFailed(message: string): void {
    this.fm.setStatus({ auth: 'failed', message });
    this.fm.log.error(message);
    this.fm.bus.feed('error', message);
    this.fm.notify('warn', message);
    if (process.stdout.isTTY) process.stdout.write('\x07');
  }

  private env(who: { agentId?: string; cwd?: string } = {}): NodeJS.ProcessEnv {
    return codexEnv(process.env, who);
  }

  private async handleServerRequest(
    request: CodexServerRequest,
    entry: CodexRunning,
    context: TurnContext,
    codexTools: ReturnType<typeof buildCodexTools>,
    where: { cwd: string; role: 'lead' | 'worker' },
    turn: TurnHandle,
  ): Promise<unknown> {
    const params = request.params ?? {};
    if (turn.signal.aborted) throw new Error('Turn stopped');
    if (request.method === 'item/tool/call') {
      if (typeof params.threadId === 'string' && entry.threadId && params.threadId !== entry.threadId) throw new Error('Tool call belongs to a different Codex thread');
      const name = typeof params.tool === 'string' ? params.tool : '';
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
      codexToolStarted(this.fm, entry.job.agentId, where.cwd, name, args);
      const result = await codexTools.call(name, args);
      codexToolResult(this.fm, entry.job.agentId, result);
      return { contentItems: [{ type: 'inputText', text: result.text }], success: result.success };
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      const command = typeof params.command === 'string' ? params.command : '';
      const cwd = typeof params.cwd === 'string' ? params.cwd : where.cwd;
      // The sandbox root belongs to the job, never to an approval request.
      const quotedCwd = "'" + path.resolve(cwd).replaceAll("'", "'\"'\"'") + "'";
      const policyCommand = path.resolve(cwd) === path.resolve(where.cwd) ? command : `cd ${quotedCwd} && ${command}`;
      const allowed = await context.permissionGranted('Bash', { command: policyCommand }, typeof params.reason === 'string' ? params.reason : undefined);
      return { decision: allowed ? 'accept' : turn.signal.aborted ? 'cancel' : 'decline' };
    }
    if (request.method === 'item/fileChange/requestApproval') {
      const root = typeof params.grantRoot === 'string' ? params.grantRoot : where.cwd;
      // A proposed grant root is not an inventory of changed files.
      const answer = await context.askUser(`Codex requests file-change approval.\nProposed root: ${root}\nReason: ${String(params.reason ?? 'No reason supplied')}\nRequest: ${JSON.stringify(params)}`, ['Allow once', 'Deny']);
      const allowed = answer === 'Allow once' && !turn.signal.aborted;
      return { decision: allowed ? 'accept' : turn.signal.aborted ? 'cancel' : 'decline' };
    }
    if (request.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const answers: Record<string, { answers: string[] }> = {};
      for (const value of questions) {
        if (!value || typeof value !== 'object') continue;
        const question = value as Record<string, unknown>;
        const id = typeof question.id === 'string' ? question.id : '';
        const choices = Array.isArray(question.options) ? question.options.map((item) => item && typeof item === 'object' && 'label' in item ? String((item as { label: unknown }).label) : '').filter(Boolean) : [];
        const answer = await context.askUser(typeof question.question === 'string' ? question.question : 'Codex needs your input.', choices);
        if (id) answers[id] = { answers: answer ? [answer] : [] };
      }
      return { answers };
    }
    if (request.method === 'item/permissions/requestApproval') {
      const reason = typeof params.reason === 'string' ? params.reason : 'Codex requests additional file or network access.';
      const requested = params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions) ? params.permissions as Record<string, unknown> : {};
      const answer = await context.askUser(`${reason}\nRequested permissions: ${JSON.stringify(requested)}`, ['Allow once', 'Deny']);
      return { permissions: answer === 'Allow once' && !turn.signal.aborted ? requested : {}, scope: 'turn' };
    }
    this.fm.log.warn(`Unsupported Codex app-server request: ${request.method}`);
    throw new Error(`Unsupported Codex request ${request.method}`);
  }

  async execute(context: TurnContext): Promise<TurnStats> {
    const entry = context.entry as CodexRunning;
    const {job, abort} = entry;
    const agentId = job.agentId;
    const {turn, cwd, policyRole: role, resume, systemAppend} = context;
    const where = {cwd, role};
    const {model, effort} = context.selection;
    let server: CodexAppServer | undefined;
    try {
      entry.model = model;
      entry.effort = effort;
      this.fm.agentLog(agentId, 'text', `${resume ? 'Resuming' : 'Starting'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (${model ?? 'Codex default model'})`);
      if (job.kind === 'followup' || job.resumed) this.fm.agentLog(agentId, 'text', truncate(context.prompt, 400));
      const mapper = new CodexStreamMapper(this.fm, agentId, cwd, role);
      const codexTools = buildCodexTools(this.fm, agentId, role, context.hooks, turn);
      let threadId: string | undefined;
      let completeTurn: ((value: Record<string, unknown>) => void) | undefined;
      const turnComplete = new Promise<Record<string, unknown>>((resolve) => { completeTurn = resolve; });
      const binaryPath = context.capabilities?.binaryPath ?? this.codexPath ?? this.resolveCodexBinary();
      if (!binaryPath) throw new Error('Codex CLI was not found');
      server = new CodexAppServer({
        binaryPath,
        cwd,
        env: this.env({ agentId, cwd }),
        onNotification: (method, params) => {
          if (method === 'turn/completed' && params.threadId === threadId) completeTurn?.(params.turn as Record<string, unknown>);
          if (!abort.signal.aborted) mapper.handle(method, params);
        },
        onServerRequest: (request) => this.handleServerRequest(request, entry, context, codexTools, where, turn),
      });
      entry.server = server;
      entry.interrupt = () => { if (entry.threadId && entry.turnId) void server?.interrupt(entry.threadId, entry.turnId); else void server?.close(100); };
      entry.spawnedAt = Date.now();

      await server.start();
      entry.child = server.process;
      abort.signal.throwIfAborted();

      // App attachment is not part of Foreman's tool surface. Override the inherited
      // app defaults for this thread; Codex expects a structured `_default` entry.
      const config = {
        apps: { _default: { enabled: false, approvals_reviewer: 'user', destructive_enabled: false, open_world_enabled: false, default_tools_approval_mode: 'prompt' } },
        web_search: 'disabled',
        approval_policy: 'on-request',
        sandbox_mode: role === 'lead' ? 'read-only' : 'workspace-write',
      };
      const modelConfig = model ? { model } : {};
      const effortConfig = effort ? { effort } : {};
      const threadConfig = {
        ...modelConfig,
        ...effortConfig,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        approvalPolicy: 'on-request',
        sandbox: role === 'lead' ? 'read-only' : 'workspace-write',
        config,
        developerInstructions: systemAppend,
      };
      const threadResponse = resume
        ? await resumeThread(server, resume, threadConfig, role === 'lead', () => {
          this.fm.agentLog(agentId, 'text', 'Recovered an idle Codex session in a new thread with its completed history.');
        })
        : await server.request('thread/start', { ...threadConfig, dynamicTools: codexTools.dynamicTools });
      abort.signal.throwIfAborted();
      const thread = (threadResponse as { thread?: { id?: string; model?: string | null }; model?: string }).thread;
      threadId = thread?.id;
      if (!threadId) throw new Error('Codex app-server returned no thread id');
      entry.threadId = threadId;
      const actualModel = (threadResponse as { model?: string }).model ?? thread?.model ?? model ?? 'Codex default model';
      mapper.stats.sessionId = threadId;
      mapper.stats.model = actualModel;
      entry.model = actualModel;
      context.recordSession(threadId, actualModel);

      const prompt = context.prompt;
      const sandboxPolicy = role === 'lead'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      const turnResponse = await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd,
        runtimeWorkspaceRoots: [cwd],
        approvalPolicy: 'on-request',
        sandboxPolicy,
        ...modelConfig,
        ...effortConfig,
      }) as { turn?: { id?: string } };
      abort.signal.throwIfAborted();
      entry.turnId = turnResponse.turn?.id;
      if (!entry.turnId) throw new Error('Codex app-server returned no turn id');
      await Promise.race([
        turnComplete,
        server.disconnected.then(() => { throw new Error('Codex app-server disconnected before completing its turn'); }),
        new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      return mapper.stats;
    } finally {
      if (server) {
        if (entry.threadId) await server.unsubscribe(entry.threadId).catch(() => this.fm.log.warn(`could not release ${agentId}'s Codex thread before closing its app-server`));
        await server.close().catch(error => this.fm.log.debug(`Codex app-server cleanup: ${(error as Error).message}`));
      }
    }
  }
  async close(): Promise<void> { this.stopping = true; await this.catalogServer?.close(); }
  models(): Promise<ModelChoice[]> { return this.availableModels(); }
}
export class CodexBackend extends SharedRunner {
  private adapter: CodexAdapter;
  constructor(fm: Foreman, cfg: CodexConfig, opts: CodexBackendOptions = {}) {
    const adapter = new CodexAdapter(fm, cfg, opts);
    super(fm, {provider:'codex', config:cfg, adapters:{codex:adapter}, legacySessions:true});
    this.adapter = adapter;
  }
  protected override availableModels(provider: ExecutionProvider = 'codex'): Promise<ModelChoice[]> {
    return provider === 'codex' ? this.adapter.models() : super.availableModels(provider);
  }
}
