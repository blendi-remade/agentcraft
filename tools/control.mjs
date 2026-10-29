#!/usr/bin/env node
// AgentCraft Control: one program that runs everything and a web dashboard to drive it.
//
//   node tools/control.mjs                 dashboard on http://127.0.0.1:8045, Foreman started from the saved settings
//   node tools/control.mjs --port 8045 --no-open --no-autostart
//   node tools/control.mjs --lan           also reachable from your network (phone/tablet), token required
//
// What it does
//  - starts, stops and restarts the Foreman (its own child process, log in artifacts/logs/control-foreman-<profile>.log)
//    or attaches to one that is already running for the profile
//  - starts and stops Minecraft through the platform launcher (tools/unix.mjs, tools/launch.ps1) and
//    tells you whether the game is connected ("waiting for Minecraft")
//  - relays the Foreman protocol to the dashboard: chat, goals, agents, tasks, decisions, diffs, memory
//  - edits ~/.agentcraft/config.json (language, skills, plugins, MCP servers) from the settings page
//
// Security: binds 127.0.0.1 by default. Every API call and the WebSocket need the per-run token that
// is embedded in the page, the Host must be a loopback name and the Origin this server, so another
// web page cannot drive your agents. --lan binds every interface and then also requires the token
// on the page itself (open the printed URL).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'tools');
const webDir = path.join(tools, 'dashboard');
const logDir = path.join(root, 'artifacts', 'logs');
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
};

// ---- options ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { port: Number(process.env.AGENTCRAFT_CONTROL_PORT || 8045), open: true, autostart: undefined, lan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--no-open') out.open = false;
    else if (a === '--no-autostart') out.autostart = false;
    else if (a === '--autostart') out.autostart = true;
    else if (a === '--lan') out.lan = true;
    else if (a === '--home') out.home = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/control.mjs [--port 8045] [--home DIR] [--no-open] [--no-autostart] [--lan]');
      process.exit(0);
    } else {
      console.error(`unknown option ${a} (see --help)`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('bad --port');
  return out;
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = isMain ? parseArgs(process.argv.slice(2)) : { port: 8045, open: false, lan: false };
const home = args.home ?? path.resolve(process.env.AGENTCRAFT_HOME || path.join(os.homedir(), '.agentcraft'));
const controlFile = path.join(home, 'control.json');
const foremanConfigFile = path.join(home, 'config.json');
const token = crypto.randomBytes(18).toString('base64url');

/** Launch settings the dashboard edits (control.json). The Foreman's own options live in config.json. */
const DEFAULTS = {
  backend: 'claude',
  profile: '',
  repos: [],
  useClaudeLogin: false,
  workers: '',
  model: '',
  foremanPort: 7878,
  devPort: 7879,
  extraArgs: '',
  autostartForeman: true,
  autostartGame: false,
  dev: false,
};

function loadSettings() {
  return { ...DEFAULTS, ...(readJson(controlFile) ?? {}) };
}
let settings = loadSettings();
const profileOf = (s) => s.profile || s.backend;

// ---- small helpers ------------------------------------------------------------------------------

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Split a command-line string like a shell would for simple cases: spaces, "double" and 'single' quotes. */
export function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s ?? ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class Ring {
  constructor(max = 600) { this.max = max; this.lines = []; }
  push(line) { this.lines.push(line); if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max); }
}

function installDeps(dir) {
  const lock = path.join(dir, 'package-lock.json');
  const stamp = path.join(dir, 'node_modules', '.package-lock.json');
  if (fs.existsSync(stamp) && fs.statSync(stamp).mtimeMs >= fs.statSync(lock).mtimeMs - 2000) return;
  log('system', `npm ci in ${path.relative(root, dir)}/ (first run) ...`);
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) throw new Error(`npm ci failed in ${dir}`);
}

// ---- event fan-out to dashboards -----------------------------------------------------------------

const browsers = new Set();
function toBrowsers(msg) {
  const s = JSON.stringify(msg);
  for (const b of browsers) if (b.ws.readyState === WebSocket.OPEN) b.ws.send(s);
}

