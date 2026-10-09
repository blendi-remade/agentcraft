// Compatibility entry point for an all-Claude team.
import type { ClaudeConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { TeamBackend, type PullFetcher } from '../team.js';
import { ClaudeEngine } from './engine.js';
import type { ClaudeBackendOptions as RuntimeOptions } from './runtime.js';

export { agentEnv, TeamBackend, type PullFetcher } from '../team.js';
export interface ClaudeBackendOptions extends RuntimeOptions {
  pullFetcher?: PullFetcher;
}

export class ClaudeBackend extends TeamBackend {
  constructor(fm: Foreman, cfg: ClaudeConfig, opts: ClaudeBackendOptions = {}) {
    const claude = new ClaudeEngine(fm, cfg, opts.queryFn);
    super(fm, cfg, {
      name: 'claude', engines: { lead: claude, worker: claude },
      ...(opts.skipAuthCheck ? { skipAuthCheck: true } : {}),
      ...(opts.pullFetcher ? { pullFetcher: opts.pullFetcher } : {}),
    });
  }
}
