// A mixed team: a Claude lead (fake SDK) with a Codex worker (fake app-server), and the config
// that builds such a team from flags.
import fs from 'node:fs';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeEngine } from '../src/agents/claude/engine.js';
import { CodexEngine } from '../src/agents/codex/engine.js';
import { TeamBackend } from '../src/agents/team.js';
import { loadConfig } from '../src/config.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'fixtures', 'fake-codex-native.mjs');
type ToolServer = { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
const callTool = async (o: Options, name: string, args: Record<string, unknown>) =>
  (await (o.mcpServers!.agentcraft as unknown as ToolServer).instance._registeredTools[name]!.handler(args, {})).content.map((c) => c.text).join('\n');
const S = '00000000-0000-4000-8000-000000000042';
const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: S, ...o }) as unknown as SDKMessage;

function fakeLead() {
  return ({ prompt, options }: { prompt: unknown; options?: Options }) => {
    const p = String(prompt);
    async function* run(): AsyncGenerator<SDKMessage> {
      yield m({ type: 'system', subtype: 'init', session_id: S, model: 'fake', cwd: '', tools: [] });
      if (p.startsWith('New goal')) await callTool(options!, 'create_task', { title: 'Add a --version flag', description: 'print it', assignee: 'kit' });
      const review = /Review request: (t\d+)/.exec(p)?.[1];
      if (review) await callTool(options!, 'request_merge', { task_id: review, summary: 'Looks right.' });
      yield m({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.01, session_id: S, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
    }
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x' }) });
  };
}

let h: Harness;
let home: string;
let repoPath: string;

beforeAll(async () => {
  home = tempDir();
  repoPath = await demoRepo();
  const scenarioFile = path.join(home, 'scenario.json');
  fs.writeFileSync(
    scenarioFile,
    JSON.stringify({
      turns: [{ role: 'worker', match: 'Your task: t1', steps: [{ write: { file: 'src/cli.ts', content: '\n// --version from Codex\n' } }, { tool: 'update_task', args: { task_id: 't1', status: 'review', summary: 'Done.' } }] }],
    }),
  );
  process.env.FAKE_CODEX_SCENARIO = scenarioFile;
  delete process.env.FAKE_CODEX_LOG;
  h = makeForeman(home, ['--backend', 'claude', '--use-claude-login', '--worker-engine', 'codex', '--workers', 'kit', '--repo', repoPath]);
  const claude = new ClaudeEngine(h.fm, h.cfg.claude, fakeLead() as never);
  const codex = new CodexEngine(h.fm, h.cfg.codex, { bin: process.execPath, args: [FAKE] });
  // the Claude auth probe is the fake's accountInfo; Codex's is the fake app-server's account/read
  await h.fm.start(new TeamBackend(h.fm, h.cfg.claude, { name: 'claude', engines: { lead: claude, worker: codex } }));
});

afterAll(async () => {
  await h.fm.close();
  delete process.env.FAKE_CODEX_SCENARIO;
  rmrf(home);
  rmrf(path.dirname(repoPath));
});

describe('mixed team: Claude lead, Codex worker', () => {
  it('plans with Claude, builds with Codex, merges', async () => {
    const fm = h.fm;
    expect(fm.status.message).toBe('Claude lead opus · Codex workers gpt-fake');
    // each nameplate shows its engine and model (the configured one until a turn reports the real one)
    expect(fm.agent('marlow')).toMatchObject({ engine: 'claude', model: 'Opus' });
    expect(fm.agent('kit')).toMatchObject({ engine: 'codex', model: 'gpt-fake' });
    const goal = await fm.submitGoal('Add a --version flag');
    await until(() => fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === 't1'), 60_000);
    await fm.answerDecision(fm.decisions.open().find((d) => d.kind === 'merge')!.id, 'Merge');
    await until(() => fm.goal(goal.id)!.status === 'done', 30_000);
    expect(fs.readFileSync(path.join(repoPath, 'src', 'cli.ts'), 'utf8')).toContain('// --version from Codex');
    expect(fm.store.data.sessions[`marlow:${goal.id}`]!.engine).toBe('claude');
    expect(fm.store.data.sessions['kit:t1']!.engine).toBe('codex');
    expect(fm.agent('marlow')!.model).toBe('fake'); // what the (fake) CLI reported at init
    expect(fm.store.logTail('kit').some((e) => e.text.startsWith('Starting work t1 (Codex gpt-fake)'))).toBe(true);
  }, 120_000);
});

describe('engine config', () => {
  const load = (args: string[], env: NodeJS.ProcessEnv = {}) => loadConfig(['--home', home, ...args], env);
  it('picks engines per backend, role and agent', () => {
    expect(load([]).engines).toEqual({ lead: 'claude', worker: 'claude', byAgent: {} });
    expect(load(['--backend', 'codex']).engines).toEqual({ lead: 'codex', worker: 'codex', byAgent: {} });
    expect(load(['--backend', 'codex']).profile).toBe('codex');
    expect(load(['--worker-engine', 'codex', '--engines', 'wren=claude,Tove=codex']).engines).toEqual({ lead: 'claude', worker: 'codex', byAgent: { wren: 'claude', tove: 'codex' } });
    expect(load([], { AGENTCRAFT_LEAD_ENGINE: 'codex' }).engines.lead).toBe('codex');
    expect(load(['--codex-model', 'gpt-x', '--codex-lead-model', 'gpt-y', '--codex-effort', 'high']).codex).toMatchObject({ leadModel: 'gpt-y', workerModel: 'gpt-x', effort: 'high', leadEffort: 'high' });
    expect(() => load(['--worker-engine', 'gemini'])).toThrow(/unknown worker engine "gemini"/);
    expect(() => load(['--engines', 'kit'])).toThrow(/engine for kit/);
    expect(() => load(['--backend', 'cursor'])).toThrow(/use sim, claude, codex or openai/);
  });
});
