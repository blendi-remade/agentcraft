// Real app-server migration: upstream dynamic-tools threads resume through the authenticated
// MCP runtime against a local Responses stub. No model calls or user Codex state are used.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { CodexEngine } from '../src/agents/codex/engine.js';
import { CodexRuntime } from '../src/agents/codex/index.js';
import { makeForeman, rmrf, tempDir } from './helpers.js';
import { turnRequest } from './provider-helpers.js';

it.skipIf(!process.env.AGENTCRAFT_TEST_CODEX)('resumes an upstream native dynamic-tools thread with the authenticated MCP runtime', async () => {
  const dir = tempDir('ac-codex-native-migration-');
  const h = makeForeman(path.join(dir, 'home'), ['--backend', 'codex']);
  const requests: Array<{ phase: string; body: any }> = [];
  const routeErrors: unknown[] = [];
  let phase = 'native';
  let calledLegacyAlias = false;
  let currentHandlerCalls = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const data of req) raw += data;
      if (req.url !== '/v1/responses') throw new Error(`Unexpected local route: ${req.url}`);
      const body = JSON.parse(raw);
      requests.push({ phase, body });
      const index = requests.length;
      const item = phase === 'migrated' && !calledLegacyAlias
        ? { type: 'function_call', id: 'fc_legacy', call_id: 'call_legacy', name: 'legacy_probe', arguments: '{}', status: 'completed' }
        : { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: phase === 'native' ? 'NATIVE_HISTORY_MARKER_4719' : 'Continued through MCP.', annotations: [] }] };
      if (phase === 'migrated') calledLegacyAlias = true;
      const response = { id: `resp_${index}`, object: 'response', created_at: 0, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) { routeErrors.push(error); res.writeHead(500).end('local test failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: path.join(dir, 'codex-home'), AGENTCRAFT_TEST_KEY: 'local-stub-only' };
  fs.mkdirSync(env.CODEX_HOME!, { recursive: true });
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  const port = (server.address() as AddressInfo).port;
  const localArgs = ['-c', 'model_provider="agentcraft_test"', '-c', 'model_providers.agentcraft_test.request_max_retries=0',
    '-c', `model_providers.agentcraft_test={name="local stub",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="AGENTCRAFT_TEST_KEY"}`];
  const abort = new AbortController();
  const runtimeAbort = new AbortController();
  try {
    const native = new CodexEngine(h.fm, { ...h.cfg.codex, workerModel: 'test-model' }, { bin: process.env.AGENTCRAFT_TEST_CODEX!, args: localArgs });
    const original = await native.runTurn({
      agentId: 'kit', role: 'worker', cwd: dir, prompt: 'Keep NATIVE_GOAL_MARKER_8264 in this conversation.', instructions: 'Test migration.',
      env, abort, turn: { signal: abort.signal, reason: () => undefined }, permission: async () => ({ allow: false, message: 'test is read-only' }),
      tools: [{ name: 'legacy_probe', description: 'A dynamic team tool from the upstream backend.', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'legacy result' }] }) }],
      onProcess() {}, onSession() {},
    });
    expect(original.errors).toEqual([]);
    expect(original.sessionId).toBeTruthy();
    const toolNames = (body: any): string[] => (body.tools ?? []).flatMap((tool: any) => [tool.name, ...(tool.tools ?? []).map((nested: any) => nested.name)]);
    expect(toolNames(requests[0]!.body)).toContain('legacy_probe');
    phase = 'migrated';
    const runtime = new CodexRuntime(h.cfg.codex, (_command, args, options) => spawn(process.env.AGENTCRAFT_TEST_CODEX!, [...args, ...localArgs], options));
    const migrated = await runtime.run(turnRequest(h, dir, { env, resume: original.sessionId, abortController: runtimeAbort, tools: [{ name: 'legacy_probe', description: 'Current team handler', inputSchema: {}, handler: async () => { currentHandlerCalls++; return { content: [{ type: 'text', text: 'CURRENT_HANDLER_RESULT_2378' }] }; } }], prompt: 'Continue the earlier objective through the current MCP tools.' }));
    expect(routeErrors).toEqual([]);
    expect(migrated.errors).toEqual([]);
    expect(migrated.isError).toBe(false);
    expect(migrated.sessionId).toBe(original.sessionId);
    const resumed = requests.filter(request => request.phase === 'migrated');
    expect(resumed.length).toBeGreaterThan(0);
    expect(JSON.stringify(resumed[0]!.body.input)).toContain('NATIVE_GOAL_MARKER_8264');
    expect(JSON.stringify(resumed[0]!.body.input)).toContain('NATIVE_HISTORY_MARKER_4719');
    const names = toolNames(resumed[0]!.body);
    expect(names.some(name => name === 'mcp__agentcraft' || name?.startsWith('mcp__agentcraft__'))).toBe(true);
    expect(names).toContain('legacy_probe'); // the app-server persists these aliases
    expect(currentHandlerCalls).toBe(1);
    expect(JSON.stringify(resumed.at(-1)!.body.input)).toContain('CURRENT_HANDLER_RESULT_2378');
  } finally {
    abort.abort();
    runtimeAbort.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await h.fm.close();
    rmrf(dir);
  }
}, 60_000);
