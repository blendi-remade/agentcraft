// MessageBus: agent<->agent, agent<->user messages, plus the activity feed.
import type { Ctx } from './context.js';
import type { FeedItem, FeedKind } from './protocol.js';
import type { BusMessage } from './store.js';
import { truncate } from './util/text.js';
import { userName } from './user.js';

export class MessageBus {
  private listeners: Array<(m: BusMessage) => void> = [];

  constructor(private ctx: Ctx) {}

  /** Append to the activity feed (persisted + broadcast). */
  feed(kind: FeedKind, text: string, extra: { agentId?: string; to?: string } = {}): FeedItem {
    const item: FeedItem = { ts: this.ctx.now(), kind, text: truncate(text, 400) };
    if (extra.agentId) item.agentId = extra.agentId;
    if (extra.to) item.to = extra.to;
    this.ctx.store.pushFeed(item);
    this.ctx.emit({ type: 'feed.add', item });
    return item;
  }

  /**
   * Send a message. `from` is an agent id or "user"; `to` is an agent id, "user" or "all".
   * Agents speak through `agent.say` (speech bubble); every message is also a feed item.
   */
  send(from: string, to: string, text: string): BusMessage {
    const msg: BusMessage = { id: this.ctx.store.nextId('m'), ts: this.ctx.now(), from, to, text, readBy: [] };
    this.ctx.store.pushMessage(msg);
    if (from !== 'user') {
      const say = { type: 'agent.say' as const, agentId: from, text: truncate(text, 600), ts: msg.ts, ...(to ? { to } : {}) };
      this.ctx.emit(say);
      this.feed('message', text, { agentId: from, to });
    } else {
      this.feed('user', text, { to });
    }
    for (const l of this.listeners) l(msg);
    return msg;
  }

  onMessage(listener: (m: BusMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Unread messages addressed to `agentId` (directly or via "all"), oldest first. */
  inbox(agentId: string, opts: { markRead?: boolean } = {}): BusMessage[] {
    const out = this.ctx.store.data.messages.filter(
      (m) => m.from !== agentId && (m.to === agentId || m.to === 'all') && !m.readBy.includes(agentId),
    );
    if (opts.markRead && out.length) {
      for (const m of out) m.readBy.push(agentId);
      this.ctx.store.markDirty();
    }
    return out;
  }

  /** Mark specific messages as consumed by `agentId`. */
  markRead(agentId: string, ids: string[]): void {
    let changed = false;
    for (const m of this.ctx.store.data.messages) {
      if (ids.includes(m.id) && !m.readBy.includes(agentId)) {
        m.readBy.push(agentId);
        changed = true;
      }
    }
    if (changed) this.ctx.store.markDirty();
  }

  /** Return a reserved message to the inbox if a live provider turn did not accept it. */
  markUnread(agentId: string, ids: string[]): void {
    for (const m of this.ctx.store.data.messages) {
      if (ids.includes(m.id)) m.readBy = m.readBy.filter(id => id !== agentId);
    }
    this.ctx.store.markDirty();
  }

  /** Recent conversation involving an agent (for prompts). */
  history(agentId: string, limit = 20): BusMessage[] {
    return this.ctx.store.data.messages
      .filter((m) => m.from === agentId || m.to === agentId || m.to === 'all')
      .slice(-limit);
  }
}

/** Format inbox messages for injection into an agent prompt / tool result. */
export function formatInbox(msgs: BusMessage[], nameOf: (id: string) => string): string {
  return msgs
    .map((m) => `- from ${m.from === 'user' ? `the user (${userName()})` : nameOf(m.from)}${m.to === 'all' ? ' to everyone' : ''}: ${m.text}`)
    .join('\n');
}
