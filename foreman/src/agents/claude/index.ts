// Claude SDK transport; SharedRunner owns queues, worktrees, approvals, CI and review.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import { FOREMAN_VERSION } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { withGitSafety } from '../../gitsafety.js';
import { agentGitIdentity } from '../../util/git.js';
import { truncate } from '../../util/text.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from './auth.js';
import { StreamMapper } from './stream.js';
import { buildMcpServer, MCP_SERVER } from './tools.js';

import { SharedRunner } from '../shared-runner.js';
import type { ExecutionAdapter, ProviderCapabilities, TurnContext, TurnStats } from '../execution-types.js';
/**
 * Environment for an agent's CLI process (and every command it runs): git refuses all
 * transports (no push, ever) and never signs; git does not walk up out of the agent's cwd; the
 * agent's commits carry its own placeholder identity ("AgentCraft Kit <kit@agentcraft.local>"),
 * never the user's; and each Bash call starts in the agent's own cwd, so a `cd` in one command
 * cannot carry the next one out of the worktree.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, who: { agentId?: string; cwd?: string } = {}): Record<string, string | undefined> {
  return withGitSafety(
    base,
    {
      CLAUDE_AGENT_SDK_CLIENT_APP: `agentcraft-foreman/${FOREMAN_VERSION}`,
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      ...(who.agentId ? (agentGitIdentity(who.agentId) as Record<string, string>) : {}),
    },
    who.cwd ? { ceiling: path.dirname(path.resolve(who.cwd)) } : {},
  );
}

export interface ClaudeBackendOptions {
  /** injectable for tests */
  queryFn?: typeof query;
  /** skip the startup auth probe (tests) */
  skipAuthCheck?: boolean;
}