const logs = { foreman: new Ring(), game: new Ring(), system: new Ring(200) };
function log(source, line) {
  const entry = { ts: Date.now(), line: String(line).replace(/\s+$/, '') };
  logs[source].push(entry);
  if (source === 'system') console.log(`[control] ${entry.line}`);
  toBrowsers({ type: 'control.log', source, entries: [entry] });
}

// ---- Foreman process ----------------------------------------------------------------------------

const foreman = {
  child: null,
  /** a Foreman we did not start but found running for the profile */
  external: null,
  startedAt: 0,
  state: 'stopped', // stopped | starting | running | stopping | external
  lastExit: '',
};

function foremanRunFile() {
  return path.join(home, profileOf(settings), 'foreman.json');
}

async function findExternalForeman() {
  const info = readJson(foremanRunFile());
  if (info && pidAlive(info.pid) && (await portOpen(info.port))) return info;
  return null;
}

function foremanArgs() {
  const a = ['--import', 'tsx', 'src/main.ts', '--backend', settings.backend, '--profile', profileOf(settings), '--home', home, '--port', String(settings.foremanPort)];
  const repos = (settings.repos ?? []).filter(Boolean);
  if (repos.length) a.push('--repo', repos.join(','));
  if (settings.useClaudeLogin) a.push('--use-claude-login');
  if (settings.workers) a.push('--workers', settings.workers);
  if (settings.model) a.push('--model', settings.model);
  if (settings.dev) a.push('--no-notify');
  a.push(...splitArgs(settings.extraArgs));
  return a;
}

