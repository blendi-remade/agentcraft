// Configuration: defaults < <AGENTCRAFT_HOME>/config.json < environment < CLI flags.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util/fsx.js';
import type { BackendName } from './protocol.js';
import { defaultUserName } from './user.js';
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

export const FOREMAN_VERSION = '0.1.0';

/** Repo root of the AgentCraft project (foreman/src/config.ts -> ../..). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface ClaudeConfig {
  leadModel: string;
  workerModel: string;
  effort: EffortLevel;
  leadEffort: EffortLevel;
  maxTurnsLead: number;
  maxTurnsWorker: number;
  /** max workers running a turn at the same time */
  maxConcurrent: number;
  /** worker ids in the team (subset of the cast) */
  workers: string[];
  /** test command for CI after a worker finishes (default: detect, e.g. `npm test`) */
  ciCommand?: string;
  /** per-turn budget cap passed to the SDK */
  maxBudgetUsdPerTurn?: number;
  /** resume interrupted sessions on Foreman start */
  resumeOnStart: boolean;
  /** lead reviews each finished task before the merge decision reaches the user */
  leadReview: boolean;
  /**
   * Use the local `claude` CLI's claude.ai login instead of an API key / cloud provider. Personal use
   * only: Anthropic does not allow third-party tools to offer claude.ai login (see agents/claude/auth.ts).
   */
  useClaudeLogin: boolean;
  /** command prefixes the lead runs without asking, e.g. `bd show` */
  leadReadCommands: string[];
  /**
   * Skills the agents may use: 'off' (default), 'all', or skill names (e.g. ["designer"]). Skills
   * come from `plugins` and, with `userSettings`, from ~/.claude/skills.
   */
  skills: 'off' | 'all' | string[];
  /**
   * Load your own ~/.claude settings (skills, CLAUDE.md, user MCP servers). Off by default: those
   * settings can carry permission rules and hooks. Turned on by `skills` unless set to false.
   */
  userSettings: boolean;
  /** local plugin directories (skills, commands, agents) loaded for every Claude agent */
  plugins: string[];
  /**
   * Your own Claude Code MCP servers (~/.claude.json, the repo's .mcp.json) the agents get, by name,
   * or 'all'. Picked with checkboxes on the dashboard.
   */
  mcp: 'all' | string[];
  /** extra MCP servers for every Claude agent, in the Claude Code `mcpServers` format */
  mcpServers: Record<string, McpServerSpec>;
  /** MCP server names whose tools run without a permission prompt (others ask in game) */
  trustedMcp: string[];
}

/** An MCP server as Claude Code's .mcp.json writes it: stdio (`command`) or remote (`url`). */
export type McpServerSpec =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export type EngineName = 'claude' | 'codex';
export const ENGINE_NAMES: readonly EngineName[] = ['claude', 'codex'];

/** Codex engine (`codex app-server`): models and effort default to your Codex config. */
export interface CodexConfig {
  /** the codex CLI (default: `codex` on PATH, else the one inside the Codex desktop app) */
  path?: string;
  leadModel?: string;
  workerModel?: string;
  /** model_reasoning_effort for workers / the lead (low, medium, high, xhigh...) */
  effort?: string;
  leadEffort?: string;
  /** skills from ~/.codex/skills and ~/.agents/skills the agents may use: 'off', 'all' or names */
  skills: 'off' | 'all' | string[];
  /** your Codex MCP servers ([mcp_servers.*] in ~/.codex/config.toml) that stay on, by name, or 'all' */
  mcp: 'all' | string[];
}

/** Which engine runs the lead, the workers, and per-agent exceptions (`--engines kit=codex`). */
export interface EngineChoice {
  lead: EngineName;
  worker: EngineName;
  byAgent: Record<string, EngineName>;
}

export type ShowcaseCheckpoint = 'showcase' | 'showcase-late';

export interface SimConfig {
  speed: number;
  seed: number;
  showcase: boolean;
  /** which static state --showcase holds: the busy mid-run state (default) or `--showcase late` */
  showcaseAt: ShowcaseCheckpoint;
  /** sim answers its own decisions (first option) after a short delay — for unattended runs/tests */
  autoAnswer: boolean;
  /** extra idle log lines while waiting on the user */
  ambient: boolean;
}

