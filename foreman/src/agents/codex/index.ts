// Share scheduling and worktree lifecycle without invoking the Claude SDK.
import type { CodexConfig } from '../../config.js';
import type { Task } from '../../protocol.js';
import type { Foreman } from '../../foreman.js';
import { ClaudeBackend, type ClaudeBackendOptions } from '../claude/index.js';
import { CodexDriver, type CodexDriverOptions } from './driver.js';
export interface CodexBackendOptions extends CodexDriverOptions {
  skipAuthCheck?: boolean;
  driver?: ClaudeBackendOptions['driver'];
}
export class CodexBackend extends ClaudeBackend {
  constructor(private codexForeman: Foreman, config: CodexConfig, options: CodexBackendOptions = {}) {
    super(codexForeman, config, { driver: options.driver ?? new CodexDriver(config, options), skipAuthCheck: options.skipAuthCheck });
  }

  override onMergeConflict(task: Task, info: { base: string; branch: string; files: string[]; reason: string }): boolean {
    // Git merge/commit needs shared .git metadata outside the worker's sandbox.
    // Returning false preserves the Foreman's reopened decision; do not burn
    // model turns retrying an operation this backend intentionally cannot permit.
    const message = `Codex cannot automatically resolve ${task.id}'s merge conflict within its sandbox. Resolve ${info.branch} against ${info.base} locally in the task worktree, then choose Merge again.`;
    this.codexForeman.agentLog(task.assignee ?? 'marlow', 'error', message);
    this.codexForeman.bus.feed('error', message, { agentId: task.assignee ?? 'marlow' });
    return false;
  }
}
