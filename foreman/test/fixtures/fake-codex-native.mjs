// A scripted stand-in for `codex app-server` (tests). It speaks the JSON-RPC line protocol, plays
// one scenario turn per `turn/start` (the first turn in $FAKE_CODEX_SCENARIO whose `match` regex
// matches the prompt and whose `role` fits the thread), and appends every message it receives and
// every answer it gets to $FAKE_CODEX_LOG (one JSON object per line).
//
// Steps: { cmd, foreign?, output? }  run a shell command (asks for approval; foreign: from another thread)
//        { write: { file, content } } edit a file in the worktree (no approval: inside the sandbox)
//        { editOutside: path }        an edit outside the sandbox (asks for file-change approval)
//        { tool, args }               call a dynamic tool (the AgentCraft team tools)
//        { say }                      final answer text
//        { wait }                     sleep ms (to be interrupted)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const logFile = process.env.FAKE_CODEX_LOG;
const log = (o) => logFile && fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...o })}\n`);
log({ serverLocalAppData: process.env.LOCALAPPDATA });
let nextId = 1000;
const pending = new Map();
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ method, params });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const wrap = (cmd) => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${cmd.replace(/'/g, "''")}'`;

let thread = null;
let role = 'worker';
let cwd = process.cwd();
let interrupted = false;

async function play(params, turnId) {
  const text = params.input?.[0]?.text ?? '';
  const turn = scenario.turns.find((t) => (!t.role || t.role === role) && new RegExp(t.match).test(text)) ?? { steps: [] };
  log({ playing: turn.match ?? '(none)', role });
  for (const s of turn.steps) {
    if (interrupted) break;
    const itemId = `item-${nextId++}`;
    if (s.cmd) {
      const command = wrap(s.cmd);
      notify('item/started', { threadId: thread, turnId, item: { type: 'commandExecution', id: itemId, command, cwd, status: 'inProgress', commandActions: [] } });
      const r = await ask('item/commandExecution/requestApproval', { threadId: s.foreign ? 'th-somebody-else' : thread, turnId, itemId, kind: 'command', command, cwd, startedAtMs: Date.now(), environmentId: 'local' });
      log({ cmd: s.cmd, foreign: !!s.foreign, decision: r.decision });
      notify('item/completed', { threadId: thread, turnId, item: { type: 'commandExecution', id: itemId, command, cwd, status: r.decision === 'accept' ? 'completed' : 'declined', aggregatedOutput: s.output ?? '', exitCode: r.decision === 'accept' ? 0 : null } });
    } else if (s.write) {
      const file = path.join(cwd, s.write.file);
      fs.appendFileSync(file, s.write.content);
      const change = { path: file, kind: { type: 'update', move_path: null }, diff: `@@\n+${s.write.content.trim()}\n` };
      notify('item/started', { threadId: thread, turnId, item: { type: 'fileChange', id: itemId, changes: [change], status: 'inProgress' } });
      notify('item/completed', { threadId: thread, turnId, item: { type: 'fileChange', id: itemId, changes: [change], status: 'completed' } });
    } else if (s.editOutside) {
      const change = { path: s.editOutside, kind: { type: 'update', move_path: null }, diff: '@@\n+x\n' };
      notify('item/started', { threadId: thread, turnId, item: { type: 'fileChange', id: itemId, changes: [change], status: 'inProgress' } });
      const r = await ask('item/fileChange/requestApproval', { threadId: thread, turnId, itemId, startedAtMs: Date.now() });
      log({ editOutside: s.editOutside, decision: r.decision });
      notify('item/completed', { threadId: thread, turnId, item: { type: 'fileChange', id: itemId, changes: [change], status: r.decision === 'accept' ? 'completed' : 'declined' } });
    } else if (s.tool) {
      notify('item/started', { threadId: thread, turnId, item: { type: 'dynamicToolCall', id: itemId, tool: s.tool, arguments: s.args ?? {}, status: 'inProgress' } });
      const r = await ask('item/tool/call', { threadId: thread, turnId, callId: itemId, namespace: null, tool: s.tool, arguments: s.args ?? {} });
      log({ tool: s.tool, result: r });
      notify('item/completed', { threadId: thread, turnId, item: { type: 'dynamicToolCall', id: itemId, tool: s.tool, arguments: s.args ?? {}, status: 'completed', contentItems: r.contentItems, success: r.success } });
    } else if (s.say) {
      notify('item/completed', { threadId: thread, turnId, item: { type: 'agentMessage', id: itemId, text: s.say, phase: 'final_answer' } });
    } else if (s.wait) {
      const t0 = Date.now();
      while (!interrupted && Date.now() - t0 < s.wait) await new Promise((r) => setTimeout(r, 20));
    }
  }
  notify('thread/tokenUsage/updated', { threadId: thread, turnId, tokenUsage: { last: { totalTokens: 1200 }, total: { totalTokens: 1200 }, modelContextWindow: null } });
  notify('turn/completed', { threadId: thread, turn: { id: turnId, items: [], status: interrupted ? 'interrupted' : 'completed', error: null } });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    pending.get(m.id)?.(m.result ?? { error: m.error });
    pending.delete(m.id);
    return;
  }
  log({ method: m.method, params: m.params });
  if (m.id === undefined) return;
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex', codexHome: '', platformFamily: process.platform, platformOs: process.platform });
    case 'config/read':
      return reply({ config: { model: 'gpt-fake', mcp_servers: { posthog: { url: 'https://example.invalid' } }, plugins: { 'computer-use@openai-bundled': { enabled: true } } } });
    case 'account/read':
      return reply(scenario.account ?? { account: { type: 'chatgpt', email: 'x@example.com', planType: 'plus' }, requiresOpenaiAuth: true });
    case 'thread/start':
    case 'thread/resume':
      role = (m.params.dynamicTools ?? []).some((t) => t.name === 'create_task') ? 'lead' : 'worker';
      cwd = m.params.cwd ?? cwd;
      thread = m.method === 'thread/resume' ? m.params.threadId : `th-${role}-${process.pid}`;
      return reply({ thread: { id: thread }, model: 'gpt-fake' });
    case 'thread/name/set':
      return reply({});
    case 'turn/interrupt':
      interrupted = true;
      return reply({});
    case 'turn/start': {
      const turnId = `turn-${process.pid}`;
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      await play(m.params, turnId);
      return;
    }
    default:
      send({ id: m.id, error: { code: -32601, message: `fake codex: unsupported ${m.method}` } });
  }
});
