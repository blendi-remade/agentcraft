import type { TurnRequest } from '../src/agents/runtime.js';
import { TurnReporter } from '../src/agents/stream.js';
import { classifyToolUse } from '../src/policy.js';
import { agentEnv } from '../src/agents/team.js';
import type { Harness } from './helpers.js';

export function turnRequest(h: Harness, cwd: string, changes: Partial<TurnRequest> = {}): TurnRequest {
  const role = changes.role ?? 'worker';
  const agentId = role === 'lead' ? 'marlow' : 'kit';
  return {
    agentId, cwd, role, prompt: 'Implement the task', systemPrompt: 'Work in this directory.', model: 'test-model',
    effort: 'medium', maxTurns: 4, tools: [], env: agentEnv(process.env, { agentId, cwd }),
    abortController: new AbortController(), reporter: new TurnReporter(h.fm, agentId, cwd, role),
    onSession() {}, onSpawn() {},
    canUseTool: async (name, input) => {
      const verdict = classifyToolUse(name, input, { cwd, role, mcpServer: 'agentcraft', tempDirs: [] });
      return verdict.action === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.reason };
    },
    ...changes,
  };
}
