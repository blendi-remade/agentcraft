// Type declarations for the plain-JavaScript launcher, so the Foreman tests can import it.
export const DEFAULT_BASE_URL: string;
export const DEFAULT_INTEGRATION: string;
export const DEFAULT_LEAD_MODEL: string;
export const DEFAULT_WORKER_MODEL: string;
export const DEFAULT_HAIKU_MODEL: string;
export const DEFAULT_MODELS_BY_AGENT: Record<string, string>;

export interface LaunchOptions {
  backend: string;
  repos: string[];
  profile?: string;
  home?: string;
  port?: string;
  foremanArgs: string[];
  noGame: boolean;
  noWait: boolean;
  dev: boolean;
  reset: boolean;
  dryRun: boolean;
  noPerAgentModels: boolean;
  help: boolean;
  integration: string;
  model?: string;
  leadModel?: string;
  workerModel?: string;
  claudeModels?: string;
  workers?: string;
  maxConcurrent?: string;
  effort?: string;
  maxTurns?: string;
  maxTurnsLead?: string;
  maxTurnsWorker?: string;
  baseUrl?: string;
}

export function parseArgs(argv: string[]): LaunchOptions;
export function extractKey(creds: unknown, integration?: string): string;
export function readKey(integration?: string): string;
export function buildEnv(opts: LaunchOptions, baseEnv?: NodeJS.ProcessEnv, keyReader?: (integration?: string) => string): NodeJS.ProcessEnv;
export function buildUnixArgs(opts: LaunchOptions): string[];
export function findJava25(baseEnv?: NodeJS.ProcessEnv): string | undefined;
export function describeEnv(env: NodeJS.ProcessEnv): string;
export function main(argv?: string[]): number | undefined;
