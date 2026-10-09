// The in-game usage display, Claude side (docs/design/usage-display.md): the CLI's /usage data
// mapped onto the wire `Usage`. The SDK method is experimental (its name and shape will change),
// so the engine finds it by name at runtime and its answer is parsed leniently here: every field
// optional, unknown keys tolerated, and each limit, window and extra_usage parsed on its own, so a
// malformed one is dropped alone. Only named fields are copied onto the wire object, so nothing
// else the server sends (codename limits, spend, per-surface breakdowns) can reach the mod.
import { z } from 'zod';
import type { Usage, UsageExtra, UsageWindow } from '../../protocol.js';

/** The SDK's /usage method on a Query, under every name it is known by (the first found is used). */
export const USAGE_METHODS = ['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET', 'usage'] as const;

/** How long one usage request may take (a round trip measured 1.3 s). */
export const USAGE_TIMEOUT_MS = 30_000;

export const USAGE_ERRORS = {
  missing: 'usage API not available in this SDK',
  shape: 'usage API shape changed',
  unavailable: 'usage not available for this login; run claude and /login again',
  /** the answer has no rate_limits at all, though the login is not refused them */
  notReported: 'usage not reported for this login',
} as const;

// lenient: tolerance on input only, never forwarded (see mapUsage). Only the outer shape is
// required (RawUsage); every part inside is parsed on its own and dropped alone if it does not fit.
const Num = z.number().nullable().optional();
const Str = z.string().nullable().optional();
const RawWindow = z.object({ utilization: Num, resets_at: Str }).passthrough();
const RawLimit = z
  .object({
    kind: Str,
    percent: Num,
    resets_at: Str,
    is_active: z.boolean().nullable().optional(),
    scope: z
      .object({ model: z.object({ display_name: Str }).passthrough().nullable().optional(), surface: z.unknown().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const RawModelWindow = z.object({ display_name: Str, utilization: Num, resets_at: Str }).passthrough();
const RawExtra = z
  .object({ is_enabled: z.boolean().nullable().optional(), monthly_limit: Num, used_credits: Num, utilization: Num, currency: Str, decimal_places: z.unknown().optional() })
  .passthrough();
/** The shape error is for this only: not an object, or rate_limits neither an object nor null. */
const RawUsage = z
  .object({
    subscription_type: z.unknown().optional(),
    rate_limits_available: z.unknown().optional(),
    rate_limits: z.object({}).passthrough().nullable().optional(),
  })
  .passthrough();
type RawLimit = z.infer<typeof RawLimit>;
type RawWindow = z.infer<typeof RawWindow>;
type RawRates = NonNullable<z.infer<typeof RawUsage>['rate_limits']>;
type RawExtra = z.infer<typeof RawExtra>;

/** `v` when it fits `schema`, else undefined (the part is dropped). */
function part<S extends z.ZodType>(schema: S, v: unknown): z.output<S> | undefined {
  const r = schema.safeParse(v);
  return r.success ? r.data : undefined;
}

/** The entries of `v` that fit `schema`; none when `v` is not an array. */
function parts<S extends z.ZodType>(schema: S, v: unknown): Array<z.output<S>> {
  return Array.isArray(v) ? v.map((x) => part(schema, x)).filter((x): x is z.output<S> => x !== undefined) : [];
}

/**
 * The `<slug>` of `weekly:<slug>`: the display name lower-cased, runs of characters other than
 * a-z0-9 replaced by "-", leading and trailing "-" trimmed ("Fable" -> "fable", "Opus (4.5)" ->
 * "opus-4-5"). Final: mods style windows by these ids.
 */
export function usageSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Percentages are 0-100 on the wire (the protocol's range); anything not a number is unknown. */
const percent = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
const amount = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const instant = (v: string | null | undefined): string | null => v || null;

/** A scoped window's name: its model's display name, else its surface's (a name, or an object with one). */
function scopeName(scope: RawLimit['scope']): string | undefined {
  if (scope?.model?.display_name) return scope.model.display_name;
  const surface = scope?.surface;
  if (typeof surface === 'string') return surface || undefined;
  const name = surface && typeof surface === 'object' ? (surface as { display_name?: unknown }).display_name : undefined;
  return typeof name === 'string' && name ? name : undefined;
}

/** Primary source: the server's normalized limits[], in its order. Unknown kinds are skipped (the server adds kinds freely). */
function fromLimits(limits: RawLimit[]): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const l of limits) {
    let key: { id: string; label: string } | undefined;
    if (l.kind === 'session') key = { id: 'session', label: '5h' };
    else if (l.kind === 'weekly_all') key = { id: 'weekly', label: '7d' };
    else if (l.kind === 'weekly_scoped') {
      const name = scopeName(l.scope);
      if (name) key = { id: `weekly:${usageSlug(name)}`, label: name };
    }
    if (!key) continue;
    out.push({ ...key, utilization: percent(l.percent), resetsAt: instant(l.resets_at), ...(typeof l.is_active === 'boolean' ? { active: l.is_active } : {}) });
  }
  return out;
}

/** Fallback when limits[] has no usable entry (older CLI): the typed windows, under the same ids. */
function fromTyped(rates: RawRates): UsageWindow[] {
  const out: UsageWindow[] = [];
  const add = (id: string, label: string, w: RawWindow | undefined) => {
    const utilization = percent(w?.utilization);
    const resetsAt = instant(w?.resets_at);
    if (w && (utilization !== null || resetsAt !== null)) out.push({ id, label, utilization, resetsAt });
  };
  const typed = (key: string) => part(RawWindow, rates[key]);
  add('session', '5h', typed('five_hour'));
  add('weekly', '7d', typed('seven_day'));
  let models = 0;
  for (const m of parts(RawModelWindow, rates.model_scoped)) {
    if (!m.display_name) continue;
    models++;
    add(`weekly:${usageSlug(m.display_name)}`, m.display_name, m);
  }
  // the legacy per-model fields only when model_scoped names none, so a model never shows twice;
  // seven_day_oauth_apps means nothing in the game
  if (!models) {
    add('weekly:opus', 'Opus', typed('seven_day_opus'));
    add('weekly:sonnet', 'Sonnet', typed('seven_day_sonnet'));
  }
  return out;
}

/**
 * Amounts in major units (dollars): the server's are divided by 10^decimal_places when it sends an
 * integer there (minor units, e.g. cents), else taken as they are.
 */
function extraOf(e: RawExtra): UsageExtra {
  const places = e.decimal_places;
  const money = (v: number | null | undefined): number | null => {
    const a = amount(v);
    return a !== null && Number.isInteger(places) ? amount(a / 10 ** (places as number)) : a;
  };
  return { enabled: e.is_enabled === true, usedCredits: money(e.used_credits), monthlyLimit: money(e.monthly_limit), utilization: percent(e.utilization), ...(e.currency ? { currency: e.currency } : {}) };
}

/**
 * The CLI's /usage answer (claude.ai login) as the wire `Usage`. Never throws: an answer that is
 * not an object, or whose rate_limits is neither an object nor null, is `error: 'usage API shape
 * changed'`; a malformed part inside (one limit, one window, extra_usage) is dropped alone.
 */
export function mapUsage(raw: unknown, fetchedAt: number): Usage {
  const parsed = RawUsage.safeParse(raw);
  if (!parsed.success) return { mode: 'subscription', windows: [], fetchedAt, error: USAGE_ERRORS.shape };
  const d = parsed.data;
  const plan = typeof d.subscription_type === 'string' ? d.subscription_type : '';
  const base: Usage = { mode: 'subscription', ...(plan ? { plan } : {}), windows: [], fetchedAt };
  // false for API keys and cloud providers, and for login tokens that lack the profile scope
  if (d.rate_limits_available === false) return { ...base, error: USAGE_ERRORS.unavailable };
  const rates = d.rate_limits;
  // nothing to show: say why rather than publish an empty usage
  if (!rates) return { ...base, error: USAGE_ERRORS.notReported };
  const limits = parts(RawLimit, rates.limits);
  const windows = limits.length ? fromLimits(limits) : fromTyped(rates);
  const extra = part(RawExtra, rates.extra_usage);
  return {
    ...base,
    windows: windows.filter((w, i) => windows.findIndex((x) => x.id === w.id) === i),
    ...(extra ? { extra: extraOf(extra) } : {}),
  };
}

/** For the debug log: mode, plan, window ids with whole percentages, and the error; never the raw answer. */
export function usageSummary(u: Usage): string {
  const windows = u.windows.map((w) => `${w.id} ${w.utilization === null ? '?' : Math.round(w.utilization)}`).join(', ');
  return [u.mode, u.plan, windows || 'no windows', u.stale ? 'stale' : '', u.error ? `error: ${u.error}` : ''].filter(Boolean).join(' · ');
}
