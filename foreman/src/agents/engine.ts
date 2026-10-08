// An engine runs one agent turn: the Claude Agent SDK (claude/engine.ts) or the Codex app-server
// (codex/engine.ts). Everything around a turn - task graph, worktrees, scheduling, CI, reviews,
// merges, steering, restarts - is the team's (team.ts) and the same for every engine, so a team
// can mix them (e.g. a Claude lead with Codex workers).
import type { ChildProcess } from 'node:child_process';
import type { AgentTool, TurnHandle } from './tools.js';

export type EngineId = 'claude' | 'codex';
export const ENGINE_IDS: readonly EngineId[] = ['claude', 'codex'];
export type Role = 'lead' | 'worker';

export interface TurnStats {
  /** the engine's session (Claude session id, Codex thread id), to resume the next turn */
  sessionId?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
  /** total tokens of the turn (engines that report usage, not cost) */
  tokens?: number;
  authFailed?: string;
  errors: string[];
}

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
}

/** `mode`: how the engine authenticated, or tried to (e.g. "claude login", "API key", "Amazon Bedrock") */
export type AuthCheck = { ok: true; account: string; mode: string } | { ok: false; message: string; mode?: string };

export interface Engine {
  readonly id: EngineId;
  /** display name, e.g. "Claude" */
  readonly label: string;
  model(role: Role): string;
  /** how the engine will authenticate, as known before checkAuth (shown while checking) */
  authMode(): string;
  checkAuth(): Promise<AuthCheck>;
  runTurn(spec: TurnSpec): Promise<TurnStats>;
  /** what to tell the user when a turn failed authentication */
  authFailedMessage(detail: string): string;
}
