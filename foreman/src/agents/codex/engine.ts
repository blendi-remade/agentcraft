// The Codex engine: one `codex app-server` process per turn (like one Claude CLI per turn). The
// agent's thread is durable (its id is the session id), so a later turn resumes it in a new process.
//
// What the agent may do is decided the same way as for Claude agents:
// - approvalPolicy "untrusted": Codex asks before every command it does not consider trivially safe;
//   each ask goes through AgentCraft's policy (policy.ts) and, if needed, an in-game prompt
// - sandbox: workers write only their worktree (+ its git dir, for commits), the lead nothing; no
//   network inside the sandbox (a command that needs it asks again, through the same policy)
// - the team tools (send_message, ask_user, update_task...) are dynamic tools answered here
// - none of the user's own Codex setup leaks in: their MCP servers, plugins, apps, web search,
//   image generation and notify hooks are off for agent threads (their Codex app is untouched)
// - commands run with the git safety environment (no push, no hooks, the agent's own identity),
//   passed explicitly because Codex drops variables named like secrets (GIT_CONFIG_KEY_0...)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CodexConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';
import type { AgentTool } from '../tools.js';
import { CODEX_NOT_FOUND, findCodex } from './find.js';
import { AppServer } from './rpc.js';
import { CodexStreamMapper, shellCommand } from './stream.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Codex features an agent thread does not get. */
const OFF_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'plugins',
  'realtime_conversation',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_suggest',
];

const CLIENT_INFO = { name: 'agentcraft', title: 'AgentCraft', version: '0.1.0' };

