// Foreman WebSocket client for tools and QA (protocol v1, see docs/protocol.md).
//
//   import { ForemanClient } from './lib/foremanclient.mjs';
//   const fm = await ForemanClient.connect({ port: 7878 });     // hello -> waits for the snapshot
//   fm.state.decisions.get('d3');                                // live mirror of the Foreman state
//   const ack = await fm.send('user.message', { to: 'kit', text: 'hi' });   // resolves with the ack
//   const diff = await fm.diff('sim-demo-showcase', 'wren-t4');  // diff.request -> diff
//   await fm.waitForState((s) => s.foreman?.showcase === true, { timeoutMs: 60_000, what: 'showcase hold' });
//   fm.close();
//
// Rules from the protocol: send no Origin header (the ws package sends none), hello first,
// optional fields omitted, unknown fields ignored, every message with an id gets an ack.

import WebSocket from 'ws';

export const DEFAULT_FOREMAN_PORT = Number(process.env.AGENTCRAFT_PORT || 7878);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ForemanError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ForemanError';
    Object.assign(this, extra);
  }
}

function emptyState() {
  return {
    snapshot: null,
    foreman: null,
    agents: new Map(),
    tasks: new Map(),
    decisions: new Map(),
    repos: new Map(),
    memory: new Map(),
    goals: new Map(),
    goal: null,
    feed: [],
    logs: new Map(),
  };
}

export class ForemanClient {
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.url = opts.url;
    this.clientName = opts.client ?? 'tools';
    this.nextId = 1;
    this.pendingAcks = new Map();
    this.waiters = new Set();
    this.listeners = new Set();
    this.state = emptyState();
    this.closed = false;
    this.messageCount = 0;
    ws.on('message', (data) => this.#onMessage(data));
    ws.on('close', () => {
      this.closed = true;
      const err = new ForemanError('Foreman connection closed');
      for (const p of this.pendingAcks.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pendingAcks.clear();
      for (const w of this.waiters) { clearTimeout(w.timer); w.reject(err); }
      this.waiters.clear();
    });
    ws.on('error', () => {});
  }

  /**
   * Connect (retrying while the Foreman starts), send hello and wait for the first snapshot.
   * @param {{port?:number, host?:string, timeoutMs?:number, retryMs?:number, client?:string, onWait?:(ms:number)=>void}} opts
   */
  static async connect(opts = {}) {
    const port = opts.port ?? DEFAULT_FOREMAN_PORT;
    const host = opts.host ?? '127.0.0.1';
    const url = `ws://${host}:${port}`;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const start = Date.now();
    let lastErr;
    let lastNotice = 0;
    while (true) {
      try {
        const ws = await ForemanClient.#open(url);
        const fm = new ForemanClient(ws, { url, client: opts.client });
        await fm.#hello(Math.max(5_000, timeoutMs - (Date.now() - start)));
        return fm;
      } catch (e) {
        lastErr = e;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        throw new ForemanError(`Foreman not reachable on ${url} after ${Math.round(elapsed / 1000)}s (${lastErr?.message ?? lastErr})`);
      }
      if (opts.onWait && elapsed - lastNotice >= 10_000) {
        lastNotice = elapsed;
        opts.onWait(elapsed);
      }
      await sleep(opts.retryMs ?? 500);
    }
  }

  static #open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: 3000 });
      const fail = (err) => {
        try { ws.terminate(); } catch {}
        reject(err);
      };
      ws.once('error', fail);
      ws.once('unexpected-response', (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
      ws.once('open', () => {
        ws.removeListener('error', fail);
        resolve(ws);
      });
    });
  }