export class ClaudeAdapter implements ExecutionAdapter {
  readonly provider = 'claude' as const;
  private queryFn: typeof query;
  constructor(private fm: Foreman, private cfg: ClaudeConfig, private opts: ClaudeBackendOptions = {}) { this.queryFn = opts.queryFn ?? query; }
  async checkAuth(capabilities?: ProviderCapabilities): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: 'Claude authentication ready' });
      return true;
    }
    // API authentication by default; the claude.ai login only when explicitly opted into
    const api = detectApiAuth(process.env);
    const useClaudeLogin = this.cfg.useClaudeLogin;
    if (!useClaudeLogin && !api.ok) {
      this.markAuthFailed(NO_API_AUTH_MESSAGE);
      return false;
    }
    this.fm.setStatus({ auth: 'checking', message: useClaudeLogin ? 'Checking Claude login...' : 'Checking Claude API access...' });
    async function* never(): AsyncGenerator<never> {
      await new Promise(() => undefined);
    }
    const q = this.queryFn({ prompt: never(), options: { settingSources: [], persistSession: false, permissionMode: 'default', env: this.env({}, useClaudeLogin),
      ...(capabilities?.binaryPath ? {pathToClaudeCodeExecutable: capabilities.binaryPath} : {}) } });
    let authTimer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([q.accountInfo(), new Promise<never>((_, r) => { authTimer = setTimeout(() => r(new Error('timed out after 45s')), 45_000); })]);
      const ok = !!(info.email || info.organization || (info.apiKeySource && info.apiKeySource !== 'none') || (info.tokenSource && info.tokenSource !== 'none') || (info.apiProvider && info.apiProvider !== 'firstParty'));
      if (!ok) throw new Error('not logged in');
      const account = useClaudeLogin
        ? [info.organization, info.subscriptionType].filter(Boolean).join(' · ') || info.apiProvider || 'ok'
        : [api.ok ? api.source : 'API', info.organization].filter(Boolean).join(' · ');
      this.fm.setStatus({ auth: 'ok', account, message: 'Claude authentication ready' });
      this.fm.log.info(`claude auth ok (${account})`);
      return true;
    } catch (e) {
      this.markAuthFailed(
        useClaudeLogin
          ? `Claude login check failed: ${(e as Error).message}. Run \`claude\` and /login, then restart the Foreman. The sim backend still works.`
          : `Claude API check failed: ${(e as Error).message}. Check ANTHROPIC_API_KEY (or your cloud provider settings), then restart the Foreman. The sim backend still works.`,
      );
      return false;
    } finally {
      if (authTimer) clearTimeout(authTimer);
      try {
        q.close();
      } catch {
        /* ignore */
      }
    }
  }

  private markAuthFailed(message: string): void {
    this.fm.setStatus({ auth: 'failed', message });
    this.fm.log.error(message);
    this.fm.bus.feed('error', message);
    this.fm.notify('warn', message);
    if (process.stdout.isTTY) process.stdout.write('\x07');
  }

  private env(who: { agentId?: string; cwd?: string } = {}, useClaudeLogin = this.cfg.useClaudeLogin): Record<string, string | undefined> {
    return withAuthMode(agentEnv(process.env, who), useClaudeLogin);
  }

  async execute(context: TurnContext): Promise<TurnStats> {
    const {entry, turn, cwd, policyRole: role, resume, systemAppend} = context;
    const {job, abort} = entry;
    const agentId = job.agentId;
    const model = context.selection.model ?? (role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel);
    const options: Options = {
      cwd,
      model,
      effort: context.selection.effort === 'default' ? undefined : context.selection.effort as Options['effort'],
      maxTurns: role === 'lead' ? this.cfg.maxTurnsLead : this.cfg.maxTurnsWorker,
      settingSources: [],
      permissionMode: 'default',
      canUseTool: async (tool, input, opts) => {
        const signal = AbortSignal.any([turn.signal, opts.signal]);
        const allowed = await context.permissionGranted(tool, input, opts.title, MCP_SERVER, signal);
        return allowed && !signal.aborted ? {behavior:'allow', updatedInput:input} : {behavior:'deny', message:'Permission denied or turn stopped.'};
      },
      tools: role === 'lead' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite'],
      // no allowedTools: every tool call (incl. our MCP tools) goes through canUseTool/policy
      disallowedTools: ['Bash(git push:*)', 'Task', 'Agent', 'WebSearch', 'WebFetch'],
      mcpServers: { [MCP_SERVER]: buildMcpServer(this.fm, agentId, role, context.hooks, turn) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
      abortController: abort,
      env: this.env({ agentId, cwd }, this.cfg.useClaudeLogin),
      ...(context.capabilities?.binaryPath ? {pathToClaudeCodeExecutable: context.capabilities.binaryPath} : {}),
      // we spawn the CLI ourselves (same as the SDK's local spawn) so its pid is known: a stopped
      // turn's whole process tree can then be ended before its worktree is handed on
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (s: string) => this.fm.log.debug(`[${agentId} stderr] ${s.trim().slice(0, 300)}`));
        child.on('error', (e) => this.fm.log.debug(`[${agentId}] CLI process error: ${e.message}`));
        entry.child = child;
        entry.spawnedAt = Date.now();
        return child;
      },
      ...(resume ? { resume } : {}),
      ...(this.cfg.maxBudgetUsdPerTurn ? { maxBudgetUsd: this.cfg.maxBudgetUsdPerTurn } : {}),
    };
    this.fm.agentLog(agentId, 'text', `${resume ? 'Resuming' : 'Starting'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (${model})`);
    if (job.kind === 'followup' || job.resumed) this.fm.agentLog(agentId, 'text', truncate(job.prompt, 400));
    const mapper = new StreamMapper(this.fm, agentId, cwd, role);

    // messages that arrived while the agent was not in a turn ride along with this prompt
    const prompt = context.prompt;
    try {
      const q = this.queryFn({ prompt, options });
      entry.interrupt = () => { try { q.close(); } catch { /* already closed */ } };
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
      for await (const msg of q) {
        if (abort.signal.aborted) break; // nothing from an aborted turn reaches the world
        mapper.handle(msg);
        if (mapper.stats.sessionId && this.fm.store.data.sessions[job.sessionKey]?.sessionId !== mapper.stats.sessionId) {
          context.recordSession(mapper.stats.sessionId, model);
        }
      }
    } finally {
      entry.interrupt?.();
    }
    const stats = mapper.stats;

    if (stats.authFailed) context.markAuthFailed(`Claude authentication failed (${stats.authFailed}). Run \`claude\` and /login, then restart the Foreman.`);
    return stats;
  }
}
export class ClaudeBackend extends SharedRunner {
  constructor(fm: Foreman, cfg: ClaudeConfig, opts: ClaudeBackendOptions = {}) {
    super(fm, {provider:'claude', config:cfg, adapters:{claude:new ClaudeAdapter(fm,cfg,opts)}, legacySessions:true});
  }
}
