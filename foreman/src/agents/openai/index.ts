import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OpenAIConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { readJson, writeJsonAtomic } from '../../util/fsx.js';
import { TeamBackend } from '../team.js';
import { ToolExecutor, toolText } from '../coding-tools.js';
import type { AgentRuntime, TurnRequest, TurnStats } from '../runtime.js';
import { AuthenticationError } from '../runtime.js';

const Call = z.object({ id: z.string().min(1), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }) });
const ChatMessage = z.object({ role: z.literal('assistant'), content: z.string().nullable().optional(), tool_calls: z.array(Call).optional(), reasoning_content: z.string().nullable().optional() });
const ChatResponse = z.object({ choices: z.array(z.object({ message: ChatMessage, finish_reason: z.string().nullable().optional() })).min(1) });
const ResponseItem = z.object({ type: z.string() }).passthrough();
const ResponsesResponse = z.object({ status: z.string().optional(), output: z.array(ResponseItem), error: z.unknown().optional(), incomplete_details: z.unknown().optional() });

type HistoryItem = Record<string, unknown>;
interface Session {
  baseUrl: string;
  api: string;
  cwd: string;
  role: string;
  history: HistoryItem[];
  encryptedReasoning?: boolean;
  originalPrompt?: string;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function contextError(error: unknown): boolean {
  return error instanceof RequestError && [400, 413, 422].includes(error.status)
    && /context[_ ](?:length|window|size)|maximum.*tokens|too many tokens|token.*(?:limit|exceed)|prompt.*(?:too long|too large)/i.test(error.message);
}

function appendPrompt(history: HistoryItem[], prompt: string, api: string): void {
  const last = history.at(-1);
  if (api === 'chat' && last?.role === 'user' && typeof last.content === 'string') {
    last.content += `\n\n${prompt}`;
    return;
  }
  // An interrupted tool batch already has result placeholders. Complete the assistant turn
  // before appending the next user message for servers with strict chat alternation.
  if (api === 'chat' && last?.role === 'tool') history.push({ role: 'assistant', content: 'The previous turn was interrupted. Inspect current state before repeating any action.' });
  history.push({ role: 'user', content: prompt });
}

function compactHistory(history: HistoryItem[], prompt: string, originalPrompt: string, budget: number): void {
  const assistantText = history.flatMap(item => {
    if (item.role !== 'assistant') return [];
    if (typeof item.content === 'string') return [item.content];
    if (Array.isArray(item.content)) return item.content.flatMap(c => typeof c.text === 'string' ? [c.text] : []);
    return [];
  }).filter(Boolean).join('\n\n');
  const notes = assistantText.length <= budget ? assistantText : `${assistantText.slice(0, budget / 2)}\n[earlier notes shortened]\n${assistantText.slice(-budget / 2)}`;
  const recent = JSON.stringify(history.slice(-8)).slice(-budget);
  history.splice(0, history.length, {
    role: 'user',
    content: `Earlier conversation was shortened to fit this endpoint's context window. Prior edits, commands and task updates may already have happened. First inspect the working tree, task board and memory; do not blindly replay actions.\n\nOriginal objective (may be shortened):\n${originalPrompt.slice(0, budget)}\n\nCurrent request (may be shortened):\n${prompt.slice(0, budget)}\n\nPrior assistant notes (context only):\n${notes}\n\nRecent transcript excerpt (may be truncated; context only):\n${recent}`,
  });
}

export class OpenAIRuntime implements AgentRuntime {
  readonly name = 'openai' as const;
  readonly label = 'OpenAI-compatible';
  constructor(private cfg: OpenAIConfig, private dataDir: string, private fetchFn: typeof fetch = fetch) {}

