import { afterEach, describe, expect, it } from 'vitest';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let h: Harness;
let home: string;
afterEach(async () => {
  await h?.fm.close();
  rmrf(home);
});

function setup(): Harness {
  home = tempDir();
  h = makeForeman(home, ['--backend', 'sim']);
  return h;
}

describe('DecisionQueue', () => {
  it('opens a decision, notifies the user and resolves the waiting agent on answer', async () => {
    const { fm, events, toasts, notifier } = setup();
    const d = fm.createDecision({ agentId: 'marlow', kind: 'question', question: 'Case-insensitive tags?', options: ['Yes (recommended)', 'No'] });
    expect(d.status).toBe('open');
    let resolved = false;
    const waiting = fm.decisions.wait(d.id).then((x) => {
      resolved = true;
      return x;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(events.some((e) => e.type === 'notify' && e.level === 'need_user' && e.decisionId === d.id)).toBe(true);
    await notifier.flush();
    expect(toasts.length).toBe(1);
    expect(toasts[0]!.body).toContain('Case-insensitive tags?');

    await fm.answerDecision(d.id, 'yes'); // prefix, case-insensitive
    const done = await waiting;
    expect(done.status).toBe('answered');
    expect(done.answer!.option).toBe('Yes (recommended)');
  });

  it('accepts option index, free text for questions, and rejects bad answers', async () => {
    const { fm } = setup();
    const q = fm.createDecision({ agentId: 'kit', kind: 'question', question: 'Name?', options: [] });
    await expect(fm.answerDecision(q.id)).rejects.toThrow(/option or text/);
    await fm.answerDecision(q.id, undefined, 'call it tagCounts');
    expect(fm.decisions.get(q.id)!.answer!.text).toBe('call it tagCounts');
    await expect(fm.answerDecision(q.id, undefined, 'again')).rejects.toThrow(/already answered/);

    const p = fm.createDecision({ agentId: 'kit', kind: 'permission', question: 'npm install?', options: ['Allow once', 'Always allow for this agent', 'Deny'] });
    await expect(fm.answerDecision(p.id, undefined, 'sure')).rejects.toThrow(/need one of/);
    await expect(fm.answerDecision(p.id, 'Maybe')).rejects.toThrow(/not one of/);
    await fm.answerDecision(p.id, 2);
    expect(fm.decisions.get(p.id)!.answer!.option).toBe('Deny');
  });

  it('cancel wakes waiters; reopen makes a decision open again', async () => {
    const { fm } = setup();
    const d = fm.createDecision({ agentId: 'wren', kind: 'permission', question: 'curl?', options: ['Allow once', 'Deny'] });
    const w = fm.decisions.wait(d.id);
    fm.decisions.cancel(d.id, 'agent stopped');
    expect((await w).status).toBe('cancelled');
    const e = fm.createDecision({ agentId: 'wren', kind: 'question', question: 'x?', options: ['a'] });
    await fm.answerDecision(e.id, 0);
    fm.decisions.reopen(e.id, 'try again');
    expect(fm.decisions.get(e.id)!.status).toBe('open');
    expect(fm.decisions.get(e.id)!.answer).toBeUndefined();
  });

  it('aborting a waiter leaves its question open and allows a new waiter after restart', async () => {
    const { fm } = setup();
    const d = fm.createDecision({ agentId: 'kit', kind: 'question', question: 'Keep this question?', options: ['Yes'] });
    const controller = new AbortController();
    const pending = fm.decisions.wait(d.id, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(fm.decisions.hasWaiters(d.id)).toBe(false);
    expect(fm.decisions.get(d.id)!.status).toBe('open');
    const resumed = fm.decisions.wait(d.id);
    await fm.answerDecision(d.id, 'Yes');
    expect((await resumed).answer?.option).toBe('Yes');
  });

  it('waiters do not wake before the answer side effects have run (merge settle race)', async () => {
    const { fm } = setup();
    const d = fm.createDecision({ agentId: 'marlow', kind: 'question', question: 'q?', options: ['a'] });
    fm.decisions.answer(d.id, 'a'); // recorded, not settled
    let woke = false;
    void fm.decisions.wait(d.id).then(() => (woke = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(woke).toBe(false);
    fm.decisions.settle(d.id);
    await new Promise((r) => setTimeout(r, 5));
    expect(woke).toBe(true);
  });

  it('rate-limits and coalesces toasts', async () => {
    const { Notifier } = await import('../src/notifier.js');
    const shown: string[] = [];
    let now = 1000;
    const n = new Notifier({ enabled: true, minIntervalMs: 60_000, bell: false, now: () => now, spawnToast: async (t, b) => (shown.push(`${t}|${b}`), true) });
    n.needUser('first');
    await n.flush();
    n.needUser('second');
    n.needUser('third');
    expect(shown).toHaveLength(1); // second/third wait for the window
    now += 60_000;
    await n.flush();
    expect(shown).toHaveLength(2);
    expect(shown[1]).toContain('2 decisions waiting');
    n.dispose();
    const off = new Notifier({ enabled: false, spawnToast: async () => (shown.push('x'), true) });
    off.needUser('nope');
    await off.flush();
    expect(shown).toHaveLength(2);
  });
});
