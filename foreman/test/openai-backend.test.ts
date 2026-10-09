import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIBackend, OpenAIRuntime } from '../src/agents/openai/index.js';
import { makeForeman, tempDir, rmrf, demoRepo, until, type Harness } from './helpers.js';
import { turnRequest } from './provider-helpers.js';

type Call = { id: string; name: string; arguments: string };
const call = (id: string, name: string, args: Record<string, unknown>): Call => ({ id, name, arguments: JSON.stringify(args) });
function reply(api: string, calls: Call[] = [], text = '') {
  return api === 'chat'
    ? { choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) } }] }
    : { status: 'completed', output: [
      ...calls.map(c => ({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: c.arguments, status: 'completed' })),
      ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
    ] };
}
const histories = (api: string, body: Record<string, any>): any[] => api === 'chat' ? body.messages : body.input;

let h: Harness;
let dir: string;
let repo: string;
let server: Server | undefined;
afterEach(async () => {
  await h?.fm.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (dir) rmrf(dir);
  if (repo) rmrf(path.dirname(repo));
  repo = '';
});
function setup(api = 'chat') {
  dir = tempDir();
  h = makeForeman(dir, ['--backend', 'openai', '--model', 'local-model', '--base-url', 'http://localhost:1234/v1', '--api', api]);
  return h;
}

