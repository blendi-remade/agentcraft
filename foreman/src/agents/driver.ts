// The provider boundary: the scheduler owns jobs, permissions, sessions and process cleanup;
// a driver owns authentication and a single model turn. No provider SDK runs through this API.
import type { ChildProcess } from 'node:child_process';
import type { Foreman } from '../foreman.js';
import type { buildTools, TurnHandle } from './claude/tools.js';
import type { TurnStats } from './claude/stream.js';

export type { TurnStats } from './claude/stream.js';

export type DriverPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type DriverPermission = (
  toolName: string,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal; title?: string },
) => Promise<DriverPermissionResult>;

export interface DriverSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface DriverTurnContext {
  fm: Foreman;
  agentId: string;
  role: 'lead' | 'worker';
  cwd: string;
  prompt: string;
  systemAppend: string;
  model: string;
  effort: string;
  maxTurns: number;
  resume?: string;
  turn: TurnHandle;
  abortController: AbortController;
  tools: ReturnType<typeof buildTools>;
  canUseTool: DriverPermission;
  /** Spawn through this hook so stop, hand-off and shutdown can reap the CLI process tree. */
  spawnProcess(options: DriverSpawnOptions): ChildProcess;
  /** Call as soon as the provider creates/resumes a session, before completing the turn. */
  onSession(sessionId: string): void;
}

export interface AgentDriver {
  readonly name: 'codex';
  readonly label: string;
  /** Set the Foreman auth/account status and return whether turns may be started. */
  checkAuth(fm: Foreman): Promise<boolean>;
  runTurn(context: DriverTurnContext): Promise<TurnStats>;
}