async function startForeman() {
  if (foreman.child || foreman.state === 'starting') return;
  const ext = await findExternalForeman();
  if (ext) {
    foreman.external = ext;
    foreman.state = 'external';
    settings.foremanPort = ext.port;
    log('system', `attached to the running Foreman pid ${ext.pid} on :${ext.port}`);
    publishStatus();
    upstream.connect();
    return;
  }
  if (await portOpen(settings.foremanPort)) throw new Error(`port ${settings.foremanPort} is in use by another program`);
  for (const repo of settings.repos ?? []) {
    if (repo && !fs.existsSync(path.join(repo, '.git'))) throw new Error(`not a git repository root: ${repo}`);
  }
  installDeps(path.join(root, 'foreman'));
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `control-foreman-${profileOf(settings)}.log`);
  const out = fs.createWriteStream(file, { flags: 'a' });
  const argv = foremanArgs();
  log('system', `starting Foreman: node ${argv.join(' ')}`);
  const child = spawn(process.execPath, argv, {
    cwd: path.join(root, 'foreman'),
    env: { ...process.env, AGENTCRAFT_HOME: home, AGENTCRAFT_STDIN_QUIT: '1', FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  foreman.child = child;
  foreman.external = null;
  foreman.state = 'starting';
  foreman.startedAt = Date.now();
  publishStatus();
  const onData = (buf) => {
    out.write(buf);
    for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) log('foreman', line);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => log('system', `Foreman could not start: ${e.message}`));
  child.on('exit', (code, signal) => {
    out.end();
    foreman.child = null;
    foreman.lastExit = signal ? `signal ${signal}` : `exit code ${code}`;
    foreman.state = 'stopped';
    log('system', `Foreman stopped (${foreman.lastExit})`);
    upstream.disconnect();
    publishStatus();
  });
  // ready when the port answers
  for (let i = 0; i < 240 && foreman.child === child; i++) {
    if (await portOpen(settings.foremanPort)) {
      foreman.state = 'running';
      publishStatus();
      upstream.connect();
      return;
    }
    await sleep(500);
  }
}

async function stopForeman() {
  if (foreman.state === 'external' && foreman.external) {
    // not ours: ask it to quit the way Ctrl+C would
    log('system', `stopping the external Foreman pid ${foreman.external.pid}`);
    try { process.kill(foreman.external.pid, 'SIGTERM'); } catch (e) { log('system', `could not stop it: ${e.message}`); }
    for (let i = 0; i < 40 && pidAlive(foreman.external.pid); i++) await sleep(250);
    foreman.external = null;
    foreman.state = 'stopped';
    upstream.disconnect();
    publishStatus();
    return;
  }
  const child = foreman.child;
  if (!child) return;
  foreman.state = 'stopping';
  publishStatus();
  // "q" + Enter: the Foreman saves its state and ends every agent turn (works on Windows too)
  try { child.stdin.write('q\n'); } catch { /* closed */ }
  for (let i = 0; i < 48 && foreman.child === child; i++) await sleep(250);
  if (foreman.child === child) {
    log('system', 'Foreman did not quit in time: terminating it');
    try { child.kill(isWin ? undefined : 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 20 && foreman.child === child; i++) await sleep(250);
    if (foreman.child === child) try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

async function restartForeman() {
  await stopForeman();
  await sleep(300);
  await startForeman();
}

// ---- upstream WebSocket to the Foreman ------------------------------------------------------------

/** One connection per dashboard tab would also work; one shared link keeps the Foreman's client list honest. */
const upstream = {
  ws: null,
  up: false,
  wanted: false,
  retry: null,
  /** the last snapshot plus every upsert since, so a new tab gets the full state at once */
  snapshot: null,
  connect() {
    this.wanted = true;
    if (this.ws) return;
    const ws = new WebSocket(`ws://127.0.0.1:${settings.foremanPort}`);
    this.ws = ws;
    ws.on('open', () => {
      this.up = true;
      ws.send(JSON.stringify({ v: 1, type: 'hello', modVersion: 'control', protocol: 1, client: 'dashboard' }));
      publishStatus();
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'snapshot') this.snapshot = msg;
      else if (this.snapshot) applyToSnapshot(this.snapshot, msg);
      if (msg.type === 'foreman.status') publishStatus();
      // replies addressed to one tab (ack/diff/error with re) carry its routing tag
      const target = routeOf(msg);
      if (target) {
        const b = [...browsers].find((x) => x.id === target.tab);
        if (b && b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify(target.msg));
        return;
      }
      toBrowsers({ type: 'foreman', msg });
    });
    const gone = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.up;
      this.up = false;
      if (was) publishStatus();
      if (this.wanted) {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.connect(), 2000);
      }
    };
    ws.on('close', gone);
    ws.on('error', () => { /* close follows */ });
  },
  disconnect() {
    this.wanted = false;
    clearTimeout(this.retry);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.up = false;
    this.snapshot = null;
    toBrowsers({ type: 'foreman', msg: { type: 'offline' } });
  },
  send(msg) {
    if (!this.ws || !this.up) return false;
    this.ws.send(JSON.stringify({ v: 1, ...msg }));
    return true;
  },
};

/** Keep the cached snapshot current so a newly opened tab sees the live state. */
function applyToSnapshot(s, m) {
  const upsert = (list, item, key = 'id') => {
    const i = list.findIndex((x) => x[key] === item[key]);
    if (i >= 0) list[i] = item; else list.push(item);
  };
  switch (m.type) {
    case 'agent.upsert': upsert(s.agents, m.agent); break;
    case 'task.upsert': upsert(s.tasks, m.task); break;
    case 'decision.upsert': upsert(s.decisions, m.decision); break;
    case 'repo.upsert': upsert(s.repos, m.repo); break;
    case 'memory.upsert': upsert(s.memory, m.entry); break;
    case 'goal.upsert': upsert(s.goals, m.goal); s.goal = s.goals[s.goals.length - 1]; break;
    case 'feed.add': s.feed.push(m.item); if (s.feed.length > 400) s.feed.splice(0, s.feed.length - 400); break;
    case 'foreman.status': s.foreman = m.status; break;
    case 'agent.log': {
      let l = s.logs.find((x) => x.agentId === m.agentId);
      if (!l) s.logs.push((l = { agentId: m.agentId, entries: [] }));
      l.entries.push(...m.entries);
      if (l.entries.length > 300) l.entries.splice(0, l.entries.length - 300);
      break;
    }
    default:
  }
}

// request ids are prefixed with the tab id: "<tab>:<id>"
function routeOf(msg) {
  const re = msg.re ?? msg.requestId;
  if (typeof re !== 'string') return null;
  const m = /^tab(\d+):(.*)$/.exec(re);
  if (!m) return null;
  const copy = { ...msg };
  if (msg.re !== undefined) copy.re = m[2];
  if (msg.requestId !== undefined) copy.requestId = m[2];
  return { tab: Number(m[1]), msg: { type: 'foreman', msg: copy } };
}

// ---- Minecraft -----------------------------------------------------------------------------------

const game = { state: 'stopped', launcher: null, since: 0 };

function gameLogFile() {
  return path.join(logDir, isWin ? 'game.log' : 'unix-game.log');
}

function launcherCommand(action) {
  const prof = profileOf(settings);
  if (isWin) {
    const ps = action === 'start'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'launch.ps1'), '-NoForeman', '-NoWait', '-Backend', settings.backend, '-Profile', prof, '-Home', home, '-Port', String(settings.foremanPort), '-DevPort', String(settings.devPort), ...(settings.dev ? ['-Dev'] : [])]
      : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'stop.ps1'), '-Game', '-Profile', prof, '-Home', home];
    return ['powershell.exe', ps];
  }
  const a = action === 'start'
    ? ['launch', '--no-foreman', '--no-wait', '--backend', settings.backend, '--profile', prof, '--home', home, '--port', String(settings.foremanPort), '--dev-port', String(settings.devPort), ...(settings.dev ? ['--dev'] : [])]
    : ['stop', '--game', '--profile', prof];
  return [process.execPath, [path.join(tools, 'unix.mjs'), ...a]];
}