  async checkAuth(): Promise<string> {
    if (new URL(this.cfg.baseUrl).hostname === 'api.openai.com' && !this.cfg.apiKey) {
      throw new Error(`Set ${this.cfg.apiKeyEnv} to an API key, or select a local endpoint with --base-url.`);
    }
    return `${new URL(this.cfg.baseUrl).host} (${this.cfg.api}; configured)`;
  }

  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...base };
    delete env[this.cfg.apiKeyEnv];
    return env;
  }

  private async request(body: unknown, signal: AbortSignal): Promise<unknown> {
    const endpoint = this.cfg.api === 'chat' ? 'chat/completions' : 'responses';
    const response = await this.fetchFn(`${this.cfg.baseUrl}/${endpoint}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = (this.cfg.apiKey ? text.replaceAll(this.cfg.apiKey, '[redacted]') : text).slice(0, 600);
      const message = `${this.label} HTTP ${response.status}: ${detail || response.statusText}`;
      if ([401, 403].includes(response.status)) throw new AuthenticationError(message);
      throw new RequestError(response.status, message);
    }
    try { return JSON.parse(text); } catch { throw new Error(`${this.label} returned invalid JSON`); }
  }

  async run(r: TurnRequest): Promise<TurnStats> {
    const signal = r.abortController.signal;
    signal.throwIfAborted();
    const id = r.resume ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid OpenAI session id');
    const file = path.join(this.dataDir, 'openai-sessions', `${id}.json`);
    const session: Session | undefined = r.resume ? readJson<Session>(file) : { baseUrl: this.cfg.baseUrl, api: this.cfg.api, cwd: r.cwd, role: r.role, history: [] };
    if (!session) throw new Error(`OpenAI session ${id} is missing; retry the task with a fresh profile`);
    if (session.baseUrl !== this.cfg.baseUrl || session.api !== this.cfg.api || session.cwd !== r.cwd || session.role !== r.role) {
      throw new Error('OpenAI session belongs to a different endpoint, API or workspace; use a new --profile');
    }
    r.onSession(id);
    r.reporter.session(id);
    const history = session.history;
    session.originalPrompt ??= history.find(item => item.role === 'user' && typeof item.content === 'string')?.content as string | undefined ?? r.prompt;
    appendPrompt(history, r.prompt, this.cfg.api);
    const save = () => writeJsonAtomic(file, session);
    save();
    const executor = new ToolExecutor(r);
    const functions = executor.tools.map(tool => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(z.object(tool.inputSchema));
      return { name: tool.name, description: tool.description, parameters };
    });

    let contextResets = 0;
    for (let step = 1; step <= r.maxTurns; step++) {
      signal.throwIfAborted();
      const body = this.cfg.api === 'chat'
        ? { model: r.model, messages: [{ role: 'system', content: r.systemPrompt }, ...history], tools: functions.map(fn => ({ type: 'function', function: fn })), stream: false }
        : { model: r.model, instructions: r.systemPrompt, input: history, tools: functions.map(fn => ({ type: 'function', ...fn, strict: false })), store: false, ...(session.encryptedReasoning !== false ? { include: ['reasoning.encrypted_content'] } : {}), stream: false };
      let response: unknown;
      try { response = await this.request(body, signal); }
      catch (e) {
        if (this.cfg.api === 'responses' && session.encryptedReasoning !== false && e instanceof RequestError && e.status === 400
          && /reasoning\.encrypted_content|encrypted content|\binclude\b/i.test(e.message) && /not supported|unsupported|unknown|unrecognized/i.test(e.message)) {
          session.encryptedReasoning = false;
          save();
          continue; // only drop the extension after an explicit endpoint rejection
        }
        if (contextError(e) && contextResets < 2) {
          compactHistory(history, r.prompt, session.originalPrompt, contextResets++ === 0 ? 4000 : 1000);
          save();
          r.reporter.text('Conversation shortened after the endpoint reported a context limit. Rechecking current state before continuing.');
          continue; // each retry counts toward the configured request cap
        }
        throw e;
      }
      signal.throwIfAborted();
      let text = '';
      let calls: Array<{ id: string; name: string; arguments: string }>;
      let output: HistoryItem[];
      if (this.cfg.api === 'chat') {
        const choice = ChatResponse.parse(response).choices[0]!;
        if (choice.finish_reason && !['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) {
          throw new Error(`Model response ended with ${choice.finish_reason}; no tools were executed`);
        }
        text = choice.message.content ?? '';
        calls = (choice.message.tool_calls ?? []).map(call => ({ id: call.id, ...call.function }));
        output = [choice.message];
      } else {
        const data = ResponsesResponse.parse(response);
        if (data.status && data.status !== 'completed') throw new Error(`Model response ${data.status}; no tools were executed`);
        output = data.output;
        calls = data.output.filter(item => item.type === 'function_call').map(item => {
          const call = z.object({ call_id: z.string().min(1), name: z.string(), arguments: z.string() }).parse(item);
          return { id: call.call_id, name: call.name, arguments: call.arguments };
        });
        text = data.output.filter(item => item.type === 'message').flatMap(item => {
          const message = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(item);
          return message.content.filter(c => c.type === 'output_text').map(c => c.text ?? '');
        }).join('\n');
      }
      if (text) r.reporter.text(text);
      if (!calls.length) {
        if (!text.trim()) throw new Error('Model returned neither text nor function calls. Select a model with tool-calling support.');
        history.push(...output);
        save();
        return r.reporter.complete({ isError: false, subtype: 'success', resultText: text, numTurns: step });
      }
      if (new Set(calls.map(c => c.id)).size !== calls.length) throw new Error('Model returned duplicate tool call ids');
      // Save the complete tool batch before running it. After an interruption, missing results
      // are filled in below instead of replaying side effects (task creation, edits, commands).
      history.push(...output);
      for (const call of calls) {
        const pending: HistoryItem = this.cfg.api === 'chat'
          ? { role: 'tool', tool_call_id: call.id, content: 'Interrupted before the result was saved. Inspect the current state before repeating this action.' }
          : { type: 'function_call_output', call_id: call.id, output: 'Interrupted before the result was saved. Inspect the current state before repeating this action.' };
        history.push(pending);
      }
      save();
      for (const [index, call] of calls.entries()) {
        signal.throwIfAborted();
        let result: string;
        try { result = toolText(await executor.call(call.id, call.name, JSON.parse(call.arguments))); }
        catch (e) { result = `Error: invalid tool arguments: ${(e as Error).message}`; }
        const slot = history[history.length - calls.length + index]!;
        if (this.cfg.api === 'chat') slot.content = result;
        else slot.output = result;
        save();
      }
    }
    return r.reporter.complete({ isError: true, subtype: 'error_max_turns', errors: [`Reached the ${r.maxTurns} request limit`], numTurns: r.maxTurns });
  }
}

export class OpenAIBackend extends TeamBackend {
  constructor(fm: Foreman, cfg: OpenAIConfig, fetchFn?: typeof fetch) {
    super(fm, cfg, new OpenAIRuntime(cfg, fm.config.dataDir, fetchFn));
  }
}