describe.each(['chat', 'responses'])('OpenAI-compatible %s API', api => {
  it('uses the configured HTTP endpoint, executes tools, and resumes persisted history', async () => {
    setup(api);
    const requests: Array<{ body: any; url?: string; auth?: string }> = [];
    server = createServer(async (req, res) => {
      let data = '';
      for await (const chunk of req) data += chunk;
      requests.push({ body: JSON.parse(data), url: req.url, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requests.length === 1
        ? reply(api, [call('c1', 'Write', { file_path: 'hello.txt', content: 'written through a tool' })])
        : reply(api, [], 'Finished.')));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    h.cfg.openai.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/custom/v1`;
    h.cfg.openai.apiKey = 'test-only-token';
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir);
    const r = turnRequest(h, dir);
    const stats = await runtime.run(r);
    expect(stats.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')).toBe('written through a tool');
    expect(requests[0]).toMatchObject({ url: `/custom/v1/${api === 'chat' ? 'chat/completions' : 'responses'}`, auth: 'Bearer test-only-token', body: { model: 'test-model' } });
    expect(JSON.stringify(histories(api, requests[1]!.body))).toContain('File written.');
    // A fresh runtime process reads the prior conversation, not just its latest prompt.
    await new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir).run(turnRequest(h, dir, { resume: stats.sessionId, prompt: 'Follow up' }));
    const last = histories(api, requests[2]!.body);
    expect(last.some(item => item.content === 'Follow up')).toBe(true);
    expect(JSON.stringify(last)).toContain('written through a tool');
    const state = fs.readFileSync(path.join(h.cfg.dataDir, 'openai-sessions', `${stats.sessionId}.json`), 'utf8');
    expect(state).not.toContain('test-only-token');
    expect(runtime.env({ OPENAI_API_KEY: 'test-only-token', KEEP: 'value' })).toEqual({ KEEP: 'value' });
    await expect(new OpenAIRuntime({ ...h.cfg.openai, baseUrl: 'http://other/v1' }, h.cfg.dataDir).run(turnRequest(h, dir, { resume: stats.sessionId }))).rejects.toThrow(/different endpoint/);
  });

  it('runs the real plan/work/review/approved-merge flow', async () => {
    setup(api);
    repo = await demoRepo();
    await h.fm.repos.add(repo);
    h.cfg.openai.workers = ['kit'];
    h.cfg.openai.ciCommand = 'node --version';
    const prompts = new Map<string, number>();
    const fetchFn = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const history = histories(api, body);
      const prompt = [...history].reverse().find(m => m.role === 'user')!.content as string;
      const n = (prompts.get(prompt) ?? 0) + 1;
      prompts.set(prompt, n);
      let output: unknown;
      if (n > 1) output = reply(api, [], 'Done.');
      else if (prompt.startsWith('New goal')) output = reply(api, [call('plan', 'create_task', { title: 'Add a greeting', description: 'Create greeting.txt', assignee: 'kit' })]);
      else if (prompt.startsWith('Review request:')) output = reply(api, [call('merge', 'request_merge', { task_id: 't1', summary: 'Greeting added; tests pass.' })]);
      else if (prompt.includes('Your task: t1')) output = reply(api, [
        call('write', 'Write', { file_path: 'greeting.txt', content: 'hello\n' }),
        call('review', 'update_task', { task_id: 't1', status: 'review', summary: 'Added greeting; tested.' }),
      ]);
      else output = reply(api, [], 'Acknowledged.');
      return new Response(JSON.stringify(output), { status: 200 });
    };
    await h.fm.start(new OpenAIBackend(h.fm, h.cfg.openai, fetchFn as typeof fetch));
    const goal = await h.fm.submitGoal('Add greeting.txt');
    await until(() => h.fm.decisions.open().some(d => d.kind === 'merge'));
    expect(fs.existsSync(path.join(repo, 'greeting.txt'))).toBe(false);
    const decision = h.fm.decisions.open().find(d => d.kind === 'merge')!;
    expect(h.fm.tasks.get('t1')!.ci).toBe('pass');
    expect(h.fm.store.data.sessions['kit:t1']!.provider).toBe('openai');
    await h.fm.answerDecision(decision.id, 'Merge');
    await until(() => h.fm.goal(goal.id)!.status === 'done');
    expect(fs.readFileSync(path.join(repo, 'greeting.txt'), 'utf8')).toBe('hello\n');
  });
});

describe('endpoint failures and cancellation', () => {
  it.each([400, 429, 500])('does not disable the team on HTTP %s bodies containing auth-like text or numbers', async status => {
    setup();
    repo = await demoRepo();
    await h.fm.repos.add(repo);
    await h.fm.start(new OpenAIBackend(h.fm, h.cfg.openai, (async () => new Response('author requested 24010 tokens; port 54013', { status })) as typeof fetch));
    await h.fm.submitGoal('First request');
    await until(() => h.fm.agent('marlow')?.state === 'error');
    expect(h.fm.status.auth).toBe('ok');
    await expect(h.fm.submitGoal('A new request')).resolves.toBeDefined();
  });

  it.each([401, 403])('marks an HTTP %s response as an authentication failure', async status => {
    setup();
    repo = await demoRepo();
    await h.fm.repos.add(repo);
    await h.fm.start(new OpenAIBackend(h.fm, h.cfg.openai, (async () => new Response('denied', { status })) as typeof fetch));
    await h.fm.submitGoal('Request');
    await until(() => h.fm.status.auth === 'failed');
  });

  it.each(['chat', 'responses'])('recovers a %s session from context overflow without replaying side effects', async api => {
    setup(api);
    let requests = 0;
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      const body = JSON.parse(String(opts!.body));
      if (++requests === 1) return new Response(JSON.stringify(reply(api, [call('write', 'Write', { file_path: 'once.txt', content: 'first' })], 'Plan: retain the existing storage format.')));
      if (requests === 2) return new Response('context_length_exceeded: maximum context window reached', { status: 400 });
      const history = histories(api, body).filter((m: any) => m.role !== 'system');
      expect(history).toHaveLength(1);
      expect(history[0].content).toContain('do not blindly replay actions');
      expect(history[0].content).toContain('once.txt');
      expect(history[0].content).toContain('Plan: retain the existing storage format.');
      return new Response(JSON.stringify(reply(api, [], 'Recovered; file already exists.')));
    }) as typeof fetch);
    expect((await runtime.run(turnRequest(h, dir))).isError).toBe(false);
    expect(requests).toBe(3);
    expect(fs.readFileSync(path.join(dir, 'once.txt'), 'utf8')).toBe('first');
  });

  it('keeps long conversations intact until the endpoint reports a context limit', async () => {
    setup();
    fs.writeFileSync(path.join(dir, 'large.txt'), 'x'.repeat(23_500));
    let requests = 0;
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      const body = JSON.parse(String(opts!.body));
      if (++requests === 11) {
        expect(JSON.stringify(body.messages).length).toBeGreaterThan(200_000);
        expect(body.messages.some((m: any) => m.content === 'Plan: preserve this design throughout the task.')).toBe(true);
        return new Response(JSON.stringify(reply('chat', [], 'Done.')));
      }
      return new Response(JSON.stringify(reply('chat', [call(`read-${requests}`, 'Read', { file_path: 'large.txt' })], requests === 1 ? 'Plan: preserve this design throughout the task.' : '')));
    }) as typeof fetch);
    expect((await runtime.run(turnRequest(h, dir, { maxTurns: 12 }))).isError).toBe(false);
  });

  it('recognizes llama.cpp context-size errors and preserves the original objective across resumed compaction', async () => {
    setup();
    const original = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async () => new Response(JSON.stringify(reply('chat', [], 'Plan: update the command parser.')))) as typeof fetch);
    const first = await original.run(turnRequest(h, dir, { prompt: 'Original objective: add a version flag.' }));
    let requests = 0;
    const resumed = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      // llama.cpp tools/server/server-common.cpp and its chat-completion unit tests specify this type/status.
      if (++requests === 1) return new Response(JSON.stringify({ error: { type: 'exceed_context_size_error', message: 'request exceeds the available context size' } }), { status: 400 });
      const user = JSON.parse(String(opts!.body)).messages[1].content;
      expect(user).toContain('Original objective: add a version flag.');
      expect(user).toContain('Plan: update the command parser.');
      expect(user).toContain('Continue the task.');
      return new Response(JSON.stringify(reply('chat', [], 'Done.')));
    }) as typeof fetch);
    expect((await resumed.run(turnRequest(h, dir, { resume: first.sessionId, prompt: 'Continue the task.' }))).isError).toBe(false);
  });

  it('merges user prompts on retry after a failed chat request', async () => {
    setup();
    let id = '';
    const fail = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async () => new Response('temporarily unavailable', { status: 503 })) as typeof fetch);
    await expect(fail.run(turnRequest(h, dir, { prompt: 'Original task.', onSession: value => { id = value; } }))).rejects.toThrow('503');
    const retry = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      const messages = JSON.parse(String(opts!.body)).messages;
      expect(messages.map((m: any) => m.role)).toEqual(['system', 'user']);
      expect(messages[1].content).toContain('Original task.');
      expect(messages[1].content).toContain('Continue.');
      return new Response(JSON.stringify(reply('chat', [], 'Done.')));
    }) as typeof fetch);
    expect((await retry.run(turnRequest(h, dir, { resume: id, prompt: 'Continue.' }))).isError).toBe(false);
  });

  it('retries without encrypted reasoning only when a Responses endpoint explicitly rejects it', async () => {
    setup('responses');
    let n = 0;
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      const body = JSON.parse(String(opts!.body));
      if (++n === 1) {
        expect(body.include).toEqual(['reasoning.encrypted_content']);
        return new Response('reasoning.encrypted_content is not supported', { status: 400 });
      }
      expect(body.include).toBeUndefined();
      return new Response(JSON.stringify(reply('responses', [], 'Done.')));
    }) as typeof fetch);
    const first = await runtime.run(turnRequest(h, dir));
    expect(first.isError).toBe(false);
    expect((await runtime.run(turnRequest(h, dir, { resume: first.sessionId }))).isError).toBe(false);
    expect(n).toBe(3);
  });

  it('redacts bearer credentials in HTTP errors and does not execute tools', async () => {
    setup();
    h.cfg.openai.apiKey = 'test-key';
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async () => new Response('invalid test-key', { status: 401 })) as typeof fetch);
    await expect(runtime.run(turnRequest(h, dir))).rejects.toThrow('HTTP 401: invalid [redacted]');
    await expect(new OpenAIRuntime({ ...h.cfg.openai, baseUrl: 'https://api.openai.com/v1', apiKey: undefined }, dir).checkAuth()).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('forwards cancellation to HTTP requests', async () => {
    setup();
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      requested();
      return new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => reject(opts!.signal!.reason), { once: true }));
    }) as typeof fetch);
    const r = turnRequest(h, dir);
    const run = runtime.run(r);
    const failed = expect(run).rejects.toThrow();
    await started;
    r.abortController.abort();
    await failed;
  });

  it('preserves Responses reasoning items and handles malformed tool arguments within a bounded loop', async () => {
    setup('responses');
    let n = 0;
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async (_url, opts) => {
      const body = JSON.parse(String(opts!.body));
      expect(body.include).toEqual(['reasoning.encrypted_content']);
      if (++n === 2) {
        expect(body.input).toContainEqual({ type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] });
        expect(JSON.stringify(body.input)).toContain('invalid tool arguments');
      }
      return new Response(JSON.stringify({ status: 'completed', output: [
        { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] },
        { type: 'function_call', call_id: `c${n}`, name: 'Write', arguments: '{invalid' },
      ] }));
    }) as typeof fetch);
    const stats = await runtime.run(turnRequest(h, dir, { maxTurns: 2 }));
    expect(stats).toMatchObject({ isError: true, subtype: 'error_max_turns', numTurns: 2 });
  });

  it('rejects truncated responses before executing a tool call', async () => {
    setup();
    const output = reply('chat', [call('write', 'Write', { file_path: 'bad.txt', content: 'no' })]) as any;
    output.choices[0].finish_reason = 'length';
    const runtime = new OpenAIRuntime(h.cfg.openai, h.cfg.dataDir, (async () => new Response(JSON.stringify(output))) as typeof fetch);
    await expect(runtime.run(turnRequest(h, dir))).rejects.toThrow(/length/);
    expect(fs.existsSync(path.join(dir, 'bad.txt'))).toBe(false);
  });
});
