// Configuration: defaults < <AGENTCRAFT_HOME>/config.json < environment < CLI flags.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util/fsx.js';
import type { BackendName } from './protocol.js';
import { defaultUserName } from './user.js';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const FOREMAN_VERSION = '0.1.0';

/** Repo root of the AgentCraft project (foreman/src/config.ts -> ../..). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface TeamConfig {
  leadModel: string;
  workerModel: string;
  effort?: EffortLevel;
  leadEffort?: EffortLevel;
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
  /** command prefixes the lead runs without asking, e.g. `bd show` */
  leadReadCommands: string[];
}

export interface ClaudeConfig extends TeamConfig {
  /** Opt into the local Claude CLI login (personal use only). */
  useClaudeLogin: boolean;
}

export type EngineName = 'claude' | 'codex';
export const ENGINE_NAMES: readonly EngineName[] = ['claude', 'codex'];

/** Which engine runs the lead, the workers, and per-agent exceptions (`--engines kit=codex`). */
export interface EngineChoice {
  lead: EngineName;
  worker: EngineName;
  byAgent: Record<string, EngineName>;
}

export interface CodexConfig extends TeamConfig {
  /** Both --codex-command and --codex-path select this executable. */
  command: string;
  path?: string;
}

export interface OpenAIConfig extends TeamConfig {
  baseUrl: string;
  /** Loaded from the named environment variable; never persisted in profile state. */
  apiKey?: string;
  apiKeyEnv: string;
  api: 'chat' | 'responses';
  timeoutMs: number;
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

export interface Config {
  backend: BackendName;
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
  openai: OpenAIConfig;
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
  'ambient', 'base-url', 'api-key-env', 'api', 'request-timeout', 'codex-command',
  'lead-read-commands', 'lead-engine', 'worker-engine', 'engines', 'codex-path', 'codex-model', 'codex-lead-model',
  'codex-worker-model', 'codex-effort', 'codex-lead-effort',
]);

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
  const fileCodex = (file.codex ?? {}) as Record<string, unknown>;
  const fileOpenAI = (file.openai ?? {}) as Record<string, unknown>;
  const fileSim = (file.sim ?? {}) as Record<string, unknown>;
  const pick = (k: string, envKey?: string): unknown => flags[k] ?? (envKey ? env[envKey] : undefined) ?? file[k];

  const backendRaw = String(pick('backend', 'AGENTCRAFT_BACKEND') ?? 'claude');
  if (!['sim', 'claude', 'codex', 'openai'].includes(backendRaw)) throw new Error(`unknown backend "${backendRaw}" (use sim, claude, codex or openai)`);
  const backend = backendRaw as BackendName;
  const profile = str(pick('profile', 'AGENTCRAFT_PROFILE')) ?? backend;
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error(`bad profile name "${profile}"`);

  const repoFlag = flags.repo;
  const repos: string[] = [];
  if (typeof repoFlag === 'string') repos.push(...repoFlag.split(',').map((s) => s.trim()).filter(Boolean));
  else if (Array.isArray(file.repos)) repos.push(...(file.repos as string[]));

  const workersFor = (section: Record<string, unknown>): string[] => {
    const workersRaw = str(flags.workers) ?? env.AGENTCRAFT_WORKERS ?? (section.workers as string[] | string | undefined);
    const workers = Array.isArray(workersRaw)
      ? workersRaw
      : typeof workersRaw === 'string'
        ? /^\d+$/.test(workersRaw)
          ? ['juniper', 'kit', 'wren', 'rowan', 'tove'].slice(0, Math.max(1, Math.min(5, Number(workersRaw))))
          : workersRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : ['juniper', 'kit', 'wren'];
    return workers;
  };

  const model = str(flags.model);
  const teamConfig = (section: Record<string, unknown>, defaults: [string, string], envModel?: string, useGenericModels = true): TeamConfig => ({
    leadModel: (useGenericModels ? str(flags['lead-model']) ?? model ?? str(env.AGENTCRAFT_LEAD_MODEL) ?? envModel : undefined) ?? str(section.leadModel) ?? defaults[0],
    workerModel: (useGenericModels ? str(flags['worker-model']) ?? model ?? str(env.AGENTCRAFT_WORKER_MODEL) ?? envModel : undefined) ?? str(section.workerModel) ?? defaults[1],
    effort: effort((useGenericModels ? flags.effort : undefined) ?? section.effort, 'medium'),
    leadEffort: effort((useGenericModels ? flags['lead-effort'] ?? flags.effort : undefined) ?? section.leadEffort, 'medium'),
    maxTurnsLead: num(flags['max-turns-lead'] ?? flags['max-turns'] ?? section.maxTurnsLead, 40),
    maxTurnsWorker: num(flags['max-turns-worker'] ?? flags['max-turns'] ?? section.maxTurnsWorker, 80),
    maxConcurrent: Math.max(1, num(flags['max-concurrent'] ?? section.maxConcurrent, 3)),
    workers: workersFor(section),
    ciCommand: str(flags.ci) ?? str(section.ciCommand),
    maxBudgetUsdPerTurn: flags['max-budget'] !== undefined ? num(flags['max-budget'], 0) || undefined : (section.maxBudgetUsdPerTurn as number | undefined),
    resumeOnStart: bool(flags.resume ?? section.resumeOnStart, true),
    leadReview: bool(flags['lead-review'] ?? section.leadReview, true),
    leadReadCommands: readCommands(flags['lead-read-commands'] ?? env.AGENTCRAFT_LEAD_READ_COMMANDS ?? section.leadReadCommands ?? fileClaude.leadReadCommands),
  });
  const baseUrl = str(flags['base-url']) ?? str(env.OPENAI_BASE_URL) ?? str(fileOpenAI.baseUrl) ?? 'https://api.openai.com/v1';
  const apiKeyEnv = str(flags['api-key-env']) ?? str(fileOpenAI.apiKeyEnv) ?? 'OPENAI_API_KEY';
  const api = flags.api ?? env.AGENTCRAFT_OPENAI_API ?? fileOpenAI.api ?? 'chat';
  if (backend === 'openai' && api !== 'chat' && api !== 'responses') throw new Error('unknown API (use chat or responses)');
  if (backend === 'openai') {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('base-url must be an absolute HTTP(S) API root, e.g. http://localhost:11434/v1'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('base-url must be HTTP(S) without credentials, query or fragment');
    }
  }
  const codexEffort = flags['codex-effort'] ?? (backend === 'codex' ? flags.effort : undefined) ?? fileCodex.effort;
  const codexLeadEffort = flags['codex-lead-effort'] ?? flags['codex-effort']
    ?? (backend === 'codex' ? flags['lead-effort'] ?? flags.effort : undefined) ?? fileCodex.leadEffort ?? fileCodex.effort;
  const cfg: Config = {
    backend,
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
      ...teamConfig(fileClaude, ['opus', 'sonnet'], undefined, backend !== 'codex' && backend !== 'openai'),
      useClaudeLogin: bool(flags['use-claude-login'] ?? env.AGENTCRAFT_USE_CLAUDE_LOGIN ?? fileClaude.useClaudeLogin, false),
    },
    engines: {
      lead: engineName(pick('lead-engine', 'AGENTCRAFT_LEAD_ENGINE') ?? (file.engines as Record<string, unknown> | undefined)?.lead, backend === 'codex' ? 'codex' : 'claude', 'lead engine'),
      worker: engineName(pick('worker-engine', 'AGENTCRAFT_WORKER_ENGINE') ?? (file.engines as Record<string, unknown> | undefined)?.worker, backend === 'codex' ? 'codex' : 'claude', 'worker engine'),
      byAgent: engineMap(flags.engines ?? env.AGENTCRAFT_ENGINES ?? (file.engines as Record<string, unknown> | undefined)?.byAgent),
    },
    codex: {
      ...teamConfig({ ...fileClaude, maxBudgetUsdPerTurn: undefined, ...fileCodex }, ['', '']),
      // Generic model flags select the backend's models; Codex-specific flags also work in mixed teams.
      leadModel: str(flags['codex-lead-model']) ?? str(flags['codex-model'])
        ?? (backend === 'codex' ? str(flags['lead-model']) ?? model ?? str(env.AGENTCRAFT_LEAD_MODEL) : undefined)
        ?? str(fileCodex.leadModel) ?? str(fileCodex.model) ?? '',
      workerModel: str(flags['codex-worker-model']) ?? str(flags['codex-model'])
        ?? (backend === 'codex' ? str(flags['worker-model']) ?? model ?? str(env.AGENTCRAFT_WORKER_MODEL) : undefined)
        ?? str(fileCodex.workerModel) ?? str(fileCodex.model) ?? '',
      effort: codexEffort === undefined ? undefined : effort(codexEffort, 'medium'),
      leadEffort: codexLeadEffort === undefined ? undefined : effort(codexLeadEffort, 'medium'),
      command: str(flags['codex-command']) ?? str(flags['codex-path']) ?? str(env.AGENTCRAFT_CODEX_COMMAND) ?? str(env.AGENTCRAFT_CODEX_PATH) ?? str(fileCodex.command) ?? str(fileCodex.path) ?? 'codex',
      path: str(flags['codex-command']) ?? str(flags['codex-path']) ?? str(env.AGENTCRAFT_CODEX_COMMAND) ?? str(env.AGENTCRAFT_CODEX_PATH) ?? str(fileCodex.command) ?? str(fileCodex.path),
    },
    openai: {
      ...teamConfig(fileOpenAI, ['', ''], str(env.OPENAI_MODEL)),
      baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: str(env[apiKeyEnv]), apiKeyEnv, api: api === 'responses' ? 'responses' : 'chat',
      timeoutMs: num(flags['request-timeout'] ?? fileOpenAI.timeoutMs, 120_000),
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
  if (backend !== 'sim') {
    const team = cfg[backend];
    for (const [key, value] of Object.entries({ maxTurnsLead: team.maxTurnsLead, maxTurnsWorker: team.maxTurnsWorker, maxConcurrent: team.maxConcurrent })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
    }
    if (backend !== 'claude' && team.maxBudgetUsdPerTurn !== undefined) throw new Error('--max-budget is supported only by Claude; use --max-turns for this backend');
  }
  if (backend === 'openai' && (!cfg.openai.leadModel || !cfg.openai.workerModel)) throw new Error('OpenAI-compatible endpoints require --model (or OPENAI_MODEL / openai.leadModel + workerModel in config.json)');
  if (backend === 'openai' && (!Number.isInteger(cfg.openai.timeoutMs) || cfg.openai.timeoutMs < 1)) throw new Error('request-timeout must be a positive number of milliseconds');
  const usesCodex = (backend === 'codex' || backend === 'claude') && [cfg.engines.lead, cfg.engines.worker, ...Object.values(cfg.engines.byAgent)].includes('codex');
  if (usesCodex && [cfg.codex.effort, cfg.codex.leadEffort].includes('max')) throw new Error('Codex effort supports low, medium, high or xhigh');
  if (cfg.sim.showcase) cfg.autostart = true;
  return cfg;
}

