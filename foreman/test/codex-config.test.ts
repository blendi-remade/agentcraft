import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BackendName } from '../src/protocol.js';
import { rmrf, tempDir } from './helpers.js';

const homes: string[] = [];
function home(config?: object) {
  const dir = tempDir();
  homes.push(dir);
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}
afterEach(() => { for (const dir of homes.splice(0)) rmrf(dir); });

describe('Codex backend configuration', () => {
  it('selects an isolated profile and never inherits Claude model defaults', () => {
    const cfg = loadConfig(['--home', home(), '--backend', 'codex'], {});
    expect(BackendName.parse('codex')).toBe('codex');
    expect(cfg.profile).toBe('codex');
    expect(cfg.codex.leadModel).toBe('');
    expect(cfg.codex.workerModel).toBe('');
    expect(cfg.codex.executable).toBe('codex');
    expect(cfg.codex.effort).toBe('medium');
    expect(cfg.notify).toBe(true);
    expect(cfg.signMerges).toBe(true);
    expect(cfg.claude.leadModel).toBe('opus');
  });

  it('resolves Codex settings independently with CLI > env > file', () => {
    const dir = home({ claude: { workers: ['wren'], leadModel: 'opus' }, codex: { workers: ['kit'], leadModel: 'file-model', executable: '/file/codex', effort: 'high', ciCommand: 'npm test', resumeOnStart: false } });
    const cfg = loadConfig(['--home', dir, '--backend', 'codex', '--worker-model', 'cli-model', '--codex-path', '/cli/codex'], { AGENTCRAFT_LEAD_MODEL: 'env-model', AGENTCRAFT_CODEX_PATH: '/env/codex' });
    expect(cfg.codex.leadModel).toBe('env-model');
    expect(cfg.codex.workerModel).toBe('cli-model');
    expect(cfg.codex.executable).toBe('/cli/codex');
    expect(cfg.codex.workers).toEqual(['kit']);
    expect(cfg.codex.effort).toBe('high');
    expect(cfg.codex.ciCommand).toBe('npm test');
    expect(cfg.codex.resumeOnStart).toBe(false);
  });

  it('supports shared team flags and explicit state profile', () => {
    const cfg = loadConfig(['--home', home(), '--backend', 'codex', '--profile', 'codex-sample', '--workers', '1', '--model', 'custom-codex', '--effort', 'low', '--max-concurrent', '1', '--no-lead-review', '--no-resume'], {});
    expect(cfg.codex.workers).toEqual(['juniper']);
    expect(cfg.codex.leadModel).toBe('custom-codex');
    expect(cfg.codex.workerModel).toBe('custom-codex');
    expect(cfg.codex.maxConcurrent).toBe(1);
    expect(cfg.codex.leadReview).toBe(false);
    expect(cfg.codex.resumeOnStart).toBe(false);
    expect(cfg.profile).toBe('codex-sample');
  });

  it('rejects unsupported budget, effort and Claude login instead of silently weakening controls', () => {
    for (const args of [['--max-budget', '2'], ['--effort', 'max'], ['--lead-effort', 'max'], ['--use-claude-login'], ['--use-claude-login=true'], ['--use-claude-login', 'true']]) {
      expect(() => loadConfig(['--home', home(), '--backend', 'codex', ...args], {})).toThrow(/Claude-only|Codex effort/);
    }
    expect(() => loadConfig(['--home', home({ codex: { maxBudgetUsdPerTurn: 2 } }), '--backend', 'codex'], {})).toThrow(/USD budget/);
  });

  it('rejects nonpositive or fractional step limits', () => {
    for (const flag of ['--max-turns', '--max-turns-lead', '--max-turns-worker', '--max-concurrent']) {
      for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992']) {
        expect(() => loadConfig(['--home', home(), '--backend', 'codex', flag, value], {})).toThrow(/positive integer/);
      }
    }
  });

  it('ignores invalid inactive Codex settings for existing backends', () => {
    const dir = home({ codex: { effort: 'invalid', maxTurnsLead: 'invalid', maxConcurrent: 0 } });
    expect(loadConfig(['--home', dir], {}).backend).toBe('claude');
    expect(loadConfig(['--home', dir, '--backend', 'sim'], {}).backend).toBe('sim');
    const codexHome = home({ claude: { effort: 'invalid' } });
    expect(loadConfig(['--home', codexHome, '--backend', 'codex'], {}).backend).toBe('codex');
  });

  it('keeps existing defaults unchanged', () => {
    const cfg = loadConfig(['--home', home()], {});
    expect(cfg.backend).toBe('claude');
    expect(cfg.profile).toBe('claude');
    expect(cfg.claude.leadModel).toBe('opus');
    expect(cfg.claude.workerModel).toBe('sonnet');
    const sim = loadConfig(['--home', home(), '--backend', 'sim'], {});
    expect(sim.notify).toBe(false);
    expect(sim.signMerges).toBe(false);
  });
});
