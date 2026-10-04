import type { ChildProcess } from 'node:child_process';
import type { ClaudeConfig, CodexConfig } from '../config.js';
import type { ModelChoice, ModelSelection } from './codex/model-settings.js';
import type { ToolHooks, TurnHandle } from './claude/tools.js';

export type ExecutionProvider = 'codex' | 'claude';
export type ExecutionRole = 'lead' | 'worker' | 'reviewer';
export interface RoleSelection { provider: ExecutionProvider; model?: string; effort?: string }
export interface ExecutionConfig { roles?: Partial<Record<ExecutionRole, RoleSelection>> }
export interface ExecutionAgentOverride {
  provider?: ExecutionProvider;
  models: Partial<Record<ExecutionProvider, ModelSelection>>;
}
export interface ExecutionSetupState {
  roles: Record<ExecutionRole, RoleSelection>;
  setupComplete: boolean;
  hasAgentOverrides: boolean;
  agentOverrides: Record<string, ExecutionAgentOverride>;
}
export interface ProviderCapabilities {
  available: boolean;
  reason?: string;
  models: ModelChoice[];
  binaryPath?: string;
  auth?: 'login' | 'api';
}
export type CapabilityLookup = (provider: ExecutionProvider) => Promise<ProviderCapabilities>;
export type JobKind = 'plan' | 'work' | 'review' | 'followup';
export type AbortReason = 'pause' | 'stop' | 'shutdown' | 'cancel' | 'timeout';
export interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  fresh?: boolean;
  nudges?: number;
  resumed?: boolean;
  /** Present only after execution starts, including restart/pause continuations. */
  selection?: RoleSelection;
  role?: ExecutionRole;
}
export interface Inflight {
  kind: JobKind;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  startedAt: number;
  selection?: RoleSelection;
  role?: ExecutionRole;
}
export interface ExecutionState {
  inflight: Record<string, Inflight>;
  ciFixes: Record<string, number>;
  stopped: string[];
  roles?: Partial<Record<ExecutionRole, RoleSelection>>;
  roleSettings?: Partial<Record<ExecutionRole, Partial<Record<ExecutionProvider, RoleSelection>>>>;
  agentSettings?: Record<string, Partial<Record<ExecutionProvider, ModelSelection>>>;
  agentProviders?: Record<string, ExecutionProvider>;
  sessionProviders?: Record<string, ExecutionProvider>;
  setupComplete?: boolean;
  /** Original ownership of pre-namespace sessions; never inferred from model names. */
  legacyProvider?: ExecutionProvider;
}
export interface TurnStats {
  sessionId?: string;
  model?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
  errors: string[];
}
export interface Running {
  abort: AbortController;
  job: Job;
  reason?: AbortReason;
  child?: ChildProcess;
  done?: Promise<void>;
  spawnedAt?: number;
  tree?: Promise<import('../util/proc.js').ProcEntry[] | undefined>;
  reaping?: Promise<void>;
  model?: string;
  effort?: string;
  /** Transport-specific interruption/close, installed by the selected adapter. */
  interrupt?: () => void;
}
export interface TurnContext {
  entry: Running;
  turn: TurnHandle;
  cwd: string;
  /** Reviewer uses the lead's read-only policy and tool surface. */
  policyRole: 'lead' | 'worker';
  selection: RoleSelection;
  capabilities?: ProviderCapabilities;
  resume?: string;
  systemAppend: string;
  prompt: string;
  hooks: ToolHooks;
  recordSession: (sessionId: string, model?: string, stats?: TurnStats) => void;
  permissionGranted: (tool: string, input: Record<string, unknown>, reason?: string, mcpServer?: string, signal?: AbortSignal) => Promise<boolean>;
  askUser: (question: string, options: string[]) => Promise<string | undefined>;
  markAuthFailed: (message: string) => void;
}
/** Adapters never enqueue, dispatch CI/review or settle merge decisions. */
export interface ExecutionAdapter {
  readonly provider: ExecutionProvider;
  checkAuth(capabilities?: ProviderCapabilities): Promise<boolean>;
  models?(): Promise<ModelChoice[]>;
  execute(context: TurnContext): Promise<TurnStats>;
  close?(): Promise<void>;
}
export interface SharedRunnerOptions {
  provider: ExecutionProvider;
  config: CodexConfig | ClaudeConfig;
  adapters: Partial<Record<ExecutionProvider, ExecutionAdapter>>;
  execution?: ExecutionConfig;
  capabilities?: CapabilityLookup;
  /** Legacy facade keeps old session aliases for existing single-harness consumers. */
  legacySessions?: boolean;
}
