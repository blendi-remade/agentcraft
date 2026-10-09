import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGES,
  ClientMessage,
  ForemanStatus,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  ServerMessage,
  Usage,
} from '../src/protocol.js';
import { CLIENT_EXAMPLES, SERVER_EXAMPLES, USAGE_EXAMPLES } from '../src/protocol-examples.js';

describe('protocol v1', () => {
  it('has an example for every message type', () => {
    expect(Object.keys(SERVER_EXAMPLES).sort()).toEqual(Object.keys(SERVER_MESSAGES).sort());
    expect(Object.keys(CLIENT_EXAMPLES).sort()).toEqual(Object.keys(CLIENT_MESSAGES).sort());
  });

  it.each(Object.entries(SERVER_EXAMPLES))('server %s round-trips through JSON', (type, ex) => {
    const wire = JSON.stringify(ex);
    const r = parseServerMessage(wire);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.msg.type).toBe(type);
      expect(r.msg).toEqual(JSON.parse(wire));
      // specific schema agrees with the union
      expect(SERVER_MESSAGES[type as keyof typeof SERVER_MESSAGES].schema.safeParse(ex).success).toBe(true);
    }
  });

  it.each(Object.entries(CLIENT_EXAMPLES))('client %s round-trips through JSON', (type, ex) => {
    const wire = JSON.stringify(ex);
    const r = parseClientMessage(wire);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.msg.type).toBe(type);
      expect(r.msg).toEqual(JSON.parse(wire));
    }
  });

  it('rejects a wrong protocol version, unknown types and invalid JSON', () => {
    expect(parseClientMessage({ v: 2, type: 'hello', modVersion: 'x', protocol: 1 }).ok).toBe(false);
    expect(parseClientMessage({ v: 1, type: 'hello', modVersion: 'x', protocol: 2 }).ok).toBe(false);
    expect(parseClientMessage({ v: 1, type: 'nope' }).ok).toBe(false);
    expect(parseClientMessage('{not json').ok).toBe(false);
    expect(parseServerMessage({ v: 1, type: 'agent.upsert' }).ok).toBe(false);
  });

  it('rejects bad enums, colors and empty required strings', () => {
    const agent = (SERVER_EXAMPLES['agent.upsert'] as { agent: Record<string, unknown> }).agent;
    expect(ServerMessage.safeParse({ v: 1, type: 'agent.upsert', agent: { ...agent, state: 'dancing' } }).success).toBe(false);
    expect(ServerMessage.safeParse({ v: 1, type: 'agent.upsert', agent: { ...agent, station: 'kitchen' } }).success).toBe(false);
    expect(ServerMessage.safeParse({ v: 1, type: 'agent.upsert', agent: { ...agent, color: 'blue' } }).success).toBe(false);
    expect(ClientMessage.safeParse({ v: 1, type: 'goal.submit', text: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ v: 1, type: 'task.action', taskId: 't1', action: 'explode' }).success).toBe(false);
  });

  it('accepts decision.answer option as label or 0-based index', () => {
    expect(ClientMessage.safeParse({ v: 1, type: 'decision.answer', decisionId: 'd1', option: 'Merge' }).success).toBe(true);
    expect(ClientMessage.safeParse({ v: 1, type: 'decision.answer', decisionId: 'd1', option: 0 }).success).toBe(true);
    expect(ClientMessage.safeParse({ v: 1, type: 'decision.answer', decisionId: 'd1', option: -1 }).success).toBe(false);
  });

  it('ignores (strips) unknown fields for forward compatibility', () => {
    const r = parseClientMessage({ v: 1, type: 'hello', modVersion: '0.1', protocol: 1, futureField: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect('futureField' in r.msg).toBe(false);
  });

  it('Usage: both example payloads parse, utilization stays within 0-100, a status without usage still parses', () => {
    for (const ex of Object.values(USAGE_EXAMPLES)) expect(Usage.parse(ex)).toEqual(ex);
    const sub = USAGE_EXAMPLES.subscription;
    const w = sub.windows[0]!;
    for (const utilization of [-1, 100.5]) {
      expect(Usage.safeParse({ ...sub, windows: [{ ...w, utilization }] }).success).toBe(false);
      expect(Usage.safeParse({ ...sub, extra: { enabled: true, usedCredits: 3.2, monthlyLimit: 20, utilization } }).success).toBe(false);
    }
    expect(Usage.safeParse({ ...sub, windows: [{ ...w, utilization: null, resetsAt: null }] }).success).toBe(true);
    expect(Usage.safeParse({ ...USAGE_EXAMPLES.api, mode: 'team' }).success).toBe(false);
    const status = { version: '0.1.0', backend: 'claude', auth: 'ok' };
    expect(ForemanStatus.safeParse(status).success).toBe(true);
    expect(ForemanStatus.parse({ ...status, usage: sub }).usage).toEqual(sub);
  });

  it('exposes protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
