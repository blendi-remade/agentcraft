#!/usr/bin/env node
// Launch AgentCraft with OpenCode Go as the model gateway.
//
// AgentCraft's `claude` engine is the Claude Agent SDK (Claude Code) under the hood. OpenCode
// exposes an Anthropic-compatible endpoint, so the same agent engine works unchanged. This wrapper
// reads the OpenCode Go key that is already stored locally, maps the Go models, and starts the
// normal tools/unix.mjs launcher.
//
// It never prints the key. Use --dry-run to see the resolved configuration with the token redacted.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/anthropic';
export const DEFAULT_INTEGRATION = 'opencode-go';
export const DEFAULT_LEAD_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_WORKER_MODEL = 'muse-spark-1.3-contributor';
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';

// Recommended default team. `--model` collapses everything to one model; `--claude-models`
// overrides individual agents; `--no-per-agent-models` keeps one worker model for all workers.
export const DEFAULT_MODELS_BY_AGENT = {
  marlow: 'deepseek-v4.1-flash',
  juniper: 'muse-spark-1.3-contributor',
  kit: 'kimi-k2.7-code',
  wren: 'muse-spark-1.3-contributor',
  rowan: 'deepseek-v4.1-flash',
  tove: 'muse-spark-1.3-contributor',
};

const VALUE_FLAGS = new Set([
  'backend',
  'repo',
  'profile',
  'home',
  'port',
  'model',
  'lead-model',
  'worker-model',
  'claude-models',
  'workers',
  'max-concurrent',
  'effort',
  'max-turns',
  'max-turns-lead',
  'max-turns-worker',
  'base-url',
  'integration',
  'foreman-arg',
]);

const SWITCH_FLAGS = new Set(['no-game', 'no-wait', 'dev', 'reset', 'dry-run', 'no-per-agent-models', 'help']);

export function parseArgs(argv) {
  const o = {
    backend: 'claude',
    repos: [],
    foremanArgs: [],
    noGame: false,
    noWait: false,
    dev: false,
    reset: false,
    dryRun: false,
    noPerAgentModels: false,
    help: false,
    integration: DEFAULT_INTEGRATION,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (VALUE_FLAGS.has(key)) {
      if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`);
      const value = argv[++i];
      switch (key) {
        case 'backend':
          o.backend = value;
          break;
        case 'repo':
          o.repos.push(path.resolve(value));
          break;
        case 'profile':
          o.profile = value;
          break;
        case 'home':
          o.home = value;
          break;
        case 'port':
          o.port = value;
          break;
        case 'model':
          o.model = value;
          break;
        case 'lead-model':
          o.leadModel = value;
          break;
        case 'worker-model':
          o.workerModel = value;
          break;
        case 'claude-models':
          o.claudeModels = value;
          break;
        case 'workers':
          o.workers = value;
          break;
        case 'max-concurrent':
          o.maxConcurrent = value;
          break;
        case 'effort':
          o.effort = value;
          break;
        case 'max-turns':
          o.maxTurns = value;
          break;
        case 'max-turns-lead':
          o.maxTurnsLead = value;
          break;
        case 'max-turns-worker':
          o.maxTurnsWorker = value;
          break;
        case 'base-url':
          o.baseUrl = value;
          break;
        case 'integration':
          o.integration = value;
          break;
        case 'foreman-arg':
          o.foremanArgs.push(value);
          break;
        default:
          break;
      }
    } else if (SWITCH_FLAGS.has(key)) {
      if (key === 'no-game') o.noGame = true;
      else if (key === 'no-wait') o.noWait = true;
      else if (key === 'dev') o.dev = true;
      else if (key === 'reset') o.reset = true;
      else if (key === 'dry-run') o.dryRun = true;
      else if (key === 'no-per-agent-models') o.noPerAgentModels = true;
      else if (key === 'help') o.help = true;
    } else {
      throw new Error(`unknown option "--${key}" (see --help)`);
    }
  }
  if (!['sim', 'claude'].includes(o.backend)) throw new Error(`--backend must be sim or claude (got "${o.backend}")`);
  return o;
}

/** Pick the active key for an integration from `opencode auth export`'s JSON. */
export function extractKey(creds, integration = DEFAULT_INTEGRATION) {
  if (!Array.isArray(creds)) throw new Error('opencode auth export did not return a JSON array');
  const keys = creds.filter(
    (c) => c && c.integrationID === integration && c.value && c.value.type === 'key' && typeof c.value.key === 'string' && c.value.key.length > 0,
  );
  const active = keys.find((c) => c.active) ?? keys[0];
  if (!active) {
    throw new Error(
      `No active ${integration} API key in OpenCode. Run \`opencode auth login\` (or /connect) and select OpenCode Go, then try again.`,
    );
  }
  return active.value.key;
}

