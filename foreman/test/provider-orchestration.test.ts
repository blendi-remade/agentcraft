// The shared scheduler exercises Codex-shaped fake turns without invoking either model provider.
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { RESUME_PROMPT } from '../src/agents/claude/prompts.js';
import type { AgentDriver, DriverTurnContext, TurnStats } from '../src/agents/driver.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.fm.close();
  for (const p of dirs.splice(0)) rmrf(p);
});

const ok = (sessionId = 'codex-session'): TurnStats => ({ sessionId, isError: false, errors: [], subtype: 'success', numTurns: 1 });
const unexpectedQuery = () => { throw new Error('Claude SDK must not be queried by an alternate provider'); };
function driver(runTurn: AgentDriver['runTurn']): AgentDriver {
  return {
    name: 'codex', label: 'Codex', runTurn,
    async checkAuth(fm) {
      fm.setStatus({ auth: 'ok', account: 'fake Codex account', message: 'Codex ready' });
      return true;
    },
  };
}
async function fresh(): Promise<{ h: Harness; home: string; repo: string }> {
  const home = tempDir();
  const repo = await demoRepo();
  dirs.push(home, path.dirname(repo));
  const h = makeForeman(home, ['--backend', 'codex', '--profile', 'shared', '--workers', 'kit', '--repo', repo]);
  harnesses.push(h);
  return { h, home, repo };
}
async function callTool(ctx: DriverTurnContext, name: string, args: Record<string, unknown>) {
  const tool = ctx.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.handler(args, {});
}
function waitForAbort(ctx: DriverTurnContext): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new Error('aborted'));
    if (ctx.turn.signal.aborted) fail();
    else ctx.turn.signal.addEventListener('abort', fail, { once: true });
  });
}

