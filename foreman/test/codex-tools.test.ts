import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexTools } from '../src/agents/codex/tools.js';
import type { ToolHooks, TurnHandle } from '../src/agents/claude/tools.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness | undefined;
let home: string | undefined;

afterEach(async () => {
  await h?.fm.close();
  if (home) rmrf(home);
  h = undefined;
  home = undefined;
});

const hooks: ToolHooks = {
  onReview: () => undefined,
  onChangesRequested: () => undefined,
  onTasksChanged: () => undefined,
  onMergeRequested: () => undefined,
  onWaiting: () => undefined,
};

function turn(): TurnHandle {
  const controller = new AbortController();
  return { signal: controller.signal, reason: () => undefined };
}

describe('Codex app-server dynamic tools', () => {
  it('shares Foreman task tools with the lead and calls their real handlers', async () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'codex']);
    const tools = buildCodexTools(h.fm, 'marlow', 'lead', hooks, turn());
    const namespace = tools.dynamicTools[0]!;
    const names = namespace.tools.map((tool) => tool.name);

    expect(namespace.name).toBe('agentcraft');
    expect(namespace.tools.every((tool) => tool.type === 'function')).toBe(true);
    expect(names).toContain('create_task');
    expect(names).toContain('request_merge');
    expect(namespace.tools.find((tool) => tool.name === 'create_task')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title', 'description'],
    });

    const result = await tools.call('write_memory', { title: 'Plan: test', body: 'Use dynamic tools.' });
    expect(result.success).toBe(true);
    expect(h.fm.memory.list().some((memory) => memory.title === 'Plan: test' && memory.body === 'Use dynamic tools.')).toBe(true);
  });

  it('does not expose lead-only task-creation or merge tools to workers', () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'codex']);
    const tools = buildCodexTools(h.fm, 'kit', 'worker', hooks, turn());
    const names = tools.dynamicTools[0]!.tools.map((tool) => tool.name);
    expect(names).toContain('update_task');
    expect(names).not.toContain('create_task');
    expect(names).not.toContain('request_merge');
  });
});
