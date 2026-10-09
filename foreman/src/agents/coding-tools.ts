// Coding tools for API models and the Codex MCP bridge. Every invocation uses the same policy
// callback as Claude; providers never get direct access to the filesystem or command runner.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { glob } from 'tinyglobby';
import { z } from 'zod';
import { isInsideOrEqual } from '../util/fsx.js';
import { descendantsOf, killTree, killSnapshot, orphansOf, processTable } from '../util/proc.js';
import { bashExecutable } from '../util/bash.js';
import { defineTool, type AgentTool, type TurnRequest } from './runtime.js';
import type { ToolResult } from './tools.js';

const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 24_000;
export const toolResult = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
export const toolText = (result: ToolResult): string => result.content.map(c => c.text).join('\n');

async function readText(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Read expects a file. Use Glob to list files.');
  if (stat.size > MAX_FILE) throw new Error('File exceeds the 1 MiB text limit. Ask a worker to extract the needed section into a smaller text file.');
  const text = await fs.readFile(file, 'utf8');
  if (text.includes('\0')) throw new Error('Binary files are not supported by this text tool.');
  return text;
}

async function files(root: string, pattern: string): Promise<string[]> {
  const matches = await glob(pattern, { cwd: root, absolute: true, dot: true, followSymbolicLinks: false, onlyFiles: true, ignore: ['**/.git/**', '**/node_modules/**'] });
  // Even an absolute glob or ../ pattern cannot widen the directory checked by the policy.
  const realRoot = await fs.realpath(root);
  const safe: string[] = [];
  for (const file of matches.sort()) {
    if (isInsideOrEqual(file, root) && isInsideOrEqual(await fs.realpath(file), realRoot)) safe.push(file);
    if (safe.length >= 500) break;
  }
  return safe;
}

export async function shellCommand(command: string, r: TurnRequest, timeoutMs: number, signal = r.abortController.signal): Promise<ToolResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const env = { ...r.env };
    delete env.BASH_ENV;
    delete env.ENV;
    const child = spawn(bashExecutable(env), ['--noprofile', '--norc', '-c', command], { cwd: r.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    let orphanedPipes = false;
    const append = (chunk: string) => { output = (output + chunk).slice(-MAX_OUTPUT); };
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    let terminating: Promise<void> | undefined;
    const terminate = (): Promise<void> => terminating ??= (async () => {
      if (!child.pid) return;
      orphanedPipes = child.exitCode !== null && !child.stdout.readableEnded;
      if (process.platform !== 'win32') {
        // Snapshot while the leader is alive, to also find descendants with their own group.
        const tree = child.exitCode === null ? await processTable() : undefined;
        // A background child may still hold stdout after the shell itself exited. Kill our
        // process group even then; killTree intentionally skips already-exited leaders.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
        if (tree) await killSnapshot(descendantsOf(tree, child.pid));
      } else {
        killTree(child); // stop live descendants before the slower orphan scan
        const table = await processTable();
        if (table) await killSnapshot(orphansOf(table, child.pid, startedAt), table);
      }
      killTree(child);
      if (signal.aborted || timedOut) {
        // A reparented daemon may retain our pipe even after its original shell exited.
        // It must not prevent timeout/cancellation from settling the owned command.
        child.stdout.destroy();
        child.stderr.destroy();
      }
    })();
    const abort = () => { void terminate(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; void terminate(); }, timeoutMs);
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', async code => {
      clean();
      await terminate();
      const stopped = signal.aborted ? 'Command stopped.' : timedOut ? 'Command timed out.' : `Exit code: ${code}`;
      const cleanup = orphanedPipes ? '\nOutput pipes closed after the shell exited. A detached daemon may still be running; inspect it before reusing its files.' : '';
      resolve(toolResult(`${output}\n${stopped}${cleanup}`, code !== 0 || timedOut || signal.aborted));
    });
  });
}

