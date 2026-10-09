import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { rmrf, tempDir } from './helpers.js';

let home: string | undefined;
afterEach(() => {
  if (home) rmrf(home);
  home = undefined;
});

function load(args: string[]) {
  home = tempDir();
  return loadConfig(['--home', home, ...args], {});
}

describe('loadConfig argument checking', () => {
  it('accepts the documented claude flags', () => {
    const cfg = load(['--backend', 'claude', '--workers', 'juniper,kit', '--model', 'sonnet', '--effort', 'low', '--no-notify', '--max-budget', '2']);
    expect(cfg.claude.workers).toEqual(['juniper', 'kit']);
    expect(cfg.claude.leadModel).toBe('sonnet');
    expect(cfg.claude.workerModel).toBe('sonnet');
    expect(cfg.claude.effort).toBe('low');
    expect(cfg.claude.leadEffort).toBe('low');
    expect(cfg.notify).toBe(false);
  });

  it('reads lead read commands as a comma list or a config.json array', () => {
    home = tempDir();
    const read = (args: string[], env = {}) => loadConfig(['--home', home!, ...args], env).claude.leadReadCommands;
    expect(read(['--lead-read-commands', 'bd show, bd list,'])).toEqual(['bd show', 'bd list']);
    expect(read([], { AGENTCRAFT_LEAD_READ_COMMANDS: 'bd show' })).toEqual(['bd show']);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { leadReadCommands: ['bd show'] } }));
    expect(read([])).toEqual(['bd show']);
  });

  it('rejects lead read commands that could write or run code', () => {
    home = tempDir();
    for (const bad of ['rm', 'git status', './bd show', 'bd show; rm x', 'bd show > f', 'bash', 'bd $(x)']) {
      expect(() => loadConfig(['--home', home!, '--lead-read-commands', bad], {})).toThrow(/lead read command/);
    }
  });

  it('accepts the sim flags launch.ps1 passes', () => {
    const cfg = load(['--backend', 'sim', '--profile', 'x', '--port', '41000', '--reset', '--showcase', 'late', '--speed', '2', '--autostart']);
    expect(cfg.sim.showcaseAt).toBe('showcase-late');
    expect(cfg.sim.speed).toBe(2);
  });

  // regression: PowerShell `-File launch.ps1 -ForemanArgs '--workers,juniper,kit,--model,sonnet'` hands
  // the Foreman ONE argument; it used to be ignored silently and the team started on opus/medium/3 workers
  it('refuses an argument that PowerShell joined with commas', () => {
    expect(() => load(['--backend', 'claude', '--workers,juniper,kit,--model,sonnet,--effort,low'])).toThrow(/unknown option "--workers,juniper,kit,--model,sonnet,--effort,low"/);
  });

  it('refuses mistyped flags and stray positionals', () => {
    expect(() => load(['--wokers', 'kit'])).toThrow(/unknown option "--wokers"/);
    expect(() => load(['--backend', 'sim', 'oops', 'extra'])).toThrow(/unexpected argument "oops"/);
  });

  it('refuses an unknown effort instead of falling back to medium', () => {
    expect(() => load(['--effort', 'lo'])).toThrow(/unknown effort "lo"/);
  });
});

describe('use-claude-login', () => {
  it('comes from --use-claude-login, AGENTCRAFT_USE_CLAUDE_LOGIN or config.json claude.useClaudeLogin (not a top-level key)', () => {
    home = tempDir();
    const login = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => loadConfig(['--home', home!, ...args], env).claude.useClaudeLogin;
    expect(login()).toBe(false);
    expect(login(['--use-claude-login'])).toBe(true);
    expect(login([], { AGENTCRAFT_USE_CLAUDE_LOGIN: '1' })).toBe(true);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ useClaudeLogin: true }));
    expect(login()).toBe(false); // the key path is claude.useClaudeLogin
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { useClaudeLogin: true } }));
    expect(login()).toBe(true);
    // flag and env still decide over config.json
    expect(login([], { AGENTCRAFT_USE_CLAUDE_LOGIN: '0' })).toBe(false);
    expect(login(['--use-claude-login'], { AGENTCRAFT_USE_CLAUDE_LOGIN: '0' })).toBe(true);
  });
});

describe('user name', () => {
  it('comes from --user-name, then AGENTCRAFT_USER_NAME, then config.json, else the OS account', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { defaultUserName } = await import('../src/user.js');
    expect(load(['--user-name', 'Sam']).userName).toBe('Sam');
    home = tempDir();
    expect(loadConfig(['--home', home], { AGENTCRAFT_USER_NAME: 'Robin' }).userName).toBe('Robin');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ userName: 'Kai' }));
    expect(loadConfig(['--home', home], {}).userName).toBe('Kai');
    rmrf(home);
    const d = load([]).userName;
    expect(d).toBe(defaultUserName());
    expect(d.length).toBeGreaterThan(0);
  });

  it('is sent to the mod in foreman.status and used in prompts', async () => {
    const { makeForeman } = await import('./helpers.js');
    const { leadSystemPrompt } = await import('../src/agents/prompts.js');
    home = tempDir();
    const h = makeForeman(home, ['--user-name', 'Sam']);
    try {
      expect(h.fm.status.userName).toBe('Sam');
      expect(h.fm.nameOf('user')).toBe('Sam');
      expect(leadSystemPrompt(h.fm, ['kit'])).toContain('The user is Sam.');
    } finally {
      await h.fm.close();
    }
  });
});
