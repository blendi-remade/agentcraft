// Variant Studio bridge: pick a design variant in Minecraft (or on the dashboard) instead of the
// browser gallery.
//
// Variant Studio (github.com/Fonlogen/variant-studio) keeps everything in <project>/.variant-studio:
// rounds/<id>/round.json (the question and the variants), rounds/<id>/decision.json once the user
// decided, state/server.json ({port, key}) for its local gallery. While an agent waits on
// `studio.mjs wait`, a round has variants and no decision. For every such round in a repo checkout
// or an agent's worktree, this bridge opens a question decision (tool "variant-studio"): one option
// per variant plus "None of these". The answer goes to the gallery's own /api/decision, exactly as
// if it was clicked there, so the agent's `wait` returns it:
//   a variant            -> choose (approve it)
//   a variant + text     -> revise (keep it, change what the text says)
//   "None of these"/text -> regenerate (with the text as the note)
// Deciding in the browser instead withdraws the decision here.
import fs from 'node:fs';
import path from 'node:path';
import type { Foreman } from './foreman.js';
import type { Decision } from './protocol.js';
import { language } from './i18n.js';
import { readJson } from './util/fsx.js';
import { truncate } from './util/text.js';

export const VARIANT_TOOL = 'variant-studio';
export const NONE_OF_THESE = 'None of these: new directions';
const NONE_IT = 'Nessuna: nuove direzioni';
const SAFE = /^[\w.-]+$/;
const MAX_AGE_MS = 24 * 60 * 60_000;

interface Variant {
  id: string;
  label: string;
  notes: string;
  file: string;
}

interface Open {
  decisionId: string;
  dir: string;
  round: string;
  variants: Variant[];
  port: number;
  key: string;
}

/** A round's variants as round.json declares them, with the files that exist. */
export function roundVariants(roundDir: string): { question: string; variants: Variant[] } | undefined {
  const m = readJson<Record<string, unknown>>(path.join(roundDir, 'round.json'));
  if (!m) return undefined;
  const declared = Array.isArray(m.variants) ? m.variants : [];
  const variants: Variant[] = [];
  for (const raw of declared) {
    const v = typeof raw === 'string' ? { id: raw } : (raw as Record<string, unknown>);
    const id = typeof v.id === 'string' ? v.id : undefined;
    if (!id || !SAFE.test(id)) continue;
    const file = typeof v.file === 'string' && SAFE.test(v.file) ? v.file : `${id}.html`;
    if (!fs.existsSync(path.join(roundDir, file))) return undefined; // still being written
    variants.push({ id, label: typeof v.label === 'string' ? v.label : '', notes: typeof v.notes === 'string' ? v.notes : '', file });
  }
  if (variants.length < 2) return undefined;
  const question = (typeof m.question === 'string' && m.question) || (typeof m.title === 'string' && m.title) || 'Which variant?';
  return { question, variants };
}

export function optionLabel(v: Variant): string {
  return truncate(`${v.id.toUpperCase()}${v.label ? ` · ${v.label}` : ''}`, 60);
}

/** The gallery's answer for a decision answer (see the header). */
export function studioDecision(round: string, variants: Variant[], option: string | undefined, text: string | undefined): Record<string, unknown> {
  const v = variants.find((x) => optionLabel(x) === option);
  const note = text?.trim() || undefined;
  if (v) return { round, action: note ? 'revise' : 'choose', selected: [v.id], ...(note ? { note } : {}), no_hold: true, via: 'agentcraft' };
  return { round, action: 'regenerate', selected: [], ...(note ? { note } : {}), via: 'agentcraft' };
}

