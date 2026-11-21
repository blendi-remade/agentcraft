// Map Codex app-server events -> agent.log entries + agent state/station (like claude/stream.ts).
import type { Foreman } from '../../foreman.js';
import { firstLine, headLines, tailLines, truncate } from '../../util/text.js';
import { relPath, toolActivity } from '../activity.js';
import type { Role, TurnStats } from '../engine.js';
import { StreamParamsSchema, parsed, type Item } from './wire.js';

/**
 * Codex runs a command through a shell wrapper (Windows: `"...\powershell.exe" -Command '...'`,
 * elsewhere `bash -lc '...'`). The inner command is what the agent asked for: the policy checks it
 * and the monitor shows it.
 */
export function shellCommand(command: string): { tool: 'Bash' | 'PowerShell'; command: string } {
  const m = /^\s*"?(?:[^"]*[\\/])?(powershell|pwsh|bash|zsh|sh)(?:\.exe)?"?((?:\s+-(?!c\b|command\b|lc\b)[a-zA-Z]+)*)\s+-(?:c|command|lc)\s+([\s\S]+)$/i.exec(command);
  if (!m) return { tool: 'Bash', command };
  const shell = m[1]!.toLowerCase();
  const raw = m[3]!.trim();
  const inner = /^['"]/.test(raw) ? (shellWord(raw) ?? raw) : raw;
  return { tool: shell === 'powershell' || shell === 'pwsh' ? 'PowerShell' : 'Bash', command: inner };
}

/**
 * Codex shows a command's argument shell-quoted (shlex style, on every platform): adjacent '...'
 * and "..." pieces form one word, e.g. 'a '"'"'b'"'"'' is a 'b'. Returns the word's text, or
 * undefined when the text is not exactly one word (then it is shown as it is).
 */
function shellWord(s: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1]!)) i++;
        out += s[i++];
      }
      if (i >= s.length) return undefined;
      i++;
    } else if (/\s/.test(c)) {
      return undefined; // a second word
    } else {
      if (c === '\\' && i + 1 < s.length) i++;
      out += s[i++];
    }
  }
  return out;
}

