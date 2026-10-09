// Restart recovery for the claude backend (fake SDK). A Foreman shutdown can happen at any point
// of a goal; after the restart nothing may wait forever:
//  - a worker turn interrupted mid-way resumes with its persisted session id
//  - an ask_user question left open resumes the session with the answer once the user replies
//  - the LEAD's planning turn interrupted (asking the user, mid-exploration, or before it even had
//    a session) still ends with an active goal and workers starting
//  - a task left "doing" with no turn behind it is re-queued and its session resumed
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { RESUME_PROMPT } from '../src/agents/prompts.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const tools = (o: Options) => (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools;
const callTool = async (o: Options, name: string, args: Record<string, unknown>) => (await tools(o)[name]!.handler(args, {})).content.map((c) => c.text).join('\n');
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-000000000000', ...o }) as unknown as SDKMessage;
const init = (s: string) => m({ type: 'system', subtype: 'init', session_id: s, model: 'fake' });
const result = (s: string) => m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.001, session_id: s, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
const LEAD_S = '11111111-1111-4111-8111-111111111111';
const WORK_S = '22222222-2222-4222-8222-222222222222';

/**
 * hang        worker hangs mid-turn (killed by the restart)
 * ask         worker asks the user and waits
 * lead-ask    lead asks the user during planning and waits
 * lead-hang   lead hangs mid-plan after it got a session
 * lead-early  lead hangs before it has a session id (no init message yet)
 * finish      everyone completes their turn
 */
type Mode = 'hang' | 'ask' | 'lead-ask' | 'lead-hang' | 'lead-early' | 'finish';
interface Call {
  prompt: string;
  resume?: string;
  cwd: string;
  lead: boolean;
}