export class VariantBridge {
  private open = new Map<string, Open>(); // `${dir}#${round}`
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private health = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private fm: Foreman,
    private fetchFn: typeof fetch = fetch,
  ) {}

  start(intervalMs = 3000): void {
    this.recover();
    this.timer = setInterval(() => void this.scan(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** After a restart: the open variant decisions in the state are ours again. */
  private recover(): void {
    for (const d of this.fm.decisions.open().filter((x) => x.tool === VARIANT_TOOL)) {
      const ctx = d.context ?? '';
      const dir = /^Studio: (.+)$/m.exec(ctx)?.[1];
      const round = /^Round: (.+)$/m.exec(ctx)?.[1];
      const gallery = /^Gallery: http:\/\/127\.0\.0\.1:(\d+)\/\?k=(\w+)$/m.exec(ctx);
      const rv = dir && round ? roundVariants(path.join(dir, '.variant-studio', 'rounds', round)) : undefined;
      if (!dir || !round || !gallery || !rv) {
        this.fm.decisions.cancel(d.id, 'the Variant Studio round is gone');
        continue;
      }
      this.open.set(`${dir}#${round}`, { decisionId: d.id, dir, round, variants: rv.variants, port: Number(gallery[1]), key: gallery[2]! });
    }
  }

  /** Where agents work: each repo checkout (the lead) and each active worktree. */
  private places(): Array<{ dir: string; agentId: string; taskId?: string }> {
    const out: Array<{ dir: string; agentId: string; taskId?: string }> = [];
    for (const r of this.fm.repos.list()) {
      out.push({ dir: r.path, agentId: 'marlow' });
      for (const w of r.worktrees) if (w.status === 'active') out.push({ dir: w.path, agentId: w.agentId, ...(w.taskId ? { taskId: w.taskId } : {}) });
    }
    return out;
  }

  private async alive(port: number, key: string): Promise<boolean> {
    const id = `${port}:${key}`;
    const c = this.health.get(id);
    if (c && Date.now() - c.at < 10_000) return c.ok;
    const ok = await this.fetchFn(`http://127.0.0.1:${port}/api/health?k=${key}`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    this.health.set(id, { ok, at: Date.now() });
    return ok;
  }

  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const seen = new Set<string>();
      for (const p of this.places()) {
        const home = path.join(p.dir, '.variant-studio');
        const info = readJson<{ port?: number; key?: string }>(path.join(home, 'state', 'server.json'));
        if (!info?.port || !info.key || !/^\w+$/.test(info.key)) continue;
        let rounds: string[] = [];
        try {
          rounds = fs.readdirSync(path.join(home, 'rounds')).filter((r) => SAFE.test(r));
        } catch {
          continue;
        }
        for (const round of rounds) {
          const dir = path.join(home, 'rounds', round);
          const k = `${p.dir}#${round}`;
          if (fs.existsSync(path.join(dir, 'decision.json'))) continue; // decided (here or in the browser)
          let mtime = 0;
          try {
            mtime = fs.statSync(dir).mtimeMs;
          } catch {
            continue;
          }
          if (Date.now() - mtime > MAX_AGE_MS) continue;
          seen.add(k);
          if (this.open.has(k)) continue;
          const a = this.fm.agent(p.agentId);
          if (!a?.active || a.paused) continue;
          const rv = roundVariants(dir);
          if (!rv || !(await this.alive(info.port, info.key))) continue;
          this.create(p, round, rv, info.port, info.key);
        }
      }
      // decided in the browser (or the round is gone): withdraw ours
      for (const [k, o] of this.open) {
        const d = this.fm.decisions.get(o.decisionId);
        if (!d || d.status !== 'open') {
          this.open.delete(k);
          continue;
        }
        if (!seen.has(k)) {
          this.fm.decisions.cancel(o.decisionId, 'decided in the Variant Studio gallery');
          this.open.delete(k);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private create(p: { dir: string; agentId: string; taskId?: string }, round: string, rv: { question: string; variants: Variant[] }, port: number, key: string): void {
    const gallery = `http://127.0.0.1:${port}/?k=${key}`;
    const it = language() === 'it';
    const context = [
      it
        ? 'Variant Studio: scegli una variante qui (scrivi cosa cambiare per chiedere una revisione), oppure apri la galleria.'
        : 'Variant Studio: pick a variant here (write what to change to ask for a revision), or open the gallery.',
      ...rv.variants.map((v) => `${optionLabel(v)}${v.notes ? ` - ${truncate(v.notes, 140)}` : ''}`),
      `Gallery: ${gallery}`,
      `Round: ${round}`,
      `Files: ${rv.variants.map((v) => `${v.id}=${v.file}`).join(',')}`,
      `Studio: ${p.dir}`,
    ].join('\n');
    const d = this.fm.createDecision({
      agentId: p.agentId,
      kind: 'question',
      tool: VARIANT_TOOL,
      question: truncate(rv.question, 200),
      options: [...rv.variants.map(optionLabel), it ? NONE_IT : NONE_OF_THESE],
      context,
      ...(p.taskId ? { taskId: p.taskId } : {}),
    });
    this.open.set(`${p.dir}#${round}`, { decisionId: d.id, dir: p.dir, round, variants: rv.variants, port, key });
  }

  /** Send an answered variant decision to the gallery. Throws when the gallery refuses it. */
  async forward(d: Decision): Promise<void> {
    const o = [...this.open.values()].find((x) => x.decisionId === d.id);
    if (!o) throw new Error('this Variant Studio round is no longer open');
    const body = studioDecision(o.round, o.variants, d.answer?.option, d.answer?.text);
    const r = await this.fetchFn(`http://127.0.0.1:${o.port}/api/decision?k=${o.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch((e: Error) => {
      throw new Error(`Variant Studio is not reachable (${e.message})`);
    });
    if (!r.ok) throw new Error(`Variant Studio refused the decision (HTTP ${r.status})`);
    this.open.delete(`${o.dir}#${o.round}`);
  }
}