describe('shared orchestration driver boundary', () => {
  it('uses provider auth/state and does not display legacy Claude spend', async () => {
    const { h } = await fresh();
    const legacyState = { inflight: {}, ciFixes: { t1: 2 }, stopped: ['kit'] };
    h.fm.store.data.backend.claude = legacyState;
    h.fm.store.data.sessions['marlow:g1'] = { sessionId: 'claude-session', turns: 3, costUsd: 12.5, updatedAt: 1 };
    const queryFn = vi.fn(unexpectedQuery);
    const d = driver(async () => ok());
    const auth = vi.spyOn(d, 'checkAuth');
    const b = new ClaudeBackend(h.fm, h.cfg.codex, { driver: d, queryFn: queryFn as never });
    await h.fm.start(b);
    expect(b.name).toBe('codex');
    expect(auth).toHaveBeenCalledExactlyOnceWith(h.fm);
    expect(queryFn).not.toHaveBeenCalled();
    expect(h.fm.status.auth).toBe('ok');
    expect(h.fm.status.account).toBe('fake Codex account');
    expect(h.fm.status.costUsd ?? 0).toBe(0);
    expect(h.fm.agent('kit')!.active).toBe(true);
    expect(h.fm.store.data.backend.claude).toEqual(legacyState);
    expect(h.fm.store.data.backend.codex).toBeDefined();
  });

  it('fails auth with provider-specific wording and prevents turns', async () => {
    const { h } = await fresh();
    const run = vi.fn(async () => ok());
    const d = driver(run);
    d.checkAuth = async () => { throw new Error('Codex login is missing'); };
    await h.fm.start(new ClaudeBackend(h.fm, h.cfg.codex, { driver: d, queryFn: unexpectedQuery as never }));
    expect(h.fm.status.auth).toBe('failed');
    expect(h.fm.status.message).toContain('Codex authentication check failed');
    await expect(h.fm.submitGoal('Should never reach a turn')).rejects.toThrow('Codex is not available');
    expect(run).not.toHaveBeenCalled();
  });

  it('persists a session before turn completion and resumes it after restart in its own namespace', async () => {
    let { h, home, repo } = await fresh();
    h.fm.store.data.sessions['marlow:g1'] = { sessionId: 'claude-session', turns: 1, costUsd: 1, updatedAt: 1 };
    let first: DriverTurnContext | undefined;
    await h.fm.start(new ClaudeBackend(h.fm, h.cfg.codex, {
      queryFn: unexpectedQuery as never,
      driver: driver(async (ctx) => {
        first = ctx;
        ctx.onSession('codex-early-session');
        return waitForAbort(ctx);
      }),
    }));
    const goal = await h.fm.submitGoal('Inspect the repository');
    await until(() => h.fm.store.data.sessions[`codex:marlow:${goal.id}`]?.sessionId === 'codex-early-session');
    expect(first!.resume).toBeUndefined();
    expect(h.fm.store.data.sessions['marlow:g1']!.sessionId).toBe('claude-session');
    expect(h.fm.goal(goal.id)!.status).toBe('planning');
    await h.fm.close();
    harnesses.splice(harnesses.indexOf(h), 1);

    h = makeForeman(home, ['--backend', 'codex', '--profile', 'shared', '--workers', 'kit', '--repo', repo]);
    harnesses.push(h);
    let resumed: DriverTurnContext | undefined;
    await h.fm.start(new ClaudeBackend(h.fm, h.cfg.codex, {
      queryFn: unexpectedQuery as never,
      driver: driver(async (ctx) => { resumed = ctx; return ok('codex-early-session'); }),
    }));
    await until(() => h.fm.goal(goal.id)!.status === 'cancelled');
    expect(resumed!.resume).toBe('codex-early-session');
    expect(resumed!.prompt).toBe(RESUME_PROMPT);
    expect(resumed!.role).toBe('lead');
    expect(resumed!.cwd).toBe(repo);
    expect(h.fm.store.data.sessions[`codex:marlow:${goal.id}`]!.turns).toBe(1);
    expect(h.fm.store.data.sessions['marlow:g1']!.turns).toBe(1);
  });

  it('provides the shared tools and permission policy, and refuses further actions after pause', async () => {
    const { h } = await fresh();
    let turn: DriverTurnContext | undefined;
    const b = new ClaudeBackend(h.fm, h.cfg.codex, {
      queryFn: unexpectedQuery as never,
      driver: driver(async (ctx) => { turn = ctx; return waitForAbort(ctx); }),
    });
    await h.fm.start(b);
    await h.fm.submitGoal('Inspect the repository');
    await until(() => !!turn);
    const ctx = turn!;
    expect(ctx.tools.map((t) => t.name)).toContain('create_task');
    expect(ctx.tools.map((t) => t.name)).toContain('request_merge');
    expect((await ctx.canUseTool('Read', { file_path: path.join(ctx.cwd, 'README.md') })).behavior).toBe('allow');
    expect((await ctx.canUseTool('Write', { file_path: path.join(ctx.cwd, 'x.txt'), content: 'x' })).behavior).toBe('deny');
    await callTool(ctx, 'write_memory', { title: 'Before pause', body: 'Allowed', scope: 'shared' });
    expect(h.fm.memory.get('shared/before-pause')).toBeDefined();
    await b.onAgentAction('marlow', 'pause');
    expect(ctx.turn.signal.aborted).toBe(true);
    expect(ctx.turn.reason()).toBe('pause');
    expect((await ctx.canUseTool('Read', { file_path: path.join(ctx.cwd, 'README.md') })).behavior).toBe('deny');
    const result = await callTool(ctx, 'write_memory', { title: 'After pause', body: 'Forbidden', scope: 'shared' });
    expect(result.isError).toBe(true);
    expect(h.fm.memory.get('shared/after-pause')).toBeUndefined();
  });

  it('reaps a registered provider process on shutdown even if it ignores the abort signal', async () => {
    const { h } = await fresh();
    let child: ChildProcess | undefined;
    const b = new ClaudeBackend(h.fm, h.cfg.codex, {
      queryFn: unexpectedQuery as never,
      driver: driver(async (ctx) => {
        child = ctx.spawnProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: ctx.cwd });
        return waitForAbort(ctx);
      }),
    });
    await h.fm.start(b);
    await h.fm.submitGoal('Inspect the repository');
    await until(() => !!child?.pid);
    await b.stop();
    await until(() => child!.exitCode !== null || child!.signalCode !== null);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });

  it('schedules a worker in a worktree with shared permission and question decisions', async () => {
    const { h } = await fresh();
    let worker: DriverTurnContext | undefined;
    let allowed: string | undefined;
    const d = driver(async (ctx) => {
      ctx.onSession(`codex-${ctx.agentId}`);
      if (ctx.role === 'lead') {
        await callTool(ctx, 'create_task', { title: 'Inspect version flag', description: 'Check whether a flag is needed', assignee: 'kit' });
      } else {
        worker = ctx;
        allowed = (await ctx.canUseTool('Bash', { command: 'npm install left-pad' }, { title: 'Dependency request' })).behavior;
        await callTool(ctx, 'ask_user', { question: 'Should this remain blocked?', options: ['Yes', 'No'] });
        await callTool(ctx, 'update_task', { task_id: 't1', status: 'blocked', blocked_reason: 'Awaiting requirements' });
      }
      return ok(`codex-${ctx.agentId}`);
    });
    await h.fm.start(new ClaudeBackend(h.fm, h.cfg.codex, { driver: d, queryFn: unexpectedQuery as never }));
    await h.fm.submitGoal('Evaluate version flag');
    await until(() => h.fm.decisions.open().some((x) => x.kind === 'permission'));
    expect(worker!.cwd).toContain(path.join('worktrees', 'demo-app', 'kit-t1'));
    expect(worker!.tools.map((t) => t.name)).not.toContain('create_task');
    const permission = h.fm.decisions.open().find((x) => x.kind === 'permission')!;
    expect(permission.context).toContain('Dependency request');
    await h.fm.answerDecision(permission.id, 'Deny');
    await until(() => h.fm.decisions.open().some((x) => x.kind === 'question'));
    expect(allowed).toBe('deny');
    const question = h.fm.decisions.open().find((x) => x.kind === 'question')!;
    await h.fm.answerDecision(question.id, 'Yes');
    await until(() => h.fm.tasks.get('t1')!.status === 'blocked');
    expect(h.fm.store.data.sessions['codex:kit:t1']!.sessionId).toBe('codex-kit');
    expect(h.fm.store.data.sessions['kit:t1']).toBeUndefined();
  });
});
