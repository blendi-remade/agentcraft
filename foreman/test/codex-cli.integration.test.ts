// Opt in with AGENTCRAFT_TEST_CODEX=codex. Runs the installed CLI against a local Responses
// stub and the real AgentCraft MCP bridge; no paid model calls or user credentials are used.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { CodexRuntime, codexArgs } from '../src/agents/codex/index.js';
import { startBridge } from '../src/agents/codex/bridge.js';
import { makeForeman, rmrf, tempDir, until } from './helpers.js';
import { turnRequest } from './provider-helpers.js';

const permissionWaitMs = Number(process.env.AGENTCRAFT_TEST_CODEX_WAIT_MS ?? 0);

it.skipIf(!process.env.AGENTCRAFT_TEST_CODEX)('installed Codex CLI uses only AgentCraft MCP and resumes against a local API stub', async () => {
  const dir = tempDir('ac-codex-cli-');
  const h = makeForeman(path.join(dir, 'home'), ['--backend', 'codex']);
  const requests: any[] = [];
  let routeError: unknown;
  let firstRequest!: () => void;
  const firstRequestSeen = new Promise<void>(resolve => { firstRequest = resolve; });
  let releaseFirst!: () => void;
  const firstResponseAllowed = new Promise<void>(resolve => { releaseFirst = resolve; });
  let interruptRequest!: () => void;
  const interruptRequestSeen = new Promise<void>(resolve => { interruptRequest = resolve; });
  let forceWrite = false;
  let phase = 'app-server';
  const requestPhases: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const data of req) raw += data;
      if (req.url !== '/v1/responses') throw new Error(`Unexpected local API route: ${req.url}`);
      const body = JSON.parse(raw);
      requests.push(body);
      requestPhases.push(phase);
      if (phase === 'interruption') { interruptRequest(); return; } // model response remains pending
      if (requests.length === 1) { firstRequest(); await firstResponseAllowed; }
      const names = (body.tools ?? []).map((t: any) => t.name);
      const group = (body.tools ?? []).find((tool: any) => tool.name === 'mcp__agentcraft');
      const write = names.find((name: string) => name?.endsWith('__Write')) ?? group?.tools?.find((tool: any) => tool.name === 'Write')?.name;
      if (body.tools?.length && !write && phase !== 'lead') throw new Error(`No Write MCP tool: ${names.join(', ')}`);
      // Steering can replace the first pending request in newer CLIs. Keep requesting the
      // write until its side effect exists, instead of using a mutable global request count.
      const item = write && ((phase === 'app-server' && !fs.existsSync(path.join(dir, 'real-cli.txt'))) || forceWrite)
        ? { type: 'function_call', id: 'fc_write', call_id: 'call_write', name: write, ...(group ? { namespace: 'mcp__agentcraft' } : {}), arguments: JSON.stringify({ file_path: 'real-cli.txt', content: 'real CLI, local stub\n' }), status: 'completed' }
        : { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
      if (write) forceWrite = false;
      const response = { id: `resp_${requests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (e) { routeError = e; res.writeHead(500).end('local test failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const localArgs = [
      '-c', 'model_provider="agentcraft_test"',
      '-c', 'model_providers.agentcraft_test.request_max_retries=0',
      '-c', `model_providers.agentcraft_test={name="local stub",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="AGENTCRAFT_TEST_KEY"}`,
    ];
    let queuedSteers = 0;
    const runtime = new CodexRuntime(h.cfg.codex, (_command, args, opts) => {
      const child = spawn(process.env.AGENTCRAFT_TEST_CODEX!, [...args, ...localArgs], opts);
      createInterface({ input: child.stdout! }).on('line', line => {
        if (typeof JSON.parse(line).result?.turnId === 'string') queuedSteers++;
      });
      return child;
    });
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: path.join(dir, 'codex-home'), AGENTCRAFT_TEST_KEY: 'local-stub-only' };
    fs.mkdirSync(env.CODEX_HOME!, { recursive: true });
    // Personal integrations must never start, even though app-server reads layered config.
    const marker = path.join(dir, 'personal-mcp-started');
    fs.writeFileSync(path.join(env.CODEX_HOME!, 'config.toml'), [
      '[features]', 'current_time_reminder = true', 'send_message_to_user_async = true',
      '[mcp_servers.personal]', `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`])}`,
      '[shell_environment_policy.set]', 'INHERITED_SHELL_SETTING = "must-not-affect-our-tools"',
    ].join('\n'));
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const first = turnRequest(h, dir, { env, onSteerReady: ready => { steer = ready; } });
    const policy = first.canUseTool;
    first.canUseTool = async (name, input, opts) => {
      if (name === 'Write' && permissionWaitMs > 0) await new Promise(resolve => setTimeout(resolve, permissionWaitMs));
      return policy(name, input, opts);
    };
    const running = runtime.run(first);
    await firstRequestSeen;
    expect(steer).toBeDefined();
    const steered = steer!('Live instruction: keep the implementation minimal.');
    await until(() => queuedSteers === 1);
    releaseFirst();
    expect(await steered).toBe(true);
    const stats = await running;
    expect(routeError).toBeUndefined();
    expect(stats.errors).toEqual([]);
    expect(stats.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'real-cli.txt'), 'utf8')).toBe('real CLI, local stub\n');
    const names = requests[0].tools.map((t: any) => t.name).filter((n: string) => n?.startsWith('mcp__'));
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n: string) => n === 'mcp__agentcraft' || n.startsWith('mcp__agentcraft__'))).toBe(true);
    expect(requests.some(request => JSON.stringify(request.input).includes('Live instruction:'))).toBe(true);
    const resumed = await runtime.run(turnRequest(h, dir, { env, resume: stats.sessionId, prompt: 'Confirm the result.' }));
    expect(routeError).toBeUndefined();
    expect(resumed.errors).toEqual([]);
    expect(resumed.sessionId).toBe(stats.sessionId);
    expect(fs.existsSync(marker)).toBe(false);

    // Migration: create a conversation with the old exec interface, close its MCP bridge,
    // then resume it through app-server and prove that the newly configured bridge is used.
    const legacyRequest = turnRequest(h, dir, { env });
    const legacyBridge = await startBridge(legacyRequest, () => {});
    let legacyId: string | undefined;
    const legacyErrors: string[] = [];
    try {
      phase = 'legacy-exec';
      const legacy = spawn(process.env.AGENTCRAFT_TEST_CODEX!, [
        'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'workspace-write',
        ...codexArgs().slice(3).filter((arg, index, args) => arg !== 'agents.enabled=false' && !(arg === '-c' && args[index + 1] === 'agents.enabled=false')), ...localArgs,
        '-c', `mcp_servers={agentcraft={url=${JSON.stringify(legacyBridge.url)},bearer_token_env_var="AGENTCRAFT_MCP_TOKEN",required=true,tools={Write={approval_mode="approve"},Read={approval_mode="approve"},Edit={approval_mode="approve"},Bash={approval_mode="approve"},Glob={approval_mode="approve"},Grep={approval_mode="approve"}}}}`,
        '-',
      ], { cwd: dir, env: { ...env, AGENTCRAFT_MCP_TOKEN: legacyBridge.token }, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<number | null>((resolve, reject) => { legacy.once('error', reject); legacy.once('close', resolve); });
      void exited.catch(() => {});
      legacy.stderr.resume();
      legacy.stdin.end('Use AgentCraft MCP tools. Confirm you can continue later.');
      for await (const line of createInterface({ input: legacy.stdout })) {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') legacyId = event.thread_id;
        if (event.type === 'error') legacyErrors.push(event.message);
        if (event.type === 'turn.failed') legacyErrors.push(event.error?.message ?? 'turn failed');
      }
      expect(routeError).toBeUndefined();
      expect(await exited, legacyErrors.join('\n')).toBe(0);
      expect(legacyId).toBeTruthy();
    } finally { await legacyBridge.close(); }
    fs.rmSync(path.join(dir, 'real-cli.txt'));
    phase = 'migrated-app-server';
    forceWrite = true;
    const migrated = await runtime.run(turnRequest(h, dir, { env, resume: legacyId, prompt: 'Write the result using the current MCP bridge.' }));
    expect(migrated.errors).toEqual([]);
    expect(migrated.sessionId).toBe(legacyId);
    expect(fs.readFileSync(path.join(dir, 'real-cli.txt'), 'utf8')).toBe('real CLI, local stub\n');
    expect(fs.existsSync(marker)).toBe(false);
    phase = 'lead';
    const lead = await runtime.run(turnRequest(h, dir, { env, role: 'lead', prompt: 'Inspect the repository.' }));
    expect(lead.errors).toEqual([]);
    expect(lead.isError).toBe(false);
    const leadTools = requests.filter((_request, index) => requestPhases[index] === 'lead').flatMap(request => request.tools ?? []);
    const leadNames = leadTools.flatMap(tool => tool.tools?.map((nested: any) => nested.name) ?? [tool.name]);
    expect(leadNames.some(name => ['Write', 'Edit'].some(writeName => name === writeName || name?.endsWith(`__${writeName}`)))).toBe(false);
    expect(leadNames.some(name => name === 'Bash' || name?.endsWith('__Bash'))).toBe(true);
    const safeNative = new Set(['update_plan', 'request_user_input', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
    for (const [index, request] of requests.entries()) {
      const unexpected = (request.tools ?? []).map((tool: any) => tool.name).filter((name: string) => !safeNative.has(name) && name !== 'mcp__agentcraft' && !name.startsWith('mcp__agentcraft__'));
      expect(unexpected, `Unexpected tools in ${requestPhases[index]}`).toEqual([]);
    }

    phase = 'interruption';
    const interruptedRequest = turnRequest(h, dir, { env, prompt: 'Wait for the response.' });
    const pending = runtime.run(interruptedRequest);
    await interruptRequestSeen;
    const cancelledAt = Date.now();
    interruptedRequest.abortController.abort();
    expect(await pending).toMatchObject({ isError: true, subtype: 'interrupted' });
    expect(Date.now() - cancelledAt).toBeLessThan(3000);
  } finally {
    releaseFirst();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await h.fm.close();
    rmrf(dir);
  }
}, permissionWaitMs + 60_000);
