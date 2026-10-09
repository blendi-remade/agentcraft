// Durable state. Everything the Foreman knows lives under `dir` (a profile directory inside
// AGENTCRAFT_HOME) and survives restarts:
//
//   <dir>/state.json            agents, tasks, decisions, repos, goals, feed, messages, sessions...
//   <dir>/logs/<agentId>.jsonl  append-only agent logs (the snapshot carries a tail); rotated at
//                               8 MB into <agentId>.1.jsonl (one old file kept)
//   <dir>/foreman.json          {pid, port, ...} of the Foreman running this profile (see runfile.ts)
//   <dir>/memory/**.md          markdown memory (see memory.ts)
//   <dir>/worktrees/<repo>/<wt> git worktrees for workers (see repos.ts)
//
// state.json is written atomically (temp + fsync + rename), debounced, and flushed on exit.
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Decision, FeedItem, Goal, LogEntry, Repo, Task } from './protocol.js';
import { ensureDir, readJson, writeJsonAtomic } from './util/fsx.js';

export interface BusMessage {
  id: string;
  ts: number;
  from: string; // agent id or "user"
  to: string; // agent id, "user" or "all"
  text: string;
  /** agent ids that have consumed this message */
  readBy: string[];
}

export interface SessionRecord {
  provider?: import('./protocol.js').BackendName;
  sessionId?: string;
  model?: string;
  /** the engine whose session this is (absent: claude, from before engines) */
  engine?: 'claude' | 'codex' | 'openai';
  turns: number;
  costUsd: number;
  updatedAt: number;
  /** why the last turn ended (for resume decisions) */
  lastResult?: string;
}

export interface WorktreeMeta {
  /** base sha recorded at merge time so merged diffs stay viewable */
  mergedBaseSha?: string;
  mergedSha?: string;
  createdAt: number;
  /** the directory of a finished worktree could not be removed yet (busy); retried later */
  pendingRemoval?: boolean;
}

export interface StateData {
  version: 1;
  createdAt: number;
  agents: Agent[];
  tasks: Task[];
  decisions: Decision[];
  repos: Repo[];
  goals: Goal[];
  feed: FeedItem[];
  messages: BusMessage[];
  counters: Record<string, number>;
  sessions: Record<string, SessionRecord>;
  worktreeMeta: Record<string, WorktreeMeta>; // key: `${repoId}/${worktreeId}`
  permissionRules: Record<string, string[]>; // agentId -> rule keys always allowed
  teamPermissionRules: Record<string, string[]>; // repoId -> rule keys approved for this team
  /** opaque backend-owned state (e.g. sim progress) */
  backend: Record<string, unknown>;
}

export const FEED_LIMIT = 300;
export const MESSAGE_LIMIT = 500;
export const LOG_TAIL = 200;
/** an agent log rotates at this size; one previous file (<agent>.1.jsonl) is kept */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** how much of the end of a log file is read to rebuild its tail */
const TAIL_READ_BYTES = 512 * 1024;

/** Complete lines from the last `maxBytes` of a file (the first, partial line is dropped). */
function readTailLines(file: string, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, maxBytes);
    if (!len) return [];
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function emptyState(now: number): StateData {
  return {
    version: 1,
    createdAt: now,
    agents: [],
    tasks: [],
    decisions: [],
    repos: [],
    goals: [],
    feed: [],
    messages: [],
    counters: {},
    sessions: {},
    worktreeMeta: {},
    permissionRules: {},
    teamPermissionRules: {},
    backend: {},
  };
}

export class Store {
  readonly dir: string;
  readonly file: string;
  data: StateData;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private logTails = new Map<string, LogEntry[]>();
  private logSizes = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly logMaxBytes: number;

