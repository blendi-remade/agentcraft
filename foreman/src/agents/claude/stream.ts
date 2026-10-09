// Map Agent SDK stream messages -> agent.log entries + agent state/station.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Foreman } from '../../foreman.js';
import { firstLine, headLines, tailLines, truncate } from '../../util/text.js';
import { relPath, toolActivity } from '../activity.js';

export type { TurnStats } from '../runtime.js';
import type { TurnStats } from '../runtime.js';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const AUTH_RE = /(authentication|not logged in|log ?in|\/login|invalid api key|oauth|401|credential)/i;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

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

export class StreamMapper {
  private toolNames = new Map<string, string>();
  readonly stats: TurnStats = { isError: false, errors: [] };
  /** the model the CLI reported at init */
  model: string | undefined;

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: 'lead' | 'worker',
  ) {}

  handle(msg: SDKMessage): void {
    const fm = this.fm;
    const id = this.agentId;
    switch (msg.type) {
      case 'system': {
        const m = msg as { subtype?: string; session_id?: string; model?: string };
        if (m.subtype === 'init' && m.session_id) {
          this.stats.sessionId = m.session_id;
          if (m.model) this.model = m.model;
          fm.log.debug(`${id}: session ${m.session_id} (${m.model ?? '?'})`);
        }
        break;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) break; // subagent chatter (disabled anyway)
        if (msg.error) {
          const err = String(msg.error);
          this.stats.errors.push(err);
          if (err === 'authentication_failed' || err === 'oauth_org_not_allowed') this.stats.authFailed = err;
          fm.agentLog(id, 'error', `API error: ${err}`);
        }
        this.stats.sessionId ??= msg.session_id;
        const blocks = (msg.message?.content ?? []) as Block[];
        for (const b of blocks) {
          if (b.type === 'text' && b.text?.trim()) {
            fm.agentLog(id, 'text', truncate(b.text.trim(), 1200));
            const a = fm.agent(id);
            if (a && a.state !== 'waiting_user') fm.setAgent(id, { state: 'thinking', activity: firstLine(b.text, 48) });
          } else if (b.type === 'thinking') {
            const a = fm.agent(id);
            if (a && a.state !== 'waiting_user') fm.setAgent(id, { state: 'thinking', activity: 'thinking' });
            if (b.thinking?.trim()) fm.agentLog(id, 'text', `~ ${truncate(b.thinking.trim().replace(/\s+/g, ' '), 300)}`);
          } else if (b.type === 'tool_use' && b.name && b.id) {
            this.toolNames.set(b.id, b.name);
            const input = (b.input ?? {}) as Record<string, unknown>;
            const act = toolActivity(b.name, input, this.cwd);
            fm.agentLog(id, 'tool', act.label);
            const diff = diffFromInput(b.name, input, this.cwd);
            if (diff) fm.agentLog(id, 'diff', diff);
            fm.setAgent(id, { state: act.state, station: act.station, activity: act.activity });
            if ((act.state === 'editing' || act.state === 'running' || act.state === 'testing') && this.role === 'worker') {
              const repoId = fm.agent(id)?.repoId;
              if (repoId) fm.repos.scheduleRefresh(repoId, 1500);
            }
          }
        }
        break;
      }
      case 'user': {
        if (msg.parent_tool_use_id) break;
        const content = (msg.message as { content?: unknown }).content;
        if (!Array.isArray(content)) break;
        for (const b of content as Block[]) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          const tool = this.toolNames.get(b.tool_use_id) ?? '?';
          const text = resultText(b.content);
          if (tool.startsWith('mcp__') && !b.is_error) {
            fm.agentLog(id, 'result', headLines(text, 3, 300) || 'ok');
          } else {
            fm.agentLog(id, b.is_error ? 'error' : 'result', b.is_error ? truncate(text || 'tool error', 600) : summarizeResult(tool, text));
          }
        }
        break;
      }
      case 'result': {
        this.stats.subtype = msg.subtype;
        this.stats.isError = msg.is_error || msg.subtype !== 'success';
        this.stats.costUsd = msg.total_cost_usd;
        this.stats.numTurns = msg.num_turns;
        this.stats.sessionId ??= msg.session_id;
        if (msg.subtype === 'success') {
          this.stats.resultText = msg.result;
          if (msg.is_error && AUTH_RE.test(msg.result)) this.stats.authFailed = firstLine(msg.result, 200);
        } else {
          this.stats.errors.push(...(msg.errors ?? []));
          const joined = (msg.errors ?? []).join(' ');
          if (AUTH_RE.test(joined)) this.stats.authFailed = firstLine(joined, 200);
        }
        const cost = typeof msg.total_cost_usd === 'number' ? ` · $${msg.total_cost_usd.toFixed(3)}` : '';
        fm.agentLog(id, this.stats.isError ? 'error' : 'result', `turn ${msg.subtype === 'success' && !msg.is_error ? 'complete' : `ended: ${msg.subtype}`} (${msg.num_turns} steps${cost})`);
        break;
      }
      default: {
        const t = (msg as { type: string; subtype?: string }).type;
        if (t === 'rate_limit_event') {
          const info = (msg as { rate_limit_info?: { status?: string; utilization?: number; rateLimitType?: string } }).rate_limit_info;
          if (info?.status === 'rejected') {
            fm.agentLog(id, 'error', `rate limited (${info.rateLimitType ?? 'limit'}); waiting...`);
            fm.setAgent(id, { state: 'blocked', activity: 'rate limited - waiting' });
          } else if (info?.status === 'allowed_warning') {
            fm.agentLog(id, 'text', `usage warning: ${info.rateLimitType ?? 'limit'} ${info.utilization !== undefined ? `${Math.round(info.utilization * 100)}%` : ''}`.trim());
          }
        }
        if (t === 'auth_status') {
          const m = msg as { error?: string };
          if (m.error) this.stats.authFailed = m.error;
        }
      }
    }
  }
}
