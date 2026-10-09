// The Claude engine: one Claude Agent SDK `query()` per turn. We spawn the CLI ourselves (same as
// the SDK's local spawn) so its pid is known and a stopped turn's whole process tree can be ended.
import { spawn } from 'node:child_process';
import { query, type CanUseTool, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import type { Usage } from '../../protocol.js';
import { truncate } from '../../util/text.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from './auth.js';
import { StreamMapper } from './stream.js';
import { MCP_SERVER, mcpServer } from './tools.js';
import { mapUsage, USAGE_ERRORS, USAGE_METHODS, USAGE_TIMEOUT_MS, usageSummary } from './usage.js';

/** The prompt of a throwaway query (auth probe, usage): it never sends a turn. */
async function* never(): AsyncGenerator<never> {
  await new Promise(() => undefined);
}

export class ClaudeEngine implements Engine {
  readonly id = 'claude' as const;
  readonly label = 'Claude';
  /** the SDK has no usage method (learned on a poll): later polls answer that without spawning */
  private usageMissing = false;

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

  /**
   * The plan usage for the in-game display (docs/design/usage-display.md). API key / cloud
   * provider: plan limits do not apply, nothing is spawned. claude.ai login: a throwaway query like
   * checkAuth's asks the CLI for its /usage data through the SDK's experimental method, found by
   * name so a rename breaks neither the build nor the run (a missing method is remembered: the SDK
   * cannot change while the Foreman runs). Never throws; the answer and the env are never logged.
   */
  async usage(): Promise<Usage> {
    if (!this.cfg.useClaudeLogin) return { mode: 'api', windows: [], fetchedAt: Date.now() };
    const failed = (error: string): Usage => ({ mode: 'subscription', windows: [], fetchedAt: Date.now(), error });
    if (this.usageMissing) return failed(USAGE_ERRORS.missing);
    const t0 = Date.now();
    let q: Query | undefined;
    let timer: NodeJS.Timeout | undefined;
    let usage: Usage;
    try {
      q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: withAuthMode({ ...process.env }, this.cfg.useClaudeLogin) } });
      const target = q as unknown as Record<string, unknown>;
      const method = USAGE_METHODS.find((m) => typeof target[m] === 'function');
      if (!method) {
        this.usageMissing = true;
        usage = failed(USAGE_ERRORS.missing);
      } else {
        // skipBehaviors: no scan of seven days of local transcripts, only the plan limits
        const answer = (target[method] as (opts: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${USAGE_TIMEOUT_MS / 1000}s`)), USAGE_TIMEOUT_MS);
        });
        const raw = await Promise.race([answer, timeout]);
        usage = mapUsage(raw, Date.now());
        if (usage.error === USAGE_ERRORS.shape) this.fm.log.debug(`usage: unexpected answer, top-level keys: ${raw && typeof raw === 'object' ? Object.keys(raw).join(', ') : typeof raw}`);
      }
    } catch (e) {
      usage = failed(`usage request failed: ${truncate((e as Error)?.message ?? String(e), 160)}`);
    } finally {
      if (timer) clearTimeout(timer);
      try {
        q?.close();
      } catch {
        /* ignore */
      }
    }
    this.fm.log.debug(`usage: ${usageSummary(usage)} (${Date.now() - t0} ms)`);
    return usage;
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
