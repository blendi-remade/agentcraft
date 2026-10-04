import type { Foreman } from '../foreman.js';
import { SharedRunner } from './shared-runner.js';
import { CodexAdapter, type CodexBackendOptions } from './codex/index.js';
import { ClaudeAdapter, type ClaudeBackendOptions } from './claude/index.js';
import type { CapabilityLookup, ExecutionConfig, ExecutionProvider } from './execution-types.js';

export interface ExecutionBackendOptions {
  execution?: ExecutionConfig;
  capabilities?: CapabilityLookup;
  codex?: CodexBackendOptions;
  claude?: ClaudeBackendOptions;
}
/** Install this one backend on Foreman; adapters do not own schedulers. */
export class ExecutionBackend extends SharedRunner {
  constructor(fm: Foreman, options: ExecutionBackendOptions = {}) {
    if (fm.config.backend === 'sim') throw new Error('ExecutionBackend requires a real provider.');
    const provider: ExecutionProvider = fm.config.backend;
    super(fm, {provider, config:fm.config[provider], execution:options.execution, capabilities:options.capabilities,
      adapters:{codex:new CodexAdapter(fm, fm.config.codex, options.codex), claude:new ClaudeAdapter(fm, fm.config.claude, options.claude)}});
  }
}
