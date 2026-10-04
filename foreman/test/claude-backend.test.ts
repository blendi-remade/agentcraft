// Orchestration test for the claude backend with a scripted fake `query()`: the fake plays the
// lead and workers by calling our real in-process MCP tools, editing the real worktree and
// calling canUseTool like the CLI would. Everything else (task graph, worktrees, CI, reviews,
// merge decisions, merges, session persistence) is the real code path. No API calls.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { StreamMapper } from '../src/agents/claude/stream.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };

async function callTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = options.mcpServers!.agentcraft as unknown as ToolServer;
  const res = await server.instance._registeredTools[name]!.handler(args, {});
  return res.content.map((c) => c.text).join('\n');
}

const sid = (k: string) => `00000000-0000-4000-8000-${k.padStart(12, '0')}`;
let n = 0;
const msg = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: sid(String(++n)), ...o }) as unknown as SDKMessage;
const init = (session: string) => msg({ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', cwd: '', tools: [] });
const toolUse = (session: string, name: string, input: Record<string, unknown>) => msg({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: `tu${n}`, name, input }] } });
const toolResult = (session: string, text: string) => msg({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${n - 1}`, content: text }] } });
const say = (session: string, text: string) => msg({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text }] } });
const result = (session: string, text = 'done') => msg({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 3, total_cost_usd: 0.012, session_id: session, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

const calls: Array<{ prompt: string; cwd: string; resume?: string; env?: Record<string, string | undefined> }> = [];
let permissionVerdict: string | undefined;

function fakeQuery(h: Harness) {
  return ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const opts = options!;
    const p = String(prompt);
    calls.push({ prompt: p, cwd: opts.cwd!, ...(opts.resume ? { resume: opts.resume } : {}), ...(opts.env ? { env: opts.env } : {}) });
    async function* run(): AsyncGenerator<SDKMessage> {
      if (p.startsWith('New goal')) {
        const s = sid('1001');
        yield init(s);
        yield toolUse(s, 'Read', { file_path: path.join(opts.cwd!, 'src', 'cli.ts') });
        yield toolResult(s, '1\t#!/usr/bin/env node\n2\t// Entry point');
        await callTool(opts, 'write_memory', { title: 'Plan: --version flag', body: '# Plan\n- t1 flag (Kit)\n- t2 docs (Juniper)', scope: 'shared' });
        const a = await callTool(opts, 'create_task', { title: 'Add a --version flag', description: 'print the package version', assignee: 'kit' });
        const id1 = /Created (t\d+)/.exec(a)![1]!;
        await callTool(opts, 'create_task', { title: 'Document --version in README', description: 'one line', assignee: 'juniper', deps: [id1] });
        await callTool(opts, 'send_message', { to: 'all', text: 'Plan is up.' });
        yield result(s, 'planned');
        return;
      }
      const task = /Your task: (t\d+)/.exec(p)?.[1];
      if (task && path.basename(opts.cwd!).startsWith('kit-')) {
        const s = sid('2001');
        yield init(s);
        yield toolUse(s, 'Edit', { file_path: path.join(opts.cwd!, 'src', 'cli.ts'), old_string: "case 'help':", new_string: "case '--version':" });
        const cli = path.join(opts.cwd!, 'src', 'cli.ts');
        fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace("      case 'help':", "      case '--version':\n        io.out('pocket-notes 0.2.0');\n        return 0;\n      case 'help':"));
        yield toolResult(s, 'The file has been updated.');
        // the CLI asks the host before a risky command
        const verdict = await opts.canUseTool!('Bash', { command: 'npm install left-pad' }, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never);
        permissionVerdict = verdict?.behavior ?? 'none';
        const answer = await callTool(opts, 'ask_user', { question: 'Print just the number or "pocket-notes 0.2.0"?', options: ['Name + number (recommended)', 'Just the number'] });
        yield say(s, `Got it: ${answer}`);
        yield toolUse(s, 'Bash', { command: 'npm test' });
        yield toolResult(s, '# pass 10\n# fail 0');
        await callTool(opts, 'update_task', { task_id: task, status: 'review', summary: 'Added --version; tests pass.' });
        yield result(s, 'implemented');
        return;
      }
      if (task && path.basename(opts.cwd!).startsWith('juniper-')) {
        const s = sid('3001');
        yield init(s);
        fs.appendFileSync(path.join(opts.cwd!, 'README.md'), '\n`notes --version` prints the version.\n');
        yield toolUse(s, 'Write', { file_path: path.join(opts.cwd!, 'README.md'), content: 'x' });
        yield toolResult(s, 'ok');
        // forgets update_task: the Foreman nudges once, then moves it to review itself
        yield result(s, 'README updated');
        return;
      }
      if (p.startsWith('You ended your turn')) {
        const s = sid('3001');
        yield init(s);
        yield result(s, 'all done');
        return;
      }
      const review = /Review request: (t\d+)/.exec(p)?.[1];
      if (review) {
        const s = sid('1001');
        yield init(s);
        if (review === 't1') await callTool(opts, 'request_merge', { task_id: review, summary: 'Adds --version. Tests green.' });
        yield result(s, 'Looks fine to me.'); // t2: no verdict -> Foreman still opens a merge decision
        return;
      }
      const s = sid('9999');
      yield init(s);
      yield result(s, 'ok');
    }
    const it = run();
    return Object.assign(it, { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

let h: Harness;
let home: string;
let repoPath: string;
let backend: ClaudeBackend;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit,juniper', '--repo', repoPath]);
  backend = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fakeQuery(h) as never, skipAuthCheck: true });
  await h.fm.start(backend);
});

afterAll(async () => {
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

describe('claude backend orchestration (fake SDK)', () => {
  it('plans, works in worktrees, asks the user, reviews, merges and completes the goal', async () => {
    const fm = h.fm;
    expect(fm.agent('rowan')!.active).toBe(false); // off shift
    const goal = await fm.submitGoal('Add a --version flag');
    await until(() => fm.tasks.list().length === 2 && fm.goal(goal.id)!.status === 'active');
    expect(fm.memory.get('shared/plan-version-flag')).toBeDefined();

    // Kit: permission prompt -> Deny
    await until(() => fm.decisions.open().some((d) => d.kind === 'permission'));
    const perm = fm.decisions.open().find((d) => d.kind === 'permission')!;
    expect(perm.question).toContain('npm install left-pad');
    expect(fm.agent('kit')!.state).toBe('waiting_user');
    await fm.answerDecision(perm.id, 'Deny');
    await until(() => permissionVerdict !== undefined);
    expect(permissionVerdict).toBe('deny');

    // Kit: ask_user -> answered
    await until(() => fm.decisions.open().some((d) => d.kind === 'question'));
    const q = fm.decisions.open().find((d) => d.kind === 'question')!;
    expect(fm.agent('kit')!.station).toBe('user');
    await fm.answerDecision(q.id, 0);

    // CI runs in the worktree, lead reviews and requests the merge
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    expect(fm.tasks.get('t1')!.ci).toBe('pass');
    const m1 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1')!;
    const diff = await fm.repos.diff(m1.repoId!, m1.worktree!);
    expect(diff.files.map((f) => f.path)).toEqual(['src/cli.ts']);
    await fm.answerDecision(m1.id, 'Merge');
    expect(fm.tasks.get('t1')!.status).toBe('done');
    expect(fs.readFileSync(path.join(repoPath, 'src', 'cli.ts'), 'utf8')).toContain("case '--version':");

    // Juniper starts after the dep merged; forgets update_task -> nudged -> auto review -> merge decision
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't2'), 60_000);
    expect(calls.some((c) => c.prompt.startsWith('You ended your turn') && c.resume === sid('3001'))).toBe(true);
    const m2 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't2')!;
    await fm.answerDecision(m2.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done');

    // sessions persisted per agent+task, cost accounted, logs mapped from the stream
    const sessions = fm.store.data.sessions;
    expect(sessions[`marlow:${goal.id}`]!.sessionId).toBe(sid('1001'));
    expect(sessions['kit:t1']!.sessionId).toBe(sid('2001'));
    expect(fm.status.costUsd).toBeGreaterThan(0);
    const kitLog = fm.store.logTail('kit').map((e) => `${e.kind}:${e.text}`);
    expect(kitLog.some((l) => l.startsWith('tool:Edit src/cli.ts'))).toBe(true);
    expect(kitLog.some((l) => l.startsWith('diff:src/cli.ts'))).toBe(true);
    expect(kitLog.some((l) => l.includes('Alex denied'))).toBe(true);
    // workers never ran in the user checkout; the lead did (read-only)
    expect(calls.filter((c) => /Your task/.test(c.prompt)).every((c) => c.cwd.includes(path.join('worktrees', 'demo-app')))).toBe(true);
    expect(fs.realpathSync(calls.find((c) => c.prompt.startsWith('New goal'))!.cwd)).toBe(fs.realpathSync(repoPath));

    // each agent's CLI env: its own git identity, no signing, git cannot walk up out of its cwd
    const kitTurn = calls.find((c) => /Your task/.test(c.prompt) && c.cwd.includes('kit-'))!;
    const env = kitTurn.env!;
    expect(env.GIT_AUTHOR_NAME).toBe('AgentCraft Kit');
    expect(env.GIT_COMMITTER_EMAIL).toBe('kit@agentcraft.local');
    expect(env.GIT_CEILING_DIRECTORIES!.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(path.dirname(kitTurn.cwd));
    const cfg = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_x, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(cfg['commit.gpgsign']).toBe('false');
    expect(cfg['protocol.allow']).toBe('never');
    expect(calls.find((c) => c.prompt.startsWith('New goal'))!.env!.GIT_AUTHOR_NAME).toBe('AgentCraft Marlow');
  });
});

describe('stream mapping', () => {
  it('maps tool use to state/station like the spec says', () => {
    const fm = h.fm;
    const m = new StreamMapper(fm, 'wren', repoPath, 'worker');
    const s = sid('5');
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ['Read', { file_path: path.join(repoPath, 'src', 'format.ts') }, 'reading', 'library'],
      ['Grep', { pattern: 'TAG' }, 'reading', 'library'],
      ['Edit', { file_path: path.join(repoPath, 'src', 'format.ts'), old_string: 'a', new_string: 'b' }, 'editing', 'desk'],
      ['Bash', { command: 'npm test' }, 'testing', 'testbench'],
      ['Bash', { command: 'git status' }, 'running', 'terminal'],
      ['mcp__agentcraft__ask_user', { question: 'q?' }, 'waiting_user', 'user'],
    ];
    for (const [tool, input, state, station] of cases) {
      m.handle(toolUse(s, tool, input));
      expect([fm.agent('wren')!.state, fm.agent('wren')!.station], tool).toEqual([state, station]);
    }
    m.handle(result(s));
    expect(m.stats.sessionId).toBe(s);
    expect(m.stats.isError).toBe(false);
  });

  it('flags authentication failures', () => {
    const m = new StreamMapper(h.fm, 'wren', repoPath, 'worker');
    m.handle(msg({ type: 'assistant', session_id: 'x', error: 'authentication_failed', message: { content: [] } }));
    expect(m.stats.authFailed).toBe('authentication_failed');
  });
});