function runLauncher(action) {
  return new Promise((resolve) => {
    const [cmd, argv] = launcherCommand(action);
    log('system', `${action === 'start' ? 'starting' : 'stopping'} Minecraft: ${path.basename(cmd)} ${argv.slice(-12).join(' ')}`);
    const child = spawn(cmd, argv, { cwd: root, windowsHide: true, env: { ...process.env, AGENTCRAFT_HOME: home } });
    const onData = (buf) => { for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) log('game', line); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { log('system', `launcher failed: ${e.message}`); resolve(false); });
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function startGame() {
  if (game.state === 'starting' || game.state === 'running') return;
  game.state = 'starting';
  game.since = Date.now();
  publishStatus();
  const ok = await runLauncher('start');
  if (!ok) {
    game.state = 'stopped';
    log('system', 'Minecraft launcher reported an error (see the game log)');
  }
  publishStatus();
}

async function stopGame() {
  game.state = 'stopping';
  publishStatus();
  await runLauncher('stop');
  game.state = 'stopped';
  publishStatus();
}

/** Follow the game log file the launcher writes (it runs detached). */
let gameLogPos = -1;
function pollGameLog() {
  const file = gameLogFile();
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (gameLogPos < 0 || st.size < gameLogPos) gameLogPos = Math.max(0, st.size - 32 * 1024);
  if (st.size === gameLogPos) return;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(st.size - gameLogPos, 256 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, gameLogPos);
  fs.closeSync(fd);
  gameLogPos += len;
  for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) log('game', line);
}

async function refreshGame() {
  const clients = upstream.snapshot?.foreman?.clients ?? [];
  const connected = clients.includes('mod');
  const bridge = await portOpen(settings.devPort);
  const before = game.state;
  if (connected) game.state = 'running';
  else if (bridge) game.state = 'waiting'; // the game runs but has not connected to the Foreman yet
  else if (game.state === 'running' || game.state === 'waiting') game.state = 'stopped';
  else if (game.state === 'starting' && Date.now() - game.since > 15 * 60_000) game.state = 'stopped';
  if (before !== game.state) publishStatus();
}

// ---- status ---------------------------------------------------------------------------------------

function statusMessage() {
  return {
    type: 'control.status',
    foreman: {
      state: foreman.state,
      pid: foreman.child?.pid ?? foreman.external?.pid ?? null,
      startedAt: foreman.startedAt,
      lastExit: foreman.lastExit,
      linked: upstream.up,
      port: settings.foremanPort,
    },
    game: { state: game.state, devPort: settings.devPort },
    settings,
    profile: profileOf(settings),
    home,
    platform: process.platform,
  };
}
function publishStatus() {
  toBrowsers(statusMessage());
}

// ---- Foreman config.json (language, skills, MCP) ---------------------------------------------------

function readForemanConfig() {
  return readJson(foremanConfigFile) ?? {};
}

/** Only the keys the dashboard owns are changed; everything else in config.json stays as it is. */
function saveForemanConfig(patch) {
  const cur = readForemanConfig();
  const next = { ...cur };
  if ('language' in patch) next.language = patch.language;
  if ('userName' in patch) {
    if (patch.userName) next.userName = patch.userName;
    else delete next.userName;
  }
  if ('stallMinutes' in patch) next['stall-minutes'] = Number(patch.stallMinutes);
  if ('stallAction' in patch) next['stall-action'] = patch.stallAction;
  if ('models' in patch) {
    const models = Object.fromEntries(Object.entries(patch.models ?? {}).filter(([k, v]) => /^[\w-]+$/.test(k) && typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
    if (Object.keys(models).length) next.models = models;
    else delete next.models;
  }
  const empty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
  const section = (name, keys, from) => {
    const out = { ...(cur[name] ?? {}) };
    for (const k of keys) {
      if (!(k in from)) continue;
      if (empty(from[k])) delete out[k];
      else out[k] = from[k];
    }
    next[name] = out;
  };
  section('claude', ['skills', 'userSettings', 'plugins', 'mcp', 'mcpServers', 'trustedMcp'], patch.claude ?? {});
  section('codex', ['skills', 'mcp'], patch.codex ?? {});
  writeJson(foremanConfigFile, next);
  return next;
}

/** Skills and MCP servers each engine already has, found by the Foreman's own code (src/skills.ts). */
function discover() {
  const argv = ['--import', 'tsx', 'scripts/discover.ts'];
  for (const r of settings.repos ?? []) if (r) argv.push('--repo', r);
  const r = spawnSync(process.execPath, argv, { cwd: path.join(root, 'foreman'), encoding: 'utf8', timeout: 20_000, windowsHide: true });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: (r.stderr || r.error?.message || 'discovery failed').slice(0, 400), claude: { skills: [], mcp: [] }, codex: { skills: [], mcp: [] } };
  }
}

// ---- HTTP + dashboard WebSocket --------------------------------------------------------------------

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function hostOk(req) {
  return args.lan || LOOPBACK_HOST.test(req.headers.host ?? '');
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin GET/fetch without Origin, curl
  try {
    const u = new URL(o);
    return u.host === req.headers.host;
  } catch {
    return false;
  }
}
function tokenOf(req) {
  const u = new URL(req.url, 'http://x');
  return req.headers['x-agentcraft-token'] ?? u.searchParams.get('t') ?? /(?:^|;\s*)ac_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function api(req, res, pathname) {
  if (tokenOf(req) !== token) return sendJson(res, 403, { error: 'bad token' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'bad origin' });
  const body = req.method === 'POST' ? await readBody(req) : {};
  switch (`${req.method} ${pathname}`) {
    case 'GET /api/status': return sendJson(res, 200, statusMessage());
    case 'POST /api/foreman/start': await startForeman(); return sendJson(res, 200, { ok: true });
    case 'POST /api/foreman/stop': await stopForeman(); return sendJson(res, 200, { ok: true });
    case 'POST /api/foreman/restart': await restartForeman(); return sendJson(res, 200, { ok: true });
    case 'POST /api/foreman/reconnect': upstream.disconnect(); upstream.connect(); return sendJson(res, 200, { ok: true });
    case 'POST /api/game/start': void startGame(); return sendJson(res, 200, { ok: true });
    case 'POST /api/game/stop': await stopGame(); return sendJson(res, 200, { ok: true });
    case 'POST /api/all/start':
      await startForeman();
      void startGame();
      return sendJson(res, 200, { ok: true });
    case 'POST /api/all/stop':
      await stopGame();
      await stopForeman();
      return sendJson(res, 200, { ok: true });
    case 'POST /api/settings': {
      const allowed = Object.keys(DEFAULTS);
      for (const k of Object.keys(body)) if (allowed.includes(k)) settings[k] = body[k];
      if (typeof settings.repos === 'string') settings.repos = settings.repos.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      settings.foremanPort = Number(settings.foremanPort) || 7878;
      settings.devPort = Number(settings.devPort) || 7879;
      writeJson(controlFile, settings);
      publishStatus();
      return sendJson(res, 200, { ok: true, settings });
    }
    case 'GET /api/config': return sendJson(res, 200, { config: readForemanConfig(), file: foremanConfigFile, found: discover() });
    case 'POST /api/config': return sendJson(res, 200, { ok: true, config: saveForemanConfig(body) });
    case 'GET /api/logs': return sendJson(res, 200, { foreman: logs.foreman.lines, game: logs.game.lines, system: logs.system.lines });
    default: return sendJson(res, 404, { error: 'no such endpoint' });
  }
}

function serveStatic(req, res, pathname) {
  if (args.lan && tokenOf(req) !== token) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Open the URL printed by AgentCraft Control (it carries the access token).');
  }
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(webDir, rel);
  if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = Buffer.from(body.toString('utf8').replace('__AC_TOKEN__', token));
  const headers = { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  // the token travels as a cookie too, so a reload after ?t= keeps working in --lan mode
  if (rel === 'index.html') {
    headers['set-cookie'] = `ac_token=${token}; Path=/; SameSite=Strict; HttpOnly`;
    headers['x-frame-options'] = 'DENY';
  }
  res.writeHead(200, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (!hostOk(req)) {
    res.writeHead(403);
    return res.end('bad host');
  }
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/')) {
    api(req, res, pathname).catch((e) => sendJson(res, 500, { error: e.message }));
    return;
  }
  serveStatic(req, res, pathname);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
let nextTab = 1;
server.on('upgrade', (req, socket, head) => {
  if (!hostOk(req) || !originOk(req) || tokenOf(req) !== token) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onBrowser(ws));
});

function onBrowser(ws) {
  const b = { ws, id: nextTab++ };
  browsers.add(b);
  ws.send(JSON.stringify(statusMessage()));
  ws.send(JSON.stringify({ type: 'control.logs', foreman: logs.foreman.lines, game: logs.game.lines, system: logs.system.lines }));
  if (upstream.snapshot) ws.send(JSON.stringify({ type: 'foreman', msg: upstream.snapshot }));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.type === 'foreman.send' && msg.msg && typeof msg.msg.type === 'string' && msg.msg.type !== 'hello') {
      const out = { ...msg.msg };
      if (typeof out.id === 'string') out.id = `tab${b.id}:${out.id}`;
      if (typeof out.requestId === 'string') out.requestId = `tab${b.id}:${out.requestId}`;
      if (!upstream.send(out) && typeof msg.msg.id === 'string') {
        ws.send(JSON.stringify({ type: 'foreman', msg: { type: 'ack', re: msg.msg.id, ok: false, error: 'Foreman is offline' } }));
      }
    }
  });
  ws.on('close', () => browsers.delete(b));
  ws.on('error', () => {});
}

