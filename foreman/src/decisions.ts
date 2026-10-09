// DecisionQueue: questions, permission prompts and merge approvals that need the user.
//
// create() opens a decision (persisted, broadcast, user notified). The waiting agent awaits
// wait(id). answer() records the user's choice; the Foreman then runs kind-specific side effects
// (e.g. the merge) and calls settle(id) to wake waiters. Waiters are in-memory: after a restart
// open decisions are still open, and backends re-attach by id (sim) or resume the session with
// the answer (claude).
import type { Ctx } from './context.js';
import type { Decision, DecisionKind } from './protocol.js';

export class DecisionError extends Error {}

export interface CreateDecisionInput {
  agentId: string;
  kind: DecisionKind;
  question: string;
  options: string[];
  context?: string;
  taskId?: string;
  repoId?: string;
  worktree?: string;
  tool?: string;
}

type Waiter = { resolve: (d: Decision) => void };

export class DecisionQueue {
  private waiters = new Map<string, Waiter[]>();
  /** answered, but side effects (e.g. the merge) not finished yet: waiters keep waiting */
  private unsettled = new Set<string>();
  private createdListeners: Array<(d: Decision) => void> = [];

  constructor(private ctx: Ctx) {}

  private get all(): Decision[] {
    return this.ctx.store.data.decisions;
  }

  list(): Decision[] {
    return this.all;
  }

  open(): Decision[] {
    return this.all.filter((d) => d.status === 'open');
  }

  get(id: string): Decision | undefined {
    return this.all.find((d) => d.id === id);
  }

  onCreated(l: (d: Decision) => void): void {
    this.createdListeners.push(l);
  }

  create(input: CreateDecisionInput): Decision {
    if (!input.question.trim()) throw new DecisionError('decision question is empty');
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (input.kind !== 'question' && options.length === 0) throw new DecisionError(`${input.kind} decisions need options`);
    const d: Decision = {
      id: this.ctx.store.nextId('d'),
      agentId: input.agentId,
      kind: input.kind,
      question: input.question.trim(),
      options,
      status: 'open',
      createdAt: this.ctx.now(),
    };
    if (input.context) d.context = input.context;
    if (input.taskId) d.taskId = input.taskId;
    if (input.repoId) d.repoId = input.repoId;
    if (input.worktree) d.worktree = input.worktree;
    if (input.tool) d.tool = input.tool;
    this.all.push(d);
    this.trim();
    this.touch(d);
    for (const l of this.createdListeners) l(d);
    return d;
  }

  /** Resolve an option given as label (case-insensitive), 1-based "#n"/number string, or 0-based index. */
  resolveOption(d: Decision, option: string | number | undefined): string | undefined {
    if (option === undefined || option === '') return undefined;
    if (typeof option === 'number') {
      const o = d.options[option];
      if (o === undefined) throw new DecisionError(`option index ${option} out of range (0..${d.options.length - 1})`);
      return o;
    }
    const exact = d.options.find((o) => o === option);
    if (exact) return exact;
    const ci = d.options.find((o) => o.toLowerCase() === option.trim().toLowerCase());
    if (ci) return ci;
    const prefix = d.options.filter((o) => o.toLowerCase().startsWith(option.trim().toLowerCase()));
    if (prefix.length === 1) return prefix[0];
    throw new DecisionError(`"${option}" is not one of: ${d.options.join(' | ')}`);
  }

  /** Record an answer. Does not wake waiters; call settle() after side effects. */
  answer(id: string, option?: string | number, text?: string): Decision {
    const d = this.get(id);
    if (!d) throw new DecisionError(`no decision ${id}`);
    if (d.status !== 'open') throw new DecisionError(`decision ${id} is already ${d.status}`);
    const opt = this.resolveOption(d, option);
    const freeText = text?.trim() || undefined;
    if (d.kind === 'question') {
      if (!opt && !freeText) throw new DecisionError('answer needs an option or text');
    } else if (!opt) {
      throw new DecisionError(`${d.kind} decisions need one of: ${d.options.join(' | ')}`);
    }
    d.status = 'answered';
    d.answer = { ts: this.ctx.now() };
    if (opt) d.answer.option = opt;
    if (freeText) d.answer.text = freeText;
    this.unsettled.add(d.id);
    this.touch(d);
    return d;
  }

  /** Re-open an answered decision (e.g. merge was refused because the checkout is dirty). */
  reopen(id: string, context?: string): Decision {
    const d = this.get(id);
    if (!d) throw new DecisionError(`no decision ${id}`);
    d.status = 'open';
    delete d.answer;
    this.unsettled.delete(id);
    if (context !== undefined) d.context = context;
    this.touch(d);
    return d;
  }

  cancel(id: string, reason?: string): Decision | undefined {
    const d = this.get(id);
    if (!d || d.status !== 'open') return d;
    d.status = 'cancelled';
    if (reason) d.context = d.context ? `${d.context}\n(cancelled: ${reason})` : `(cancelled: ${reason})`;
    this.touch(d);
    this.settle(id);
    return d;
  }

  /** Wake everyone waiting on this decision. */
  settle(id: string): void {
    this.unsettled.delete(id);
    const d = this.get(id);
    const ws = this.waiters.get(id);
    if (!d || !ws) return;
    this.waiters.delete(id);
    for (const w of ws) w.resolve(d);
  }

  /** Resolves once settled. Abort detaches only this waiter, preserving the saved decision. */
  wait(id: string, signal?: AbortSignal): Promise<Decision> {
    const d = this.get(id);
    if (!d) return Promise.reject(new DecisionError(`no decision ${id}`));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (d.status !== 'open' && !this.unsettled.has(id)) return Promise.resolve(d);
    return new Promise((resolve, reject) => {
      const ws = this.waiters.get(id) ?? [];
      const onAbort = () => {
        const remaining = (this.waiters.get(id) ?? []).filter(w => w !== waiter);
        if (remaining.length) this.waiters.set(id, remaining);
        else this.waiters.delete(id);
        reject(signal!.reason);
      };
      const waiter = { resolve: (decision: Decision) => { signal?.removeEventListener('abort', onAbort); resolve(decision); } };
      ws.push(waiter);
      this.waiters.set(id, ws);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  hasWaiters(id: string): boolean {
    return (this.waiters.get(id)?.length ?? 0) > 0;
  }

  /** Keep all open decisions and the latest 100 closed ones. */
  private trim(): void {
    const closed = this.all.filter((d) => d.status !== 'open');
    if (closed.length <= 100) return;
    const drop = new Set(closed.slice(0, closed.length - 100).map((d) => d.id));
    this.ctx.store.data.decisions = this.all.filter((d) => !drop.has(d.id));
  }

  private touch(d: Decision): void {
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'decision.upsert', decision: { ...d, options: [...d.options] } });
  }
}
