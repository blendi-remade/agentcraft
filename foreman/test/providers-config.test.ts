import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BackendName, ForemanStatus } from '../src/protocol.js';
import { tempDir, rmrf } from './helpers.js';

let home = '';
afterEach(() => { if (home) rmrf(home); });
function load(args: string[], env: NodeJS.ProcessEnv = {}) {
  home ||= tempDir();
  fs.mkdirSync(home, { recursive: true });
  return loadConfig(['--home', home, ...args], env);
}

describe('provider configuration', () => {
  it('supports the new backends without changing Claude defaults', () => {
    expect(load([]).claude.leadModel).toBe('opus');
    for (const backend of ['codex', 'openai']) {
      const cfg = load(['--backend', backend, '--model', 'my-model']);
      expect(cfg.profile).toBe(backend);
      expect(cfg.notify).toBe(true);
      expect(cfg.signMerges).toBe(true);
      expect(BackendName.parse(backend)).toBe(backend);
      expect(ForemanStatus.parse({ version: '0.1.0', backend, auth: 'ok' }).backend).toBe(backend);
    }
    expect(load(['--backend', 'codex']).codex.leadModel).toBe('');
    expect(load(['--backend', 'codex']).codex.effort).toBeUndefined();
    expect(load(['--backend', 'codex']).codex.leadEffort).toBeUndefined();
  });

  it('keeps provider settings separate with flags > env > provider config', () => {
    load([]);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      backend: 'openai', claude: { leadModel: 'opus', workers: ['wren'] },
      openai: { leadModel: 'file-lead', workerModel: 'file-worker', workers: ['kit'], baseUrl: 'http://localhost:1234/v1', apiKeyEnv: 'LOCAL_TOKEN', api: 'responses' },
    }));
    const cfg = load(['--lead-model', 'cli-lead', '--base-url', 'http://localhost:2345/custom/v1/'], { AGENTCRAFT_LEAD_MODEL: 'env-lead', AGENTCRAFT_WORKER_MODEL: 'env-worker', LOCAL_TOKEN: 'test-secret' });
    expect(cfg.openai).toMatchObject({ leadModel: 'cli-lead', workerModel: 'env-worker', workers: ['kit'], baseUrl: 'http://localhost:2345/custom/v1', apiKey: 'test-secret', api: 'responses' });
    expect(cfg.claude.workers).toEqual(['wren']);
  });

  it('accepts local endpoints without a key, and requires an explicit API model', () => {
    expect(load(['--backend', 'openai', '--base-url', 'http://localhost:11434/v1'], { OPENAI_MODEL: 'local-model' }).openai.apiKey).toBeUndefined();
    expect(() => load(['--backend', 'openai'])).toThrow(/require --model/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--base-url', 'https://key:secret@example.com/v1'])).toThrow(/without credentials/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--base-url', 'file:///tmp'])).toThrow(/HTTP/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--max-budget', '1'])).toThrow(/only by Claude/);
    expect(() => load(['--backend', 'codex', '--max-turns', '0'])).toThrow(/positive integer/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--request-timeout', '-1'])).toThrow(/request-timeout/);
    expect(() => load(['--backend', 'codex', '--effort', 'max'])).toThrow(/Codex effort/);
  });

  it('applies OPENAI_MODEL above file settings and below role-specific environment and CLI flags', () => {
    load([]);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      backend: 'openai', openai: { leadModel: 'file-lead', workerModel: 'file-worker' },
    }));
    expect(load([], { OPENAI_MODEL: 'env-default' }).openai).toMatchObject({ leadModel: 'env-default', workerModel: 'env-default' });
    expect(load(['--worker-model', 'cli-worker'], { OPENAI_MODEL: 'env-default', AGENTCRAFT_LEAD_MODEL: 'env-lead' }).openai)
      .toMatchObject({ leadModel: 'env-lead', workerModel: 'cli-worker' });
  });

  it('keeps mixed-team Codex models separate while accepting both CLI path names', () => {
    const mixed = load(['--backend', 'claude', '--worker-engine', 'codex', '--model', 'sonnet', '--codex-path', '/custom/codex']);
    expect(mixed.claude.workerModel).toBe('sonnet');
    expect(mixed.codex.workerModel).toBe('');
    expect(mixed.codex).toMatchObject({ command: '/custom/codex', path: '/custom/codex' });
    expect(load(['--backend', 'codex', '--model', 'gpt-generic', '--codex-worker-model', 'gpt-specific', '--codex-command', '/other/codex']).codex)
      .toMatchObject({ leadModel: 'gpt-generic', workerModel: 'gpt-specific', command: '/other/codex', path: '/other/codex' });
    expect(load([], { AGENTCRAFT_CODEX_PATH: '/env/codex' }).codex.command).toBe('/env/codex');
  });

  it('does not send Codex backend model or effort flags to a Claude lead', () => {
    const cfg = load(['--backend', 'codex', '--lead-engine', 'claude', '--model', 'gpt-codex', '--effort', 'xhigh']);
    expect(cfg.codex).toMatchObject({ leadModel: 'gpt-codex', workerModel: 'gpt-codex', effort: 'xhigh' });
    expect(cfg.claude).toMatchObject({ leadModel: 'opus', workerModel: 'sonnet', effort: 'medium', leadEffort: 'medium' });
  });

  it('validates Codex effort for mixed teams as well as Codex profiles', () => {
    expect(() => load(['--backend', 'claude', '--worker-engine', 'codex', '--codex-effort', 'max'])).toThrow(/Codex effort/);
    expect(() => load(['--backend', 'claude', '--engines', 'kit=codex', '--codex-lead-effort', 'max'])).toThrow(/Codex effort/);
  });

  it('preserves shared team settings and read commands in Codex profiles', () => {
    load([]);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      backend: 'codex', claude: { workers: ['kit'], ciCommand: 'npm test', leadReadCommands: ['bd show'], maxBudgetUsdPerTurn: 2 },
      codex: { maxConcurrent: 1 }, openai: { leadModel: 'api-model', workerModel: 'api-model' },
    }));
    expect(load([]).codex.maxBudgetUsdPerTurn).toBeUndefined();
    expect(load([]).codex).toMatchObject({ workers: ['kit'], ciCommand: 'npm test', maxConcurrent: 1, leadReadCommands: ['bd show'], leadModel: '', workerModel: '' });
    expect(load(['--backend', 'openai']).openai.leadReadCommands).toEqual(['bd show']);
    expect(load(['--lead-read-commands', 'bd list']).codex.leadReadCommands).toEqual(['bd list']);
  });

  it('ignores API dialect settings for other backends', () => {
    expect(load(['--backend', 'sim'], { AGENTCRAFT_OPENAI_API: 'unrelated-value' }).backend).toBe('sim');
    expect(() => load(['--backend', 'openai', '--model', 'm'], { AGENTCRAFT_OPENAI_API: 'bad' })).toThrow('unknown API');
  });
});
