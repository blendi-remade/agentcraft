// Steering the claude backend (fake SDK): stop really takes an agent off shift, its open
// question is withdrawn and its task continues with another worker from the same branch; pause
// during a question withdraws the question and resumes the job later; failed turns show `error`.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { git } from '../src/util/git.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const tools = (o: Options) => (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools;
const callTool = async (o: Options, name: string, args: Record<string, unknown>) => (await tools(o)[name]!.handler(args, {})).content.map((c) => c.text).join('\n');
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000000', ...o }) as unknown as SDKMessage;
const init = (s: string) => m({ type: 'system', subtype: 'init', session_id: s, model: 'fake' });
const ok = (s: string) => m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.001, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
const maxTurns = (s: string) => m({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 30, total_cost_usd: 0.01, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [], errors: [] });
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Call {
  agent: string;
  prompt: string;
  cwd: string;
}

type WorkerScript = (o: Options, p: string, aborted: Promise<never>) => AsyncGenerator<SDKMessage>;
let closedQueries = 0;

function fake(calls: Call[], worker: Record<string, WorkerScript>, reviewer?: WorkerScript) {
  return ({ prompt, options }: { prompt: string; options: Options }) => {
    const p = String(prompt);
    const lead = 'create_task' in tools(options);
    const agent = lead ? 'marlow' : (/[\\/](\w+)-t\d+$/.exec(options.cwd!)?.[1] ?? '?');
    calls.push({ agent, prompt: p, cwd: options.cwd! });
    const aborted = new Promise<never>((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    aborted.catch(() => undefined);
    async function* run(): AsyncGenerator<SDKMessage> {
      if (lead) {
        yield init(sid(1));
        if (p.startsWith('New goal')) await callTool(options, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit' });
        else if (reviewer) {
          yield* reviewer(options, p, aborted);
          return;
        }
        const review = /Review request: (t\d+)/.exec(p)?.[1];
        if (review) await callTool(options, 'request_merge', { task_id: review, summary: 'ok' });
        yield ok(sid(1));
        return;
      }
      yield* worker[agent]!(options, p, aborted);
    }
    return Object.assign(run(), {
      close() {
        closedQueries++;
      },
      accountInfo: async () => ({ email: 'x' }),
    });
  };
}

const cleanup: string[] = [];
afterAll(() => cleanup.forEach(rmrf));

async function boot(workers: string, calls: Call[], worker: Record<string, WorkerScript>, reviewer?: WorkerScript): Promise<{ h: Harness; repo: string }> {
  const home = tempDir();
  const repo = await demoRepo();
  cleanup.push(home, path.dirname(repo));
  const h = makeForeman(home, ['--backend', 'claude', '--workers', workers, '--repo', repo]);
  const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fake(calls, worker, reviewer) as never, skipAuthCheck: true });
  await h.fm.start(b);
  return { h, repo };
}

/** Kit starts t1, leaves a partial edit, then asks the user and waits. */
const kitAsks: WorkerScript = async function* (o, p, aborted) {
  yield init(sid(2));
  if (p.startsWith('Your task')) {
    fs.writeFileSync(path.join(o.cwd!, 'KIT_PARTIAL.md'), 'half-done by Kit\n');
    await Promise.race([callTool(o, 'ask_user', { question: 'Short or long output?', options: ['Short', 'Long'] }), aborted]);
  }
  fs.appendFileSync(path.join(o.cwd!, 'README.md'), '\nversion flag (Kit)\n');
  await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'done by Kit' });
  yield ok(sid(2));
};

/** Juniper finishes whatever task she is given (noting whether Kit's partial work is there). */
let juniperSawKitWork: boolean | undefined;
const juniperFinishes: WorkerScript = async function* (o) {
  yield init(sid(3));
  juniperSawKitWork = fs.existsSync(path.join(o.cwd!, 'KIT_PARTIAL.md'));
  fs.appendFileSync(path.join(o.cwd!, 'README.md'), '\nversion flag (Juniper)\n');
  await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'finished by Juniper' });
  yield ok(sid(3));
};

