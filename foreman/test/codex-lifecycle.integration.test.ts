// Real CLI regression cases against a local API only; opt in with AGENTCRAFT_TEST_CODEX.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { CodexRuntime } from '../src/agents/codex/index.js';
import type { TurnRequest, TurnStats } from '../src/agents/runtime.js';
import { makeForeman, rmrf, tempDir, until } from './helpers.js';
import { turnRequest } from './provider-helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const realCLI = it.skipIf(!process.env.AGENTCRAFT_TEST_CODEX);
const marker = 'LIFECYCLE_STEER_MARKER_8742';

async function localCLI() {
  const dir = tempDir('ac-codex-lifecycle-');
  const h = makeForeman(path.join(dir, 'home'), ['--backend', 'codex']);
  const state = { hold: false, queuedSteers: 0, requests: [] as Array<{ hasMarker: boolean }>, responses: [] as Array<() => void>, extraArgs: [] as string[] };
  const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const routeErrors: unknown[] = [];
  const controllers = new Set<AbortController>();
  const active = new Set<Promise<TurnStats>>();
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const data of req) raw += data;
      if (req.url !== '/v1/responses') throw new Error(`Unexpected local route: ${req.url}`);
      const body = JSON.parse(raw);
      state.requests.push({ hasMarker: JSON.stringify(body.input).includes(marker) });
      const index = state.requests.length;
      const item = { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
      const response = { id: `resp_${index}`, object: 'response', created_at: 0, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } };
      const respond = () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      };
      if (state.hold) state.responses.push(respond);
      else respond();
    } catch (error) { routeErrors.push(error); res.writeHead(500).end('test route failed'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: path.join(dir, 'codex-home'), AGENTCRAFT_TEST_KEY: 'local-stub-only' };
  fs.mkdirSync(env.CODEX_HOME!, { recursive: true });
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  const localArgs = ['-c', 'model_provider="agentcraft_test"', '-c', 'model_providers.agentcraft_test.request_max_retries=0',
    '-c', `model_providers.agentcraft_test={name="local stub",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="AGENTCRAFT_TEST_KEY"}`];
  const runtime = new CodexRuntime(h.cfg.codex, (_command, args, options) => {
    const child = spawn(process.env.AGENTCRAFT_TEST_CODEX!, [...args, ...localArgs, ...state.extraArgs], options);
    createInterface({ input: child.stdout! }).on('line', line => {
      if (typeof JSON.parse(line).result?.turnId === 'string') state.queuedSteers++;
    });
    child.once('exit', (code, signal) => { exits.push({ code, signal }); });
    return child;
  });
  const run = (changes: Partial<TurnRequest> = {}) => {
    const request = turnRequest(h, dir, { env, ...changes });
    controllers.add(request.abortController);
    const done = runtime.run(request).finally(() => { controllers.delete(request.abortController); active.delete(done); });
    active.add(done);
    return { request, done };
  };
  cleanups.push(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(active);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await h.fm.close();
    rmrf(dir);
    expect(routeErrors).toEqual([]);
  });
  return { dir, env, state, exits, runtime, run };
}

realCLI('returns an acknowledged but unconsumed steer for delivery after interruption', async () => {
  const c = await localCLI();
  c.state.hold = true;
  let steer: ((text: string) => Promise<boolean>) | undefined;
  const first = c.run({ onSteerReady: fn => { steer = fn; } });
  await until(() => c.state.requests.length === 1);
  let settled = false;
  const delivery = steer!(marker).then(result => { settled = true; return result; });
  await until(() => c.state.queuedSteers === 1);
  expect(settled).toBe(false);
  first.request.abortController.abort();
  const interrupted = await first.done;
  expect(await delivery).toBe(false);
  expect(interrupted.subtype).toBe('interrupted');
  c.state.hold = false;
  const resumed = await c.run({ resume: interrupted.sessionId, prompt: `Continue the task.\n${marker}` }).done;
  expect(resumed.errors).toEqual([]);
  expect(c.state.requests.at(-1)?.hasMarker).toBe(true);
});

realCLI('resumes accumulated history beyond the transport limit and saves normal completions before exit', async () => {
  const c = await localCLI();
  const notifyMarker = path.join(c.dir, 'notify-fired');
  fs.writeFileSync(path.join(c.env.CODEX_HOME!, 'config.toml'), `notify = ${JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(notifyMarker)},'bad')`])}\n`);
  let sessionId: string | undefined;
  for (let index = 0; index < 12; index++) {
    const stats = await c.run({ resume: sessionId, prompt: `History ${index}: ${'x'.repeat(900_000)}` }).done;
    expect(stats.errors, `turn ${index + 1}`).toEqual([]);
    expect(stats.isError).toBe(false);
    sessionId = stats.sessionId;
  }
  expect(c.exits).toHaveLength(12);
  expect(c.exits.every(exit => exit.code === 0 && exit.signal === null)).toBe(true);
  expect(fs.existsSync(notifyMarker)).toBe(false);
  const sessions = path.join(c.env.CODEX_HOME!, 'sessions');
  const rollouts = fs.readdirSync(sessions, { recursive: true }).filter(file => typeof file === 'string' && file.endsWith('.jsonl')) as string[];
  const events = rollouts.flatMap(file => fs.readFileSync(path.join(sessions, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  expect(events.filter(event => event.type === 'event_msg' && event.payload?.type === 'task_complete')).toHaveLength(12);
});

realCLI('consumes steering after a final model response and persists it across a later interruption', async () => {
  const c = await localCLI();
  c.state.hold = true;
  let steer: ((text: string) => Promise<boolean>) | undefined;
  const first = c.run({ onSteerReady: fn => { steer = fn; } });
  await until(() => c.state.requests.length === 1);
  const delivery = steer!(marker);
  await until(() => c.state.queuedSteers === 1);
  c.state.responses.shift()!(); // the original response contains only final assistant text
  expect(await delivery).toBe(true);
  // Interrupt at the consumption notification, without waiting for the next model request.
  first.request.abortController.abort();
  const interrupted = await first.done;
  c.state.hold = false;
  const resumed = await c.run({ resume: interrupted.sessionId, prompt: 'Continue the task.' }).done;
  expect(resumed.errors).toEqual([]);
  expect(c.state.requests.at(-1)?.hasMarker).toBe(true); // saved by Codex, no reinjection
});

realCLI('preserves malformed config errors and command-line startup diagnostics', async () => {
  const c = await localCLI();
  const configPath = path.join(c.env.CODEX_HOME!, 'config.toml');
  fs.writeFileSync(configPath, '[invalid header\n');
  const malformed = await c.run().done;
  expect(malformed.errors.join('\n')).toMatch(/unclosed table|expected.*\]/);
  fs.rmSync(configPath);
  c.state.extraArgs = ['--agentcraft-invalid-option'];
  const unsupported = await c.run().done;
  expect(unsupported.errors.join('\n')).toContain('--agentcraft-invalid-option');
});
