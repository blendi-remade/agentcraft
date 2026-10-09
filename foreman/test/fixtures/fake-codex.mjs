// Deterministic app-server double: real JSON-RPC pipes and real MCP, no model access.
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if (process.argv.includes('login')) process.exit(process.env.AGENTCRAFT_TEST_NO_OPENAI_AUTH ? 1 : 0);
if (process.argv.includes('--version') || process.argv.includes('--help')) process.exit(0);
if (process.env.AGENTCRAFT_TEST_STARTUP_ERROR) {
  process.stderr.write(`startup configuration rejected: ${process.env.AGENTCRAFT_TEST_STARTUP_ERROR}\n`);
  process.exit(1);
}
const emit = data => process.stdout.write(JSON.stringify(data) + '\n');
const notify = (method, params) => emit({ method, params });
let threadId = '', turnId = '', config, cwd, instructions;
let client;
let active;
let prompt = '';
let completed = false;
let nextServerId = 1000;
const pendingServerRequests = new Map();
const requestTool = params => new Promise(resolve => {
  const id = nextServerId++; pendingServerRequests.set(id, resolve);
  emit({ id, method: 'item/tool/call', params });
});
const trace = message => {
  if (process.env.AGENTCRAFT_TEST_TRACE) fs.appendFileSync(process.env.AGENTCRAFT_TEST_TRACE, JSON.stringify(message) + '\n');
};
const finish = (status = 'completed', error = null) => {
  if (completed) return;
  completed = true;
  notify('turn/completed', { threadId, turn: { id: turnId, status, error } });
};
const text = (value = 'Finished via AgentCraft MCP.') => {
  notify('item/completed', { threadId, turnId, item: { id: 'msg-final', type: 'agentMessage', phase: 'final_answer', text: value } });
};
async function work() {
  if (prompt.includes('[legacy-tool]')) {
    const result = await requestTool({ threadId: prompt.includes('[foreign]') ? 'foreign' : threadId,
      turnId: prompt.includes('[stale]') ? 'stale' : turnId, tool: prompt.includes('[unknown]') ? 'create_task' : 'legacy_probe',
      arguments: prompt.includes('[bad-args]') ? {} : { value: 'current' }, namespace: null });
    text(JSON.stringify(result)); finish(); return;
  }
  if (prompt.includes('[metadata]')) {
    const usage = (total, last) => notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: total }, last: { totalTokens: last } } });
    usage(1100, 100); usage(1100, 100); usage(1300, 200);
    text('Metadata reported.'); finish(); return;
  }
  if (prompt.includes('[split-secret]')) {
    const key = process.env.AGENTCRAFT_TEST_PROVIDER_KEY;
    const split = Math.floor(key.length / 2);
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-final', delta: `Credential: ${key.slice(0, split)}` });
    await delay(600);
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-final', delta: `${key.slice(split)} hidden.` });
    text(`Credential: ${key} hidden.`);
    finish(); return;
  }
  if (prompt.includes('[hang]')) { await delay(60_000, undefined, { signal: active.signal }).catch(() => {}); return; }
  if (prompt.includes('[steer]') || prompt.includes('[queued-steer]') || prompt.includes('[consumed-steer-hang]') || prompt.includes('[late-steer-ack]')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-progress', delta: 'Working on the original task.' });
    return; // finish after turn/steer, without waiting on a tool
  }
  if (prompt.includes('[malformed]')) { process.stdout.write('not JSON\n'); return; }
  if (prompt.includes('[failure]')) { finish('failed', { message: 'test provider failed' }); return; }
  if (prompt.includes('[policy-failure]')) { finish('failed', { message: `This content was flagged for possible cybersecurity risk. ${process.env.CODEX_API_KEY}` }); return; }
  if (prompt.includes('[false-auth]')) { finish('failed', { message: 'Invalid schema additionalProperties key; requested 24010 tokens' }); return; }
  if (prompt.includes('[auth-failure]')) { finish('failed', { message: 'HTTP 401 Unauthorized' }); return; }
  if (prompt.includes('[recovered-auth-error]')) {
    notify('error', { threadId, turnId, error: { message: 'HTTP 401 Unauthorized' }, willRetry: false });
    text('Recovered successfully.'); finish(); return;
  }
  client = new Client({ name: 'fake-codex', version: '1.0' });
  const url = config.mcp_servers.agentcraft.url;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${process.env.AGENTCRAFT_MCP_TOKEN}` } } }));
  const { tools } = await client.listTools();
  if (prompt.includes('[hang-tool]') || prompt.includes('[hang-escaped-tool]')) {
    const command = prompt.includes('[hang-escaped-tool]') ? 'node detach.cjs; echo started' : 'node -e "require(\'fs\').writeFileSync(\'shell-pid.txt\',String(process.pid));setTimeout(() => {}, 60000)"';
    await client.callTool({ name: 'Bash', arguments: { command } }, undefined, { signal: active.signal }).catch(() => {});
    return;
  }
  if (prompt.includes('[ask]')) {
    await client.callTool({ name: 'ask_user', arguments: { question: 'Continue?', options: ['Yes', 'No'] } }, undefined, { signal: active.signal });
  } else if (prompt.includes('[env]')) {
    if (!process.env.CODEX_API_KEY) throw new Error('CLI needs its provider key');
    const result = await client.callTool({ name: 'Bash', arguments: { command: 'node -e "console.log(Boolean(process.env.CODEX_API_KEY), Boolean(process.env.OPENAI_API_KEY), Boolean(process.env.AGENTCRAFT_MCP_TOKEN), Boolean(process.env.AGENTCRAFT_TEST_PROVIDER_KEY))"' } });
    if (!JSON.stringify(result).includes('false false false false')) throw new Error('provider credentials reached tool environment');
  } else if (prompt.includes('[lead]')) {
    if (tools.some(t => ['Write', 'Edit'].includes(t.name))) throw new Error('lead has write tools');
  } else {
    await client.callTool({ name: 'Write', arguments: { file_path: 'from-codex.txt', content: 'MCP write\n' } });
    if (prompt.includes('[limit]')) await client.callTool({ name: 'Write', arguments: { file_path: 'over-limit.txt', content: 'must not run' } });
  }
  await client.close();
  text();
  if (prompt.includes('[no-complete]')) process.exit(0);
  finish();
}
async function handle(message) {
  trace(message);
  const { id, method, params = {} } = message;
  if (!method && pendingServerRequests.has(id)) { pendingServerRequests.get(id)(message.result ?? message.error); pendingServerRequests.delete(id); return; }
  const reply = result => emit({ id, result });
  switch (method) {
    case 'initialize':
      if (params.capabilities.experimentalApi) throw new Error('Experimental APIs must remain disabled');
      reply({ userAgent: 'fake-codex/0.160.0' }); break;
    case 'initialized': break;
    case 'account/read': reply(process.env.AGENTCRAFT_TEST_NO_OPENAI_AUTH ? { account: null, requiresOpenaiAuth: false } : { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true }); break;
    case 'config/read': reply({ config: { model: process.env.AGENTCRAFT_TEST_MODEL || 'gpt-configured', model_providers: { test: { env_key: 'AGENTCRAFT_TEST_PROVIDER_KEY' } } } }); break;
    case 'thread/start':
    case 'thread/resume': {
      if ('dynamicTools' in params) throw new Error('Dynamic tools must not be sent');
      threadId = params.threadId ?? 'test-codex-session';
      cwd = params.cwd; config = params.config; instructions = params.developerInstructions;
      const sandbox = params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', networkAccess: false, writableRoots: [cwd], excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      reply({ model: params.model || process.env.AGENTCRAFT_TEST_MODEL || 'gpt-configured', thread: { id: threadId }, cwd, approvalPolicy: params.approvalPolicy, sandbox });
      break;
    }
    case 'turn/start':
      turnId = 'test-turn'; completed = false; active = new AbortController();
      prompt = instructions + '\n' + params.input.map(item => item.text).join('\n');
      reply({ turn: { id: turnId, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      void work().catch(error => { if (!active.signal.aborted) finish('failed', { message: error.message }); });
      break;
    case 'turn/steer':
      if (completed || params.expectedTurnId !== turnId || prompt.includes('[reject-steer]')) {
        emit({ id, error: { code: -32600, message: 'No active matching turn' } });
      } else {
        if (prompt.includes('[queued-steer]')) {
          reply({ turnId });
          if (prompt.includes('[fail-after-steer]')) finish('failed', { message: 'provider failed after queueing' });
          if (prompt.includes('[complete-after-steer]')) finish();
          break;
        }
        if (!prompt.includes('[late-steer-ack]')) reply({ turnId });
        notify('item/completed', { threadId, turnId, item: { type: 'userMessage', id: 'msg-steer', clientId: params.clientUserMessageId, content: params.input } });
        if (prompt.includes('[consumed-steer-hang]')) break;
        text('Accepted new instructions.');
        finish();
        if (prompt.includes('[late-steer-ack]')) { await delay(100); reply({ turnId }); }
      }
      break;
    case 'turn/interrupt':
      active?.abort(); reply({}); finish('interrupted'); break;
    default: emit({ id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => { void handle(JSON.parse(line)).catch(error => { process.stderr.write(error.message); process.exit(1); }); });
input.on('close', () => { active?.abort(); void Promise.resolve(client?.close()).finally(() => process.exit(0)); });