export function codingTools(r: TurnRequest): AgentTool[] {
  const tools = [
    defineTool('Read', 'Read a UTF-8 file. Paths are relative to the current worktree unless absolute.', {
      file_path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(500).optional(),
    }, async ({ file_path, offset = 1, limit = 200 }) => {
      const lines = (await readText(path.resolve(r.cwd, file_path))).split('\n');
      return toolResult(lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}\t${line}`).join('\n').slice(0, MAX_OUTPUT));
    }),
    defineTool('Glob', 'Find files with a glob pattern (for example **/*.ts). Excludes .git and node_modules; up to 500 matches.', {
      pattern: z.string(), path: z.string().optional(),
    }, async a => {
      const root = path.resolve(r.cwd, a.path ?? '.');
      return toolResult((await files(root, a.pattern)).map(f => path.relative(root, f)).join('\n').slice(0, MAX_OUTPUT) || 'No matches.');
    }),
    defineTool('Grep', 'Search literal text in UTF-8 files. Returns path:line:content; up to 100 matches in the first 500 files. Use glob to narrow the search.', {
      pattern: z.string().min(1), path: z.string().optional(), glob: z.string().optional(), case_insensitive: z.boolean().optional(),
    }, async (a, signal = r.abortController.signal) => {
      const root = path.resolve(r.cwd, a.path ?? '.');
      const candidates = (await fs.stat(root)).isFile() ? [root] : await files(root, a.glob ?? '**/*');
      const needle = a.case_insensitive ? a.pattern.toLowerCase() : a.pattern;
      const hits: string[] = [];
      for (const file of candidates) {
        signal.throwIfAborted();
        let text: string;
        try { text = await readText(file); } catch { continue; }
        for (const [i, line] of text.split('\n').entries()) {
          if ((a.case_insensitive ? line.toLowerCase() : line).includes(needle)) hits.push(`${path.relative(r.cwd, file)}:${i + 1}:${line}`);
          if (hits.length >= 100) break;
        }
        if (hits.length >= 100) break;
      }
      return toolResult(hits.join('\n').slice(0, MAX_OUTPUT) || 'No matches.');
    }),
  ];
  if (r.role === 'worker') tools.push(
    defineTool('Write', 'Create or replace a UTF-8 file in your worktree.', { file_path: z.string(), content: z.string().max(MAX_FILE) }, async (a, signal = r.abortController.signal) => {
      const file = path.resolve(r.cwd, a.file_path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      signal.throwIfAborted();
      await fs.writeFile(file, a.content, 'utf8');
      return toolResult('File written.');
    }),
    defineTool('Edit', 'Replace one exact, unique occurrence in a UTF-8 file. Read the file first; include enough surrounding text to make the match unique.', {
      file_path: z.string(), old_string: z.string().min(1), new_string: z.string().max(MAX_FILE),
    }, async (a, signal = r.abortController.signal) => {
      const file = path.resolve(r.cwd, a.file_path);
      const original = await readText(file);
      if (!original.includes(a.old_string)) throw new Error('old_string was not found. Read the file and try again.');
      if (original.indexOf(a.old_string) !== original.lastIndexOf(a.old_string)) throw new Error('old_string occurs more than once. Include more context.');
      signal.throwIfAborted();
      await fs.writeFile(file, original.replace(a.old_string, () => a.new_string), 'utf8');
      return toolResult('File edited.');
    }),
  );
  tools.push(
    defineTool('Bash', r.role === 'lead'
      ? 'Inspect the repository with read-only shell commands. Workers make changes and run tests in their own worktrees.'
      : 'Run a shell command in your worktree. Risky commands require user approval through AgentCraft. Use for tests and build commands.', {
      command: z.string().min(1), timeout_ms: z.number().int().min(1).max(600_000).optional(),
    }, (a, signal) => shellCommand(a.command, r, a.timeout_ms ?? 120_000, signal)),
  );
  return tools;
}

export class ToolExecutor {
  readonly tools: AgentTool[];
  private teamNames: Set<string>;
  constructor(private r: TurnRequest) {
    this.teamNames = new Set(r.tools.map(t => t.name));
    this.tools = [...r.tools, ...codingTools(r)];
  }

  async call(id: string, name: string, args: unknown, requestSignal?: AbortSignal): Promise<ToolResult> {
    const signal = requestSignal ? AbortSignal.any([this.r.abortController.signal, requestSignal]) : this.r.abortController.signal;
    if (signal.aborted) return toolResult('Your turn was stopped; nothing was changed.', true);
    const tool = this.tools.find(t => t.name === name);
    if (!tool) return toolResult(`Unknown or unavailable tool: ${name}`, true);
    let result: ToolResult;
    const policyName = this.teamNames.has(name) ? `mcp__agentcraft__${name}` : name;
    try {
      const input = z.object(tool.inputSchema).parse(args);
      // Resolve paths once, exactly as the actual filesystem operation does (no tilde expansion).
      for (const key of ['file_path', 'path']) {
        if (typeof input[key] === 'string') input[key] = path.resolve(this.r.cwd, input[key] as string);
      }
      this.r.reporter.tool(id, policyName, input);
      const permission = await this.r.canUseTool(policyName, input, { signal });
      signal.throwIfAborted();
      result = permission.behavior === 'allow' ? await tool.handler(permission.updatedInput, signal) : toolResult(permission.message, true);
    } catch (e) {
      result = toolResult((e as Error).message, true);
    }
    if (!signal.aborted) this.r.reporter.result(id, toolText(result), result.isError);
    return result;
  }
}
