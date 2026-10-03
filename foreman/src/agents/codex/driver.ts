// Sandbox-only Codex integration. Contracts generated from CLI 0.159.2.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { CodexConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { gitSafetyEnv } from '../../gitsafety.js';
import { agentGitIdentity } from '../../util/git.js';
import { descendantsOf, killSnapshot, killTree, processTable } from '../../util/proc.js';
import { truncate } from '../../util/text.js';
import { toolActivity } from '../activity.js';
import type { AgentDriver, DriverSpawnOptions, DriverTurnContext, TurnStats } from '../driver.js';
import { AppServerTransport, object, type RpcObject } from './transport.js';

export const SUPPORTED_CODEX_VERSION = '0.159.2';
const AUTH_RE = /authentication|not logged in|invalid api key|unauthorized|oauth|401|credential/i;
const DISABLED_FEATURES = ['apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode', 'hooks', 'shell_snapshot', 'shell_zsh_fork', 'request_permissions_tool', 'skill_mcp_dependency_install', 'workspace_dependencies', 'image_generation'];
const CORE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
const WORK_ITEMS = new Set(['agentMessage', 'commandExecution', 'fileChange', 'dynamicToolCall', 'mcpToolCall', 'webSearch', 'collabToolCall']);
export interface CodexDriverOptions {
  /** Authentication/version probe injection. Turns use the scheduler's tracked spawn. */
  spawnProcess?: (options: DriverSpawnOptions) => ChildProcess;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
function defaultSpawn(o: DriverSpawnOptions): ChildProcess {
  const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  child.stderr?.resume(); // Drain diagnostics without exposing credential-bearing output.
  return child;
}
export function validateExecutable(executable: string, platform = process.platform): void {
  if (!executable || /[\r\n\0]/.test(executable)) throw new Error('Invalid Codex executable path');
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) throw new Error('Use --codex-path with native codex.exe. Windows .cmd/.bat shims are unsupported.');
}
function safeShellEnvironment(ctx: Pick<DriverTurnContext, 'cwd' | 'agentId'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CORE_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return { ...env, ...gitSafetyEnv({}, { ceiling: path.dirname(path.resolve(ctx.cwd)) }), ...(agentGitIdentity(ctx.agentId) as Record<string, string>) };
}
function baseOverrides(): RpcObject {
  return { approval_policy: 'never', approvals_reviewer: 'user', web_search: 'disabled', ...Object.fromEntries(DISABLED_FEATURES.map((feature) => [`features.${feature}`, false])) };
}
function cliArgs(): string[] {
  return ['app-server', '--listen', 'stdio://', '--strict-config', ...Object.entries(baseOverrides()).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
}
/** Empty config tables merge rather than erase. Reject ambiguous inherited shell settings. */
export function threadOverrides(config: RpcObject, ctx: Pick<DriverTurnContext, 'cwd' | 'agentId' | 'role'>): RpcObject {
  const shell = config.shell_environment_policy;
  if (shell != null && !object(shell)) throw new Error('Invalid Codex shell environment configuration');
  if (object(shell)) for (const key of ['set', 'filters', 'include_only', 'exclude']) {
    const value = shell[key];
    const populated = Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : value != null;
    if (populated) throw new Error(`Codex sandbox-only backend cannot safely merge shell_environment_policy.${key}. Remove that override from the selected Codex configuration, then retry.`);
  }
  const overrides: RpcObject = {
    ...baseOverrides(), 'shell_environment_policy.inherit': 'none', 'shell_environment_policy.experimental_use_profile': false,
    'shell_environment_policy.set': safeShellEnvironment(ctx),
    'sandbox_workspace_write.writable_roots': ctx.role === 'worker' ? [path.resolve(ctx.cwd)] : [],
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true,
  };
  if (config.mcp_servers != null && !object(config.mcp_servers)) throw new Error('Invalid Codex MCP configuration');
  if (object(config.mcp_servers)) for (const name of Object.keys(config.mcp_servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Codex MCP name cannot be safely overridden: ${JSON.stringify(name)}`);
    overrides[`mcp_servers.${name}.enabled`] = false;
  }
  return overrides;
}
function sandboxPolicy(ctx: Pick<DriverTurnContext, 'role' | 'cwd'>): RpcObject {
  return ctx.role === 'lead' ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [path.resolve(ctx.cwd)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}
function verifyThreadSafety(result: RpcObject, ctx: Pick<DriverTurnContext, 'cwd' | 'role'>): void {
  const sandbox = result.sandbox;
  if (result.approvalPolicy !== 'never' || !object(sandbox) || sandbox.networkAccess !== false) throw new Error('Codex did not confirm the required sandbox and approval policy');
  if (sandbox.type !== (ctx.role === 'lead' ? 'readOnly' : 'workspaceWrite')) throw new Error('Codex did not honor the requested sandbox');
  if (ctx.role === 'worker' && (!Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some((root) => typeof root !== 'string' || path.resolve(root) !== path.resolve(ctx.cwd)) || sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true)) throw new Error('Codex returned broader workspace-write access than requested');
  if (typeof result.cwd !== 'string' || path.resolve(result.cwd) !== path.resolve(ctx.cwd)) throw new Error('Codex returned a different working directory');
}
interface ProcessOwner { startedAt: number; created?: string; }
async function identifyChild(child: ChildProcess): Promise<ProcessOwner> {
  const owner: ProcessOwner = { startedAt: Date.now() };
  if (child.pid) owner.created = (await processTable())?.find((entry) => entry.pid === child.pid)?.created;
  return owner;
}
async function stopChild(child: ChildProcess, rpc: AppServerTransport | undefined, timeoutMs: number, owner?: ProcessOwner): Promise<void> {
  // Keep the identity of our detached root. An abruptly exited app-server can
  // leave commands in its group, or parent-linked descendants on Windows.
  if (child.pid) {
    const table = await processTable();
    const root = table?.find((entry) => entry.pid === child.pid);
    const reused = root && owner && (owner.created ? root.created !== owner.created : root.createdMs > owner.startedAt + 2000);
    if (!reused) {
      if (table) await killSnapshot(descendantsOf(table, child.pid), table);
      if (owner && process.platform !== 'win32') {
        // Driver processes are spawned detached. The known group remains ours
        // after its original leader exits; never target an observed reused PID.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      } else if (child.exitCode === null && child.signalCode === null) killTree(child);
    }
  }
  rpc?.close();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    let timer = setTimeout(() => {
      killTree(child);
      timer = setTimeout(done, timeoutMs);
      if (child.exitCode !== null || child.signalCode !== null) done();
    }, timeoutMs);
    child.once('exit', done);
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
}

export class CodexDriver implements AgentDriver {
  readonly name = 'codex' as const;
  readonly label = 'Codex';
  private versionChecked = false;
  private readonly timeout: number;
  private readonly shutdownTimeout: number;
  constructor(private config: CodexConfig, private options: CodexDriverOptions = {}) {
    validateExecutable(config.executable);
    this.timeout = options.requestTimeoutMs ?? 30_000;
    this.shutdownTimeout = options.shutdownTimeoutMs ?? 1000;
  }
  private async checkVersion(spawnProcess: (options: DriverSpawnOptions) => ChildProcess): Promise<void> {
    if (this.versionChecked) return;
    const child = spawnProcess({ command: this.config.executable, args: ['--version'], env: process.env });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Codex version check timed out')), this.timeout);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { if (output.length < 4096) output += chunk; });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Codex version check failed (${code})`)); });
      });
      const version = /codex-cli\s+(\d+\.\d+\.\d+)(?:\s|$)/.exec(output)?.[1];
      if (version !== SUPPORTED_CODEX_VERSION) throw new Error(`Codex ${version ?? 'unknown version'} is unsupported. This experimental adapter requires codex-cli ${SUPPORTED_CODEX_VERSION}.`);
      this.versionChecked = true;
    } finally { await stopChild(child, undefined, this.shutdownTimeout); }
  }
  private async initialize(rpc: AppServerTransport): Promise<void> {
    await rpc.request('initialize', { clientInfo: { name: 'agentcraft_foreman', title: 'AgentCraft Foreman', version: FOREMAN_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
    rpc.notify('initialized');
  }
  async checkAuth(fm: Foreman): Promise<boolean> {
    fm.setStatus({ auth: 'checking', message: 'Checking Codex CLI login...' });
    const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
    await this.checkVersion(spawnProcess);
    const child = spawnProcess({ command: this.config.executable, args: cliArgs(), env: process.env });
    const rpc = new AppServerTransport(child, this.timeout);
    const owner = await identifyChild(child);
    try {
      await this.initialize(rpc);
      const result = await rpc.request('account/read', { refreshToken: false });
      if (result.requiresOpenaiAuth !== false && !object(result.account)) throw new Error('Codex is not logged in. Run codex login, then restart Foreman.');
      const account = result.account;
      if (object(account) && !['chatgpt', 'apiKey', 'amazonBedrock'].includes(String(account.type))) throw new Error('Codex returned an unsupported account response');
      const label = object(account) && account.type === 'chatgpt' ? 'ChatGPT login' : object(account) && account.type === 'apiKey' ? 'API key' : 'configured provider';
      fm.setStatus({ auth: 'ok', account: label, message: `Codex (lead ${this.config.leadModel || 'CLI default'}, workers ${this.config.workerModel || 'CLI default'}). Sandbox-only; cost unavailable.` });
      return true;
    } finally { await stopChild(child, rpc, this.shutdownTimeout, owner); }
  }
  async runTurn(ctx: DriverTurnContext): Promise<TurnStats> {
    if (ctx.turn.signal.aborted) throw new Error('Codex turn was stopped');
    if (!Number.isInteger(ctx.maxTurns) || ctx.maxTurns < 1) throw new Error('Codex max-turns must be a positive completed-step limit');
    if (!['low', 'medium', 'high', 'xhigh'].includes(ctx.effort)) throw new Error(`Unsupported Codex effort: ${ctx.effort}`);
    await this.checkVersion(ctx.spawnProcess);
    if (ctx.turn.signal.aborted) throw new Error('Codex turn was stopped');
    const child = ctx.spawnProcess({ command: this.config.executable, args: cliArgs(), cwd: ctx.cwd, env: process.env });
    const rpc = new AppServerTransport(child, this.timeout);
    const owner = await identifyChild(child);
    const stats: TurnStats = { isError: false, errors: [], numTurns: 0 };
    let threadId = '', turnId = '';
    let terminal = false, acceptingEvents = false, stepLimitReached = false, activeCalls = 0;
    const seenItems = new Set<string>(), seenCalls = new Set<string>();
    const definitions = new Map(ctx.tools.map((tool) => [tool.name, { tool, schema: z.object(tool.inputSchema).strict() }]));
    let finish!: (turn: RpcObject) => void;
    const completed = new Promise<RpcObject>((resolve) => { finish = resolve; });
    let abort!: (error: Error) => void;
    const aborted = new Promise<Error>((resolve) => { abort = resolve; });
    const interrupt = (): void => { if (threadId && turnId && !terminal) void rpc.request('turn/interrupt', { threadId, turnId }, Math.min(this.timeout, 1000)).catch(() => {}); };
    const onAbort = (): void => { interrupt(); abort(new Error('Codex turn was stopped')); };
    ctx.turn.signal.addEventListener('abort', onAbort, { once: true });
    const request = async (method: string, params: RpcObject): Promise<RpcObject> => {
      if (ctx.turn.signal.aborted) throw new Error('Codex turn was stopped');
      const result = await Promise.race([rpc.request(method, params), aborted]);
      if (result instanceof Error) throw result;
      return result;
    };
    const logActivity = (tool: string, input: RpcObject): void => {
      const activity = toolActivity(tool, input, ctx.cwd);
      ctx.fm.agentLog(ctx.agentId, 'tool', truncate(activity.label, 1000));
      ctx.fm.setAgent(ctx.agentId, { state: activity.state, station: activity.station, activity: activity.activity });
      const repoId = ctx.fm.agent(ctx.agentId)?.repoId;
      if (repoId && ctx.role === 'worker' && ['editing', 'running', 'testing'].includes(activity.state)) ctx.fm.repos.scheduleRefresh(repoId, 1500);
    };
    const toolError = (text: string): RpcObject => ({ contentItems: [{ type: 'inputText', text }], success: false });
    rpc.onRequest = async (method, params) => {
      // These approvals may lift the sandbox; never expand permissions.
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
      if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
      if (method !== 'item/tool/call') throw new Error(`Unsupported Codex request (denied): ${method}`);
      if (ctx.turn.signal.aborted || terminal || stepLimitReached) return toolError('The turn has stopped; no action was taken.');
      if (params.threadId !== threadId || !turnId || params.turnId !== turnId || typeof params.callId !== 'string' || !params.callId) return toolError('Invalid or stale tool-call scope.');
      if (params.namespace != null || typeof params.tool !== 'string' || !params.tool.startsWith('mcp__agentcraft__')) return toolError('Unknown dynamic tool.');
      const name = params.tool.slice('mcp__agentcraft__'.length), definition = definitions.get(name);
      if (!definition) return toolError('Unknown dynamic tool.');
      if (seenCalls.has(params.callId)) return toolError('Duplicate dynamic tool call; no action was repeated.');
      seenCalls.add(params.callId);
      const parsed = definition.schema.safeParse(params.arguments);
      if (!parsed.success) return toolError(`Invalid ${name} arguments: ${parsed.error.message}`);
      activeCalls++;
      try {
        const permission = await ctx.canUseTool(params.tool, parsed.data as RpcObject, { signal: ctx.turn.signal });
        if (permission.behavior === 'deny') return toolError(permission.message);
        if (ctx.turn.signal.aborted || terminal || stepLimitReached) return toolError('The turn has stopped; no action was taken.');
        const validated = definition.schema.safeParse(permission.updatedInput ?? parsed.data);
        if (!validated.success) return toolError('Permission handler returned invalid arguments.');
        logActivity(params.tool, validated.data as RpcObject);
        const result = await definition.tool.handler(validated.data, { signal: ctx.turn.signal });
        const contentItems = result.content.filter((item) => item.type === 'text').map((item) => ({ type: 'inputText', text: String(item.text) }));
        if (!contentItems.length) contentItems.push({ type: 'inputText', text: result.isError ? 'Tool failed.' : 'Done.' });
        if (ctx.turn.signal.aborted || terminal) return toolError('The turn has stopped.');
        ctx.fm.agentLog(ctx.agentId, result.isError ? 'error' : 'result', truncate(contentItems.map((item) => item.text).join('\n'), 1000));
        return { contentItems, success: !result.isError };
      } catch (error) { return toolError(`Tool failed: ${(error as Error).message}`); }
      finally { activeCalls--; }
    };
    rpc.onNotification = (method, params) => {
      if (ctx.turn.signal.aborted || terminal || !acceptingEvents || params.threadId !== threadId) return;
      if (method === 'turn/started' && object(params.turn) && typeof params.turn.id === 'string') { turnId ||= params.turn.id; return; }
      if (typeof params.turnId === 'string' && turnId && params.turnId !== turnId) return;
      if (method === 'turn/completed') {
        if (!object(params.turn) || typeof params.turn.id !== 'string' || !turnId || params.turn.id !== turnId) return;
        terminal = true;
        if (activeCalls || rpc.pendingServerRequests) {
          abort(new Error('Codex completed while a dynamic tool was pending'));
          ctx.abortController.abort();
        } else finish(params.turn);
      } else if (method === 'item/started' && object(params.item)) {
        const item = params.item;
        if (item.type === 'commandExecution' && typeof item.command === 'string') logActivity('Bash', { command: item.command });
        else if (item.type === 'fileChange' && Array.isArray(item.changes)) for (const change of item.changes) if (object(change) && typeof change.path === 'string') logActivity('Edit', { file_path: change.path });
      } else if (method === 'item/completed' && object(params.item)) {
        const item = params.item;
        if (typeof item.id !== 'string' || seenItems.has(item.id)) return;
        seenItems.add(item.id);
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          ctx.fm.agentLog(ctx.agentId, 'text', truncate(item.text, 2000));
          if (item.phase === 'final_answer' || !item.phase) stats.resultText = item.text;
        } else if (item.type === 'commandExecution') ctx.fm.agentLog(ctx.agentId, item.status === 'failed' ? 'error' : 'result', truncate(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : `command ${String(item.status)}`, 1000));
        else if (item.type === 'fileChange' && Array.isArray(item.changes)) for (const change of item.changes) if (object(change) && typeof change.diff === 'string') ctx.fm.agentLog(ctx.agentId, 'diff', truncate(`${String(change.path)}\n${change.diff}`, 1800));
        if (WORK_ITEMS.has(String(item.type)) && !(item.type === 'agentMessage' && item.phase === 'final_answer')) {
          stats.numTurns = (stats.numTurns ?? 0) + 1;
          if (stats.numTurns >= ctx.maxTurns) {
            stepLimitReached = true; stats.isError = true; stats.subtype = 'max_steps';
            interrupt(); abort(new Error(`Codex reached the ${ctx.maxTurns} completed-step limit`));
          }
        }
      } else if (method === 'thread/tokenUsage/updated' && object(params.tokenUsage) && object(params.tokenUsage.last)) {
        const usage = params.tokenUsage.last;
        if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') ctx.fm.agentLog(ctx.agentId, 'result', `Codex tokens: ${usage.inputTokens} input, ${usage.outputTokens} output (USD cost unavailable)`);
      } else if (method === 'error' && object(params.error)) {
        const message = String(params.error.message ?? 'Codex error'); stats.errors.push(message);
        if (AUTH_RE.test(message)) stats.authFailed = message;
        ctx.fm.agentLog(ctx.agentId, 'error', truncate(message, 1000));
      }
    };
    try {
      await request('initialize', { clientInfo: { name: 'agentcraft_foreman', title: 'AgentCraft Foreman', version: FOREMAN_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify('initialized');
      const read = await request('config/read', { cwd: ctx.cwd, includeLayers: false });
      if (!object(read.config)) throw new Error('Codex returned no effective project configuration');
      const common = {
        cwd: ctx.cwd, runtimeWorkspaceRoots: [path.resolve(ctx.cwd)], approvalPolicy: 'never', approvalsReviewer: 'user',
        sandbox: ctx.role === 'lead' ? 'read-only' : 'workspace-write', config: threadOverrides(read.config, ctx),
        developerInstructions: `${ctx.systemAppend}\n\nAgentCraft Codex uses a network-disabled sandbox. Native escalation, external MCP/plugins, browser tools and Codex subagents are unavailable. References to Read/Grep/Glob in the shared instructions mean read-only file inspection through your sandboxed shell tools. Use the exact mcp__agentcraft__ tool names for coordination. Never bypass these limits.`,
        ...(ctx.model ? { model: ctx.model } : {}),
      };
      const start = await request(ctx.resume ? 'thread/resume' : 'thread/start', ctx.resume ? { ...common, threadId: ctx.resume }
        : { ...common, environments: [], dynamicTools: ctx.tools.map((tool) => ({ type: 'function', name: `mcp__agentcraft__${tool.name}`, description: tool.description, inputSchema: z.toJSONSchema(definitions.get(tool.name)!.schema, { target: 'draft-7' }) })) });
      verifyThreadSafety(start, ctx);
      if (!object(start.thread) || typeof start.thread.id !== 'string') throw new Error('Codex returned no thread ID');
      threadId = start.thread.id;
      if (ctx.resume && threadId !== ctx.resume) throw new Error('Codex resumed a different thread');
      stats.sessionId = threadId; ctx.onSession(threadId); acceptingEvents = true;
      const begun = await request('turn/start', { threadId, input: [{ type: 'text', text: ctx.prompt }], cwd: ctx.cwd, runtimeWorkspaceRoots: [path.resolve(ctx.cwd)], environments: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: sandboxPolicy(ctx), effort: ctx.effort, ...(ctx.model ? { model: ctx.model } : {}) });
      if (!object(begun.turn) || typeof begun.turn.id !== 'string') throw new Error('Codex returned no turn ID');
      if (turnId && turnId !== begun.turn.id) throw new Error('Codex turn ID mismatch');
      turnId = begun.turn.id;
      const outcome = await Promise.race([completed, rpc.closed, aborted]);
      if (outcome instanceof Error) throw outcome;
      if (!['completed', 'failed', 'interrupted'].includes(String(outcome.status))) throw new Error('Codex ended with an unknown turn status');
      stats.isError = stepLimitReached || outcome.status !== 'completed';
      stats.subtype ??= outcome.status === 'completed' ? 'success' : String(outcome.status);
      if (object(outcome.error)) {
        const message = String(outcome.error.message ?? 'Codex turn failed');
        if (!stats.errors.includes(message)) stats.errors.push(message);
        if (AUTH_RE.test(message)) stats.authFailed = message;
      }
      ctx.fm.agentLog(ctx.agentId, stats.isError ? 'error' : 'result', `Codex turn ${stats.subtype} (${stats.numTurns ?? 0} completed steps; USD cost unavailable)`);
      return stats;
    } catch (error) {
      stats.isError = true; stats.subtype ??= ctx.turn.signal.aborted ? 'interrupted' : 'error';
      const message = (error as Error).message;
      if (!stats.errors.includes(message)) stats.errors.push(message);
      if (AUTH_RE.test(message)) stats.authFailed = message;
      // Cancels outstanding ask_user/policy waits and blocks late tool effects.
      ctx.abortController.abort();
      return stats;
    } finally {
      terminal = true; ctx.turn.signal.removeEventListener('abort', onAbort);
      await stopChild(child, rpc, this.shutdownTimeout, owner);
    }
  }
}