  constructor(dir: string, opts: { debounceMs?: number; now?: number; logMaxBytes?: number } = {}) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 100;
    this.logMaxBytes = opts.logMaxBytes ?? LOG_MAX_BYTES;
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, 'logs'));
    const loaded = this.loadFile();
    this.data = loaded ?? emptyState(opts.now ?? Date.now());
    if (!loaded) this.flush();
  }

  private loadFile(): StateData | undefined {
    try {
      const d = readJson<StateData>(this.file);
      if (!d) return undefined;
      if (d.version !== 1) throw new Error(`unsupported state version ${String((d as { version?: unknown }).version)}`);
      // tolerate older files missing newer keys
      return { ...emptyState(d.createdAt ?? Date.now()), ...d };
    } catch (e) {
      // Keep the corrupt file for inspection and start fresh rather than crash-looping.
      const bad = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, bad);
      } catch {
        /* ignore */
      }
      console.error(`[store] could not read ${this.file} (${(e as Error).message}); moved to ${bad}`);
      return undefined;
    }
  }

  /** Allocate the next id for a counter, e.g. nextId('t') -> "t1", "t2"... */
  nextId(prefix: string): string {
    const n = (this.data.counters[prefix] ?? 0) + 1;
    this.data.counters[prefix] = n;
    this.markDirty();
    return `${prefix}${n}`;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    writeJsonAtomic(this.file, this.data);
    this.dirty = false;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  pushFeed(item: FeedItem): void {
    this.data.feed.push(item);
    if (this.data.feed.length > FEED_LIMIT) this.data.feed.splice(0, this.data.feed.length - FEED_LIMIT);
    this.markDirty();
  }

  pushMessage(m: BusMessage): void {
    this.data.messages.push(m);
    if (this.data.messages.length > MESSAGE_LIMIT) this.data.messages.splice(0, this.data.messages.length - MESSAGE_LIMIT);
    this.markDirty();
  }

  // ---- logs -------------------------------------------------------------------------------

  private logFile(agentId: string): string {
    return path.join(this.dir, 'logs', `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  }

  private rotatedLogFile(agentId: string): string {
    return this.logFile(agentId).replace(/\.jsonl$/, '.1.jsonl');
  }

  appendLog(agentId: string, entries: LogEntry[]): void {
    if (!entries.length) return;
    // load the cached tail BEFORE appending, or the lazy load would read these entries twice
    const tail = this.logTail(agentId);
    const f = this.logFile(agentId);
    const data = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const bytes = Buffer.byteLength(data);
    let size = this.logSizes.get(agentId) ?? (fs.existsSync(f) ? fs.statSync(f).size : 0);
    if (size > 0 && size + bytes > this.logMaxBytes) {
      // rotate: keep one previous file, so the logs never grow without bound
      try {
        fs.rmSync(this.rotatedLogFile(agentId), { force: true });
        fs.renameSync(f, this.rotatedLogFile(agentId));
        size = 0;
      } catch {
        /* held open elsewhere: try again on a later append */
      }
    }
    fs.appendFileSync(f, data);
    this.logSizes.set(agentId, size + bytes);
    tail.push(...entries);
    if (tail.length > LOG_TAIL) tail.splice(0, tail.length - LOG_TAIL);
  }

  /** Recent log entries for an agent (cached; loaded lazily from the END of the log files). */
  logTail(agentId: string): LogEntry[] {
    let tail = this.logTails.get(agentId);
    if (tail) return tail;
    tail = [];
    let lines = readTailLines(this.logFile(agentId), TAIL_READ_BYTES);
    // just rotated: the rest of the tail is at the end of the previous file
    if (lines.length < LOG_TAIL) lines = [...readTailLines(this.rotatedLogFile(agentId), TAIL_READ_BYTES), ...lines];
    for (const l of lines.slice(-LOG_TAIL)) {
      try {
        tail.push(JSON.parse(l) as LogEntry);
      } catch {
        /* skip torn line */
      }
    }
    this.logTails.set(agentId, tail);
    return tail;
  }

  close(): void {
    this.flush();
  }
}
