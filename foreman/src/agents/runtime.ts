// Provider boundary: the scheduler, tools and permission policy have no SDK dependencies.
import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { EffortLevel } from '../config.js';
import type { TurnReporter } from './stream.js';
import type { ToolResult } from './tools.js';

/** Only provider adapters can classify an authentication failure; arbitrary error text cannot. */
export class AuthenticationError extends Error {}

export function isAuthenticationMessage(message: string): boolean {
  return /\b(?:HTTP(?: status)?\s*[:=]?\s*40[13]|unauthorized|not logged in|authentication[_ ](?:failed|required)|invalid[_ ]api[_ ]key|incorrect API key)\b/i.test(message);
}

export interface TurnStats {
  sessionId?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  costUsd?: number;
  numTurns?: number;
  /** Token usage for providers that report tokens instead of cost. */
  tokens?: number;
  authFailed?: string;
  errors: string[];
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
export type CanUseTool = (name: string, input: Record<string, unknown>, opts: { signal: AbortSignal; title?: string }) => Promise<PermissionResult>;

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** API adapters may pass a request signal; SDK-specific context remains optional. */
  handler(args: Record<string, unknown>, context?: unknown): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodRawShape>(
  name: string, description: string, inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>, signal?: AbortSignal) => Promise<ToolResult>,
): AgentTool {
  const schema = z.object(inputSchema);
  return { name, description, inputSchema, handler: async (args, context) => handler(schema.parse(args), context instanceof AbortSignal ? context : undefined) };
}

export interface TurnRequest {
  agentId: string;
  prompt: string;
  systemPrompt: string;
  cwd: string;
  role: 'lead' | 'worker';
  model: string;
  effort?: EffortLevel;
  maxTurns: number;
  maxBudgetUsd?: number;
  resume?: string;
  env: NodeJS.ProcessEnv;
  abortController: AbortController;
  tools: AgentTool[];
  canUseTool: CanUseTool;
  reporter: TurnReporter;
  onSession(id: string): void;
  onSpawn(child: ChildProcess): void;
  onModel?(model: string): void;
  /** Live input: true only once consumed, not merely queued. False retains it for redelivery. */
  onSteerReady?(steer: (prompt: string) => Promise<boolean>): void;
}

export interface AgentRuntime {
  readonly name: 'claude' | 'codex' | 'openai';
  readonly label: string;
  model?(role: 'lead' | 'worker'): string | undefined;
  /** Checks local configuration/auth without generating a model response. */
  checkAuth(): Promise<string>;
  env?(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  run(request: TurnRequest): Promise<TurnStats>;
}
