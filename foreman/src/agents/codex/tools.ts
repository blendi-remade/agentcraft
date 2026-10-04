import { z } from 'zod';
import type { Foreman } from '../../foreman.js';
import { buildAgentToolDefinitions, type ToolHooks, type TurnHandle } from '../claude/tools.js';

export interface DynamicToolNamespace {
  type: 'namespace';
  name: string;
  description: string;
  tools: Array<{ type: 'function'; name: string; description: string; inputSchema: Record<string, unknown> }>;
}

/** Present the same owner-authorized Foreman tools through Codex app-server's dynamic tool API. */
export function buildCodexTools(fm: Foreman, agentId: string, role: 'lead' | 'worker', hooks: ToolHooks, turn: TurnHandle): {
  dynamicTools: DynamicToolNamespace[];
  call: (name: string, args: unknown) => Promise<{ text: string; success: boolean }>;
} {
  const definitions = buildAgentToolDefinitions(fm, agentId, role, hooks, turn);
  const dynamicTools: DynamicToolNamespace[] = [
    {
      type: 'namespace',
      name: 'agentcraft',
      description: 'AgentCraft team actions. Use these to coordinate, ask the owner, manage tasks, memory, and merge requests.',
      tools: definitions.map((definition) => ({
        type: 'function',
        name: definition.name,
        description: definition.description,
        inputSchema: z.toJSONSchema(z.object(definition.inputSchema), { target: 'draft-7' }) as Record<string, unknown>,
      })),
    },
  ];

  return {
    dynamicTools,
    async call(name, args) {
      const definition = definitions.find((candidate) => candidate.name === name);
      if (!definition) return { text: `Unknown AgentCraft tool ${name}.`, success: false };
      const checked = z.object(definition.inputSchema).safeParse(args);
      if (!checked.success) return { text: `Invalid arguments: ${z.prettifyError(checked.error)}`, success: false };
      const result = await definition.handler(checked.data, {});
      const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).filter(Boolean).join('\n') || 'ok';
      return { text, success: !result.isError };
    },
  };
}