export type Language = 'en' | 'it';

export interface Config {
  backend: BackendName;
  /** the language agents talk to you in (and the dashboard's default): en or it */
  language: Language;
  /** minutes without any activity in a running turn before an agent counts as stalled (0 = never) */
  stallMinutes: number;
  /** what happens to a stalled agent: tell you (notify) or also restart its turn (nudge) */
  stallAction: 'notify' | 'nudge';
  /** start mode for permission prompts (the dashboard switch is saved in the profile and wins) */
  permissionMode: 'ask' | 'allow_all';
  /** model per agent, overriding the role's model, e.g. {"kit": "haiku"} (any engine) */
  agentModels: Record<string, string>;
  /** the person the team works for (prompts, feed, UI); default: the OS user name */
  userName: string;
  home: string;
  profile: string;
  /** profile directory: <home>/<profile> */
  dataDir: string;
  host: string;
  port: number;
  repos: string[];
  goal?: string;
  autostart: boolean;
  reset: boolean;
  notify: boolean;
  toastSilent: boolean;
  debug: boolean;
  quiet: boolean;
  projectRoot: string;
  /** reject WebSocket upgrades that carry a browser Origin (CSRF-style protection) */
  allowBrowserOrigins: boolean;
  /** how often the main checkouts are polled for head/dirty changes (ms) */
  repoPollMs: number;
  /** approved merges: a merge commit (keeps the agents' commits) or one squashed commit */
  mergeStyle: 'merge' | 'squash';
  /** sign approved merge commits when the repo's own git config says commit.gpgsign=true */
  signMerges: boolean;
  /** team settings (workers, CI, review, lead read commands) and the Claude engine's options */
  claude: ClaudeConfig;
  codex: CodexConfig;
  engines: EngineChoice;
  sim: SimConfig;
}

type Flags = Record<string, string | boolean>;

export function parseFlags(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { flags, positional };
}