function notes(role: Role, tools: AgentTool[]): string {
  return [
    '',
    '# Working in AgentCraft (Codex)',
    `- The AgentCraft team tools (${tools.map((t) => t.name).join(', ')}) are function tools: call them directly. They are how the team and ${userName()} see your work; plain text only shows on your monitor.`,
    '- Where these instructions mention Read, Grep or Glob, read and search files with your shell (e.g. rg). Edit files with apply_patch.',
    process.platform === 'win32' ? '- In PowerShell, use npm.cmd and npx.cmd for npm/npx commands. Their .ps1 launchers can fail under the Windows sandbox even when the .cmd launchers work.' : '',
    `- Every command is checked against AgentCraft's policy, and anything it cannot allow by itself is shown to ${userName()}, who may deny it. Never work around a denial: find another way or use ask_user.`,
    `- Do not spawn sub-agents, do not search the web, and ask questions only with ask_user (not request_user_input).`,
    role === 'lead' ? '- You are read-only: never modify files or run commands that change anything.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Variables the agent's commands need beyond the user's environment (git safety, identity). */
function envDelta(env: Record<string, string | undefined>, inherited = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && inherited[k] !== v) out[k] = v;
  return out;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface CodexEngineOptions {
  /** the codex CLI (tests: node with a fake app-server script in `args`) */
  bin?: string;
  /** arguments before `app-server` */
  args?: string[];
}

export class CodexEngine implements Engine {
  readonly id = 'codex' as const;
  readonly label = 'Codex';
  /** the model in the user's Codex config (read at the auth check) */
  private configuredModel: string | undefined;

  constructor(
    private fm: Foreman,
    private cfg: CodexConfig,
    private opts: CodexEngineOptions = {},
  ) {}

  private bin(): string | undefined {
    return this.opts.bin ?? findCodex(this.cfg.path);
  }

  private serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform !== 'win32') return env;
    // Windows sandbox setup scans LOCALAPPDATA/OpenAI/Codex/runtimes even when MCP is off.
    // Older Codex builds try to repair ACLs on active desktop EXEs and fail with sharing
    // violations (openai/codex#51822). Give our server its own app-data root; shell commands
    // get the original environment back below. The sandbox and the user's Codex home stay intact.
    const localAppData = path.join(this.fm.config.dataDir, 'codex-localappdata');
    fs.mkdirSync(localAppData, { recursive: true });
    const isolated = { ...env };
    for (const key of Object.keys(isolated)) if (key.toUpperCase() === 'LOCALAPPDATA') delete isolated[key];
    isolated.LOCALAPPDATA = localAppData;
    return isolated;
  }

  model(role: Role): string {
    const configured = role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
    return configured && configured !== 'default' ? configured : this.configuredModel ?? 'default';
  }

  authFailedMessage(detail: string): string {
    return `Codex authentication failed (${detail}). Run \`codex login\`, then restart the Foreman.`;
  }

  private async initialize(server: AppServer): Promise<void> {
    await server.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } }, 30_000);
    server.notify('initialized');
  }

  async checkAuth(): Promise<AuthCheck> {
    const bin = this.bin();
    if (!bin) return { ok: false, message: CODEX_NOT_FOUND };
    const server = new AppServer(bin, { cwd: os.homedir(), env: this.serverEnv(process.env), ...(this.opts.args ? { args: this.opts.args } : {}) });
    try {
      await this.initialize(server);
      const cfg = await server.request<any>('config/read', {}, 30_000).catch(() => undefined);
      if (typeof cfg?.config?.model === 'string') this.configuredModel = cfg.config.model;
      const r = await server.request<any>('account/read', {}, 30_000);
      const a = r?.account;
      if (!a && r?.requiresOpenaiAuth !== false) return { ok: false, message: 'Codex is not logged in. Run `codex login` (ChatGPT or an OpenAI API key), then restart the Foreman. The sim backend still works.' };
      const account = a?.type === 'chatgpt' ? `ChatGPT${a.planType ? ` ${a.planType}` : ''}` : a?.type === 'apiKey' ? 'OpenAI API key' : a?.type === 'amazonBedrock' ? 'Amazon Bedrock' : 'ok';
      return { ok: true, account };
    } catch (e) {
      return { ok: false, message: `Codex check failed: ${errorText(e)}. Check that \`codex\` works and you are logged in (\`codex login\`), then restart the Foreman. The sim backend still works.` };
    } finally {
      server.close();
    }
  }

  /** Config overrides for an agent thread (see the header). `userConfig`: the effective config. */
  private threadConfig(userConfig: any, spec: TurnSpec, serverEnv: NodeJS.ProcessEnv): Record<string, unknown> {
    const off = (names: string[]) => Object.fromEntries(names.map((n) => [n, { enabled: false }]));
    const effort = spec.role === 'lead' ? this.cfg.leadEffort : this.cfg.effort;
    return {
      mcp_servers: off(Object.keys(userConfig?.mcp_servers ?? {})),
      plugins: off(Object.keys(userConfig?.plugins ?? {})),
      features: Object.fromEntries(OFF_FEATURES.map((f) => [f, false])),
      web_search: 'disabled',
      notify: [],
      include_apps_instructions: false,
      // Preserve both the git-safety variables Codex normally filters and any values isolated
      // for the app-server itself (LOCALAPPDATA on Windows).
      shell_environment_policy: { set: { ...envDelta(spec.env), ...envDelta(spec.env, serverEnv) } },
      sandbox_workspace_write: { writable_roots: spec.writableRoots ?? [], network_access: false },
      ...(effort ? { model_reasoning_effort: effort } : {}),
    };
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const bin = this.bin();
    if (!bin) throw new Error(CODEX_NOT_FOUND);
    const { agentId, role, cwd, abort } = spec;
    const mapper = new CodexStreamMapper(this.fm, agentId, cwd, role);
    const serverEnv = this.serverEnv(spec.env);
    const server = new AppServer(bin, {
      cwd,
      env: serverEnv,
      ...(this.opts.args ? { args: this.opts.args } : {}),
      onStderr: (s) => this.fm.log.debug(`[${agentId} codex] ${s.trim().slice(0, 300)}`),
    });
    spec.onProcess(server.child);
    const tools = new Map(spec.tools.map((t) => [t.name, t]));
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));

    server.onNotification((method, params: any) => {
      // only our own thread reaches the world (Codex could start helper threads of its own)
      if (params?.threadId && threadId && params.threadId !== threadId) return;
      if (abort.signal.aborted) return;
      mapper.handle(method, params);
      if (method === 'turn/completed' && (!turnId || params?.turn?.id === turnId)) finish();
    });
    server.onRequest((method, params) => this.answer(method, params as any, spec, () => threadId, mapper, tools));

    const onAbort = () => {
      if (threadId && turnId) server.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => undefined);
      const t = setTimeout(() => server.close(), 2_000);
      t.unref?.();
      finish();
    };
    if (abort.signal.aborted) onAbort();
    else abort.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.initialize(server);
      const userConfig = (await server.request<any>('config/read', { cwd }, 30_000).catch(() => undefined))?.config;
      if (typeof userConfig?.model === 'string') this.configuredModel ??= userConfig.model;
      const model = role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
      const dynamicTools = spec.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.inputSchema)) }));
      const thread = {
        cwd,
        approvalPolicy: 'untrusted',
        sandbox: role === 'lead' ? 'read-only' : 'workspace-write',
        config: this.threadConfig(userConfig, spec, serverEnv),
        developerInstructions: spec.instructions + notes(role, spec.tools),
        dynamicTools,
        ...(model && model !== 'default' ? { model } : {}),
      };
      let started: any;
      if (spec.resume) {
        started = await server.request<any>('thread/resume', { threadId: spec.resume, ...thread }, 60_000).catch((e) => {
          this.fm.log.warn(`${agentId}: could not resume Codex thread ${spec.resume} (${errorText(e)}); starting a new one`);
          return undefined;
        });
      }
      if (!started) {
        started = await server.request<any>('thread/start', { ...thread, serviceName: 'agentcraft' }, 60_000);
        const task = this.fm.agent(agentId)?.taskId;
        server.request('thread/name/set', { threadId: started.thread.id, name: `AgentCraft · ${this.fm.nameOf(agentId)}${task ? ` · ${task}` : ''}` }, 10_000).catch(() => undefined);
      }
      threadId = started.thread.id as string;
      mapper.stats.sessionId = threadId;
      spec.onSession(threadId);
      if (typeof started.model === 'string' && started.model) spec.onModel?.(started.model);
      if (abort.signal.aborted) return mapper.stats;
      const turn = await server.request<any>('turn/start', { threadId, input: [{ type: 'text', text: spec.prompt, text_elements: [] }] }, 60_000);
      turnId = turn?.turn?.id;
      // until the turn completes, the turn is stopped, or the process dies
      const died = server.exited.then(() => {
        if (!abort.signal.aborted) throw new Error(`codex app-server exited during the turn${server.stderr().length ? `: ${truncate(server.stderr().slice(-3).join(' | '), 300)}` : ''}`);
      });
      await Promise.race([finished, died]);
      return mapper.stats;
    } finally {
      abort.signal.removeEventListener('abort', onAbort);
      server.close();
    }
  }

  /** The app-server's own requests: approvals (-> policy / the user) and our team tools. */
  private async answer(method: string, params: any, spec: TurnSpec, thread: () => string | undefined, mapper: CodexStreamMapper, tools: Map<string, AgentTool>): Promise<unknown> {
    const ours = !!params?.threadId && params.threadId === thread();
    const { cwd, abort } = spec;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        if (!ours) return { decision: 'decline' };
        if (params.kind === 'writeStdin') return { decision: 'accept' }; // input to a command already approved
        const sc = shellCommand(String(params.command ?? ''));
        const r = await spec.permission(sc.tool, { command: sc.command }, abort.signal, params.reason ?? undefined);
        return { decision: r.allow ? 'accept' : r.interrupt ? 'cancel' : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        if (!ours) return { decision: 'decline' };
        const paths = mapper.fileChangePaths(String(params.itemId));
        if (!paths.length && params.grantRoot) paths.push(String(params.grantRoot));
        if (!paths.length) return { decision: 'decline' };
        for (const p of paths) {
          const r = await spec.permission('Edit', { file_path: path.resolve(cwd, p) }, abort.signal, params.reason ?? undefined);
          if (!r.allow) return { decision: r.interrupt ? 'cancel' : 'decline' };
        }
        return { decision: 'accept' };
      }
      case 'item/tool/call': {
        const reply = (text: string, success: boolean) => ({ success, contentItems: [{ type: 'inputText', text }] });
        if (!ours) return reply('Not available in this thread.', false);
        const t = tools.get(String(params.tool));
        if (!t) return reply(`Unknown tool ${params.tool}. Available: ${[...tools.keys()].join(', ')}`, false);
        const parsed = z.object(t.inputSchema).safeParse(params.arguments ?? {});
        if (!parsed.success) return reply(`Invalid arguments for ${t.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, false);
        const res = await t.handler(parsed.data, abort.signal);
        return reply(res.content.map((c) => c.text).join('\n'), !res.isError);
      }
      case 'item/tool/requestUserInput': {
        const msg = `(Not available in AgentCraft: ask ${userName()} with the ask_user tool instead.)`;
        return { answers: Object.fromEntries(((params?.questions ?? []) as Array<{ id: string }>).map((q) => [q.id, { answers: [msg] }])) };
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: { denied: { rejection: 'AgentCraft answers approvals through the v2 API only' } } };
      default:
        throw new Error(`AgentCraft does not handle ${method}`);
    }
  }
}