function fake(mode: Mode, calls: Call[]) {
  return ({ prompt, options }: { prompt: string; options: Options }) => {
    const p = String(prompt);
    const lead = 'create_task' in tools(options);
    calls.push({ prompt: p, cwd: options.cwd!, lead, ...(options.resume ? { resume: options.resume } : {}) });
    const aborted = new Promise<never>((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    async function* run(): AsyncGenerator<SDKMessage> {
      if (lead) {
        if (p.startsWith('Review request')) {
          yield init(LEAD_S);
          await callTool(options, 'request_merge', { task_id: 't1', summary: 'ok' });
          yield result(LEAD_S);
          return;
        }
        if (mode === 'lead-early' && p.startsWith('New goal')) await aborted; // dies before init
        yield init(LEAD_S);
        if (mode === 'lead-ask' && p.startsWith('New goal')) await Promise.race([callTool(options, 'ask_user', { question: 'Flag name: --version or -V?', options: ['--version', '-V'] }), aborted]);
        if (mode === 'lead-hang' && p.startsWith('New goal')) await aborted;
        // plan (fresh, resumed after a restart, or continued after the answer)
        if (!h0.fm.tasks.list().length || !h0.fm.tasks.get('t1')) await callTool(options, 'create_task', { title: 'Add a version flag', description: 'x', assignee: 'kit' });
        yield result(LEAD_S);
        return;
      }
      yield init(WORK_S);
      if (mode === 'hang' && p.startsWith('Your task')) await aborted; // killed mid-turn
      if (mode === 'ask' && p.startsWith('Your task')) {
        await Promise.race([callTool(options, 'ask_user', { question: 'Short or long output?', options: ['Short', 'Long'] }), aborted]);
      }
      fs.appendFileSync(path.join(options.cwd!, 'README.md'), '\nversion flag\n');
      await callTool(options, 'update_task', { task_id: 't1', status: 'review', summary: 'done' });
      yield result(WORK_S);
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

// the fake needs the current Foreman to know whether tasks exist
let h0: Harness;

const cleanup: string[] = [];
afterAll(() => cleanup.forEach(rmrf));

async function boot(home: string, repo: string, mode: Mode, calls: Call[]): Promise<{ h: Harness; b: ClaudeBackend }> {
  const h = makeForeman(home, ['--backend', 'claude', '--workers', 'kit', '--repo', repo]);
  h0 = h;
  const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fake(mode, calls) as never, skipAuthCheck: true });
  await h.fm.start(b);
  return { h, b };
}

async function fresh(): Promise<{ home: string; repo: string }> {
  const home = tempDir();
  const repo = await demoRepo();
  cleanup.push(home, path.dirname(repo));
  return { home, repo };
}

describe('claude backend restart recovery (fake SDK)', () => {
  it('resumes an interrupted worker turn with its persisted session id', async () => {
    const { home, repo } = await fresh();
    const calls: Call[] = [];
    let { h } = await boot(home, repo, 'hang', calls);
    await h.fm.submitGoal('version flag');
    await until(() => h.fm.store.data.sessions['kit:t1']?.sessionId === WORK_S);
    const st = h.fm.store.data.backend.claude as { inflight: Record<string, unknown> };
    expect(st.inflight.kit).toBeDefined();
    await h.fm.close(); // Foreman goes down mid-turn

    const calls2: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls2));
    await until(() => calls2.some((c) => c.prompt === RESUME_PROMPT));
    const resumed = calls2.find((c) => c.prompt === RESUME_PROMPT)!;
    expect(resumed.resume).toBe(WORK_S);
    expect(resumed.cwd).toContain(path.join('worktrees', 'demo-app', 'kit-t1'));
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    await h.fm.close();
  });

  it('an ask_user question left open across a restart resumes the session with the answer', async () => {
    const { home, repo } = await fresh();
    const calls: Call[] = [];
    let { h } = await boot(home, repo, 'ask', calls);
    await h.fm.submitGoal('version flag');
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'question'));
    const q = h.fm.decisions.open().find((d) => d.kind === 'question')!;
    await h.fm.close();

    const calls2: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls2));
    expect(h.fm.decisions.get(q.id)!.status).toBe('open');
    expect(h.fm.agent('kit')!.state).toBe('waiting_user');
    expect(calls2.length).toBe(0); // nothing resumed until the user answers
    await h.fm.answerDecision(q.id, 'Long');
    await until(() => calls2.length > 0);
    expect(calls2[0]!.resume).toBe(WORK_S);
    expect(calls2[0]!.prompt).toContain('Alex answered: Long');
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge'), 60_000);
    await h.fm.close();
  });

  it('the lead asking Alex during planning, across a restart: the goal becomes active and work starts', async () => {
    const { home, repo } = await fresh();
    const calls: Call[] = [];
    let { h } = await boot(home, repo, 'lead-ask', calls);
    const goal = await h.fm.submitGoal('version flag');
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'question' && d.agentId === 'marlow'));
    const q = h.fm.decisions.open().find((d) => d.kind === 'question')!;
    expect(h.fm.goal(goal.id)!.status).toBe('planning');
    await h.fm.close();

    const calls2: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls2));
    expect(h.fm.goal(goal.id)!.status).toBe('planning');
    expect(calls2.length).toBe(0); // still waiting for the answer
    await h.fm.answerDecision(q.id, '--version');
    await until(() => calls2.some((c) => c.lead));
    const lead = calls2.find((c) => c.lead)!;
    expect(lead.resume).toBe(LEAD_S);
    expect(lead.prompt).toContain('Alex answered: --version');
    // the resumed turn is still the plan: the goal goes active and the worker picks up t1
    await until(() => h.fm.goal(goal.id)!.status === 'active');
    await until(() => calls2.some((c) => !c.lead && c.prompt.startsWith('Your task: t1')));
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    await h.fm.close();
  });

  it('a planning turn killed mid-way is resumed as a plan (goal goes active)', async () => {
    const { home, repo } = await fresh();
    const calls: Call[] = [];
    let { h } = await boot(home, repo, 'lead-hang', calls);
    const goal = await h.fm.submitGoal('version flag');
    await until(() => h.fm.store.data.sessions[`marlow:${goal.id}`]?.sessionId === LEAD_S);
    await h.fm.close();

    const calls2: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls2));
    await until(() => calls2.some((c) => c.lead && c.prompt === RESUME_PROMPT));
    expect(calls2.find((c) => c.lead)!.resume).toBe(LEAD_S);
    await until(() => h.fm.goal(goal.id)!.status === 'active');
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    await h.fm.close();
  });

  it('a planning turn that died before it had a session is planned again', async () => {
    const { home, repo } = await fresh();
    const calls: Call[] = [];
    let { h } = await boot(home, repo, 'lead-early', calls);
    const goal = await h.fm.submitGoal('version flag');
    await until(() => calls.some((c) => c.lead));
    await h.fm.close();

    const calls2: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls2));
    await until(() => calls2.some((c) => c.lead && c.prompt.startsWith('New goal')));
    await until(() => h.fm.goal(goal.id)!.status === 'active');
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    await h.fm.close();
  });

  it('clears a cancelled task left attached to an errored worker and never resumes its stale session', async () => {
    const { home, repo } = await fresh();
    let { h } = await boot(home, repo, 'hang', []);
    await h.fm.submitGoal('version flag');
    await until(() => h.fm.store.data.sessions['kit:t1']?.sessionId === WORK_S);
    await h.fm.close();
    const stateFile = path.join(home, 'claude', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.tasks.find((t: { id: string }) => t.id === 't1').status = 'cancelled';
    Object.assign(state.agents.find((a: { id: string }) => a.id === 'kit'), { state: 'error', activity: 't1 failed', station: 'desk' });
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const calls: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls));
    try {
      await new Promise(r => setTimeout(r, 200));
      expect(h.fm.agent('kit')).toMatchObject({ active: true, state: 'idle', station: 'lounge', activity: 'task cancelled' });
      expect(h.fm.agent('kit')!.taskId).toBeUndefined();
      expect(h.fm.agent('kit')!.worktree).toBeUndefined();
      expect((h.fm.store.data.backend.claude as { inflight: Record<string, unknown> }).inflight.kit).toBeUndefined();
      expect(calls.some(c => !c.lead)).toBe(false);
      expect(h.fm.tasks.get('t1')!.status).toBe('cancelled');
    } finally { await h.fm.close(); }
  });

  it('a task left "doing" with no turn behind it is re-queued and its session resumed', async () => {
    const { home, repo } = await fresh();
    const calls: Call[] = [];
    let { h } = await boot(home, repo, 'hang', calls);
    await h.fm.submitGoal('version flag');
    await until(() => h.fm.store.data.sessions['kit:t1']?.sessionId === WORK_S);
    await h.fm.close();
    // simulate a crash after the turn record was cleared but before its follow-up work ran
    const stateFile = path.join(home, 'claude', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { backend: { claude: { inflight: Record<string, unknown> } }; tasks: Array<{ id: string; status: string }> };
    delete state.backend.claude.inflight.kit;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    expect(state.tasks.find((t) => t.id === 't1')!.status).toBe('doing');

    const calls2: Call[] = [];
    ({ h } = await boot(home, repo, 'finish', calls2));
    await until(() => calls2.some((c) => !c.lead && c.prompt.startsWith('Your task: t1')));
    expect(calls2.find((c) => !c.lead)!.resume).toBe(WORK_S);
    await until(() => h.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    await h.fm.close();
  });
});
