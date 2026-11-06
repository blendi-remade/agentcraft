// The OpenCode Go launcher: it reads the key that is already stored by the opencode CLI and maps
// the Go models onto AgentCraft's Claude engine. The key must never reach stdout or the command line.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  DEFAULT_LEAD_MODEL,
  DEFAULT_WORKER_MODEL,
  buildEnv,
  buildUnixArgs,
  extractKey,
  parseArgs,
} from '../../tools/launch-opencode.mjs';
import { rmrf, tempDir } from './helpers.js';

const WRAPPER = fileURLToPath(new URL('../../tools/launch-opencode.mjs', import.meta.url));

const baseOpts = () => ({ backend: 'claude', repos: [], foremanArgs: [], integration: 'opencode-go' });
let dir: string | undefined;
afterEach(() => {
  if (dir) rmrf(dir);
  dir = undefined;
});

function fakeOpencode(body: string): string {
  dir = tempDir('ac-opencode-');
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return dir;
}

describe('opencode launcher', () => {
  it('extracts the active key for the integration', () => {
    const creds = [
      { integrationID: 'other', active: true, value: { type: 'key', key: 'nope' } },
      { integrationID: 'opencode-go', active: false, value: { type: 'key', key: 'old' } },
      { integrationID: 'opencode-go', active: true, value: { type: 'key', key: 'active' } },
    ];
    expect(extractKey(creds, 'opencode-go')).toBe('active');
    expect(() => extractKey([], 'opencode-go')).toThrow(/No active opencode-go/);
  });

  it('builds the gateway environment and removes Anthropic keys', () => {
    const opts = parseArgs(['--workers', 'juniper']);
    const env = buildEnv(
      opts,
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'work-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        ANTHROPIC_MODEL: 'opus',
        ANTHROPIC_SMALL_FAST_MODEL: 'haiku',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
      },
      () => 'oc_sk_test',
    );
    expect(env.ANTHROPIC_BASE_URL).toBe(DEFAULT_BASE_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('oc_sk_test');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(DEFAULT_LEAD_MODEL);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(DEFAULT_WORKER_MODEL);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-5-5');
    expect(env.AGENTCRAFT_LEAD_MODEL).toBe(DEFAULT_LEAD_MODEL);
    expect(env.AGENTCRAFT_WORKER_MODEL).toBe(DEFAULT_WORKER_MODEL);
    expect(env.AGENTCRAFT_WORKERS).toBe('juniper');
    expect(env.AGENTCRAFT_OPENCODE_GO).toBe('1');
    expect(env.AGENTCRAFT_CLAUDE_MODELS).toContain('kit=kimi-k2.7-code');
    expect(env.AGENTCRAFT_CLAUDE_MODELS).toContain('juniper=muse-spark-1.3-contributor');
  });

  it('--model collapses the per-agent map; --claude-models overrides it', () => {
    const one = buildEnv(parseArgs(['--model', 'deepseek-v4.1-flash']), {}, () => 'key');
    expect(one.AGENTCRAFT_CLAUDE_MODELS).toBeUndefined();
    expect(one.AGENTCRAFT_LEAD_MODEL).toBe('deepseek-v4.1-flash');
    expect(one.AGENTCRAFT_WORKER_MODEL).toBe('deepseek-v4.1-flash');

    const custom = buildEnv(parseArgs(['--claude-models', 'kit=kimi-k2.7-code,wren=qwen3.8-flash']), {}, () => 'key');
    expect(custom.AGENTCRAFT_CLAUDE_MODELS).toBe('kit=kimi-k2.7-code,wren=qwen3.8-flash');
  });

  it('passes Foreman-only flags as --foreman-arg pairs', () => {
    const opts = parseArgs(['--repo', '/tmp/agentcraft-test', '--workers', 'juniper', '--max-concurrent', '1', '--effort', 'low', '--no-game']);
    expect(buildUnixArgs(opts)).toEqual([
      'launch',
      '--backend',
      'claude',
      '--repo',
      '/tmp/agentcraft-test',
      '--no-game',
      '--foreman-arg',
      '--max-concurrent',
      '--foreman-arg',
      '1',
      '--foreman-arg',
      '--effort',
      '--foreman-arg',
      'low',
    ]);
  });

  it('never prints the key in --dry-run', () => {
    const bin = fakeOpencode(`console.log(JSON.stringify([{integrationID:'opencode-go',active:true,value:{type:'key',key:'oc_sk_test_secret'}}]))`);
    const out = execFileSync(process.execPath, [WRAPPER, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(out).toContain(`ANTHROPIC_BASE_URL=${DEFAULT_BASE_URL}`);
    expect(out).toContain('ANTHROPIC_AUTH_TOKEN=<redacted>');
    expect(out).not.toContain('oc_sk_test_secret');
    expect(out).toContain('tools/unix.mjs launch');
  });

  it('reports a missing key clearly', () => {
    const bin = fakeOpencode(`console.log('[]')`);
    let error: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [WRAPPER, '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    } catch (e) {
      error = e as { status?: number; stderr?: string };
    }
    expect(error?.status).not.toBe(0);
    expect(error?.stderr).toContain('No active opencode-go');
  });

  it('does not need a key for the sim backend', () => {
    const bin = fakeOpencode(`process.exit(7)`);
    const out = execFileSync(process.execPath, [WRAPPER, '--backend', 'sim', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(out).toContain('command:');
    expect(out).not.toContain('ANTHROPIC_AUTH_TOKEN');
  });
});