  async #hello(timeoutMs) {
    const snap = this.waitFor((m) => m.type === 'snapshot', { timeoutMs, what: 'snapshot after hello' });
    this.#raw({ type: 'hello', modVersion: 'tools-0.1.0', protocol: 1, client: this.clientName });
    await snap;
  }

  #raw(msg) {
    if (this.closed) throw new ForemanError('Foreman connection closed');
    this.ws.send(JSON.stringify({ v: 1, ...msg }));
  }

  #apply(m) {
    const s = this.state;
    switch (m.type) {
      case 'snapshot': {
        s.snapshot = m;
        s.foreman = m.foreman ?? null;
        s.agents = new Map((m.agents ?? []).map((a) => [a.id, a]));
        s.tasks = new Map((m.tasks ?? []).map((t) => [t.id, t]));
        s.decisions = new Map((m.decisions ?? []).map((d) => [d.id, d]));
        s.repos = new Map((m.repos ?? []).map((r) => [r.id, r]));
        s.memory = new Map((m.memory ?? []).map((e) => [e.id, e]));
        s.goals = new Map((m.goals ?? []).map((g) => [g.id, g]));
        s.goal = m.goal ?? null;
        s.feed = [...(m.feed ?? [])];
        s.logs = new Map((m.logs ?? []).map((l) => [l.agentId, [...l.entries]]));
        break;
      }
      case 'agent.upsert': if (m.agent) s.agents.set(m.agent.id, m.agent); break;
      case 'task.upsert': if (m.task) s.tasks.set(m.task.id, m.task); break;
      case 'decision.upsert': if (m.decision) s.decisions.set(m.decision.id, m.decision); break;
      case 'repo.upsert': if (m.repo) s.repos.set(m.repo.id, m.repo); break;
      case 'memory.upsert': if (m.entry) s.memory.set(m.entry.id, m.entry); break;
      case 'goal.upsert':
        if (m.goal) {
          s.goals.set(m.goal.id, m.goal);
          s.goal = m.goal;
        }
        break;
      case 'feed.add': if (m.item) { s.feed.push(m.item); if (s.feed.length > 500) s.feed.shift(); } break;
      case 'agent.log': {
        const arr = s.logs.get(m.agentId) ?? [];
        arr.push(...(m.entries ?? []));
        if (arr.length > 200) arr.splice(0, arr.length - 200);
        s.logs.set(m.agentId, arr);
        break;
      }
      case 'foreman.status': if (m.status) s.foreman = m.status; break;
      default: break;
    }
  }

  #onMessage(data) {
    let m;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    this.messageCount++;
    this.#apply(m);
    if (m.type === 'ack' && m.re != null) {
      const p = this.pendingAcks.get(String(m.re));
      if (p) {
        this.pendingAcks.delete(String(m.re));
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m);
        else p.reject(new ForemanError(`${p.type} refused: ${m.error ?? 'error'}`, { ack: m }));
      }
    }
    for (const fn of this.listeners) { try { fn(m); } catch {} }
    for (const w of [...this.waiters]) {
      let hit = false;
      try { hit = w.pred(m, this.state); } catch {}
      if (hit) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }

  /** Subscribe to every incoming message. Returns an unsubscribe function. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve with the first incoming message for which pred(msg, state) is true. */
  waitFor(pred, opts = {}) {
    return this.#waiter(pred, opts).promise;
  }

  // Internal cancellation lets a failed request discard its unused reply waiter.
  #waiter(pred, { timeoutMs = 15_000, what = 'message' } = {}) {
    const w = { pred, timer: null };
    const cancel = () => {
      this.waiters.delete(w);
      clearTimeout(w.timer);
    };
    const promise = new Promise((resolve, reject) => {
      if (this.closed) { reject(new ForemanError('Foreman connection closed')); return; }
      Object.assign(w, { resolve, reject });
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new ForemanError(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      this.waiters.add(w);
    });
    return { promise, cancel };
  }

  /** Resolve once pred(state) is true (checked now and after every message). */
  async waitForState(pred, { timeoutMs = 15_000, what = 'Foreman state' } = {}) {
    if (pred(this.state)) return this.state;
    await this.waitFor((_m, s) => pred(s), { timeoutMs, what });
    return this.state;
  }

  /**
   * Send a client message. With ack (default) it carries an id and resolves with the Foreman's
   * ack (rejects when ack.ok is false). Without ack it resolves immediately.
   */
  send(type, payload = {}, { ack = true, timeoutMs = 15_000 } = {}) {
    if (!ack) {
      this.#raw({ type, ...payload });
      return Promise.resolve(null);
    }
    const id = `${this.clientName}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new ForemanError(`${type}: no ack within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pendingAcks.set(id, { resolve, reject, timer, type });
      try {
        this.#raw({ type, ...payload, id });
      } catch (e) {
        clearTimeout(timer);
        this.pendingAcks.delete(id);
        reject(e);
      }
    });
  }

  /** diff.request -> the matching `diff` reply (throws if the reply carries an error). */
  async diff(repoId, worktree, { timeoutMs = 30_000 } = {}) {
    const requestId = `${this.clientName}-diff-${this.nextId++}`;
    const reply = this.#waiter((m) => m.type === 'diff' && m.requestId === requestId, { timeoutMs, what: `diff ${repoId}/${worktree}` });
    try {
      // Observe both promises immediately: either may reject before the other settles.
      const [d] = await Promise.all([
        reply.promise,
        this.send('diff.request', { requestId, repoId, worktree }, { timeoutMs }),
      ]);
      if (d.error) throw new ForemanError(`diff ${repoId}/${worktree}: ${d.error}`, { diff: d });
      return d;
    } finally {
      reply.cancel();
    }
  }

  /** Open decisions, oldest first, optionally of one kind (question|permission|merge). */
  openDecisions(kind) {
    return [...this.state.decisions.values()]
      .filter((d) => d.status === 'open' && (!kind || d.kind === kind))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  /** Small summary used by launch/qa output. */
  summary() {
    const s = this.state;
    const tasks = [...s.tasks.values()].filter((t) => t.status !== 'cancelled');
    const byStatus = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    return {
      url: this.url,
      foreman: s.foreman,
      agents: s.agents.size,
      activeAgents: [...s.agents.values()].filter((a) => a.active).length,
      tasks: tasks.length,
      tasksByStatus: byStatus,
      openDecisions: this.openDecisions().map((d) => ({ id: d.id, kind: d.kind, agentId: d.agentId, repoId: d.repoId, worktree: d.worktree })),
      repos: [...s.repos.values()].map((r) => ({ id: r.id, path: r.path, branch: r.branch, worktrees: (r.worktrees ?? []).length })),
      goal: s.goal ? { id: s.goal.id, text: s.goal.text, status: s.goal.status, progress: s.goal.progress } : null,
      memory: s.memory.size,
    };
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