export const HELP = `AgentCraft Foreman ${FOREMAN_VERSION}

usage: npm run start -- [options]

  --backend sim|claude|codex|openai agent backend (default: claude)
  --repo <path>[,<path>]   register local git repo(s) at start (sim: defaults to a fresh sandbox/sim-demo)
  --goal "<text>"          submit a goal right away
  --port <n>               WebSocket port (default 7878, env AGENTCRAFT_PORT)
  --home <dir>             state root (default ~/.agentcraft, env AGENTCRAFT_HOME)
  --user-name <name>       your name, as the agents address you (default: your OS user name,
                           env AGENTCRAFT_USER_NAME, config.json "userName")
  --profile <name>         state profile under home (default: backend name)
  --reset                  wipe this profile's state first (sim: also recreates the demo repo)
  --notify / --no-notify   desktop notification when a decision waits (default: on for real agents, off for sim)
  --toast-silent           toasts without sound
  --repo-poll-ms <n>       how often repo checkouts are checked for head/dirty changes (default 10000)
  --merge-style merge|squash  approved merges: merge commit keeping the agents' commits (default),
                           or one squashed commit authored by you
  --no-sign-merges         never sign approved merge commits (default: signed when your git
                           config has commit.gpgsign=true; real backends only)
  --debug                  verbose logging

 sim backend
  --speed <x>              speed multiplier (default 1)
  --seed <n>               scenario seed (default 7)
  --autostart              start the scripted scenario immediately (otherwise: on first goal.submit)
  --showcase               run to the showcase checkpoint instantly and hold that static state
  --showcase late          hold the later state instead (blocked, error, done and running agents)
  --auto-answer            answer the scenario's own decisions (unattended runs)
  --no-ambient             no idle chatter while waiting on you

 codex backend
  auth: saved Codex CLI login (codex login), or CODEX_API_KEY
  --codex-command <path>   Codex executable (default codex, env AGENTCRAFT_CODEX_COMMAND)
  model defaults to the Codex CLI default; --model overrides it
  requires a compatible Codex app-server; saved auth is reused, personal integrations are disabled

 openai backend (OpenAI-compatible endpoints)
  --base-url <url>         API root (default https://api.openai.com/v1, env OPENAI_BASE_URL)
  --api chat|responses    API dialect (default chat, env AGENTCRAFT_OPENAI_API)
  --api-key-env <name>     env variable holding the bearer key (default OPENAI_API_KEY)
                           key optional for local endpoints; never passed on the command line
  --request-timeout <ms>  timeout per HTTP request (default 120000)
  --model <m>              required model id (or OPENAI_MODEL); endpoint must support tool calling

 claude backend
  auth: ANTHROPIC_API_KEY, or a cloud provider (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY)
  --use-claude-login       use your local \`claude\` CLI login instead (personal use only; env
                           AGENTCRAFT_USE_CLAUDE_LOGIN=1, config.json claude.useClaudeLogin)

 shared real-agent options (config sections: claude, codex, openai)
  --model <m>              model for lead and workers (Claude defaults: opus / sonnet)
  --lead-model <m> / --worker-model <m>
  --effort low|medium|high|xhigh|max   reasoning effort (Claude: medium; Codex: CLI config; max: Claude only)
  --max-turns <n>          cap per job (default lead 40 / worker 80; Codex: tool calls)
  --workers <n|ids>        team size or comma list (default juniper,kit,wren)
  --max-concurrent <n>     workers running at once (default 3)
  --max-budget <usd>       per-turn USD cap (Claude only)
  --ci "<cmd>"             test command run after each task (default: detected, e.g. npm test)
  --lead-read-commands "<cmd>,..."
                           read commands the lead runs without asking, by prefix, e.g.
                           "bd show,gh issue view" (env AGENTCRAFT_LEAD_READ_COMMANDS)
  --no-lead-review         skip the lead's review turn before merge decisions
  --no-resume              do not resume interrupted sessions on start

 codex engine (--backend codex, or mixed teams)
  auth: your Codex login (\`codex login\`: ChatGPT or an OpenAI API key)
  --lead-engine claude|codex / --worker-engine claude|codex
                           mix engines (default: the backend's), e.g. a Claude lead with Codex workers
  --engines <agent=engine,...>  per agent, e.g. kit=codex,wren=claude (env AGENTCRAFT_ENGINES)
  --codex-path <path>      the codex CLI (default: on PATH, else the Codex desktop app's)
  --codex-model <m>        model for Codex agents (default: your Codex config's model)
  --codex-lead-model <m> / --codex-worker-model <m>
  --codex-effort <e>       reasoning effort (low|medium|high|xhigh; default: your Codex config's)
  Codex agents get none of your own MCP servers, plugins, web search or apps; every command and
  out-of-worktree edit goes through the same policy and in-game permission prompts.
`;
