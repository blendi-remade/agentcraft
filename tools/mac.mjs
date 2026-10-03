#!/usr/bin/env node
// macOS launcher for the Foreman and the Fabric development client.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'tools');
const runDir = path.join(root, 'artifacts', 'run');
const logDir = path.join(root, 'artifacts', 'logs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const saveJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const runFile = (kind, profile) => path.join(runDir, `mac-${kind}-${profile}.json`);

function usage(code = 0) {
  console.log(`AgentCraft macOS launcher
  node tools/mac.mjs launch [--backend sim|claude|codex] [--repo PATH] [--use-claude-login]
                            [--home PATH] [--profile NAME] [--port N] [--dev-port N]
                            [--dev] [--showcase busy|late] [--reset]
                            [--no-game] [--no-foreman] [--no-wait]
                            [--summary-json PATH]
                            [--foreman-arg VALUE] (repeatable)
  node tools/mac.mjs stop [--game] [--foreman] [--profile NAME] [--stop-daemon]

Default: Claude backend, ~/.agentcraft, ports 7878/7879. --dev mutes the game,
keeps it from taking focus, and disables desktop notifications.`);
  process.exit(code);
}

function options(argv) {
  const out = { action: argv.shift(), repo: [], foremanArgs: [] };
  const values = new Set(['backend', 'repo', 'home', 'profile', 'port', 'dev-port', 'showcase', 'summary-json', 'foreman-arg']);
  const switches = new Set(['use-claude-login', 'dev', 'reset', 'no-game', 'no-foreman', 'no-wait', 'game', 'foreman', 'stop-daemon']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    if (values.has(key)) {
      if (!argv[i + 1]) throw new Error(`--${key} needs a value`);
      const value = argv[++i];
      if (key === 'repo') out.repo.push(path.resolve(value));
      else if (key === 'foreman-arg') out.foremanArgs.push(value);
      else out[key] = value;
    } else if (switches.has(key)) out[key] = true;
    else throw new Error(`unknown option: --${key}`);
  }
  if (!['launch', 'stop'].includes(out.action)) usage(out.action ? 2 : 0);
  out.backend ??= process.env.AGENTCRAFT_BACKEND || 'claude';
  if (out.showcase) {
    if (!['busy', 'late'].includes(out.showcase)) throw new Error('showcase must be busy or late');
    out.backend = 'sim';
    out.profile ??= out.showcase === 'late' ? 'showcase-late' : 'showcase';
  }
  if (!['sim', 'claude', 'codex'].includes(out.backend)) throw new Error('backend must be sim, claude or codex');
  out.profile ??= out.backend;
  if (!/^[\w-]+$/.test(out.profile)) throw new Error('profile must contain only letters, digits, _ or -');
  out.home = path.resolve(out.home ?? process.env.AGENTCRAFT_HOME ?? path.join(os.homedir(), '.agentcraft'));
  out.port = Number(out.port ?? process.env.AGENTCRAFT_PORT ?? 7878);
  out['dev-port'] = Number(out['dev-port'] ?? process.env.AGENTCRAFT_DEV_PORT ?? 7879);
  for (const port of [out.port, out['dev-port']]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
  }
  if (out.port === out['dev-port']) throw new Error('Foreman and DevBridge ports must differ');
  return out;
}

function processStamp(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function owned(info) { return info?.pid && info?.stamp && processStamp(info.pid) === info.stamp; }
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function waitPort(port, timeoutMs, info, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return;
    if (info && !owned(info)) throw new Error(`${name} exited; see ${info.log}`);
    await sleep(500);
  }
  throw new Error(`${name} did not start in time; see ${info?.log ?? 'its logs'}`);
}

function javaHome() {
  const candidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const java = path.join(candidate, 'bin', 'java');
    if (!fs.existsSync(java)) continue;
    const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
    if (/version "25[.\"]/.test(result.stderr + result.stdout)) return candidate;
  }
  throw new Error('Java 25 is required. Install it with: brew install openjdk@25');
}

function installDeps(dir) {
  const lock = path.join(dir, 'package-lock.json');
  const stamp = path.join(dir, 'node_modules', '.package-lock.json');
  if (fs.existsSync(stamp) && fs.statSync(stamp).mtimeMs >= fs.statSync(lock).mtimeMs - 2000) return;
  console.log(`Installing npm dependencies in ${path.relative(root, dir)}/ ...`);
  const result = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm ci failed in ${dir}`);
}

function start(command, args, cwd, log, env = {}) {
  const output = fs.openSync(log, 'a');
  const child = spawn(command, args, {
    cwd, env: { ...process.env, ...env }, detached: true,
    stdio: ['ignore', output, output],
  });
  child.on('error', () => {});
  fs.closeSync(output);
  child.unref();
  if (!child.pid) throw new Error(`could not start ${command}`);
  return { pid: child.pid, stamp: processStamp(child.pid), log, startedAt: new Date().toISOString() };
}

function runCli(script, args, timeout = 30000) {
  const result = spawnSync(process.execPath, [path.join(tools, script), ...args], { cwd: root, encoding: 'utf8', timeout });
  if (result.status !== 0) throw new Error(`${script}: ${result.stdout || result.stderr}`.trim());
  return result.stdout.trim();
}

function prepareAudio(dev) {
  const optionsFile = path.join(root, 'mod', 'run', 'options.txt');
  const savedFile = path.join(runDir, 'mac-audio.json');
  const template = path.join(root, 'mod', 'run-template', 'options.txt');
  const level = (text, name) => new RegExp(`^soundCategory_${name}:([^\\n]+)$`, 'm').exec(text)?.[1];
  const replace = (text, name, value) => text.replace(new RegExp(`^soundCategory_${name}:[^\\n]+$`, 'm'), `soundCategory_${name}:${value}`);
  if (!fs.existsSync(optionsFile) && dev) {
    saveJson(savedFile, { master: '1.0', music: level(fs.readFileSync(template, 'utf8'), 'music') });
    return;
  }
  if (!fs.existsSync(optionsFile) && !dev) {
    fs.mkdirSync(path.dirname(optionsFile), { recursive: true });
    fs.writeFileSync(optionsFile, replace(fs.readFileSync(template, 'utf8'), 'master', '1.0'));
  }
  if (!fs.existsSync(optionsFile)) return;
  let text = fs.readFileSync(optionsFile, 'utf8');
  if (dev) {
    if (!fs.existsSync(savedFile)) saveJson(savedFile, { master: level(text, 'master'), music: level(text, 'music') });
  } else {
    const saved = readJson(savedFile);
    if (saved) {
      if (level(text, 'master') === '0.0' && saved.master) text = replace(text, 'master', saved.master);
      if (level(text, 'music') === '0.0' && saved.music) text = replace(text, 'music', saved.music);
      fs.writeFileSync(optionsFile, text);
      fs.rmSync(savedFile, { force: true });
    }
  }
}

async function launch(opt, summary) {
  if (process.platform !== 'darwin') throw new Error('tools/mac.mjs is for macOS');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ is required');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  if (!opt['no-game']) javaHome();
  for (const repo of opt.repo) {
    if (!fs.existsSync(path.join(repo, '.git'))) throw new Error(`not a Git repository root: ${repo}`);
  }
  installDeps(tools);
  const fmFile = runFile('foreman', opt.profile);
  let fm = readJson(fmFile);
  let fmPort = opt.port;
  if (!opt['no-foreman']) {
    if (owned(fm) && await portOpen(fm.port)) {
      fmPort = fm.port;
      summary.foreman.port = fmPort;
      console.log(`Reusing Foreman ${fm.pid} on :${fmPort}`);
      if (fm.backend !== opt.backend) console.warn(`Foreman is already using backend ${fm.backend}`);
      for (const repo of opt.repo) console.log(runCli('foremancli.mjs', ['repo-add', repo, '--port', String(fmPort)]));
    } else {
      if (await portOpen(fmPort)) throw new Error(`port ${fmPort} is already in use`);
      installDeps(path.join(root, 'foreman'));
      const args = ['--import', 'tsx', 'src/main.ts', '--backend', opt.backend,
        '--profile', opt.profile, '--home', opt.home, '--port', String(fmPort)];
      for (const repo of opt.repo) args.push('--repo', repo);
      if (opt['use-claude-login']) args.push('--use-claude-login');
      if (opt.dev) args.push('--no-notify');
      if (opt.showcase) args.push('--showcase', opt.showcase);
      if (opt.reset || opt.showcase) args.push('--reset');
      args.push(...opt.foremanArgs);
      fm = { ...start(process.execPath, args, path.join(root, 'foreman'), path.join(logDir, `mac-foreman-${opt.profile}.log`)), backend: opt.backend, port: fmPort, home: opt.home };
      saveJson(fmFile, fm);
      summary.foreman.started = true;
      await waitPort(fmPort, 120000, fm, 'Foreman');
      console.log(`Foreman running on :${fmPort} (PID ${fm.pid})`);
    }
  } else if (!await portOpen(fmPort)) {
    console.warn(`No Foreman is listening on :${fmPort}; the game will retry connecting.`);
  }
  if (opt['no-game']) return;

  const gameFile = runFile('game', opt.profile);
  for (const name of fs.readdirSync(runDir).filter((name) => /^mac-game-[\w-]+\.json$/.test(name))) {
    const otherFile = path.join(runDir, name);
    if (otherFile !== gameFile && owned(readJson(otherFile))) {
      throw new Error(`another Minecraft client from this checkout is running (${name}); stop it before switching profiles`);
    }
  }
  let game = readJson(gameFile);
  if (owned(game)) {
    if (!await portOpen(game.devPort)) await waitPort(game.devPort, 600000, game, 'Minecraft');
    console.log(`Minecraft is already running (PID ${game.pid}, DevBridge :${game.devPort})`);
    summary.game.devPort = game.devPort;
    if (game.foremanPort !== fmPort) console.warn(`It was launched for Foreman :${game.foremanPort}; stop the game before switching ports.`);
    return;
  }
  if (await portOpen(opt['dev-port'])) throw new Error(`DevBridge port ${opt['dev-port']} is already in use`);
  prepareAudio(opt.dev);
  const gradleHome = process.env.GRADLE_USER_HOME || path.join(root, '.gradle-home');
  const env = {
    JAVA_HOME: javaHome(), GRADLE_USER_HOME: gradleHome,
    AGENTCRAFT_PORT: String(fmPort), AGENTCRAFT_DEV_PORT: String(opt['dev-port']),
    AGENTCRAFT_HOME: opt.home, AGENTCRAFT_PROFILE: opt.profile,
    AGENTCRAFT_MUTE: opt.dev ? '1' : '0', AGENTCRAFT_FOCUS: opt.dev ? '0' : '1',
  };
  game = { ...start('/bin/sh', [path.join(root, 'mod', 'gradlew'), 'runClient', '--console=plain'], path.join(root, 'mod'), path.join(logDir, 'mac-game.log'), env), devPort: opt['dev-port'], foremanPort: fmPort };
  saveJson(gameFile, game);
  summary.game.started = true;
  console.log(`Starting Minecraft (Gradle PID ${game.pid}); log: ${game.log}`);
  if (opt['no-wait']) return;
  await waitPort(game.devPort, 600000, game, 'Minecraft');
  console.log('Waiting for the studio world...');
  const state = JSON.parse(runCli('devcli.mjs', ['wait', '--port', String(game.devPort), '--timeout', '300'], 310000));
  console.log(`Studio ready: Minecraft ${state.minecraft}, world ${state.world?.name ?? 'unknown'}, Foreman ${state.foreman?.link ?? 'unknown'}`);
  console.log(`Ready. Stop with: node tools/mac.mjs stop --profile ${opt.profile}`);
}

async function stop(opt) {
  const kinds = opt.game ? ['game'] : opt.foreman ? ['foreman'] : ['game', 'foreman'];
  for (const kind of kinds) {
    const file = runFile(kind, opt.profile);
    const info = readJson(file);
    if (!owned(info)) { console.log(`${kind}: no launcher-owned process running`); continue; }
    if (kind === 'game' && await portOpen(info.devPort)) {
      try { console.log(runCli('devcli.mjs', ['quit', '--port', String(info.devPort), '--timeout', '20'])); }
      catch (error) { console.warn(error.message); }
    } else if (kind === 'foreman') {
      process.kill(info.pid, 'SIGTERM');
    }
    for (let i = 0; i < 40 && owned(info); i++) await sleep(250);
    if (owned(info)) {
      // launch made this PID a separate process group; only touch the recorded group.
      try { process.kill(-info.pid, 'SIGTERM'); } catch {}
      await sleep(1000);
      if (owned(info)) try { process.kill(-info.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(file, { force: true });
    console.log(`${kind}: stopped`);
  }
  if (opt['stop-daemon'] && kinds.includes('game')) {
    const localGradleHome = path.join(root, '.gradle-home');
    if (process.env.GRADLE_USER_HOME && path.resolve(process.env.GRADLE_USER_HOME) !== localGradleHome) {
      throw new Error('--stop-daemon requires this checkout\'s .gradle-home to avoid stopping other projects');
    }
    const env = { ...process.env, JAVA_HOME: javaHome(), GRADLE_USER_HOME: localGradleHome };
    const result = spawnSync('/bin/sh', [path.join(root, 'mod', 'gradlew'), '--stop'], { cwd: path.join(root, 'mod'), env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('could not stop the Gradle daemon');
  }
}

try {
  const opt = options(process.argv.slice(2));
  if (opt.action === 'launch') {
    const summary = { foreman: { started: false, port: opt.port }, game: { started: false, devPort: opt['dev-port'] } };
    try { await launch(opt, summary); }
    finally { if (opt['summary-json']) saveJson(path.resolve(opt['summary-json']), summary); }
  } else await stop(opt);
} catch (error) {
  console.error(`AgentCraft: ${error.message}`);
  process.exitCode = 1;
}
