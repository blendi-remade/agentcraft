// Auth mode: API key / cloud provider by default; the claude.ai CLI login only with --use-claude-login.
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { detectApiAuth, NO_API_AUTH_MESSAGE, withAuthMode } from '../src/agents/claude/auth.js';
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
    expect(withAuthMode(env, true)).toEqual(env);
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
    expect(h.fm.status.message).toContain(NO_API_AUTH_MESSAGE);
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
  });
});
