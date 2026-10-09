// Auth mode: API key / cloud provider by default; the claude.ai CLI login only with --use-claude-login.
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentEnv, ClaudeBackend } from '../src/agents/claude/index.js';
import { detectApiAuth, LOGIN_MODE_DROP_VARS, NO_API_AUTH_MESSAGE, PROVIDER_SWITCHES, withAuthMode } from '../src/agents/claude/auth.js';
import { ClaudeEngine } from '../src/agents/claude/engine.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

describe('detectApiAuth', () => {
  it('finds an API key, a cloud provider switch or a gateway, and nothing else', () => {
    expect(detectApiAuth({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toEqual({ ok: true, source: 'API key' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual({ ok: true, source: 'Amazon Bedrock' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_VERTEX: 'true' })).toEqual({ ok: true, source: 'Google Vertex AI' });
    expect(detectApiAuth({ CLAUDE_CODE_USE_BEDROCK: '0' })).toEqual({ ok: false });
    expect(detectApiAuth({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw' })).toEqual({ ok: true, source: 'API gateway' });
    expect(detectApiAuth({ ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' })).toEqual({ ok: false });
  });

  it('drops the claude.ai login token from agent processes unless opted in', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'k' };
    expect(withAuthMode(env, false)).toEqual({ ANTHROPIC_API_KEY: 'k' });
    expect(withAuthMode(env, true)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
  });

  it('under --use-claude-login strips the API key, auth token, gateway URL and every provider switch (any case), keeps the rest', () => {
    expect(LOGIN_MODE_DROP_VARS).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...Object.keys(PROVIDER_SWITCHES)]));
    const env = {
      ANTHROPIC_API_KEY: 'k',
      anthropic_auth_token: 't',
      Anthropic_Base_Url: 'https://gw',
      CLAUDE_CODE_USE_BEDROCK: '1',
      claude_code_use_bedrock: '1',
      claude_code_use_vertex: '1',
      Claude_Code_Use_Foundry: 'true',
      claude_code_use_Anthropic_AWS: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      PATH: '/bin',
      HOME: '/home/me',
    };
    const out = withAuthMode(env, true);
    expect(out).toStrictEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth', PATH: '/bin', HOME: '/home/me' });
    expect(JSON.stringify(out)).not.toContain('"k"');
    expect(env.ANTHROPIC_API_KEY).toBe('k'); // a copy: the input is untouched
  });

  it('in API mode (no opt-in) strips only the claude.ai login token (any case), nothing else', () => {
    const env = {
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      Anthropic_Base_Url: 'https://gw',
      CLAUDE_CODE_USE_BEDROCK: '1',
      claude_code_use_vertex: '1',
      Claude_Code_Use_Foundry: 'true',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      PATH: '/bin',
      HOME: '/home/me',
    };
    expect(withAuthMode({ ...env, CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }, false)).toStrictEqual(env);
    expect(withAuthMode({ ...env, claude_code_Oauth_Token: 'oauth' }, false)).toStrictEqual(env);
    expect(Object.keys(withAuthMode({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ...env }, false))).toEqual(Object.keys(env));
  });
});

describe('a cloud provider switch in the shell', () => {
  let home: string | undefined;
  let h: Harness | undefined;
  const envs: Array<Record<string, string | undefined>> = [];
  const fakeQuery = ({ options }: { options?: Options }) => {
    envs.push(options?.env ?? {});
    async function* run(): AsyncGenerator<never> {}
    return Object.assign(run(), { close() {}, accountInfo: async () => ({ email: 'x@example.com', organization: 'Acme', subscriptionType: 'max' }) });
  };
  const workerTurn = (engine: ClaudeEngine, cwd: string, env: Record<string, string | undefined>) =>
    engine.runTurn({
      agentId: 'kit',
      role: 'worker',
      cwd,
      prompt: 'Your task: t1',
      instructions: '',
      env,
      abort: new AbortController(),
      turn: { signal: new AbortController().signal, reason: () => undefined },
      permission: async () => ({ allow: true }),
      tools: [],
      onProcess() {},
      onSession() {},
    });
  /** keys that would route the CLI past the claude.ai login, in any letter case */
  const notLogin = (env: Record<string, string | undefined>) => Object.keys(env).filter((k) => LOGIN_MODE_DROP_VARS.includes(k.toUpperCase()));

  beforeEach(() => {
    envs.length = 0;
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']) vi.stubEnv(k, undefined);
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://bedrock-gateway.example');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await h?.fm.close();
    if (home) rmrf(home);
    h = undefined;
    home = undefined;
  });

  it('--use-claude-login keeps it (and the gateway URL) out of the auth probe and the turns', async () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--use-claude-login']);
    const engine = new ClaudeEngine(h.fm, h.cfg.claude, fakeQuery as never);
    expect(engine.authMode()).toBe('claude login');
    expect(await engine.checkAuth()).toEqual({ ok: true, account: 'Acme · max', mode: 'claude login' });
    await workerTurn(engine, home, agentEnv(process.env, { agentId: 'kit', cwd: home }));
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(notLogin(env)).toEqual([]);
      expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CLAUDE_CODE_USE_BEDROCK');
      expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('ANTHROPIC_BASE_URL');
    }
    expect(envs[0]!.AGENTCRAFT_USER_NAME).toBe('Alex'); // the rest of the environment is passed on
    expect(envs[1]!.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^agentcraft-foreman\//);
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe('1'); // the Foreman's own environment is untouched
  });

  it('without --use-claude-login it reaches query() untouched and is the reported mode', async () => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude']);
    const engine = new ClaudeEngine(h.fm, h.cfg.claude, fakeQuery as never);
    expect(engine.authMode()).toBe('Amazon Bedrock');
    expect(await engine.checkAuth()).toEqual({ ok: true, account: 'Amazon Bedrock · Acme', mode: 'Amazon Bedrock' });
    expect(envs[0]).toStrictEqual({ ...process.env });
    const turnEnv = agentEnv(process.env, { agentId: 'kit', cwd: home });
    await workerTurn(engine, home, turnEnv);
    expect(envs[1]).toStrictEqual(turnEnv);
    expect(envs[1]!.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(envs[1]!.ANTHROPIC_BASE_URL).toBe('https://bedrock-gateway.example');
  });
});

describe('ClaudeBackend.checkAuth', () => {
  let home: string | undefined;
  let h: Harness | undefined;
  const saved = { key: process.env.ANTHROPIC_API_KEY, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK };
  afterEach(async () => {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.bedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = saved.bedrock;
    await h?.fm.close();
    if (home) rmrf(home);
    h = undefined;
    home = undefined;
  });

  let queried = 0;
  const fakeQuery = () => {
    queried++;
    return { close() {}, accountInfo: async () => ({ email: 'x@example.com', organization: 'Acme', subscriptionType: 'max' }) };
  };

  it('without an API key (and no opt-in) fails loudly and never touches the CLI login', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude']);
    queried = 0;
    const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fakeQuery as never });
    expect(await b.checkAuth()).toBe(false);
    expect(queried).toBe(0);
    expect(h.fm.status.auth).toBe('failed');
    expect(h.fm.status.message).toBe(NO_API_AUTH_MESSAGE);
    expect(h.fm.status.authMode).toBe('API key'); // what was attempted
  });

  it('with ANTHROPIC_API_KEY it checks access and reports the API key as the source', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude']);
    queried = 0;
    const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fakeQuery as never });
    expect(await b.checkAuth()).toBe(true);
    expect(queried).toBe(1);
    expect(h.fm.status.auth).toBe('ok');
    expect(h.fm.status.account).toBe('API key · Acme');
    expect(h.fm.status.authMode).toBe('API key');
  });

  it('--use-claude-login uses the CLI login (personal use) even without a key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--use-claude-login']);
    expect(h.cfg.claude.useClaudeLogin).toBe(true);
    const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: fakeQuery as never });
    expect(await b.checkAuth()).toBe(true);
    expect(h.fm.status.account).toBe('Acme · max');
    expect(h.fm.status.authMode).toBe('claude login');
    // the mode is shown while checking too
    const statuses = h.events.flatMap((e) => (e.type === 'foreman.status' ? [e.status] : []));
    expect(statuses.find((s) => s.auth === 'checking')?.authMode).toBe('claude login');
    expect(statuses.at(-1)).toMatchObject({ auth: 'ok', authMode: 'claude login' });
  });

  it('a failed login probe reports auth failed with the attempted mode', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--use-claude-login']);
    const notLoggedIn = () => ({ close() {}, accountInfo: async () => ({}) });
    const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: notLoggedIn as never });
    expect(await b.checkAuth()).toBe(false);
    expect(h.fm.status.auth).toBe('failed');
    expect(h.fm.status.authMode).toBe('claude login');
    expect(h.fm.status.message).toContain('Claude login check failed: not logged in');
  });

  it('a failed API key probe reports auth failed with the attempted mode', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-bad';
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude']);
    const rejected = () => ({
      close() {},
      accountInfo: async () => {
        throw new Error('invalid x-api-key');
      },
    });
    const b = new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: rejected as never });
    expect(await b.checkAuth()).toBe(false);
    expect(h.fm.status).toMatchObject({ auth: 'failed', authMode: 'API key' });
    expect(h.fm.status.message).toContain('Claude API check failed: invalid x-api-key');
  });
});
