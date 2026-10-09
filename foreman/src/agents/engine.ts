// An engine runs one agent turn: the Claude Agent SDK (claude/engine.ts) or the Codex app-server
// (codex/engine.ts). Everything around a turn - task graph, worktrees, scheduling, CI, reviews,
// merges, steering, restarts - is the team's (team.ts) and the same for every engine, so a team
// can mix them (e.g. a Claude lead with Codex workers).
import type { ChildProcess } from 'node:child_process';
import type { TurnHandle } from './tools.js';
import type { AgentRuntime, AgentTool } from './runtime.js';
import type { TeamConfig } from '../config.js';
import type { Foreman } from '../foreman.js';
import { TurnReporter } from './stream.js';

export type EngineId = 'claude' | 'codex' | 'openai';
export const ENGINE_IDS: readonly EngineId[] = ['claude', 'codex'];
export type Role = 'lead' | 'worker';

export type { TurnStats } from './runtime.js';
import type { TurnStats } from './runtime.js';

/** The user's (or the policy's) verdict on a tool call. */
export type PermissionAnswer = { allow: true } | { allow: false; message: string; interrupt?: boolean };

/**
 * Ask whether an agent may use a tool: the policy decides, or the user is asked (a permission
 * decision). `toolName`/`input` use the Claude tool vocabulary (Bash {command}, Edit {file_path}),
 * which the policy understands; other engines map their actions onto it.
 */
export type PermissionGate = (toolName: string, input: Record<string, unknown>, signal: AbortSignal, title?: string) => Promise<PermissionAnswer>;

export interface TurnSpec {
  agentId: string;
  role: Role;
  /** lead: the user's checkout (read-only); worker: its worktree */
  cwd: string;
  prompt: string;
  /** role, rules and worktree, added to the engine's own system prompt */
  instructions: string;
  /** the engine session to continue (from TurnStats.sessionId), if any */
  resume?: string;
  /** environment for the agent's process and every command it runs (git safety, identity) */
  env: Record<string, string | undefined>;
  /** directories the agent may write besides cwd (a worktree's git dir, for commits) */
  writableRoots?: string[];
  abort: AbortController;
  turn: TurnHandle;
  permission: PermissionGate;
  tools: AgentTool[];
  /** the agent process the engine spawned, so the team can end its whole tree on abort */
  onProcess(child: ChildProcess): void;
  /** the session id, as soon as the engine knows it (persisted for resume) */
  onSession(sessionId: string): void;
  /** the model the turn really runs (e.g. "claude-opus-5-5"), as soon as the engine knows it */
  onModel?(model: string): void;
  /** Resolve true only once live input was consumed by the model. */
  onSteerReady?(steer: (prompt: string) => Promise<boolean>): void;
}

export type AuthCheck = { ok: true; account: string } | { ok: false; message: string };

export interface Engine {
  readonly id: EngineId;
  /** display name, e.g. "Claude" */
  readonly label: string;
  model(role: Role): string;
  checkAuth(): Promise<AuthCheck>;
  runTurn(spec: TurnSpec): Promise<TurnStats>;
  /** what to tell the user when a turn failed authentication */
  authFailedMessage(detail: string): string;
}

/** Adapt provider runtimes to the per-agent engine selection used by the scheduler. */
export class RuntimeEngine implements Engine {
  readonly id: EngineId;
  readonly label: string;
  constructor(private fm: Foreman, private cfg: TeamConfig, private runtime: AgentRuntime) {
    this.id = runtime.name;
    this.label = runtime.label;
  }
  model(role: Role): string {
    const configured = role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
    return configured && configured !== 'default' ? configured : this.runtime.model?.(role) ?? 'default';
  }
  async checkAuth(): Promise<AuthCheck> {
    try { return { ok: true, account: await this.runtime.checkAuth() }; }
    catch (error) { return { ok: false, message: (error as Error).message }; }
  }
  authFailedMessage(detail: string): string {
    return `${this.label} authentication failed (${detail}). Check provider credentials and restart the Foreman.`;
  }
  runTurn(spec: TurnSpec): Promise<TurnStats> {
    // Configured choices are overrides; runtime-discovered models are display metadata only.
    const model = spec.role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
    return this.runtime.run({
      agentId: spec.agentId, prompt: spec.prompt, systemPrompt: spec.instructions,
      cwd: spec.cwd, role: spec.role, model: !model || model === 'default' ? '' : model,
      effort: spec.role === 'lead' ? this.cfg.leadEffort : this.cfg.effort,
      maxTurns: spec.role === 'lead' ? this.cfg.maxTurnsLead : this.cfg.maxTurnsWorker,
      ...(this.cfg.maxBudgetUsdPerTurn ? { maxBudgetUsd: this.cfg.maxBudgetUsdPerTurn } : {}),
      ...(spec.resume ? { resume: spec.resume } : {}),
      env: this.runtime.env?.(spec.env) ?? spec.env,
      abortController: spec.abort, tools: spec.tools,
      canUseTool: async (name, input, opts) => {
        const result = await spec.permission(name, input, opts.signal, opts.title);
        return result.allow ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: result.message, ...(result.interrupt ? { interrupt: true } : {}) };
      },
      reporter: new TurnReporter(this.fm, spec.agentId, spec.cwd, spec.role),
      onSession: spec.onSession, onSpawn: spec.onProcess,
      ...(spec.onModel ? { onModel: spec.onModel } : {}),
      ...(spec.onSteerReady ? { onSteerReady: spec.onSteerReady } : {}),
    });
  }
}
