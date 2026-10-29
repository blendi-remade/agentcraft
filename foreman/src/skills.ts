// Skills and MCP servers the user already set up for each engine, found where that engine looks:
//
//   Claude  skills: ~/.claude/skills/<name>/SKILL.md, ~/.agents/skills/<name>/SKILL.md
//           MCP:    ~/.claude.json (user scope, and the repo's project entry), <repo>/.mcp.json
//   Codex   skills: $CODEX_HOME/skills (default ~/.codex/skills), ~/.agents/skills
//           MCP:    [mcp_servers.<name>] in $CODEX_HOME/config.toml
//
// The dashboard lists them with checkboxes; config.json stores only the choice (names), so nobody
// writes server specs by hand. Read-only: nothing here changes the user's own setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from './util/fsx.js';

export type EngineKind = 'claude' | 'codex';

export interface SkillInfo {
  name: string;
  dir: string;
  description: string;
}

export interface McpInfo {
  name: string;
  /** where it was found, e.g. "~/.claude.json" */
  source: string;
  /** one line for the list: the command or url */
  summary: string;
  /** Claude Code format spec (stdio or http), when it could be read */
  spec?: Record<string, unknown>;
}

export interface Env {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function homeOf(o: Env): string {
  return o.home ?? os.homedir();
}

function codexHome(o: Env): string {
  return (o.env ?? process.env).CODEX_HOME || path.join(homeOf(o), '.codex');
}

export function skillRoots(engine: EngineKind, o: Env = {}): string[] {
  const shared = path.join(homeOf(o), '.agents', 'skills');
  return engine === 'claude' ? [path.join(homeOf(o), '.claude', 'skills'), shared] : [path.join(codexHome(o), 'skills'), shared];
}

/** Every <root>/<name>/SKILL.md, first root wins for a name. */
export function findSkills(roots: string[]): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const dir = path.join(root, n);
      const file = path.join(dir, 'SKILL.md');
      if (out.some((s) => s.name === n) || !fs.existsSync(file)) continue;
      let head = '';
      try {
        head = fs.readFileSync(file, 'utf8').slice(0, 4000);
      } catch {
        /* unreadable: still listed */
      }
      const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? '';
      out.push({ name: /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() || n, dir, description: description.slice(0, 300) });
    }
  }
  return out;
}

/** The skills an engine may use: 'off' none, 'all' every one found, or the named ones. */
export function selectedSkills(engine: EngineKind, choice: 'off' | 'all' | string[] | undefined, o: Env = {}): SkillInfo[] {
  if (!choice || choice === 'off') return [];
  const all = findSkills(skillRoots(engine, o));
  return choice === 'all' ? all : all.filter((s) => choice.includes(s.name) || choice.includes(path.basename(s.dir)));
}

function summarize(spec: Record<string, unknown>): string {
  if (typeof spec.url === 'string') return spec.url;
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  return [String(spec.command ?? '?'), ...args].join(' ').slice(0, 160);
}

/** Claude Code MCP servers: user scope and this repo's (project scope, .mcp.json). */
export function claudeMcpServers(repos: string[] = [], o: Env = {}): McpInfo[] {
  const out: McpInfo[] = [];
  const add = (servers: unknown, source: string) => {
    if (!servers || typeof servers !== 'object') return;
    for (const [name, spec] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
      if (!spec || typeof spec !== 'object' || out.some((s) => s.name === name) || name === 'agentcraft') continue;
      if (typeof spec.command !== 'string' && typeof spec.url !== 'string') continue;
      out.push({ name, source, summary: summarize(spec), spec });
    }
  };
  const user = readJson<Record<string, unknown>>(path.join(homeOf(o), '.claude.json'));
  add(user?.mcpServers, '~/.claude.json');
  const projects = (user?.projects ?? {}) as Record<string, { mcpServers?: unknown }>;
  for (const repo of repos) {
    const key = Object.keys(projects).find((p) => path.resolve(p) === path.resolve(repo));
    if (key) add(projects[key]!.mcpServers, `~/.claude.json (${path.basename(repo)})`);
    add(readJson<Record<string, unknown>>(path.join(repo, '.mcp.json'))?.mcpServers, `${path.basename(repo)}/.mcp.json`);
  }
  return out;
}

/** Names (and command/url) of the [mcp_servers.<name>] tables in Codex's config.toml. */
export function codexMcpServers(o: Env = {}): McpInfo[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(codexHome(o), 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  return parseCodexMcp(text);
}

/** Just enough TOML for the server list: table headers plus `command`, `args` and `url` lines. */
export function parseCodexMcp(text: string): McpInfo[] {
  const found: Array<{ name: string; command?: string; args: string[]; url?: string }> = [];
  let cur: (typeof found)[number] | undefined;
  const str = (v: string) => v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[\s*mcp_servers\.("([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
    if (header) {
      const name = header[2] ?? header[3] ?? header[4]!;
      cur = found.find((s) => s.name === name);
      if (!cur) found.push((cur = { name, args: [] }));
      continue;
    }
    if (line.startsWith('[')) {
      cur = undefined; // another table, e.g. [mcp_servers.x.env]
      continue;
    }
    const kv = cur && /^(command|url|args)\s*=\s*(.+)$/.exec(line);
    if (!cur || !kv) continue;
    if (kv[1] === 'args') cur.args = [...kv[2]!.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]!);
    else if (kv[1] === 'command') cur.command = str(kv[2]!);
    else cur.url = str(kv[2]!);
  }
  return found.map((f) => ({ name: f.name, source: '~/.codex/config.toml', summary: f.url ?? [f.command ?? '?', ...f.args].join(' ').slice(0, 160) }));
}

/** One block for the instructions: the skills an agent may use and where their SKILL.md lives. */
export function skillsNote(skills: SkillInfo[]): string {
  if (!skills.length) return '';
  return [
    '',
    '',
    '# Skills you may use',
    'When a task matches one of these skills, read its SKILL.md first and follow it. Its other files and scripts live next to it.',
    ...skills.map((s) => `- ${s.name}: ${path.join(s.dir, 'SKILL.md')}${s.description ? ` - ${s.description}` : ''}`),
  ].join('\n');
}