export function readKey(integration = DEFAULT_INTEGRATION) {
  let raw;
  try {
    raw = execFileSync('opencode', ['auth', 'export'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = e && typeof e === 'object' && 'stderr' in e ? String(e.stderr).trim() : String(e);
    throw new Error(`Could not read OpenCode credentials (is the opencode CLI installed and logged in?): ${detail}`);
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error('opencode auth export did not return valid JSON');
  }
  return extractKey(creds, integration);
}

/** The environment for the Foreman and every Claude Code process it spawns. */
export function buildEnv(opts, baseEnv = process.env, keyReader = readKey) {
  const env = { ...baseEnv };
  if (opts.backend === 'sim') return env;

  const leadModel = opts.leadModel ?? opts.model ?? env.AGENTCRAFT_LEAD_MODEL ?? DEFAULT_LEAD_MODEL;
  const workerModel = opts.workerModel ?? opts.model ?? env.AGENTCRAFT_WORKER_MODEL ?? DEFAULT_WORKER_MODEL;
  const baseUrl = opts.baseUrl ?? env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;

  let token = env.ANTHROPIC_AUTH_TOKEN;
  if (!token) token = keyReader(opts.integration ?? DEFAULT_INTEGRATION);

  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // Stale Anthropic aliases must not leak into a Go session.
  delete env.ANTHROPIC_MODEL;
  delete env.ANTHROPIC_SMALL_FAST_MODEL;

  env.ANTHROPIC_DEFAULT_OPUS_MODEL = leadModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = workerModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? DEFAULT_HAIKU_MODEL;

  env.AGENTCRAFT_LEAD_MODEL = leadModel;
  env.AGENTCRAFT_WORKER_MODEL = workerModel;
  env.AGENTCRAFT_OPENCODE_GO = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? '1';

  if (opts.workers) env.AGENTCRAFT_WORKERS = opts.workers;

  if (opts.noPerAgentModels || opts.model) {
    delete env.AGENTCRAFT_CLAUDE_MODELS;
  } else if (opts.claudeModels) {
    env.AGENTCRAFT_CLAUDE_MODELS = opts.claudeModels;
  } else if (!env.AGENTCRAFT_CLAUDE_MODELS) {
    env.AGENTCRAFT_CLAUDE_MODELS = Object.entries(DEFAULT_MODELS_BY_AGENT)
      .map(([agent, model]) => `${agent}=${model}`)
      .join(',');
  }
  return env;
}

/** Arguments for tools/unix.mjs. Foreman-only flags become --foreman-arg pairs. */
export function buildUnixArgs(opts) {
  const args = ['launch', '--backend', opts.backend];
  for (const repo of opts.repos) args.push('--repo', repo);
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.home) args.push('--home', opts.home);
  if (opts.port) args.push('--port', String(opts.port));
  if (opts.noGame) args.push('--no-game');
  if (opts.noWait) args.push('--no-wait');
  if (opts.dev) args.push('--dev');
  if (opts.reset) args.push('--reset');
  const foreman = (flag, value) => {
    if (value !== undefined) args.push('--foreman-arg', flag, '--foreman-arg', String(value));
  };
  foreman('--max-concurrent', opts.maxConcurrent);
  foreman('--effort', opts.effort);
  foreman('--max-turns', opts.maxTurns);
  foreman('--max-turns-lead', opts.maxTurnsLead);
  foreman('--max-turns-worker', opts.maxTurnsWorker);
  for (const value of opts.foremanArgs) args.push('--foreman-arg', value);
  return args;
}

const REDACTED = '<redacted>';

/** The launcher needs Java 25; find one even when the system JDK is newer. */
export function findJava25(baseEnv = process.env) {
  const candidates = [];
  if (baseEnv.JAVA_HOME) candidates.push(baseEnv.JAVA_HOME);
  const mise = path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'java');
  try {
    for (const name of fs.readdirSync(mise)) if (/25/.test(name)) candidates.push(path.join(mise, name));
  } catch {
    /* no mise */
  }
  candidates.push('/usr/lib/jvm/java-25-openjdk', '/usr/lib/jvm/java-25-openjdk-amd64', '/usr/lib/jvm/java-25-openjdk-arm64');
  for (const candidate of candidates) {
    const java = path.join(candidate, 'bin', 'java');
    if (!fs.existsSync(java)) continue;
    const r = spawnSync(java, ['-version'], { encoding: 'utf8' });
    if (/version "25[.\"]/.test(`${r.stdout}${r.stderr}`)) return candidate;
  }
  return undefined;
}

export function describeEnv(env) {
  const keys = [
    'JAVA_HOME',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'AGENTCRAFT_LEAD_MODEL',
    'AGENTCRAFT_WORKER_MODEL',
    'AGENTCRAFT_CLAUDE_MODELS',
    'AGENTCRAFT_WORKERS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ];
  return keys
    .filter((k) => env[k] !== undefined)
    .map((k) => `${k}=${k === 'ANTHROPIC_AUTH_TOKEN' ? REDACTED : env[k]}`)
    .join('\n');
}

function help() {
  return `AgentCraft with OpenCode Go

usage: tools/launch-opencode.mjs [options]

Reads the active OpenCode Go API key from \`opencode auth export\` and launches
tools/unix.mjs with an Anthropic-compatible gateway. The key is never printed.

options:
  --repo <path>              repo to register (repeatable)
  --backend <claude|sim>     backend (default claude)
  --profile <name>           state profile under the home directory
  --home <dir>               state root (default ~/.agentcraft)
  --port <n>                 Foreman port (default 7878)
  --model <id>               one model for lead and every worker
  --lead-model <id>          lead model (default ${DEFAULT_LEAD_MODEL})
  --worker-model <id>        fallback worker model (default ${DEFAULT_WORKER_MODEL})
  --claude-models <list>     per-agent overrides, e.g. kit=kimi-k2.7-code,juniper=muse-spark-1.3-contributor
  --no-per-agent-models      use --worker-model for every worker
  --workers <n|ids>          team size or comma list (default: Foreman default)
  --max-concurrent <n>       workers running at once
  --effort <level>           low|medium|high|xhigh|max
  --max-turns <n>            cap per turn
  --base-url <url>           override the gateway (default ${DEFAULT_BASE_URL})
  --integration <id>         OpenCode auth integration (default ${DEFAULT_INTEGRATION})
  --no-game                  start only the Foreman
  --no-wait                  return immediately while Minecraft builds
  --dev                      muted client
  --reset                    wipe the profile state
  --foreman-arg <arg>        extra Foreman argument (repeatable)
  --dry-run                  print the resolved config and command; do not start
  --help                     this text

Java 25 is required (the launcher rejects newer system JDKs). The wrapper uses
JAVA_HOME when it points at Java 25, otherwise it looks in a mise Java install
or /usr/lib/jvm/java-25-openjdk.

Default team:
  Marlow   ${DEFAULT_MODELS_BY_AGENT.marlow}
  Juniper  ${DEFAULT_MODELS_BY_AGENT.juniper}
  Kit      ${DEFAULT_MODELS_BY_AGENT.kit}
  Wren     ${DEFAULT_MODELS_BY_AGENT.wren}
  Rowan    ${DEFAULT_MODELS_BY_AGENT.rowan}
  Tove     ${DEFAULT_MODELS_BY_AGENT.tove}

examples:
  tools/launch-opencode.mjs --dry-run
  tools/launch-opencode.mjs --repo ~/src/my-project --workers juniper
  tools/launch-opencode.mjs --repo ~/src/my-project --model deepseek-v4.1-flash
  tools/launch-opencode.mjs --repo ~/src/my-project --claude-models kit=kimi-k2.7-code,juniper=muse-spark-1.3-contributor
`;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(help());
    return 0;
  }
  const env = buildEnv(opts);
  const javaHome = findJava25(env);
  if (javaHome) env.JAVA_HOME = javaHome;
  const args = buildUnixArgs(opts);
  if (opts.dryRun) {
    process.stdout.write(`AgentCraft + OpenCode Go\n${describeEnv(env)}\n\ncommand: ${process.execPath} ${path.join(ROOT, 'tools', 'unix.mjs')} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    return 0;
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'unix.mjs'), ...args], { stdio: 'inherit', env });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    });
  }
  child.on('exit', (code) => process.exit(code ?? 1));
  return undefined;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`agentcraft-opencode: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
