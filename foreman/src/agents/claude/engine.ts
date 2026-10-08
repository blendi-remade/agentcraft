// The Claude engine: one Claude Agent SDK `query()` per turn. We spawn the CLI ourselves (same as
// the SDK's local spawn) so its pid is known and a stopped turn's whole process tree can be ended.
import { spawn } from 'node:child_process';
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from './auth.js';
import { StreamMapper } from './stream.js';
import { MCP_SERVER, mcpServer } from './tools.js';

export class ClaudeEngine implements Engine {
  readonly id = 'claude' as const;
  readonly label = 'Claude';

  constructor(
    private fm: Foreman,
    private cfg: ClaudeConfig,
    private queryFn: typeof query = query,
  ) {}

  model(role: Role): string {
    return role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
  }

  authFailedMessage(detail: string): string {
    return `Claude authentication failed (${detail}). Run \`claude\` and /login, then restart the Foreman.`;
  }

  /** "claude login" (opted in), else the API authentication the environment provides */
  authMode(): string {
    if (this.cfg.useClaudeLogin) return 'claude login';
    const api = detectApiAuth(process.env);
    return api.ok ? api.source : 'API key';
  }

  async checkAuth(): Promise<AuthCheck> {
    // API authentication by default; the claude.ai login only when explicitly opted into
    const api = detectApiAuth(process.env);
    const mode = this.authMode();
    if (!this.cfg.useClaudeLogin && !api.ok) return { ok: false, message: NO_API_AUTH_MESSAGE, mode };
    async function* never(): AsyncGenerator<never> {
      await new Promise(() => undefined);
    }
    const q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: withAuthMode({ ...process.env }, this.cfg.useClaudeLogin) } });
    try {
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timed out after 45s')), 45_000))]);
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      const account = this.cfg.useClaudeLogin
        ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') || info.apiProvider || 'ok'
        : [api.ok ? api.source : 'API', info.organization].filter(Boolean).join(' · ');
      return { ok: true, account, mode };
    } catch (e) {
      return {
        ok: false,
        mode,
        message: this.cfg.useClaudeLogin
          ? `Claude login check failed: ${(e as Error).message}. Run \`claude\` and /login, then restart the Foreman. The sim backend still works.`
          : `Claude API check failed: ${(e as Error).message}. Check ANTHROPIC_API_KEY (or your cloud provider settings), then restart the Foreman. The sim backend still works.`,
      };
    } finally {
      try {
        q.close();
      } catch {
        /* ignore */
      }
    }
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const { agentId, role, cwd, abort } = spec;
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      const r = await spec.permission(toolName, input, opts.signal, opts.title);
      return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: r.message, ...(r.interrupt ? { interrupt: true } : {}) };
    };
    const options: Options = {
      cwd,
      model: this.model(role),
      effort: role === 'lead' ? this.cfg.leadEffort : this.cfg.effort,
      maxTurns: role === 'lead' ? this.cfg.maxTurnsLead : this.cfg.maxTurnsWorker,
      settingSources: [],
      permissionMode: 'default',
      canUseTool,
      // the lead's Bash is read-only: the policy asks before anything that writes
      tools: role === 'lead' ? ['Read', 'Grep', 'Glob', 'Bash'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      // no allowedTools: every tool call (incl. our MCP tools) goes through canUseTool/policy
      disallowedTools: ['Bash(git push:*)', 'Task', 'Agent', 'WebSearch', 'WebFetch'],
      mcpServers: { [MCP_SERVER]: mcpServer(spec.tools) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions },
      abortController: abort,
      env: withAuthMode(spec.env, this.cfg.useClaudeLogin),
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (s: string) => this.fm.log.debug(`[${agentId} stderr] ${s.trim().slice(0, 300)}`));
        child.on('error', (e) => this.fm.log.debug(`[${agentId}] CLI process error: ${e.message}`));
        spec.onProcess(child);
        return child;
      },
      ...(spec.resume ? { resume: spec.resume } : {}),
      ...(this.cfg.maxBudgetUsdPerTurn ? { maxBudgetUsd: this.cfg.maxBudgetUsdPerTurn } : {}),
    };
    const mapper = new StreamMapper(this.fm, agentId, cwd, role);
    const q = this.queryFn({ prompt: spec.prompt, options });
    // the abort signal alone lets a CLI finish what it is doing (seen in a real run: ~6 s of
    // further turns after /stop). close() force-ends the subprocess and its transports.
    const closeQuery = () => {
      try {
        q.close();
      } catch {
        /* already closed */
      }
    };
    if (abort.signal.aborted) closeQuery();
    else abort.signal.addEventListener('abort', closeQuery, { once: true });
    let session: string | undefined;
    let model: string | undefined;
    for await (const msg of q) {
      if (abort.signal.aborted) break; // nothing from an aborted turn reaches the world
      mapper.handle(msg);
      if (mapper.model && mapper.model !== model) {
        model = mapper.model;
        spec.onModel?.(model);
      }
      if (mapper.stats.sessionId && mapper.stats.sessionId !== session) {
        session = mapper.stats.sessionId;
        spec.onSession(session);
      }
    }
    return mapper.stats;
  }
}
