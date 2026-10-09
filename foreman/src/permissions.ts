// Repository-scoped permissions, shared by all provider runtimes.
import type { Foreman } from './foreman.js';
import type { CanUseTool, PermissionResult } from './agents/runtime.js';
import type { TurnHandle } from './agents/tools.js';
import { classifyToolUse, describeRuleKey, describeToolCall } from './policy.js';
import { PERMISSION_OPTIONS } from './protocol.js';
import { skillReadDirs } from './skill-dirs.js';
import { truncate } from './util/text.js';
import { userName } from './user.js';

export class TeamPermissions {
  private readonly skillDirs: string[];
  private pendingPermissions = new Map<string, { repoId: string; covered: boolean; allowed: () => boolean }>();

  constructor(private fm: Foreman, skillDirs = skillReadDirs()) { this.skillDirs = skillDirs; }

  canUseTool(agentId: string, role: 'lead' | 'worker', cwd: string, repoId: string, turn: TurnHandle, leadReadCommands: string[] = []): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      // a stopped/paused/cancelled turn runs nothing more, even if its CLI has not exited yet
      if (turn.signal.aborted) return { behavior: 'deny', message: `Your turn was stopped by ${userName()}.`, interrupt: true };
      const classify = () => classifyToolUse(toolName, input, {
        role,
        cwd,
        leadReadCommands,
        readDirs: [this.fm.memory.dir, ...this.skillDirs],
        alwaysAllow: [...(this.fm.store.data.permissionRules[agentId] ?? []), ...(this.fm.store.data.teamPermissionRules[repoId] ?? [])],
        mcpServer: 'agentcraft',
      });
      const verdict = classify();
      if (verdict.action === 'allow') return { behavior: 'allow', updatedInput: input };
      if (verdict.action === 'deny') {
        this.fm.agentLog(agentId, 'error', `blocked: ${describeToolCall(toolName, input)} (${verdict.reason})`);
        return { behavior: 'deny', message: verdict.reason };
      }
      const prev = this.fm.agent(agentId);
      const prevState = prev ? { state: prev.state, station: prev.station, activity: prev.activity } : undefined;
      const t = prev?.taskId;
      const d = this.fm.createDecision({
        agentId,
        kind: 'permission',
        repoId,
        tool: toolName,
        question: `${this.fm.nameOf(agentId)} wants to run ${truncate(describeToolCall(toolName, input), 160)}`,
        options: [...PERMISSION_OPTIONS],
        context: `${verdict.reason}\ncwd: ${cwd}\n"${PERMISSION_OPTIONS[1]}" covers: all agents in repository ${repoId}; ${[...new Set(verdict.ruleKeys.map(describeRuleKey))].join('; ')}${opts.title ? `\n${opts.title}` : ''}`,
        ...(t ? { taskId: t } : {}),
      });
      this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'asking permission' });
      this.fm.agentLog(agentId, 'tool', `permission? ${describeToolCall(toolName, input)}`);
      const pending = { repoId, covered: false, allowed: () => classify().action === 'allow' };
      this.pendingPermissions.set(d.id, pending);
      const onAbort = () => this.fm.decisions.cancel(d.id, 'turn stopped');
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
      const res = await this.fm.decisions.wait(d.id);
      this.pendingPermissions.delete(d.id);
      opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal.aborted) {
        if (!turn.signal.aborted && prevState) this.fm.setAgent(agentId, prevState);
        return { behavior: 'deny', message: 'The tool request was stopped.' };
      }
      if (prevState) this.fm.setAgent(agentId, prevState);
      const opt = res.answer?.option;
      if (pending.covered && pending.allowed()) {
        this.fm.agentLog(agentId, 'result', `Allowed by ${userName()}'s team permission: ${describeToolCall(toolName, input)}`);
        return { behavior: 'allow', updatedInput: input };
      }
      if (res.status === 'answered' && (opt === PERMISSION_OPTIONS[0] || opt === PERMISSION_OPTIONS[1])) {
        if (opt === PERMISSION_OPTIONS[1]) {
          // every key the call needed: each is scoped (see policy.ts), so this grants exactly
          // what the prompt listed
          const rules = (this.fm.store.data.teamPermissionRules[repoId] ??= []);
          for (const k of verdict.ruleKeys) if (!rules.includes(k)) rules.push(k);
          this.fm.store.markDirty();
          for (const [id, other] of this.pendingPermissions) {
            if (other.repoId !== repoId || this.fm.decisions.get(id)?.status !== 'open' || !other.allowed()) continue;
            other.covered = true;
            this.fm.decisions.cancel(id, `Covered by team permission ${d.id}`);
          }
        }
        this.fm.agentLog(agentId, 'result', `${userName()} allowed: ${describeToolCall(toolName, input)}`);
        return { behavior: 'allow', updatedInput: input };
      }
      this.fm.agentLog(agentId, 'error', `${res.status === 'cancelled' ? 'Permission request withdrawn' : `${userName()} denied`}: ${describeToolCall(toolName, input)}`);
      return { behavior: 'deny', message: `${userName()} denied this${res.answer?.text ? `: ${res.answer.text}` : ''}. Find another way or ask_user.` };
    };
  }
}
