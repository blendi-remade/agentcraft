// A process-level app-server fixture. Never imports a model SDK or invokes Codex.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.159.2\n'); process.exit(0); }

const mode = process.env.AGENTCRAFT_FAKE_CODEX_MODE ?? 'complete';
const trace = process.env.AGENTCRAFT_FAKE_CODEX_TRACE;
const threadId = '019a0000-0000-7000-8000-000000000001';
const turnId = '019a0000-0000-7000-8000-000000000002';
const toolRequestId = 'fake-tool-request';
const record = (value) => { if (trace) fs.appendFileSync(trace, JSON.stringify(value) + '\n'); };
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ id, result: value });
const notify = (method, params) => send({ method, params });
const turn = (status) => ({ id: turnId, items: [], itemsView: 'full', status, error: null, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: status === 'inProgress' ? null : 1000 });
let toolName;
let initialized = false;
let turnStarted = false;
record({ event: 'spawn', pid: process.pid, args: process.argv.slice(2) });

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  record({ event: 'received', message });
  if (!message.method) {
    if (message.id === toolRequestId) {
      if (!message.result?.success) {
        record({ event: 'tool-failed', response: message });
        process.exit(24);
      }
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'message-1', delta: 'Fixture completed.' });
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'message-1', text: 'Fixture completed.', phase: 'final_answer' } });
      notify('turn/completed', { threadId, turn: turn('completed') });
    }
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case 'initialize': {
      const reply = JSON.stringify({ id, result: { userAgent: 'codex-cli/0.159.2', codexHome: '/fake/codex-home', platformFamily: 'unix', platformOs: 'linux' } }) + '\n';
      // Exercise JSONL framing with a response split across writes.
      process.stdout.write(reply.slice(0, 13));
      setTimeout(() => process.stdout.write(reply.slice(13)), 5);
      break;
    }
    case 'initialized': initialized = true; break;
    case 'config/read':
      result(id, { config: { mcp_servers: {}, features: {}, shell_environment_policy: { inherit: 'all', ignore_default_excludes: false, exclude: [], set: {}, include_only: [] } }, origins: {}, layers: [] });
      break;
    case 'account/read':
      result(id, { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true });
      break;
    case 'thread/start':
    case 'thread/resume': {
      if (!initialized) { send({ id, error: { code: -32600, message: 'initialized notification missing' } }); break; }
      toolName = params.dynamicTools?.find((tool) => /send_message$/.test(tool.name))?.name ?? 'mcp__agentcraft__send_message';
      result(id, {
        thread: { id: threadId, sessionId: threadId, turns: [], status: { type: 'idle' }, cwd: params.cwd, modelProvider: 'openai', ephemeral: false },
        model: 'fixture-model', modelProvider: 'openai', serviceTier: null, disabledPluginIds: [], cwd: params.cwd,
        runtimeWorkspaceRoots: [params.cwd], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
        sandbox: params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
        activePermissionProfile: null, reasoningEffort: 'medium', multiAgentMode: 'explicitRequestOnly',
      });
      break;
    }
    case 'turn/start':
      turnStarted = true;
      result(id, { turn: turn('inProgress') });
      notify('turn/started', { threadId, turn: turn('inProgress') });
      if (mode === 'eof') { setImmediate(() => process.exit(23)); break; }
      if (mode === 'eof-orphan') {
        // Same process group as this server, but independent stdio and a timer that outlives it.
        // The driver's cleanup, not a broken stdout pipe, must stop these writes.
        const output = process.env.AGENTCRAFT_FAKE_CODEX_WRITER;
        const script = `const fs = require('node:fs'); const out = process.argv[1];
          fs.appendFileSync(out, 'started\\n');
          setInterval(() => fs.appendFileSync(out, 'tick\\n'), 20);
          setTimeout(() => process.exit(0), 30000);
          process.send({ ready: true });`;
        const writer = spawn(process.execPath, ['-e', script, output], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        writer.once('message', () => {
          const created = spawnSync('ps', ['-p', String(writer.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
          record({ event: 'orphan', pid: writer.pid, ppid: process.pid, created, output });
          process.exit(23);
        });
        break;
      }
      if (mode === 'hang') break;
      send({ id: toolRequestId, method: 'item/tool/call', params: { threadId, turnId, callId: 'call-real-process', namespace: null, tool: toolName, arguments: { to: 'user', text: 'Hello from the fake Codex process.' } } });
      break;
    case 'turn/interrupt':
      result(id, {});
      if (turnStarted) notify('turn/completed', { threadId, turn: turn('interrupted') });
      break;
    default:
      send({ id, error: { code: -32601, message: `Fixture does not implement ${method}` } });
  }
});
input.on('close', () => process.exit(0));
