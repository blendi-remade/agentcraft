import type { Foreman } from '../../foreman.js';
import { headLines, tailLines, truncate } from '../../util/text.js';
import { toolActivity } from '../activity.js';

export interface CodexTurnStats {
  sessionId?: string;
  model?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  errors: string[];
}

type JsonRecord = Record<string, unknown>;
const COMMAND_OUTPUT_TAIL_CHARS = 16_384;
const RESPONSE_LOG_CHARS = 1200;
const MAX_PENDING_RESPONSES = 16;

function appendOutputTail(previous: string, delta: string): string {
  const combined = previous + delta;
  if (combined.length <= COMMAND_OUTPUT_TAIL_CHARS) return combined;
  // Copy the suffix: a V8 sliced string can otherwise retain the entire large source string.
  return Buffer.from(combined.slice(-COMMAND_OUTPUT_TAIL_CHARS), 'utf16le').toString('utf16le');
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? (value as JsonRecord) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Translate app-server notifications into the same live monitor and agent states as Claude. */
export class CodexStreamMapper {
  readonly stats: CodexTurnStats = { isError: false, errors: [] };
  private commandOutput = new Map<string, string>();
  private agentMessages = new Map<string, string>();

  constructor(private readonly fm: Foreman, private readonly agentId: string, private readonly cwd: string, private readonly role: 'lead' | 'worker') {}

  handle(method: string, params: JsonRecord): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = text(params.delta);
        if (!delta) break;
        const id = text(params.itemId);
        if (!this.agentMessages.has(id) && this.agentMessages.size >= MAX_PENDING_RESPONSES) {
          this.flushMessage(this.agentMessages.keys().next().value!);
        }
        // The authoritative completed item supplies the whole response. Retain only a bounded
        // prefix for interrupted turns; token fragments are not useful as individual log rows.
        const previous = this.agentMessages.get(id) ?? '';
        this.agentMessages.set(id, (previous + delta.slice(0, RESPONSE_LOG_CHARS + 1)).slice(0, RESPONSE_LOG_CHARS + 1));
        break;
      }
      case 'item/commandExecution/outputDelta':
      case 'command/exec/outputDelta': {
        const delta = text(params.delta);
        if (!delta) break;
        const itemId = text(params.itemId);
        this.commandOutput.set(itemId, appendOutputTail(this.commandOutput.get(itemId) ?? '', delta));
        this.fm.agentLog(this.agentId, 'text', delta);
        break;
      }
      case 'item/started':
        this.started(record(params.item));
        break;
      case 'item/completed':
        this.completed(record(params.item));
        break;
      case 'turn/completed':
        this.completedTurn(record(params.turn));
        break;
      case 'turn/diff/updated': {
        const diff = text(params.diff);
        if (diff) this.fm.agentLog(this.agentId, 'diff', truncate(diff, 1800));
        break;
      }
      case 'warning': {
        const message = text(params.message);
        if (message) this.fm.agentLog(this.agentId, 'text', `Codex: ${truncate(message, 400)}`);
        break;
      }
    }
  }

  private flushMessage(id: string, completedText?: string): void {
    const body = (completedText || this.agentMessages.get(id) || '').trim();
    // Completed responses use Foreman's normal log limit; the smaller prefix is
    // only for interrupted streams that never supplied an authoritative item.
    if (body) this.fm.agentLog(this.agentId, 'text', completedText ? body : truncate(body, RESPONSE_LOG_CHARS));
    this.agentMessages.delete(id);
  }

  private started(item: JsonRecord): void {
    const kind = text(item.type);
    if (kind === 'commandExecution') {
      const command = text(item.command);
      const activity = toolActivity('Bash', { command }, this.cwd);
      this.fm.setAgent(this.agentId, { state: activity.state, station: activity.station, activity: activity.activity });
      this.fm.agentLog(this.agentId, 'tool', activity.label);
    } else if (kind === 'fileChange') {
      const activity = toolActivity('Edit', {}, this.cwd);
      this.fm.setAgent(this.agentId, { state: activity.state, station: activity.station, activity: activity.activity });
      this.fm.agentLog(this.agentId, 'tool', 'Codex is applying a file change');
    } else if (kind === 'agentMessage') {
      this.fm.setAgent(this.agentId, { state: 'thinking', station: this.role === 'lead' ? 'meeting' : 'desk', activity: 'writing a response' });
    }
  }

  private completed(item: JsonRecord): void {
    const kind = text(item.type);
    if (kind === 'agentMessage') {
      const body = text(item.text);
      this.flushMessage(text(item.id), body);
      this.stats.resultText = body || this.stats.resultText;
      return;
    }
    if (kind === 'commandExecution') {
      const id = text(item.id);
      const status = text(item.status);
      const output = text(item.aggregatedOutput) || this.commandOutput.get(id) || '';
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      const failed = status === 'failed' || (exitCode !== undefined && exitCode !== 0);
      const summary = tailLines(output, 8, 900) || (exitCode === undefined ? status : `exit ${exitCode}`);
      this.fm.agentLog(this.agentId, failed ? 'error' : 'result', summary);
      this.commandOutput.delete(id);
    } else if (kind === 'fileChange') {
      this.fm.agentLog(this.agentId, 'result', 'File change applied');
    }
  }

  private completedTurn(turn: JsonRecord): void {
    this.commandOutput.clear();
    for (const id of this.agentMessages.keys()) this.flushMessage(id);
    const status = text(turn.status);
    this.stats.subtype = status || 'unknown';
    this.stats.isError = status !== 'completed';
    const err = record(turn.error);
    if (this.stats.isError) {
      const message = text(err.message) || status || 'Codex turn failed';
      this.stats.errors.push(message);
    }
    this.stats.numTurns = 1;
    this.fm.agentLog(this.agentId, this.stats.isError ? 'error' : 'result', `Codex turn ${this.stats.isError ? `ended: ${status}` : 'complete'}`);
  }
}

export function codexToolStarted(fm: Foreman, agentId: string, cwd: string, name: string, args: JsonRecord): void {
  const activity = toolActivity(name, args, cwd);
  fm.setAgent(agentId, { state: activity.state, station: activity.station, activity: activity.activity });
  fm.agentLog(agentId, 'tool', activity.label);
}

export function codexToolResult(fm: Foreman, agentId: string, result: { text: string; success: boolean }): void {
  fm.agentLog(agentId, result.success ? 'result' : 'error', result.success ? headLines(result.text, 4, 500) || 'ok' : tailLines(result.text, 8, 800));
}