function openBrowser(url) {
  const [cmd, argv] = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, argv, { stdio: 'ignore', detached: true, windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch { /* no browser */ }
}

// ---- main -------------------------------------------------------------------------------------------

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ is required');
  const host = args.lan ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${args.port} is already in use (is AgentCraft Control already running? open http://127.0.0.1:${args.port})`) : e));
    server.listen(args.port, host, resolve);
  });
  const local = `http://127.0.0.1:${args.port}/`;
  console.log(`\n  AgentCraft Control  ${local}`);
  if (args.lan) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  on your network     http://${a.address}:${args.port}/?t=${token}`);
    }
  }
  console.log('  Ctrl+C stops the dashboard and the Foreman it started (the game keeps running).\n');
  setInterval(() => { pollGameLog(); void refreshGame(); }, 2000).unref();

  const autostart = args.autostart ?? settings.autostartForeman;
  if (autostart) {
    startForeman().then(() => { if (settings.autostartGame) void startGame(); }).catch((e) => log('system', `Foreman: ${e.message}`));
  } else {
    // attach to a Foreman that is already running, without starting one
    const ext = await findExternalForeman();
    if (ext) await startForeman().catch(() => undefined);
  }
  if (args.open) openBrowser(args.lan ? `${local}?t=${token}` : local);

  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    console.log('\n[control] shutting down ...');
    upstream.wanted = false;
    if (foreman.child) await stopForeman();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  if (isWin) process.on('SIGBREAK', quit);
}

if (isMain) {
  main().catch((e) => {
    console.error(`AgentCraft Control: ${e.message}`);
    process.exit(1);
  });
}
