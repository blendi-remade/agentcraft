// Stuck agents (fake SDK): the watchdog reports a running turn with no activity, and a nudge ends
// that turn and resumes the same job on the same session; the options the user turned on (skills,
// plugins, extra MCP servers, language) reach every turn.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const tools = (o: Options) => (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools;
const callTool = async (o: Options, name: string, args: Record<string, unknown>) => (await tools(o)[name]!.handler(args, {})).content.map((c) => c.text).join('\n');
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000000', ...o }) as unknown as SDKMessage;
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const init = (s: string) => m({ type: 'system', subtype: 'init', session_id: s, model: 'fake' });
const ok = (s: string) => m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.001, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

interface Call {
  agent: string;
  prompt: string;
  options: Options;
}

const cleanup: string[] = [];
afterAll(() => cleanup.forEach(rmrf));

/** Kit's first turn hangs without a word (until aborted); every later turn finishes the task. */
function fake(calls: Call[]) {
  return ({ prompt, options }: { prompt: string; options: Options }) => {
    const p = String(prompt);
    const lead = 'create_task' in tools(options);
    const agent = lead ? 'marlow' : 'kit';
    calls.push({ agent, prompt: p, options });
    const aborted = new Promise<never>((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    aborted.catch(() => undefined);
    async function* run(): AsyncGenerator<SDKMessage> {
      if (lead) {
        yield init(sid(1));
        if (p.startsWith('New goal')) await callTool(options, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit' });
        yield ok(sid(1));
        return;
      }
      yield init(sid(2));
      if (calls.filter((c) => c.agent === 'kit').length === 1) await aborted;
      fs.appendFileSync(path.join(options.cwd!, 'README.md'), '\nversion flag\n');
      await callTool(options, 'update_task', { task_id: 't1', status: 'review', summary: 'done' });
      yield ok(sid(2));
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

async function boot(calls: Call[], extra: string[] = []): Promise<{ h: Harness; b: ClaudeBackend }> {
  const home = tempDir();
  const repo = await demoRepo();
  cleanup.push(home, path.dirname(repo));
  const h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit', '--repo', repo, '--no-lead-review', '--stall-minutes', '0', ...extra]);
  const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fake(calls) as never, skipAuthCheck: true });
  await h.fm.start(b);
  return { h, b };
}

describe('stuck agents', () => {
  it('reports a silent turn once and a nudge resumes the same job', async () => {
    const calls: Call[] = [];
    const { h, b } = await boot(calls);
    await h.fm.submitGoal('Add a version flag');
    await until(() => calls.some((c) => c.agent === 'kit'));
    // nothing for longer than the limit: reported once, not again on the next check
    const later = Date.now() + 11 * 60_000;
    expect(b.checkStalls(10 * 60_000, later)).toEqual(['kit']);
    expect(b.checkStalls(10 * 60_000, later + 60_000)).toEqual(['kit']);
    expect(h.fm.store.data.feed.filter((f) => /no activity/.test(f.text)).length).toBe(1);
    await h.fm.agentAction('kit', 'nudge');
    await until(() => h.fm.tasks.get('t1')?.status === 'review' || h.fm.tasks.get('t1')?.status === 'done', 20_000);
    const kit = calls.filter((c) => c.agent === 'kit');
    expect(kit.length).toBe(2);
    expect(kit[1]!.prompt).toMatch(/stopped making progress/);
    expect(kit[1]!.options.resume).toBe(sid(2));
    await h.fm.close();
  });

  it('a turn waiting on the user is never stalled', async () => {
    const calls: Call[] = [];
    const { h, b } = await boot(calls);
    await h.fm.submitGoal('Add a version flag');
    await until(() => calls.some((c) => c.agent === 'kit'));
    h.fm.createDecision({ agentId: 'kit', kind: 'question', question: 'Short or long?', options: ['Short', 'Long'] });
    expect(b.checkStalls(10 * 60_000, Date.now() + 60 * 60_000)).toEqual([]);
    await h.fm.agentAction('kit', 'stop');
    await h.fm.close();
  });
});

describe('user options reach the turns', () => {
  it('skills, plugins, MCP servers and the language', async () => {
    const calls: Call[] = [];
    const plugin = tempDir();
    cleanup.push(plugin);
    const { h } = await boot(calls, ['--skills', 'designer', '--plugin-dir', plugin, '--language', 'it']);
    h.cfg.claude.mcpServers = { playwright: { command: 'npx', args: ['@playwright/mcp'] } };
    await h.fm.submitGoal('Aggiungi un flag versione');
    await until(() => calls.some((c) => c.agent === 'marlow'));
    const o = calls.find((c) => c.agent === 'marlow')!.options;
    expect(o.skills).toEqual(['designer']);
    expect(o.settingSources).toEqual(['user']);
    expect(o.plugins).toEqual([{ type: 'local', path: plugin }]);
    expect(Object.keys(o.mcpServers!).sort()).toEqual(['agentcraft', 'playwright']);
    expect(o.systemPrompt).toMatchObject({ append: expect.stringMatching(/Italian/) });
    await h.fm.agentAction('kit', 'stop');
    await h.fm.close();
  });
});