export class CodexStreamMapper {
  readonly stats: TurnStats = { isError: false, errors: [] };
  private items = new Map<string, Item>();
  private steps = 0;
  private finalText: string | undefined;

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: Role,
  ) {}

  /** Paths a file change (by item id) touches, for its approval. */
  fileChangePaths(itemId: string): string[] {
    const it = this.items.get(itemId);
    return Array.isArray(it?.changes) ? it.changes.map((c: { path: string }) => c.path) : [];
  }

  private set(patch: Parameters<Foreman['setAgent']>[1]): void {
    const a = this.fm.agent(this.agentId);
    // a pending question/permission keeps the agent at the user
    if (a?.state === 'waiting_user' && patch.state !== 'waiting_user') return;
    this.fm.setAgent(this.agentId, patch);
  }

  private refreshSoon(): void {
    if (this.role !== 'worker') return;
    const repoId = this.fm.agent(this.agentId)?.repoId;
    if (repoId) this.fm.repos.scheduleRefresh(repoId, 1500);
  }

  handle(method: string, params: unknown): void {
    const p = parsed(StreamParamsSchema, params, {});
    const fm = this.fm;
    const id = this.agentId;
    switch (method) {
      case 'item/started': {
        const it = p.item;
        if (!it) break;
        this.items.set(it.id, it);
        if (it.type === 'commandExecution') {
          const sc = shellCommand(String(it.command ?? ''));
          const act = toolActivity(sc.tool, { command: sc.command }, this.cwd);
          fm.agentLog(id, 'tool', act.label);
          this.set({ state: act.state, station: act.station, activity: act.activity });
          this.refreshSoon();
        } else if (it.type === 'fileChange') {
          const changes = it.changes ?? [];
          const files = changes.map((c) => relPath(c.path, this.cwd));
          const act = toolActivity(changes[0]?.kind?.type === 'add' ? 'Write' : 'Edit', { file_path: changes[0]?.path ?? '' }, this.cwd);
          fm.agentLog(id, 'tool', files.length > 1 ? `Edit ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` +${files.length - 4}` : ''}` : act.label);
          const first = changes[0];
          if (first?.diff) {
            const lines = first.diff.replace(/\r\n/g, '\n').split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
            if (lines.length) fm.agentLog(id, 'diff', [relPath(first.path, this.cwd), ...lines.slice(0, 12).map((l) => `${l[0]} ${l.slice(1)}`)].join('\n'));
          }
          this.set({ state: act.state, station: act.station, activity: act.activity });
          this.refreshSoon();
        } else if (it.type === 'dynamicToolCall') {
          const act = toolActivity(String(it.tool ?? '?'), it.arguments ?? {}, this.cwd);
          fm.agentLog(id, 'tool', act.label);
          this.set({ state: act.state, station: act.station, activity: act.activity });
        } else if (it.type === 'reasoning') {
          this.set({ state: 'thinking', activity: 'thinking' });
        } else if (it.type === 'mcpToolCall') {
          fm.agentLog(id, 'tool', `${it.server ?? 'mcp'}: ${it.tool ?? '?'}`);
        } else if (it.type === 'webSearch') {
          fm.agentLog(id, 'tool', `web search ${it.query ?? ''}`.trim());
          this.set({ state: 'reading', station: 'library', activity: 'searching the web' });
        }
        break;
      }
      case 'item/completed': {
        const it = p.item;
        if (!it) break;
        this.items.set(it.id, { ...this.items.get(it.id), ...it });
        if (it.type === 'agentMessage') {
          const text = String(it.text ?? '').trim();
          if (!text) break;
          fm.agentLog(id, 'text', truncate(text, 1200));
          this.set({ state: 'thinking', activity: firstLine(text, 48) });
          if (it.phase === 'final_answer' || it.phase == null) this.finalText = text;
        } else if (it.type === 'commandExecution') {
          this.steps++;
          const out = String(it.aggregatedOutput ?? '');
          if (it.status === 'declined') fm.agentLog(id, 'error', 'command not run (declined)');
          else if (it.status === 'failed' || (typeof it.exitCode === 'number' && it.exitCode !== 0)) fm.agentLog(id, 'error', truncate(`exit ${it.exitCode ?? '?'}${out ? `\n${tailLines(out, 6, 700)}` : ''}`, 800));
          else fm.agentLog(id, 'result', tailLines(out, 8, 900) || '(no output)');
          this.refreshSoon();
        } else if (it.type === 'fileChange') {
          this.steps++;
          fm.agentLog(id, it.status === 'completed' ? 'result' : 'error', it.status === 'completed' ? 'ok' : `edit ${it.status ?? 'failed'}`);
          this.refreshSoon();
        } else if (it.type === 'dynamicToolCall') {
          this.steps++;
          const text = (it.contentItems ?? []).map((c) => c.text ?? '').join('\n');
          fm.agentLog(id, it.success === false ? 'error' : 'result', it.success === false ? truncate(text || 'tool error', 600) : headLines(text, 3, 300) || 'ok');
        } else if (it.type === 'reasoning') {
          const summary = (it.summary ?? []).join(' ').trim();
          if (summary) fm.agentLog(id, 'text', `~ ${truncate(summary.replace(/\s+/g, ' '), 300)}`);
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const last = p.tokenUsage?.last?.totalTokens;
        if (typeof last === 'number') this.stats.tokens = (this.stats.tokens ?? 0) + last;
        break;
      }
      case 'error': {
        const msg = String(p.error?.message ?? 'error');
        fm.agentLog(id, 'error', `${p.willRetry ? 'retrying: ' : ''}${truncate(msg, 400)}`);
        if (!p.willRetry) this.stats.errors.push(msg);
        if (p.error?.codexErrorInfo === 'unauthorized') this.stats.authFailed = firstLine(msg, 200);
        break;
      }
      case 'account/rateLimits/updated': {
        const r = p.rateLimits;
        if (r?.rateLimitReachedType) {
          fm.agentLog(id, 'error', `rate limited (${r.rateLimitReachedType}); waiting...`);
          this.set({ state: 'blocked', activity: 'rate limited - waiting' });
        }
        break;
      }
      case 'turn/completed': {
        const turn = p.turn ?? {};
        const status = String(turn.status ?? 'failed');
        this.stats.subtype = status === 'completed' ? 'success' : status === 'interrupted' ? 'interrupted' : 'error_during_execution';
        this.stats.isError = status !== 'completed';
        this.stats.numTurns = this.steps;
        if (this.finalText) this.stats.resultText = this.finalText;
        if (turn.error?.message) {
          this.stats.errors.push(String(turn.error.message));
          if (turn.error.codexErrorInfo === 'unauthorized') this.stats.authFailed = firstLine(String(turn.error.message), 200);
          if (turn.error.codexErrorInfo === 'usageLimitExceeded') this.stats.subtype = 'error_usage_limit';
        }
        const tokens = this.stats.tokens ? ` · ${Math.round(this.stats.tokens / 1000)}k tokens` : '';
        fm.agentLog(id, this.stats.isError ? 'error' : 'result', `turn ${status === 'completed' ? 'complete' : `ended: ${status}${turn.error?.message ? ` (${truncate(String(turn.error.message), 160)})` : ''}`} (${this.steps} steps${tokens})`);
        break;
      }
    }
  }
}
