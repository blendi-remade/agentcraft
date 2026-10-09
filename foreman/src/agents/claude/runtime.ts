import { spawn } from 'node:child_process';
import { createSdkMcpServer, query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import type { AgentRuntime, TurnRequest, TurnStats } from '../runtime.js';
import { AuthenticationError, isAuthenticationMessage } from '../runtime.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from './auth.js';
import { MCP_SERVER } from '../tools.js';
import { StreamMapper } from './stream.js';
import type { Foreman } from '../../foreman.js';
import { userName } from '../../user.js';

export interface ClaudeBackendOptions {
  queryFn?: typeof query;
  skipAuthCheck?: boolean;
}

export class ClaudeRuntime implements AgentRuntime {
  readonly name = 'claude' as const;
  readonly label = 'Claude';
  private queryFn: typeof query;
  constructor(private fm: Foreman, private cfg: ClaudeConfig, private opts: ClaudeBackendOptions = {}) {
    this.queryFn = opts.queryFn ?? query;
  }
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return withAuthMode(base, this.cfg.useClaudeLogin); }

  async checkAuth(): Promise<string> {
    if (this.opts.skipAuthCheck) return 'test';
    const api = detectApiAuth(process.env);
    if (!this.cfg.useClaudeLogin && !api.ok) throw new Error(NO_API_AUTH_MESSAGE);
    async function* never(): AsyncGenerator<never> { await new Promise(() => undefined); }
    const q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: this.env(process.env) } });
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out after 45s')), 45_000);
      })]);
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      return this.cfg.useClaudeLogin
        ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') || info.apiProvider || 'ok'
        : [api.ok ? api.source : 'API', info.organization].filter(Boolean).join(' · ');
    } catch (e) {
      throw new Error(`${this.cfg.useClaudeLogin ? 'Claude login' : 'Claude API'} check failed: ${(e as Error).message}. ${this.cfg.useClaudeLogin ? 'Run `claude` and /login' : 'Check ANTHROPIC_API_KEY (or your cloud provider settings)'}, then restart the Foreman. The sim backend still works.`);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }

  async run(r: TurnRequest): Promise<TurnStats> {
    const agentId = r.agentId;
    const mapper = new StreamMapper(this.fm, agentId, r.cwd, r.role);
    const options: Options = {
      cwd: r.cwd, model: r.model, effort: r.effort, maxTurns: r.maxTurns,
      settingSources: [], permissionMode: 'default', canUseTool: r.canUseTool,
      tools: r.role === 'lead' ? ['Read', 'Grep', 'Glob', 'Bash'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      disallowedTools: ['Bash(git push:*)', 'Task', 'Agent', 'WebSearch', 'WebFetch'],
      mcpServers: { [MCP_SERVER]: createSdkMcpServer({ name: MCP_SERVER, version: '0.1.0', tools: r.tools, alwaysLoad: true, instructions: `AgentCraft team tools: coordinate with teammates, ask ${userName()}, keep memory and the task board up to date.` }) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: r.systemPrompt },
      abortController: r.abortController, env: r.env,
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (s: string) => this.fm.log.debug(`[${agentId} stderr] ${s.trim().slice(0, 300)}`));
        child.on('error', (e) => this.fm.log.debug(`[${agentId}] CLI process error: ${e.message}`));
        r.onSpawn(child);
        return child;
      },
      ...(r.resume ? { resume: r.resume } : {}),
      ...(r.maxBudgetUsd ? { maxBudgetUsd: r.maxBudgetUsd } : {}),
    };
    const q = this.queryFn({ prompt: r.prompt, options });
    const close = () => { try { q.close(); } catch { /* already closed */ } };
    const signal = r.abortController.signal;
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });
    let model: string | undefined;
    try {
      for await (const msg of q) {
        if (signal.aborted) break;
        mapper.handle(msg);
        if (mapper.model && mapper.model !== model) {
          model = mapper.model;
          r.onModel?.(model);
        }
        if (mapper.stats.sessionId) r.onSession(mapper.stats.sessionId);
      }
      return mapper.stats;
    } catch (e) {
      if (e instanceof Error && isAuthenticationMessage(e.message)) throw new AuthenticationError(e.message);
      throw e;
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  }
}
