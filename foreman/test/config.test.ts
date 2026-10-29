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

describe('language, stall watchdog, skills and MCP servers', () => {
  it('defaults: English, 10 minute stall notice, no skills, no user settings', () => {
    const cfg = load([]);
    expect(cfg.language).toBe('en');
    expect(cfg.stallMinutes).toBe(10);
    expect(cfg.stallAction).toBe('notify');
    expect(cfg.claude.skills).toBe('off');
    expect(cfg.claude.userSettings).toBe(false);
    expect(cfg.claude.mcpServers).toEqual({});
  });

  it('reads them from flags', () => {
    const cfg = load(['--language', 'it_IT', '--stall-minutes', '5', '--stall-action', 'nudge', '--skills', 'designer,pdf', '--trusted-mcp', 'playwright']);
    expect(cfg.language).toBe('it');
    expect(cfg.stallMinutes).toBe(5);
    expect(cfg.stallAction).toBe('nudge');
    expect(cfg.claude.skills).toEqual(['designer', 'pdf']);
    expect(cfg.claude.userSettings).toBe(true);
    expect(cfg.claude.trustedMcp).toEqual(['playwright']);
    expect(load(['--skills', 'all', '--no-user-settings']).claude).toMatchObject({ skills: 'all', userSettings: false });
  });

  it('reads them from config.json, and --mcp-config from a .mcp.json style file', () => {
    home = tempDir();
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ language: 'it', claude: { skills: 'all', plugins: ['/opt/designer'], mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] }, docs: { type: 'http', url: 'http://localhost:9000/mcp' } } } }),
    );
    const cfg = loadConfig(['--home', home], {});
    expect(cfg.language).toBe('it');
    expect(cfg.claude.skills).toBe('all');
    expect(cfg.claude.plugins).toEqual([path.resolve('/opt/designer')]);
    expect(Object.keys(cfg.claude.mcpServers)).toEqual(['playwright', 'docs']);
    const file = path.join(home, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['server-filesystem'] } } }));
    expect(Object.keys(loadConfig(['--home', home, '--mcp-config', file], {}).claude.mcpServers)).toEqual(['fs']);
  });

  it('refuses a bad language, a server without command or url, and the reserved agentcraft name', () => {
    expect(() => load(['--language', 'de'])).toThrow(/language/);
    const dir = tempDir();
    home = dir;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ claude: { mcpServers: { x: { args: [] } } } }));
    expect(() => loadConfig(['--home', dir], {})).toThrow(/command or a url/);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ claude: { mcpServers: { agentcraft: { command: 'x' } } } }));
    expect(() => loadConfig(['--home', dir], {})).toThrow(/reserved/);
  });
});

describe('skills and MCP servers found where each engine keeps them', () => {
  it('lists Claude and Codex skills and MCP servers from their own folders', async () => {
    const { findSkills, skillRoots, claudeMcpServers, codexMcpServers, selectedSkills, skillsNote } = await import('../src/skills.js');
    const h = tempDir();
    home = h;
    const skill = (root: string, name: string) => {
      fs.mkdirSync(path.join(h, root, name), { recursive: true });
      fs.writeFileSync(path.join(h, root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: does ${name}\n---\n`);
    };
    skill('.claude/skills', 'designer');
    skill('.agents/skills', 'shared-one');
    skill('.codex/skills', 'codex-only');
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] }, docs: { type: 'http', url: 'http://localhost:9/mcp' } } }));
    fs.writeFileSync(path.join(h, '.codex', 'config.toml'), 'model = "x"\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "gh-mcp"] # comment\n[mcp_servers.github.env]\nTOKEN = "x"\n[mcp_servers."web search"]\nurl = "http://localhost:3/mcp"\n');
    const o = { home: h, env: {} };
    expect(findSkills(skillRoots('claude', o)).map((s) => s.name)).toEqual(['designer', 'shared-one']);
    expect(findSkills(skillRoots('codex', o)).map((s) => s.name)).toEqual(['codex-only', 'shared-one']);
    expect(claudeMcpServers([], o).map((s) => [s.name, s.summary])).toEqual([['playwright', 'npx @playwright/mcp'], ['docs', 'http://localhost:9/mcp']]);
    expect(codexMcpServers(o).map((s) => [s.name, s.summary])).toEqual([['github', 'npx -y gh-mcp'], ['web search', 'http://localhost:3/mcp']]);
    expect(selectedSkills('codex', ['shared-one'], o).map((s) => s.name)).toEqual(['shared-one']);
    expect(selectedSkills('codex', 'off', o)).toEqual([]);
    expect(skillsNote(selectedSkills('claude', 'all', o))).toMatch(/designer: .*SKILL\.md - does designer/);
  });

  it('reads the picks for each engine', () => {
    const cfg = load(['--mcp', 'playwright', '--codex-skills', 'all', '--codex-mcp', 'github']);
    expect(cfg.claude.mcp).toEqual(['playwright']);
    expect(cfg.codex.skills).toBe('all');
    expect(cfg.codex.mcp).toEqual(['github']);
    expect(load([]).codex).toMatchObject({ skills: 'off', mcp: [] });
  });
});
