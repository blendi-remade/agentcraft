import { afterEach, describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { RuntimeEngine, type TurnSpec } from '../src/agents/engine.js';
import { ClaudeRuntime } from '../src/agents/claude/runtime.js';
import { TeamBackend } from '../src/agents/team.js';
import { createTeam } from '../src/agents/teams.js';
import type { AgentRuntime, TurnRequest } from '../src/agents/runtime.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';
import { turnRequest } from './provider-helpers.js';

let h: Harness;
let home: string;
afterEach(async () => { await h?.fm.close(); if (home) rmrf(home); });
function setup(args: string[] = []) { home = tempDir(); h = makeForeman(home, args); }

const fakeRuntime = (): AgentRuntime => ({ name: 'codex', label: 'Codex', checkAuth: async () => 'test', run: async () => ({ isError: false, errors: [] }) });

describe('provider runtimes in mixed teams', () => {
  it('selects provider runtimes per role/agent and keeps an API-only team available', () => {
    setup(['--backend', 'claude', '--model', 'sonnet', '--worker-engine', 'codex', '--engines', 'wren=claude']);
    const team = createTeam(h.fm, h.cfg);
    expect(team.engineFor('marlow').id).toBe('claude');
    expect(team.engineFor('kit')).toBeInstanceOf(RuntimeEngine);
    expect(team.engineFor('kit').id).toBe('codex');
    expect(team.engineFor('kit').model('worker')).toBe('default');
    expect(team.engineFor('wren').id).toBe('claude');
    const api = createTeam(h.fm, { ...h.cfg, backend: 'openai' });
    expect(api.name).toBe('openai');
    expect(api.engineFor('marlow').id).toBe('openai');
    expect(api.engineFor('kit').id).toBe('openai');
  });

  it('passes provider settings, permission cancellation and consumed-input steering across the engine boundary', async () => {
    setup(['--backend', 'codex']);
    let request: TurnRequest | undefined;
    const delivered = async () => false;
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const runtime: AgentRuntime = { ...fakeRuntime(), model: () => 'cached-repo-model', env: env => ({ ...env, RUNTIME_ENV: 'yes' }), run: async r => {
      request = r;
      r.onModel?.('gpt-actual');
      r.onSteerReady?.(delivered);
      return { isError: false, tokens: 123, errors: [] };
    } };
    const engine = new RuntimeEngine(h.fm, { ...h.cfg.codex, leadModel: 'default', leadEffort: 'high', maxTurnsLead: 7 }, runtime);
    const abort = new AbortController();
    const models: string[] = [];
    const spec: TurnSpec = {
      agentId: 'marlow', role: 'lead', cwd: home, prompt: 'plan', instructions: 'read-only',
      env: { ORIGINAL: 'yes' }, abort, turn: { signal: abort.signal, reason: () => undefined },
      permission: async () => ({ allow: false, message: 'stopped', interrupt: true }), tools: [],
      onProcess() {}, onSession() {}, onModel: model => models.push(model), onSteerReady: fn => { steer = fn; },
    };
    expect(await engine.runTurn(spec)).toMatchObject({ tokens: 123 });
    expect(request).toMatchObject({ model: '', effort: 'high', maxTurns: 7, env: { ORIGINAL: 'yes', RUNTIME_ENV: 'yes' } });
    expect(request!.abortController).toBe(abort);
    expect(await request!.canUseTool('Write', {}, { signal: abort.signal })).toEqual({ behavior: 'deny', message: 'stopped', interrupt: true });
    expect(models).toEqual(['gpt-actual']);
    expect(await steer!('new instructions')).toBe(false);
  });

  it('migrates upstream Codex scheduler state from its old Claude key exactly once', () => {
    setup(['--backend', 'codex']);
    const legacy = { inflight: { marlow: { kind: 'plan', sessionKey: 'marlow:g1', startedAt: 1 } }, ciFixes: { t1: 2 }, stopped: ['kit'] };
    h.fm.store.data.backend.claude = legacy;
    const team = new TeamBackend(h.fm, h.cfg.codex, fakeRuntime());
    expect(team['st']).toEqual(legacy);
    expect(h.fm.store.data.backend.codex).toEqual(legacy);
    expect(h.fm.store.data.backend.claude).toBeUndefined();
    h.fm.store.data.backend.claude = { inflight: {}, ciFixes: {}, stopped: ['wren'] };
    expect(team['st'].stopped).toEqual(['kit']);
  });

  it('preserves existing PR Codex state when a legacy Claude state also exists', () => {
    setup(['--backend', 'codex']);
    h.fm.store.data.backend.codex = { inflight: {}, ciFixes: {}, stopped: ['kit'] };
    h.fm.store.data.backend.claude = { inflight: {}, ciFixes: {}, stopped: ['wren'] };
    expect(new TeamBackend(h.fm, h.cfg.codex, fakeRuntime())['st'].stopped).toEqual(['kit']);
    expect(h.fm.store.data.backend.claude).toBeDefined();
  });

  it('exposes policy-checked read-only lead Bash and reports the actual Claude model', async () => {
    setup();
    let options: Options | undefined;
    const models: string[] = [];
    let closed = 0;
    const queryFn = ({ options: opts }: { options?: Options }) => {
      options = opts;
      async function* stream() {
        yield { type: 'system', subtype: 'init', session_id: 'test', model: 'claude-actual' } as SDKMessage;
      }
      return Object.assign(stream(), { close: () => { closed++; } });
    };
    const request = turnRequest(h, home, { role: 'lead', onModel: model => models.push(model) });
    await new ClaudeRuntime(h.fm, h.cfg.claude, { queryFn: queryFn as never }).run(request);
    expect(options!.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(options!.canUseTool).toBe(request.canUseTool);
    expect(models).toEqual(['claude-actual']);
    expect(closed).toBe(1);
  });
});
