// Provider-neutral turn events -> Minecraft activity and monitor logs.
import type { Foreman } from '../foreman.js';
import { firstLine, headLines, tailLines, truncate } from '../util/text.js';
import { relPath, toolActivity } from './activity.js';
import type { TurnStats } from './runtime.js';

/** Short human summary of a tool result for the monitor. */
function summarizeResult(tool: string, text: string): string {
  const name = tool.startsWith('mcp__') ? tool.split('__').pop()! : tool;
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
  switch (name) {
    case 'Read':
      return `${lines.length} lines`;
    case 'Grep':
    case 'Glob':
    case 'LS':
      return lines.length ? `${lines.length} results\n${headLines(lines.join('\n'), 4, 400)}` : 'no matches';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return firstLine(text, 160) || 'ok';
    case 'Bash':
    case 'PowerShell':
      return tailLines(text, 8, 900) || '(no output)';
    default:
      return headLines(text, 4, 500) || 'ok';
  }
}

/** -/+ lines from an Edit/Write tool input, for a `diff` log entry. */
function diffFromInput(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const file = typeof input.file_path === 'string' ? relPath(input.file_path, cwd) : '?';
  const clip = (s: string, n: number) => s.replace(/\r\n/g, '\n').split('\n').slice(0, n);
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const out = [file, ...clip(input.old_string, 6).map((l) => `- ${l}`), ...clip(input.new_string, 8).map((l) => `+ ${l}`)];
    return out.join('\n');
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const out = [file];
    for (const e of (input.edits as Array<{ old_string?: string; new_string?: string }>).slice(0, 3)) {
      out.push(...clip(e.old_string ?? '', 3).map((l) => `- ${l}`), ...clip(e.new_string ?? '', 4).map((l) => `+ ${l}`));
    }
    return out.join('\n');
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    const all = input.content.split('\n');
    return [`${file} (${all.length} lines)`, ...clip(input.content, 10).map((l) => `+ ${l}`)].join('\n');
  }
  return undefined;
}

export class TurnReporter {
  private toolNames = new Map<string, string>();
  readonly stats: TurnStats = { isError: false, errors: [] };

  constructor(private fm: Foreman, private agentId: string, private cwd: string, private role: 'lead' | 'worker') {}

  session(id: string): void { this.stats.sessionId = id; }

  text(text: string): void {
    if (!text.trim()) return;
    this.fm.agentLog(this.agentId, 'text', truncate(text.trim(), 1200));
    const a = this.fm.agent(this.agentId);
    if (a && a.state !== 'waiting_user') this.fm.setAgent(this.agentId, { state: 'thinking', activity: firstLine(text, 48) });
  }

  tool(id: string, name: string, input: Record<string, unknown>): void {
    this.toolNames.set(id, name);
    const act = toolActivity(name, input, this.cwd);
    this.fm.agentLog(this.agentId, 'tool', act.label);
    const diff = diffFromInput(name, input, this.cwd);
    if (diff) this.fm.agentLog(this.agentId, 'diff', diff);
    this.fm.setAgent(this.agentId, { state: act.state, station: act.station, activity: act.activity });
    if (['editing', 'running', 'testing'].includes(act.state) && this.role === 'worker') {
      const repoId = this.fm.agent(this.agentId)?.repoId;
      if (repoId) this.fm.repos.scheduleRefresh(repoId, 1500);
    }
  }

  result(id: string, text: string, isError = false): void {
    const tool = this.toolNames.get(id) ?? '?';
    this.fm.agentLog(this.agentId, isError ? 'error' : 'result', isError ? truncate(text || 'tool error', 600)
      : tool.startsWith('mcp__') ? headLines(text, 3, 300) || 'ok' : summarizeResult(tool, text));
  }

  complete(stats: Partial<TurnStats>): TurnStats {
    Object.assign(this.stats, stats);
    this.stats.subtype ??= this.stats.isError ? 'error' : 'success';
    const cost = typeof this.stats.costUsd === 'number' ? ` · $${this.stats.costUsd.toFixed(3)}` : '';
    const tokens = typeof this.stats.tokens === 'number' ? ` · ${Math.round(this.stats.tokens / 1000)}k tokens` : '';
    this.fm.agentLog(this.agentId, this.stats.isError ? 'error' : 'result',
      `turn ${this.stats.isError ? `ended: ${this.stats.subtype}` : 'complete'} (${this.stats.numTurns ?? 1} steps${cost}${tokens})`);
    if (this.stats.isError) {
      for (const error of [...new Set(this.stats.errors)].slice(0, 5)) this.fm.agentLog(this.agentId, 'error', truncate(error, 1200));
    }
    return this.stats;
  }
}
