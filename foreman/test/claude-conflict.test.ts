// Parallel tasks that both touch the same lines: the second approved merge conflicts with main.
// The Foreman must not dead-end there; it sends the branch back to its worker to `git merge main`
// and resolve, and the task comes back through CI + review with a fresh merge decision.
// Fake SDK like claude-backend.test.ts: the real tools, worktrees, CI, merges; no API calls.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
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
const result = (session: string, text = 'done') => msg({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.001, session_id: session, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });

const HELP_LINE = /^(\s*notes help\s+show this help`;)$/m;
const addHelp = (src: string, line: string) => src.replace(HELP_LINE, `  ${line}\n$1`);

const prompts: Array<{ agent: string; prompt: string }> = [];
let conflictGitOk = false;

function fakeQuery() {
  return ({ prompt, options }: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const opts = options!;
    const p = String(prompt);
    const cwd = opts.cwd!;
    const agent = path.basename(cwd).startsWith('kit-') ? 'kit' : path.basename(cwd).startsWith('juniper-') ? 'juniper' : 'marlow';
    prompts.push({ agent, prompt: p });
    const gitEnv = { ...process.env, ...opts.env };
    async function* run(): AsyncGenerator<SDKMessage> {
      if (p.startsWith('New goal')) {
        const s = sid('1001');
        yield init(s);
        await callTool(opts, 'write_memory', { title: 'Plan: export + stats', body: '- t1 export (Kit)\n- t2 stats (Juniper), in parallel', scope: 'shared' });
        await callTool(opts, 'create_task', { title: 'notes export', description: 'help line', assignee: 'kit' });
        await callTool(opts, 'create_task', { title: 'notes stats', description: 'help line', assignee: 'juniper' });
        yield result(s, 'planned');
        return;
      }
      const cli = path.join(cwd, 'src', 'cli.ts');
      if (p.startsWith('Alex approved merging')) {
        // the conflict hand-back: merge main, resolve keeping both sides, commit the merge
        const s = sid(agent === 'kit' ? '2001' : '3001');
        yield init(s);
        const m = /run `git merge (\S+)`/.exec(p);
        let merged = true;
        try {
          execFileSync('git', ['merge', m![1]!], { cwd, env: gitEnv, stdio: 'pipe' });
        } catch {
          merged = false;
        }
        expect(merged).toBe(false); // it really conflicts
        const mainSrc = execFileSync('git', ['show', `${m![1]}:src/cli.ts`], { cwd, env: gitEnv, encoding: 'utf8' });
        fs.writeFileSync(cli, addHelp(mainSrc, 'notes stats             show counts'));
        execFileSync('git', ['add', 'src/cli.ts'], { cwd, env: gitEnv });
        execFileSync('git', ['commit', '--no-edit', '-q'], { cwd, env: gitEnv });
        conflictGitOk = true;
        await callTool(opts, 'update_task', { task_id: /merging (t\d+)/.exec(p)![1], status: 'review', summary: 'Merged main, kept both help lines.' });
        yield result(s, 'resolved');
        return;
      }
      const task = /Your task: (t\d+)/.exec(p)?.[1];
      if (task) {
        const s = sid(agent === 'kit' ? '2001' : '3001');
        yield init(s);
        const line = agent === 'kit' ? 'notes export --format md|json  export notes' : 'notes stats             show counts';
        fs.writeFileSync(cli, addHelp(fs.readFileSync(cli, 'utf8'), line));
        await callTool(opts, 'update_task', { task_id: task, status: 'review', summary: `${agent}: help line added` });
        yield result(s, 'implemented');
        return;
      }
      const review = /Review request: (t\d+)/.exec(p)?.[1];
      if (review) {
        const s = sid('1001');
        yield init(s);
        await callTool(opts, 'request_merge', { task_id: review, summary: `${review} looks good` });
        yield result(s, 'ok');
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

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit,juniper', '--repo', repoPath]);
  const backend = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fakeQuery() as never, skipAuthCheck: true });
  await h.fm.start(backend);
});

afterAll(async () => {
  await h.fm.close();
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

describe('claude backend: approved merge that conflicts with main', () => {
  it('sends the branch back to its worker, who merges main; the task merges on the second approval', async () => {
    const fm = h.fm;
    const goal = await fm.submitGoal('Add export and stats');
    // both tasks run in parallel and reach review
    await until(() => fm.decisions.open().filter((d) => d.kind === 'merge').length === 2, 60_000);
    const m1 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't1')!;
    const m2 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't2')!;
    await fm.answerDecision(m1.id, 'Merge');
    expect(fm.tasks.get('t1')!.status).toBe('done');

    // t2 now conflicts in src/cli.ts: not a dead end on the user's desk, back to Juniper
    await fm.answerDecision(m2.id, 'Merge');
    expect(fm.decisions.get(m2.id)!.status).not.toBe('open');
    expect(['doing', 'review']).toContain(fm.tasks.get('t2')!.status); // the fake worker may already be done
    expect(fm.store.data.feed.some((f) => /t2 conflicts with main in src\/cli\.ts/.test(f.text))).toBe(true);
    await until(() => prompts.some((x) => x.agent === 'juniper' && x.prompt.startsWith('Alex approved merging t2')));
    const handBack = prompts.find((x) => x.agent === 'juniper' && x.prompt.startsWith('Alex approved merging t2'))!.prompt;
    expect(handBack).toContain('git merge main');
    expect(handBack).toContain('src/cli.ts');

    // resolved -> CI -> lead review -> a fresh merge decision -> merges cleanly
    await until(() => conflictGitOk && fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't2' && d.id !== m2.id), 60_000);
    const m3 = fm.decisions.open().find((d) => d.kind === 'merge' && d.taskId === 't2')!;
    await fm.answerDecision(m3.id, 'Merge');
    expect(fm.tasks.get('t2')!.status).toBe('done');
    const cli = fs.readFileSync(path.join(repoPath, 'src', 'cli.ts'), 'utf8');
    expect(cli).toContain('notes export --format md|json');
    expect(cli).toContain('notes stats');
    expect(cli).not.toMatch(/^(<<<<<<<|>>>>>>>|=======)/m);
    await until(() => fm.goal(goal.id)!.status === 'done');
  });
});