describe('claude backend steering (fake SDK)', () => {
  it('stop: off shift, open question withdrawn, task handed to a free worker on the same branch', async () => {
    const calls: Call[] = [];
    const { h } = await boot('kit,juniper', calls, { kit: kitAsks, juniper: juniperFinishes });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => fm.decisions.open().some((d) => d.kind === 'question' && d.agentId === 'kit'));
    const q = fm.decisions.open().find((d) => d.kind === 'question')!;

    await fm.handle({ v: 1, type: 'agent.action', agentId: 'kit', action: 'stop' }, () => undefined);
    // the question is withdrawn (not left on the podium), Kit is off shift, t1 is back on the board
    expect(fm.decisions.get(q.id)!.status).toBe('cancelled');
    await expect(fm.answerDecision(q.id, 'Long')).rejects.toThrow(/cancelled/);
    expect(fm.agent('kit')!.active).toBe(false);
    expect(fm.agent('kit')!.station).toBe('lounge');

    // Juniper (free) picks t1 up and continues from Kit's branch: Kit's partial work is there
    await until(() => calls.some((c) => c.agent === 'juniper'));
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    expect(juniperSawKitWork).toBe(true);
    const t1 = fm.tasks.get('t1')!;
    expect(t1.assignee).toBe('juniper');
    expect(t1.worktree).toBe('juniper-t1');
    const kitWt = fm.repos.findWorktree('demo-app', 'kit-t1')!;
    expect(kitWt.status).toBe('abandoned');
    const log = (await git(h.fm.repos.require('demo-app').path, ['log', '--format=%s', kitWt.branch, '-1'])).stdout.trim();
    expect(log).toMatch(/work in progress \(Kit was stopped\)/);
    const diff = await fm.repos.diff('demo-app', 'juniper-t1');
    expect(diff.files.map((f) => f.path).sort()).toEqual(['KIT_PARTIAL.md', 'README.md']);

    // Kit never ran again while stopped, and stays stopped until resumed
    const kitCalls = calls.filter((c) => c.agent === 'kit').length;
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.agent === 'kit').length).toBe(kitCalls);
    expect(fm.agent('kit')!.active).toBe(false);
    await fm.handle({ v: 1, type: 'agent.action', agentId: 'kit', action: 'resume' }, () => undefined);
    expect(fm.agent('kit')!.active).toBe(true);
    await fm.close();
  });

  it('stop with no other worker: the task waits on the board; resume brings the agent back to it', async () => {
    const calls: Call[] = [];
    let resumedWork = false;
    const kit: WorkerScript = async function* (o, p, aborted) {
      if (calls.filter((c) => c.agent === 'kit').length > 1) {
        resumedWork = true;
        yield* kitAsks(o, 'continue', aborted);
        return;
      }
      yield* kitAsks(o, p, aborted);
    };
    const { h } = await boot('kit', calls, { kit });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => fm.decisions.open().some((d) => d.kind === 'question'));
    await fm.agentAction('kit', 'stop');
    await new Promise((r) => setTimeout(r, 400));
    expect(fm.tasks.get('t1')!.status).toBe('todo');
    expect(fm.tasks.get('t1')!.assignee).toBeUndefined();
    expect(calls.filter((c) => c.agent === 'kit').length).toBe(1); // not rescheduled
    expect(fm.decisions.open()).toEqual([]);
    await fm.agentAction('kit', 'resume');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    expect(resumedWork).toBe(true);
    expect(fm.tasks.get('t1')!.worktree).toBe('kit-t1'); // same agent: same worktree
    await fm.close();
  });

  it('a stopped turn changes nothing even if its CLI lingers, and the query is force-closed', async () => {
    const calls: Call[] = [];
    const lingering: string[] = [];
    const kit: WorkerScript = async function* (o, _p, aborted) {
      yield init(sid(5));
      await Promise.race([callTool(o, 'ask_user', { question: 'Short or long?', options: ['Short', 'Long'] }), aborted]).catch(() => undefined);
      // a CLI that keeps going after the stop (seen for real before close() was added)
      lingering.push(await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'sneaky' }));
      lingering.push(await callTool(o, 'send_message', { to: 'all', text: 'still here' }));
      const v = await o.canUseTool!('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r' } as never);
      lingering.push(v?.behavior ?? 'none');
      yield m({ type: 'assistant', session_id: sid(5), message: { content: [{ type: 'text', text: 'I am still working!' }] } });
      yield ok(sid(5));
    };
    const { h } = await boot('kit', calls, { kit });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => fm.decisions.open().some((d) => d.kind === 'question'));
    const closedBefore = closedQueries;
    await fm.agentAction('kit', 'stop');
    await until(() => lingering.length === 3);
    await new Promise((r) => setTimeout(r, 200));
    expect(lingering[0]).toMatch(/turn was stopped/);
    expect(lingering[1]).toMatch(/turn was stopped/);
    expect(lingering[2]).toBe('deny');
    expect(closedQueries).toBeGreaterThan(closedBefore);
    expect(fm.tasks.get('t1')!.status).toBe('todo');
    expect(h.events.some((e) => e.type === 'agent.say' && e.text === 'still here')).toBe(false);
    expect(fm.store.logTail('kit').some((e) => e.text.includes('I am still working'))).toBe(false);
    expect(fm.agent('kit')!.activity).toMatch(/stopped/);
    await fm.close();
  });

  it('a stopped agent stays off shift across a Foreman restart', async () => {
    const calls: Call[] = [];
    const { h } = await boot('kit,juniper', calls, { kit: kitAsks, juniper: juniperFinishes });
    await h.fm.agentAction('juniper', 'stop');
    const home = h.home;
    await h.fm.close();
    const h2 = makeForeman(home, ['--backend', 'claude', '--workers', 'kit,juniper']);
    await h2.fm.start(new ClaudeBackend(h2.fm, h2.cfg.claude, { queryFn: fake(calls, { kit: kitAsks, juniper: juniperFinishes }) as never, skipAuthCheck: true }));
    expect(h2.fm.agent('juniper')!.active).toBe(false);
    expect(h2.fm.agent('kit')!.active).toBe(true);
    await h2.fm.close();
  });

  it('pause during a question withdraws it; resume continues the job', async () => {
    const calls: Call[] = [];
    let pausedPrompt = '';
    const kit: WorkerScript = async function* (o, p, aborted) {
      if (p.startsWith('Alex paused you')) {
        pausedPrompt = p;
        yield* kitAsks(o, 'continue', aborted);
        return;
      }
      yield* kitAsks(o, p, aborted);
    };
    const { h } = await boot('kit', calls, { kit });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => fm.decisions.open().some((d) => d.kind === 'question'));
    const q = fm.decisions.open().find((d) => d.kind === 'question')!;
    await fm.agentAction('kit', 'pause');
    await until(() => fm.decisions.get(q.id)!.status === 'cancelled');
    expect(fm.tasks.get('t1')!.status).toBe('doing'); // pause keeps the task
    await fm.agentAction('kit', 'resume');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    expect(pausedPrompt).toMatch(/withdrawn/);
    await fm.close();
  });

  it('a failed turn puts the agent in the error state and blocks the task', async () => {
    const calls: Call[] = [];
    const kit: WorkerScript = async function* () {
      yield init(sid(4));
      yield maxTurns(sid(4));
    };
    const { h } = await boot('kit', calls, { kit });
    const fm = h.fm;
    await fm.submitGoal('version flag');
    await until(() => fm.tasks.get('t1')?.status === 'blocked');
    expect(fm.agent('kit')!.state).toBe('error');
    expect(fm.agent('kit')!.activity).toMatch(/max turns/);
    expect(fm.tasks.get('t1')!.blockedReason).toMatch(/error_max_turns/);
    expect(h.events.some((e) => e.type === 'agent.upsert' && e.agent.id === 'kit' && e.agent.state === 'error')).toBe(true);
    fm.taskAction('t1', 'cancel');
    expect(fm.agent('kit')).toMatchObject({ active: true, state: 'idle', station: 'lounge', activity: 'task cancelled' });
    expect(fm.agent('kit')!.taskId).toBeUndefined();
    expect(fm.agent('kit')!.worktree).toBeUndefined();
    await fm.close();
  });

  it('cancelling a paused task discards its continuation without discarding work', async () => {
    const calls: Call[] = [];
    const { h } = await boot('kit', calls, { kit: kitAsks });
    try {
      await h.fm.submitGoal('version flag');
      await until(() => h.fm.decisions.open().some(d => d.agentId === 'kit'));
      const worktree = h.fm.repos.requireWorktree('demo-app', 'kit-t1').path;
      await h.fm.agentAction('kit', 'pause');
      await until(() => !Object.hasOwn((h.fm.store.data.backend.claude as { inflight: object }).inflight, 'kit'));
      h.fm.taskAction('t1', 'cancel');
      await h.fm.agentAction('kit', 'resume');
      await new Promise(r => setTimeout(r, 200));
      expect(h.fm.tasks.get('t1')!.status).toBe('cancelled');
      expect(h.fm.agent('kit')).toMatchObject({ state: 'idle', station: 'lounge', active: true });
      expect(h.fm.agent('kit')!.taskId).toBeUndefined();
      expect(calls.filter(c => c.agent === 'kit')).toHaveLength(1);
      expect(fs.readFileSync(path.join(worktree, 'KIT_PARTIAL.md'), 'utf8')).toContain('half-done');
    } finally { await h.fm.close(); }
  });

  it.each(['paused', 'running'] as const)('reassigning a task preserves its %s lead review', async mode => {
    const calls: Call[] = [];
    let releaseReview!: () => void;
    const reviewReady = new Promise<void>(resolve => { releaseReview = resolve; });
    let reviews = 0;
    const reviewer: WorkerScript = async function* (o, _p, aborted) {
      reviews++;
      await Promise.race([reviewReady, aborted]);
      await callTool(o, 'request_merge', { task_id: 't1', summary: 'review complete' });
      yield ok(sid(1));
    };
    const kitFinishes: WorkerScript = async function* (o) {
      yield init(sid(2));
      fs.appendFileSync(path.join(o.cwd!, 'README.md'), '\nversion flag (Kit)\n');
      await callTool(o, 'update_task', { task_id: 't1', status: 'review', summary: 'done by Kit' });
      yield ok(sid(2));
    };
    const { h } = await boot('kit,juniper', calls, { kit: kitFinishes, juniper: juniperFinishes }, reviewer);
    const inflight = () => (h.fm.store.data.backend.claude as { inflight: Record<string, { taskId?: string }> }).inflight;
    try {
      await h.fm.submitGoal('version flag');
      await until(() => reviews === 1);
      if (mode === 'paused') {
        await h.fm.agentAction('marlow', 'pause');
        await until(() => !inflight().marlow);
      }
      h.fm.taskAction('t1', 'reassign', 'juniper');
      if (mode === 'running') expect(inflight().marlow?.taskId).toBe('t1');
      releaseReview();
      if (mode === 'paused') await h.fm.agentAction('marlow', 'resume');
      await until(() => h.fm.decisions.open().some(d => d.kind === 'merge' && d.taskId === 't1'));
      expect(reviews).toBe(mode === 'paused' ? 2 : 1);
      expect(h.fm.tasks.get('t1')).toMatchObject({ status: 'review', assignee: 'juniper' });
    } finally {
      releaseReview();
      await h.fm.close();
    }
  });
});