function num(v: unknown, d: number): number {
  if (v === undefined || v === '' || v === true) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function bool(v: unknown, d: boolean): boolean {
  if (v === undefined) return d;
  if (typeof v === 'boolean') return v;
  return !/^(0|false|no|off)$/i.test(String(v));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

/** Comma list (flag, env) or array (config.json). */
function list(v: unknown): string[] {
  const items = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [];
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Programs that can write, run other code or reach the network: never declarable as lead "read" commands. */
const NOT_READ_ONLY = new Set([
  'git', 'rm', 'mv', 'cp', 'tee', 'dd', 'sed', 'awk', 'find', 'xargs', 'env', 'sudo', 'sh', 'bash', 'zsh',
  'node', 'npm', 'npx', 'python', 'python3', 'pip', 'perl', 'ruby', 'curl', 'wget', 'ssh', 'scp', 'eval', 'exec',
  'cmd', 'powershell', 'pwsh', 'touch', 'mkdir', 'chmod', 'kill',
]);

/** Each entry is a bare program name plus plain words ("bd show"): no paths, shell syntax, or writers/interpreters. */
function readCommands(v: unknown): string[] {
  const entries = list(v);
  for (const e of entries) {
    const [head = '', ...words] = e.split(/\s+/);
    if (!/^[A-Za-z0-9_.+-]+$/.test(head) || !words.every((w) => /^[A-Za-z0-9_.:@+=-]+$/.test(w))) {
      throw new Error(`bad lead read command "${e}" (use a bare program name and plain words, like "bd show")`);
    }
    if (NOT_READ_ONLY.has(head.toLowerCase().replace(/\.(exe|cmd|bat)$/, ''))) {
      throw new Error(`lead read command "${e}" is not allowed: "${head}" can write files, run code or use the network`);
    }
  }
  return entries;
}

function mergeStyle(v: unknown): 'merge' | 'squash' {
  if (v === undefined || v === 'merge') return 'merge';
  if (v === 'squash') return 'squash';
  throw new Error(`unknown merge style "${String(v)}" (use merge or squash)`);
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
function effort(v: unknown, d: EffortLevel): EffortLevel {
  if (v === undefined) return d;
  if (typeof v === 'string' && (EFFORTS as string[]).includes(v)) return v as EffortLevel;
  throw new Error(`unknown effort "${String(v)}" (use ${EFFORTS.join(', ')})`);
}

/** Every flag loadConfig reads (the `no-` prefix is stripped by parseFlags). */
export const KNOWN_FLAGS = new Set([
  'home', 'backend', 'profile', 'user-name', 'use-claude-login', 'repo', 'workers', 'model', 'port', 'goal', 'autostart', 'reset', 'notify',
  'toast-silent', 'debug', 'quiet', 'allow-browser-origins', 'repo-poll-ms', 'merge-style', 'sign-merges',
  'lead-model', 'worker-model', 'effort', 'lead-effort', 'max-turns', 'max-turns-lead', 'max-turns-worker',
  'max-concurrent', 'ci', 'max-budget', 'resume', 'lead-review', 'speed', 'seed', 'showcase', 'auto-answer',
  'ambient', 'lead-read-commands', 'lead-engine', 'worker-engine', 'engines', 'codex-path', 'codex-model', 'codex-lead-model',
  'codex-worker-model', 'codex-effort', 'codex-lead-effort', 'language', 'stall-minutes', 'stall-action', 'skills',
  'user-settings', 'plugin-dir', 'mcp-config', 'trusted-mcp', 'mcp', 'codex-skills', 'codex-mcp', 'permission-mode',
  'agent-models',
]);

function permissionMode(v: unknown): 'ask' | 'allow_all' {
  if (v === undefined || v === 'ask') return 'ask';
  if (v === 'allow_all' || v === 'allow-all') return 'allow_all';
  throw new Error(`unknown permission mode "${String(v)}" (use ask or allow-all)`);
}

/** "kit=haiku,wren=opus" (flag) or {"kit": "haiku"} (config.json "models") */
function agentModels(v: unknown): Record<string, string> {
  const pairs: Array<[string, unknown]> = v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : list(v).map((e) => e.split('=').map((x) => x.trim()) as [string, string]);
  const out: Record<string, string> = {};
  for (const [agent, model] of pairs) {
    if (!agent || !/^[a-z0-9_-]+$/i.test(agent) || typeof model !== 'string' || !model.trim()) throw new Error(`bad --agent-models entry "${agent}=${String(model)}" (use agent=model, e.g. kit=haiku)`);
    out[agent.toLowerCase()] = model.trim();
  }
  return out;
}

/** --mcp all|name,name (flag) or "all" / ["playwright"] (config.json); default none */
function mcpChoice(v: unknown): 'all' | string[] {
  if (v === 'all' || v === true) return 'all';
  return list(v === false || v === 'none' ? [] : v);
}

function language(v: unknown): Language {
  const l = String(v ?? 'en').toLowerCase();
  if (l === 'en' || l.startsWith('en_') || l.startsWith('en-')) return 'en';
  if (l === 'it' || l.startsWith('it_') || l.startsWith('it-')) return 'it';
  throw new Error(`unknown language "${String(v)}" (use en or it)`);
}

function stallAction(v: unknown): 'notify' | 'nudge' {
  if (v === undefined || v === 'notify') return 'notify';
  if (v === 'nudge') return 'nudge';
  throw new Error(`unknown stall action "${String(v)}" (use notify or nudge)`);
}

/** --skills all|off|name,name (flag) or "all" / ["designer"] / false (config.json) */
function skills(v: unknown): 'off' | 'all' | string[] {
  if (v === undefined || v === false || v === 'off' || v === 'none' || v === '') return 'off';
  if (v === true || v === 'all') return 'all';
  const names = list(v);
  for (const n of names) if (!/^[\w.:-]+$/.test(n)) throw new Error(`bad skill name "${n}"`);
  return names.length ? names : 'off';
}

/** {"name": {command, args} | {type: "http", url}} from config.json, or the file --mcp-config names ({"mcpServers": {...}}). */
function mcpServers(fromFile: unknown, configFile: string | undefined): Record<string, McpServerSpec> {
  let raw = fromFile;
  if (configFile) {
    const doc = readJson<Record<string, unknown>>(path.resolve(configFile));
    if (!doc) throw new Error(`cannot read MCP config ${configFile}`);
    raw = doc.mcpServers ?? doc;
  }
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcpServers must be an object of servers');
  const out: Record<string, McpServerSpec> = {};
  for (const [name, spec] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`bad MCP server name "${name}"`);
    if (name === 'agentcraft') throw new Error('the MCP server name "agentcraft" is reserved');
    if (typeof spec?.command === 'string') out[name] = spec as McpServerSpec;
    else if (typeof spec?.url === 'string') out[name] = { ...(spec as object), type: spec.type === 'sse' ? 'sse' : 'http' } as McpServerSpec;
    else throw new Error(`MCP server "${name}" needs a command or a url`);
  }
  return out;
}

function engineName(v: unknown, d: EngineName, what: string): EngineName {
  if (v === undefined || v === '') return d;
  if (typeof v === 'string' && (ENGINE_NAMES as string[]).includes(v)) return v as EngineName;
  throw new Error(`unknown ${what} "${String(v)}" (use ${ENGINE_NAMES.join(' or ')})`);
}

/** "kit=codex,wren=claude" (flag/env) or {"kit": "codex"} (config.json) */
function engineMap(v: unknown): Record<string, EngineName> {
  const pairs: Array<[string, unknown]> =
    v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : list(v).map((e) => e.split('=').map((x) => x.trim()) as [string, string]);
  const out: Record<string, EngineName> = {};
  for (const [agent, engine] of pairs) {
    if (!agent || !/^[a-z0-9_-]+$/i.test(agent)) throw new Error(`bad --engines entry "${agent}=${String(engine)}" (use agent=engine, e.g. kit=codex)`);
    if (engine === undefined || engine === '') throw new Error(`no engine for ${agent} in --engines (use agent=engine, e.g. ${agent}=codex)`);
    out[agent.toLowerCase()] = engineName(engine, 'claude', `engine for ${agent}`);
  }
  return out;
}

/**
 * Unknown flags and stray positionals are errors, not silently ignored: a mistyped or mangled flag
 * (e.g. PowerShell passing `--workers,kit,--model,sonnet` as ONE argument) would otherwise start a
 * real claude team on the expensive defaults (opus lead, medium effort, three workers).
 */
function checkArgs(flags: Flags, positional: string[]): void {
  const unknown = Object.keys(flags).filter((k) => !KNOWN_FLAGS.has(k));
  if (unknown.length) {
    throw new Error(`unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"--${k}"`).join(', ')} (see --help)`);
  }
  if (positional.length) throw new Error(`unexpected argument "${positional[0]}" (options start with --; see --help)`);
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const { flags, positional } = parseFlags(argv);
  checkArgs(flags, positional);
  const home = path.resolve(str(flags.home) ?? env.AGENTCRAFT_HOME ?? path.join(os.homedir(), '.agentcraft'));
  const file = readJson<Record<string, unknown>>(path.join(home, 'config.json')) ?? {};
  const fileClaude = (file.claude ?? {}) as Record<string, unknown>;
  const fileSim = (file.sim ?? {}) as Record<string, unknown>;
  const fileCodex = (file.codex ?? {}) as Record<string, unknown>;
  const pick = (k: string, envKey?: string): unknown => flags[k] ?? (envKey ? env[envKey] : undefined) ?? file[k];

  const backendRaw = String(pick('backend', 'AGENTCRAFT_BACKEND') ?? 'claude');
  if (backendRaw !== 'sim' && backendRaw !== 'claude' && backendRaw !== 'codex') throw new Error(`unknown backend "${backendRaw}" (use sim, claude or codex)`);
  const backend = backendRaw as BackendName;
  const profile = str(pick('profile', 'AGENTCRAFT_PROFILE')) ?? backend;
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error(`bad profile name "${profile}"`);

  const repoFlag = flags.repo;
  const repos: string[] = [];
  if (typeof repoFlag === 'string') repos.push(...repoFlag.split(',').map((s) => s.trim()).filter(Boolean));
  else if (Array.isArray(file.repos)) repos.push(...(file.repos as string[]));

  const workersRaw = str(flags.workers) ?? env.AGENTCRAFT_WORKERS ?? (fileClaude.workers as string[] | string | undefined);
  const workers = Array.isArray(workersRaw)
    ? workersRaw
    : typeof workersRaw === 'string'
      ? /^\d+$/.test(workersRaw)
        ? ['juniper', 'kit', 'wren', 'rowan', 'tove'].slice(0, Math.max(1, Math.min(5, Number(workersRaw))))
        : workersRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['juniper', 'kit', 'wren'];

  const model = str(flags.model);
  const skillChoice = skills(flags.skills ?? env.AGENTCRAFT_SKILLS ?? fileClaude.skills);
  const cfg: Config = {
    backend,
    language: language(pick('language', 'AGENTCRAFT_LANGUAGE')),
    stallMinutes: Math.max(0, num(pick('stall-minutes', 'AGENTCRAFT_STALL_MINUTES'), 10)),
    stallAction: stallAction(pick('stall-action', 'AGENTCRAFT_STALL_ACTION')),
    permissionMode: permissionMode(pick('permission-mode', 'AGENTCRAFT_PERMISSION_MODE')),
    agentModels: agentModels(flags['agent-models'] ?? env.AGENTCRAFT_AGENT_MODELS ?? file.models),
    userName: (str(pick('user-name', 'AGENTCRAFT_USER_NAME')) ?? str(file.userName))?.trim().slice(0, 40) || defaultUserName(),
    home,
    profile,
    dataDir: path.join(home, profile),
    host: '127.0.0.1',
    port: num(pick('port', 'AGENTCRAFT_PORT'), 7878),
    repos,
    goal: str(flags.goal),
    autostart: bool(flags.autostart, false) || !!str(flags.goal),
    reset: bool(flags.reset, false),
    notify: bool(pick('notify', 'AGENTCRAFT_NOTIFY'), backend !== 'sim'),
    toastSilent: bool(pick('toast-silent', 'AGENTCRAFT_TOAST_SILENT'), false),
    debug: bool(pick('debug', 'AGENTCRAFT_DEBUG'), false),
    quiet: bool(flags.quiet, false),
    projectRoot: PROJECT_ROOT,
    allowBrowserOrigins: bool(pick('allow-browser-origins'), false),
    repoPollMs: Math.max(500, num(pick('repo-poll-ms'), 10_000)),
    mergeStyle: mergeStyle(pick('merge-style', 'AGENTCRAFT_MERGE_STYLE')),
    // the sim answers merges unattended (screenshot QA, --auto-answer): never sign there
    signMerges: bool(pick('sign-merges', 'AGENTCRAFT_SIGN_MERGES'), backend !== 'sim'),
    claude: {
      leadModel: str(flags['lead-model']) ?? model ?? str(env.AGENTCRAFT_LEAD_MODEL) ?? str(fileClaude.leadModel) ?? 'opus',
      workerModel: str(flags['worker-model']) ?? model ?? str(env.AGENTCRAFT_WORKER_MODEL) ?? str(fileClaude.workerModel) ?? 'sonnet',
      effort: effort(flags.effort ?? fileClaude.effort, 'medium'),
      leadEffort: effort(flags['lead-effort'] ?? flags.effort ?? fileClaude.leadEffort, 'medium'),
      maxTurnsLead: num(flags['max-turns-lead'] ?? flags['max-turns'] ?? fileClaude.maxTurnsLead, 40),
      maxTurnsWorker: num(flags['max-turns-worker'] ?? flags['max-turns'] ?? fileClaude.maxTurnsWorker, 80),
      maxConcurrent: Math.max(1, num(flags['max-concurrent'] ?? fileClaude.maxConcurrent, 3)),
      workers,
      ciCommand: str(flags.ci) ?? str(fileClaude.ciCommand),
      maxBudgetUsdPerTurn: flags['max-budget'] !== undefined ? num(flags['max-budget'], 0) || undefined : (fileClaude.maxBudgetUsdPerTurn as number | undefined),
      resumeOnStart: bool(flags.resume ?? fileClaude.resumeOnStart, true),
      leadReview: bool(flags['lead-review'] ?? fileClaude.leadReview, true),
      useClaudeLogin: bool(flags['use-claude-login'] ?? env.AGENTCRAFT_USE_CLAUDE_LOGIN ?? fileClaude.useClaudeLogin, false),
      leadReadCommands: readCommands(flags['lead-read-commands'] ?? env.AGENTCRAFT_LEAD_READ_COMMANDS ?? fileClaude.leadReadCommands),
      skills: skillChoice,
      userSettings: bool(flags['user-settings'] ?? fileClaude.userSettings, skillChoice !== 'off'),
      plugins: list(flags['plugin-dir'] ?? fileClaude.plugins).map((p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()))),
      mcp: mcpChoice(flags.mcp ?? fileClaude.mcp),
      mcpServers: mcpServers(fileClaude.mcpServers, str(flags['mcp-config'])),
      trustedMcp: list(flags['trusted-mcp'] ?? fileClaude.trustedMcp),
    },
    codex: {
      path: str(flags['codex-path']) ?? str(env.AGENTCRAFT_CODEX_PATH) ?? str(fileCodex.path),
      leadModel: str(flags['codex-lead-model']) ?? str(flags['codex-model']) ?? str(fileCodex.leadModel) ?? str(fileCodex.model),
      workerModel: str(flags['codex-worker-model']) ?? str(flags['codex-model']) ?? str(fileCodex.workerModel) ?? str(fileCodex.model),
      effort: str(flags['codex-effort']) ?? str(fileCodex.effort),
      leadEffort: str(flags['codex-lead-effort']) ?? str(flags['codex-effort']) ?? str(fileCodex.leadEffort) ?? str(fileCodex.effort),
      skills: skills(flags['codex-skills'] ?? fileCodex.skills),
      mcp: mcpChoice(flags['codex-mcp'] ?? fileCodex.mcp),
    },
    engines: {
      lead: engineName(pick('lead-engine', 'AGENTCRAFT_LEAD_ENGINE') ?? (file.engines as Record<string, unknown> | undefined)?.lead, backend === 'codex' ? 'codex' : 'claude', 'lead engine'),
      worker: engineName(pick('worker-engine', 'AGENTCRAFT_WORKER_ENGINE') ?? (file.engines as Record<string, unknown> | undefined)?.worker, backend === 'codex' ? 'codex' : 'claude', 'worker engine'),
      byAgent: engineMap(flags.engines ?? env.AGENTCRAFT_ENGINES ?? (file.engines as Record<string, unknown> | undefined)?.byAgent),
    },
    sim: {
      speed: Math.max(0.05, num(flags.speed ?? env.AGENTCRAFT_SIM_SPEED ?? fileSim.speed, 1)),
      seed: num(flags.seed ?? fileSim.seed, 7),
      showcase: bool(flags.showcase, false),
      showcaseAt: flags.showcase === 'late' ? 'showcase-late' : 'showcase',
      autoAnswer: bool(flags['auto-answer'] ?? fileSim.autoAnswer, false),
      ambient: bool(flags.ambient ?? fileSim.ambient, true),
    },
  };
  if (cfg.sim.showcase) cfg.autostart = true;
  return cfg;
}

export const HELP = `AgentCraft Foreman ${FOREMAN_VERSION}

usage: npm run start -- [options]

  --backend sim|claude|codex  agent backend (default: claude; codex = an all-Codex team)
  --repo <path>[,<path>]   register local git repo(s) at start (sim: defaults to a fresh sandbox/sim-demo)
  --goal "<text>"          submit a goal right away
  --port <n>               WebSocket port (default 7878, env AGENTCRAFT_PORT)
  --home <dir>             state root (default ~/.agentcraft, env AGENTCRAFT_HOME)
  --user-name <name>       your name, as the agents address you (default: your OS user name,
                           env AGENTCRAFT_USER_NAME, config.json "userName")
  --profile <name>         state profile under home (default: backend name)
  --reset                  wipe this profile's state first (sim: also recreates the demo repo)
  --notify / --no-notify   desktop notification when a decision waits (default: on for claude, off for sim)
  --toast-silent           toasts without sound
  --repo-poll-ms <n>       how often repo checkouts are checked for head/dirty changes (default 10000)
  --merge-style merge|squash  approved merges: merge commit keeping the agents' commits (default),
                           or one squashed commit authored by you
  --no-sign-merges         never sign approved merge commits (default: signed when your git
                           config has commit.gpgsign=true; claude backend only)
  --debug                  verbose logging
  --language en|it         the language agents talk to you in (env AGENTCRAFT_LANGUAGE,
                           config.json "language"; default en)
  --stall-minutes <n>      a running agent with no activity for n minutes is flagged as stalled
                           (default 10, 0 = off)
  --stall-action notify|nudge  notify you (default), or also restart the stalled turn
  --permission-mode ask|allow-all  allow-all answers every permission prompt with "allow" by
                           itself (git push is still refused); the dashboard has a switch
  --agent-models <agent=model,...>  a model per agent, e.g. kit=haiku,marlow=opus (config.json
                           "models": {"kit": "haiku"}); any engine

 sim backend
  --speed <x>              speed multiplier (default 1)
  --seed <n>               scenario seed (default 7)
  --autostart              start the scripted scenario immediately (otherwise: on first goal.submit)
  --showcase               run to the showcase checkpoint instantly and hold that static state
  --showcase late          hold the later state instead (blocked, error, done and running agents)
  --auto-answer            answer the scenario's own decisions (unattended runs)
  --no-ambient             no idle chatter while waiting on you

 claude backend
  auth: ANTHROPIC_API_KEY, or a cloud provider (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY)
  --use-claude-login       use your local \`claude\` CLI login instead (personal use only; env
                           AGENTCRAFT_USE_CLAUDE_LOGIN=1, config.json claude.useClaudeLogin)
  --model <m>              model for lead and workers (default lead: opus, workers: sonnet)
  --lead-model <m> / --worker-model <m>
  --effort low|medium|high|xhigh|max   (default medium)
  --max-turns <n>          turn cap per session run (default lead 40 / worker 80)
  --workers <n|ids>        team size or comma list (default juniper,kit,wren)
  --max-concurrent <n>     workers running at once (default 3)
  --max-budget <usd>       per-turn USD cap
  --ci "<cmd>"             test command run after each task (default: detected, e.g. npm test)
  --lead-read-commands "<cmd>,..."
                           read commands the lead runs without asking, by prefix, e.g.
                           "bd show,gh issue view" (env AGENTCRAFT_LEAD_READ_COMMANDS)
  --no-lead-review         skip the lead's review turn before merge decisions
  --no-resume              do not resume interrupted sessions on start
  --skills all|<name,...>  let the agents use skills (default off), e.g. --skills designer
  --user-settings          load your ~/.claude settings (skills, CLAUDE.md, user MCP servers);
                           on by default with --skills (--no-user-settings to keep it off)
  --plugin-dir <dir,...>   load local plugins (their skills, commands and MCP servers)
  --mcp all|<name,...>     your own Claude Code MCP servers the agents get (~/.claude.json,
                           the repo's .mcp.json; default none; the dashboard has checkboxes)
  --mcp-config <file>      extra MCP servers, a .mcp.json style {"mcpServers": {...}} file
                           (config.json: claude.mcpServers)
  --trusted-mcp <name,...> MCP servers whose tools run without asking (others ask in game)

 codex engine (--backend codex, or mixed teams)
  auth: your Codex login (\`codex login\`: ChatGPT or an OpenAI API key)
  --lead-engine claude|codex / --worker-engine claude|codex
                           mix engines (default: the backend's), e.g. a Claude lead with Codex workers
  --engines <agent=engine,...>  per agent, e.g. kit=codex,wren=claude (env AGENTCRAFT_ENGINES)
  --codex-path <path>      the codex CLI (default: on PATH, else the Codex desktop app's)
  --codex-model <m>        model for Codex agents (default: your Codex config's model)
  --codex-lead-model <m> / --codex-worker-model <m>
  --codex-effort <e>       reasoning effort (low|medium|high|xhigh...; default: your Codex config's)
  --codex-skills all|<name,...>  skills from ~/.codex/skills and ~/.agents/skills (default off)
  --codex-mcp all|<name,...>     your Codex MCP servers (~/.codex/config.toml) that stay on (default none)
  Codex agents get none of your plugins, web search or apps, and only the MCP servers you pick;
  every command and out-of-worktree edit goes through the same policy and in-game permission prompts.
`;
