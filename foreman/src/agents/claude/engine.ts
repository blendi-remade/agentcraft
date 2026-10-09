// Claude's provider adapter shares the same scheduler boundary as Codex and API runtimes.
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { RuntimeEngine } from '../engine.js';
import { ClaudeRuntime } from './runtime.js';

export class ClaudeEngine extends RuntimeEngine {
  constructor(fm: Foreman, cfg: ClaudeConfig, queryFn?: typeof query) {
    super(fm, cfg, new ClaudeRuntime(fm, cfg, queryFn ? { queryFn } : {}));
  }
}
