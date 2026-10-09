// The in-game usage display, Foreman side (docs/design/usage-display.md): ClaudeEngine.usage()
// against a fake SDK query that answers with the captured Max response (test/fixtures/
// usage-sample.json, trimmed; its codename keys, spend and per-surface breakdowns must never reach
// the wire), the poller's cadence, coalescing, backoff and stale republishing, and what reaches
// foreman.status per kind of team.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { ClaudeEngine } from '../src/agents/claude/engine.js';
import { mapUsage, USAGE_ERRORS, USAGE_TIMEOUT_MS, usageSlug } from '../src/agents/claude/usage.js';
import { CodexEngine } from '../src/agents/codex/engine.js';
import type { Engine } from '../src/agents/engine.js';
import { SimBackend } from '../src/agents/sim/index.js';
import { TeamBackend } from '../src/agents/team.js';
import { USAGE_BUSY_MS, USAGE_IDLE_MS, USAGE_MAX_BACKOFF_MS, UsagePoller } from '../src/agents/usage.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/context.js';
import { ForemanStatus, Usage } from '../src/protocol.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const FIXTURE = fileURLToPath(new URL('./fixtures/usage-sample.json', import.meta.url));
type Sample = { subscription_type?: unknown; rate_limits_available?: unknown; rate_limits: Record<string, unknown> | null | string };
/** a fresh copy of the captured answer (tests change it) */
const sample = (): Sample => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Sample;
const rates = (s: Sample) => s.rate_limits as Record<string, unknown>;
const RESETS = { session: '2026-10-09T23:20:00.063786+00:00', weekly: '2026-10-13T20:00:00.063805+00:00', fable: '2026-10-13T20:00:00.063946+00:00' };
const MAX_WINDOWS = [
  { id: 'session', label: '5h', utilization: 62, resetsAt: RESETS.session, active: true },
  { id: 'weekly', label: '7d', utilization: 34, resetsAt: RESETS.weekly, active: false },
  { id: 'weekly:fable', label: 'Fable', utilization: 43, resetsAt: RESETS.fable, active: false },
];

/** A fake SDK `query()`: the experimental method (under `name`) answers with `answer()`; no such method without `answer`. */
function fakeSdk(answer?: () => unknown, name: string = METHOD) {
  const seen = { queries: [] as Array<Options | undefined>, args: [] as unknown[], closed: 0 };
  const queryFn = ({ options }: { prompt: unknown; options?: Options }) => {
    seen.queries.push(options);
    return {
      close() {
        seen.closed++;
      },
      accountInfo: async () => ({ email: 'x@example.com', organization: 'Acme', subscriptionType: 'max' }),
      ...(answer
        ? {
            [name]: async (opts: unknown) => {
              seen.args.push(opts);
              return answer();
            },
          }
        : {}),
    };
  };
  return { seen, queryFn: queryFn as never };
}

let h: Harness | undefined;
let home: string | undefined;
let repo: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await h?.fm.close();
  if (home) rmrf(home);
  if (repo) rmrf(path.dirname(repo));
  h = undefined;
  home = undefined;
  repo = undefined;
});

function foreman(args: string[] = [], backend = 'claude'): Harness {
  home = tempDir();
  h = makeForeman(home, ['--backend', backend, ...args]);
  return h;
}
const loginEngine = (queryFn: never) => {
  const hh = foreman(['--use-claude-login']);
  return new ClaudeEngine(hh.fm, hh.cfg.claude, queryFn);
};

describe('ClaudeEngine.usage()', () => {
  it('maps the captured Max answer from limits[]: session, weekly, weekly:fable, plan, extra; unknown keys never reach the wire', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
    const { seen, queryFn } = fakeSdk(() => sample());
    const engine = loginEngine(queryFn);
    const debug = vi.spyOn(h!.fm.log, 'debug');
    const u = await engine.usage();
    expect(u).toStrictEqual({
      mode: 'subscription',
      plan: 'max',
      windows: MAX_WINDOWS,
      extra: { enabled: false, usedCredits: null, monthlyLimit: null, utilization: null },
      fetchedAt: expect.any(Number),
    });
    expect(Usage.safeParse(u).success).toBe(true);
    // the fixture really carries what must be dropped: spend, the per-surface breakdown, the shares
    expect(Object.keys(rates(sample()))).toEqual(expect.arrayContaining(['iguana_necktie', 'spend', 'seven_day_breakdown', 'weekly_scoped_shares']));
    expect(JSON.stringify(u)).not.toMatch(/iguana|tangelo|nimbus|limit_dollars|severity|total_cost_usd|user_disabled|decimal_places|spend|amount_minor|disclaimer|breakdown|claude_code|Chats|Cowork|scoped_shares|percent_of_weekly/);
    // a throwaway query like the auth probe: no settings, no session, the login env, closed after
    expect(seen.args).toEqual([{ skipBehaviors: true }]);
    expect(seen.queries).toHaveLength(1);
    expect(seen.queries[0]).toMatchObject({ settingSources: [], persistSession: false, permissionMode: 'default' });
    expect(Object.keys(seen.queries[0]!.env!)).not.toContain('ANTHROPIC_API_KEY');
    expect(seen.closed).toBe(1);
    // the debug log has ids, whole percentages, the plan and the duration; never the answer or the env
    const logged = debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/max · session 62, weekly 34, weekly:fable 43 \(\d+ ms\)/);
    expect(logged).not.toMatch(/sk-ant-secret|resets_at|iguana|2026-10|amount_minor|Cowork/);
  });

  it('drops only the malformed part: a bad limit, typed window, model entry or extra_usage leaves the rest', () => {
    // one malformed limit (a string percent) and an unknown kind with odd fields: the others still map
    const s = sample();
    const limits = rates(s).limits as Array<Record<string, unknown>>;
    limits[0]!.percent = '62';
    limits.push({ kind: 'cobalt_quota', percent: 'lots', resets_at: 3, scope: 'everywhere', is_active: 'no' });
    const u = mapUsage(s, 1);
    expect(u).toStrictEqual({ mode: 'subscription', plan: 'max', windows: MAX_WINDOWS.slice(1), extra: { enabled: false, usedCredits: null, monthlyLimit: null, utilization: null }, fetchedAt: 1 });
    // no usable limit at all: the typed windows, each parsed on its own (a bad one is dropped alone)
    const t = sample();
    rates(t).limits = [{ kind: 'session', percent: '62' }];
    rates(t).five_hour = { utilization: '62', resets_at: RESETS.session };
    rates(t).model_scoped = [{ display_name: 7, utilization: 1 }, ...(rates(t).model_scoped as unknown[])];
    rates(t).extra_usage = { is_enabled: 'yes' };
    t.subscription_type = 5;
    expect(mapUsage(t, 1)).toStrictEqual({ mode: 'subscription', windows: MAX_WINDOWS.slice(1).map(({ active: _, ...w }) => w), fetchedAt: 1 });
    // the shape error is only for the outer shape
    for (const raw of ['x', [], { rate_limits: 'nope' }, { rate_limits: [] }]) expect(mapUsage(raw, 1).error).toBe(USAGE_ERRORS.shape);
  });

  it('rate_limits absent or null: says the usage is not reported, unless the login is refused it', () => {
    for (const r of [{ rate_limits: null }, {}]) {
      expect(mapUsage({ subscription_type: 'max', rate_limits_available: true, ...r }, 1)).toStrictEqual({ mode: 'subscription', plan: 'max', windows: [], fetchedAt: 1, error: 'usage not reported for this login' });
    }
    expect(USAGE_ERRORS.notReported).toBe('usage not reported for this login');
    expect(mapUsage({ rate_limits_available: false }, 1).error).toBe(USAGE_ERRORS.unavailable);
  });

  it('extra-usage amounts in major units: divided by 10^decimal_places when that is an integer, as sent otherwise', () => {
    const extra = (e: Record<string, unknown>) => {
      const u = mapUsage({ rate_limits: { extra_usage: e } }, 1);
      expect(Usage.safeParse(u).success).toBe(true);
      return u.extra;
    };
    const e = { is_enabled: true, used_credits: 320, monthly_limit: 2000, utilization: 16, currency: 'USD' };
    expect(extra({ ...e, decimal_places: 2 })).toStrictEqual({ enabled: true, usedCredits: 3.2, monthlyLimit: 20, utilization: 16, currency: 'USD' });
    expect(extra({ ...e, decimal_places: 0 })).toMatchObject({ usedCredits: 320, monthlyLimit: 2000 });
    expect(extra({ ...e, monthly_limit: null, decimal_places: 2 })).toMatchObject({ usedCredits: 3.2, monthlyLimit: null });
    // null or absent (the captured answer), or not an integer: passed through unchanged
    for (const places of [{ decimal_places: null }, {}, { decimal_places: 2.5 }, { decimal_places: '2' }, { decimal_places: Number.NaN }]) {
      expect(extra({ ...e, ...places })).toStrictEqual({ enabled: true, usedCredits: 320, monthlyLimit: 2000, utilization: 16, currency: 'USD' });
    }
  });

  it('slug: lower-cased, non-alphanumeric runs to "-", leading and trailing "-" trimmed', () => {
    expect(usageSlug('Fable')).toBe('fable');
    expect(usageSlug('Opus (4.5)')).toBe('opus-4-5');
    expect(usageSlug('  Claude Code! ')).toBe('claude-code');
    expect(usageSlug('Sonnet 4.5')).toBe('sonnet-4-5');
    const u = mapUsage({ rate_limits: { limits: [{ kind: 'weekly_scoped', percent: 9, resets_at: null, scope: { model: { display_name: 'Opus (4.5)' } } }] } }, 1);
    expect(u.windows).toStrictEqual([{ id: 'weekly:opus-4-5', label: 'Opus (4.5)', utilization: 9, resetsAt: null }]);
  });

  it('falls back to the typed windows when limits[] is absent or empty, under the same ids', async () => {
    let answer = sample();
    const { queryFn } = fakeSdk(() => answer);
    const engine = loginEngine(queryFn);
    for (const limits of [undefined, []]) {
      answer = sample();
      if (limits) rates(answer).limits = limits;
      else delete rates(answer).limits;
      const u = await engine.usage();
      expect(u.windows).toStrictEqual(MAX_WINDOWS.map(({ active: _, ...w }) => w)); // limits[] alone knows the active one
      expect(u).toMatchObject({ mode: 'subscription', plan: 'max', extra: { enabled: false } });
      expect(u.error).toBeUndefined();
    }
  });

  it('legacy per-model fields only when model_scoped names no model; empty windows and oauth apps dropped', () => {
    const ids = (r: Record<string, unknown>) => mapUsage({ subscription_type: 'pro', rate_limits_available: true, rate_limits: r }, 1).windows.map((w) => `${w.id}=${w.utilization}`);
    const opus = { utilization: 70, resets_at: '2026-10-13T20:00:00+00:00' };
    expect(ids({ five_hour: { utilization: 10, resets_at: null }, seven_day: null, seven_day_opus: opus, seven_day_sonnet: { utilization: null, resets_at: null }, seven_day_oauth_apps: opus })).toEqual(['session=10', 'weekly:opus=70']);
    expect(ids({ model_scoped: [], seven_day_opus: opus })).toEqual(['weekly:opus=70']);
    // model_scoped and the legacy field both present: the model appears once
    expect(ids({ model_scoped: [{ display_name: 'Opus', utilization: 20, resets_at: null }], seven_day_opus: opus })).toEqual(['weekly:opus=20']);
  });

  it('skips unknown limit kinds and nameless scopes, names a scope by its surface without a model, and keeps percentages in 0-100', () => {
    const u = mapUsage(
      {
        rate_limits: {
          limits: [
            { kind: 'session', percent: 104.5, resets_at: null, is_active: true },
            { kind: 'iguana_necktie', percent: 3, resets_at: 'x' },
            { kind: 'weekly_scoped', percent: 5, resets_at: 'x', scope: { model: null, surface: null } },
            { kind: 'weekly_scoped', percent: 6, resets_at: 'x', scope: { model: null, surface: { display_name: 'Claude Code' } } },
            { kind: 'weekly_scoped', percent: -1, resets_at: 'x', scope: { model: { id: null, display_name: 'Opus 4.5' } } },
            { kind: 'weekly_scoped', percent: 9, resets_at: 'x', scope: { model: { display_name: 'Opus 4.5' } } },
          ],
        },
      },
      1,
    );
    expect(u.windows).toStrictEqual([
      { id: 'session', label: '5h', utilization: 100, resetsAt: null, active: true },
      { id: 'weekly:claude-code', label: 'Claude Code', utilization: 6, resetsAt: 'x' },
      { id: 'weekly:opus-4-5', label: 'Opus 4.5', utilization: 0, resetsAt: 'x' },
    ]);
    expect(Usage.safeParse(u).success).toBe(true);
    expect(usageSlug('Fable')).toBe('fable');
  });

  it('rate_limits_available false: the re-login hint, no windows', async () => {
    const { queryFn } = fakeSdk(() => ({ ...sample(), rate_limits_available: false, rate_limits: null }));
    expect(await loginEngine(queryFn).usage()).toStrictEqual({ mode: 'subscription', plan: 'max', windows: [], fetchedAt: expect.any(Number), error: USAGE_ERRORS.unavailable });
    expect(USAGE_ERRORS.unavailable).toBe('usage not available for this login; run claude and /login again');
  });

  it('without the method: an error, no throw, the query closed, remembered; the older name `usage` is found too', async () => {
    const missing = fakeSdk();
    const engine = loginEngine(missing.queryFn);
    const u = await engine.usage();
    expect(u).toStrictEqual({ mode: 'subscription', windows: [], fetchedAt: expect.any(Number), error: 'usage API not available in this SDK' });
    expect(missing.seen.closed).toBe(1);
    // the SDK cannot grow the method while the Foreman runs: the next poll spawns nothing
    expect(await engine.usage()).toStrictEqual({ mode: 'subscription', windows: [], fetchedAt: expect.any(Number), error: USAGE_ERRORS.missing });
    expect(missing.seen.queries).toHaveLength(1);
    const renamed = fakeSdk(() => sample(), 'usage');
    expect((await new ClaudeEngine(h!.fm, h!.cfg.claude, renamed.queryFn).usage()).windows).toStrictEqual(MAX_WINDOWS);
  });

  it('a malformed or failing answer: an error, no throw', async () => {
    let answer: () => unknown = () => ({ ...sample(), rate_limits: 'nope' });
    const { seen, queryFn } = fakeSdk(() => answer());
    const engine = loginEngine(queryFn);
    expect(await engine.usage()).toStrictEqual({ mode: 'subscription', windows: [], fetchedAt: expect.any(Number), error: 'usage API shape changed' });
    answer = () => null;
    expect((await engine.usage()).error).toBe('usage API shape changed');
    answer = () => {
      throw new Error('control request failed');
    };
    expect((await engine.usage()).error).toBe('usage request failed: control request failed');
    expect(seen.closed).toBe(3);
    const noCli = new ClaudeEngine(h!.fm, h!.cfg.claude, (() => {
      throw new Error('spawn claude ENOENT');
    }) as never);
    expect(await noCli.usage()).toMatchObject({ mode: 'subscription', windows: [], error: 'usage request failed: spawn claude ENOENT' });
  });

  it('API key mode: mode api, no windows, nothing spawned', async () => {
    const { seen, queryFn } = fakeSdk(() => sample());
    const hh = foreman();
    expect(await new ClaudeEngine(hh.fm, hh.cfg.claude, queryFn).usage()).toStrictEqual({ mode: 'api', windows: [], fetchedAt: expect.any(Number) });
    expect(seen.queries).toHaveLength(0);
  });

  it('gives up after 30 s and closes the query', async () => {
    const { seen, queryFn } = fakeSdk(() => new Promise(() => undefined));
    const engine = loginEngine(queryFn);
    vi.useFakeTimers();
    const pending = engine.usage();
    await vi.advanceTimersByTimeAsync(USAGE_TIMEOUT_MS - 1);
    expect(seen.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ mode: 'subscription', windows: [], error: 'usage request failed: timed out after 30s' });
    expect(seen.closed).toBe(1);
  });
});

describe('UsagePoller', () => {
  const win = (utilization: number): Usage => ({ mode: 'subscription', plan: 'max', windows: [{ id: 'session', label: '5h', utilization, resetsAt: null }], fetchedAt: Date.now() });
  const failure = (error = 'usage request failed: boom'): Usage => ({ mode: 'subscription', windows: [], fetchedAt: Date.now(), error });
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  /** a poller whose polls answer from `answers` in turn (the last one repeats) */
  function pollerWith(answers: Array<() => Promise<Usage>>, busy: () => boolean = () => false) {
    vi.useFakeTimers();
    const published: Usage[] = [];
    let i = 0;
    const poll = vi.fn(() => answers[Math.min(i++, answers.length - 1)]!());
    const poller = new UsagePoller({ poll, publish: (u) => published.push(u), busy, log: silentLogger });
    return { poller, poll, published };
  }

  it('polls at start, then every 5 min when idle and every minute while a turn runs', async () => {
    let busy = false;
    const { poller, poll } = pollerWith([async () => win(1)], () => busy);
    poller.start();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(USAGE_IDLE_MS - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(poll).toHaveBeenCalledTimes(2);
    // a turn starts 10 s later: the busy cadence, counted from the last poll
    await tick(10_000);
    busy = true;
    poller.reschedule();
    await tick(USAGE_BUSY_MS - 10_000 - 1);
    expect(poll).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(poll).toHaveBeenCalledTimes(3);
    await tick(USAGE_BUSY_MS);
    expect(poll).toHaveBeenCalledTimes(4);
    // the turn ends: a poll right away, then the idle cadence
    busy = false;
    poller.trigger();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(5);
    await tick(USAGE_IDLE_MS - 1);
    expect(poll).toHaveBeenCalledTimes(5);
    await tick(1);
    expect(poll).toHaveBeenCalledTimes(6);
    poller.stop();
    await tick(USAGE_MAX_BACKOFF_MS);
    expect(poll).toHaveBeenCalledTimes(6);
  });

  it('runs one poll at a time: triggers during a poll coalesce into one more', async () => {
    const gates: Array<(u: Usage) => void> = [];
    const { poller, poll, published } = pollerWith([() => new Promise<Usage>((r) => gates.push(r))]);
    poller.start();
    poller.trigger();
    poller.trigger();
    poller.trigger();
    expect(poll).toHaveBeenCalledTimes(1);
    gates[0]!(win(1));
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(2);
    gates[1]!(win(2));
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(2); // nothing pending: back to the timer
    expect(published.map((u) => u.windows[0]!.utilization)).toEqual([1, 2]);
    poller.stop();
  });

  it('backs off on errors (2, 4, 8, 16, then 30 min), ignores turn ends meanwhile, and a success resets it', async () => {
    let ok = false;
    const { poller, poll, published } = pollerWith([async () => (ok ? win(5) : failure())], () => true);
    poller.start();
    await tick(0);
    let calls = 1;
    expect(poll).toHaveBeenCalledTimes(calls);
    // nothing good yet: no windows, just the error
    expect(published).toStrictEqual([{ mode: 'subscription', windows: [], fetchedAt: expect.any(Number), error: 'usage request failed: boom' }]);
    for (const minutes of [2, 4, 8, 16, 30, 30]) {
      poller.trigger(); // a turn ended: the failing endpoint is not hit again before the interval is up
      await tick(minutes * 60_000 - 1);
      expect(poll).toHaveBeenCalledTimes(calls);
      await tick(1);
      expect(poll).toHaveBeenCalledTimes(++calls);
    }
    expect(USAGE_MAX_BACKOFF_MS).toBe(30 * 60_000);
    ok = true;
    await tick(USAGE_MAX_BACKOFF_MS);
    expect(poll).toHaveBeenCalledTimes(++calls);
    expect(published.at(-1)).toStrictEqual({ mode: 'subscription', plan: 'max', windows: [{ id: 'session', label: '5h', utilization: 5, resetsAt: null }], fetchedAt: expect.any(Number) });
    // back to the busy cadence, and turn ends poll again
    await tick(USAGE_BUSY_MS);
    expect(poll).toHaveBeenCalledTimes(++calls);
    poller.trigger();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(++calls);
    poller.stop();
  });

  it('a failed poll republishes the last good windows as stale, with the error and their own fetchedAt', async () => {
    const { poller, published } = pollerWith([async () => win(62), async () => failure('usage request failed: timed out after 30s'), async () => win(70)], () => true);
    poller.start();
    await tick(0);
    const good = published[0]!;
    await tick(USAGE_BUSY_MS);
    expect(published[1]).toStrictEqual({ ...good, stale: true, error: 'usage request failed: timed out after 30s' });
    await tick(2 * USAGE_BUSY_MS);
    expect(published[2]).toStrictEqual({ mode: 'subscription', plan: 'max', windows: [{ id: 'session', label: '5h', utilization: 70, resetsAt: null }], fetchedAt: expect.any(Number) });
    expect(published[2]!.fetchedAt).toBeGreaterThan(good.fetchedAt);
    poller.stop();
  });

  it('api mode: the first answer is published and polling ends; turns and timers change nothing', async () => {
    const api: Usage = { mode: 'api', windows: [], fetchedAt: 1 };
    const { poller, poll, published } = pollerWith([async () => api], () => true);
    poller.start();
    await tick(0);
    for (let i = 0; i < 3; i++) {
      poller.reschedule(); // a turn starts
      poller.trigger(); // and ends
      await tick(USAGE_IDLE_MS);
    }
    await tick(USAGE_MAX_BACKOFF_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(published).toStrictEqual([api]);
  });

  it('a poll that throws counts as a failure and never escapes; stop() ends polling and drops a poll in flight', async () => {
    const thrower = pollerWith([
      async () => {
        throw new Error('boom');
      },
    ]);
    thrower.poller.start();
    await tick(0);
    expect(thrower.published).toStrictEqual([{ mode: 'subscription', windows: [], fetchedAt: expect.any(Number), error: 'usage poll failed: boom' }]);
    thrower.poller.stop();

    const gates: Array<(u: Usage) => void> = [];
    const { poller, poll, published } = pollerWith([() => new Promise<Usage>((r) => gates.push(r))]);
    poller.start();
    poller.stop();
    gates[0]!(win(1));
    await tick(2 * USAGE_IDLE_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);
  });
});

describe('foreman.status.usage from the team', () => {
  it('a claude.ai login team publishes the windows after the auth check, asks again after a turn, and keeps them stale when that fails', async () => {
    repo = await demoRepo();
    const hh = foreman(['--use-claude-login', '--workers', 'kit', '--repo', repo]);
    const S = '00000000-0000-4000-8000-000000000077';
    const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: S, ...o }) as unknown as SDKMessage;
    let answers = 0;
    // the lead's turn plans nothing; the usage probe answers once, then the endpoint fails
    const queryFn = () => {
      async function* turn(): AsyncGenerator<SDKMessage> {
        yield m({ type: 'system', subtype: 'init', session_id: S, model: 'fake', cwd: '', tools: [] });
        yield m({ type: 'result', subtype: 'success', is_error: false, result: 'Nothing to do.', num_turns: 1, total_cost_usd: 0.01, session_id: S, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
      }
      return Object.assign(turn(), {
        close() {},
        accountInfo: async () => ({ email: 'x' }),
        [METHOD]: async () => {
          if (++answers > 1) throw new Error('usage endpoint unavailable');
          return sample();
        },
      });
    };
    await hh.fm.start(new ClaudeBackend(hh.fm, hh.cfg.claude, { queryFn: queryFn as never, skipAuthCheck: true }));
    await until(() => !!hh.fm.status.usage);
    const first = hh.fm.status.usage!;
    expect(first).toStrictEqual({ mode: 'subscription', plan: 'max', windows: MAX_WINDOWS, extra: { enabled: false, usedCredits: null, monthlyLimit: null, utilization: null }, fetchedAt: expect.any(Number) });
    expect(ForemanStatus.safeParse(hh.fm.status).success).toBe(true);
    expect(hh.events.some((e) => e.type === 'foreman.status' && e.status.usage?.windows.length === 3)).toBe(true);
    const goal = await hh.fm.submitGoal('Nothing to do here');
    await until(() => hh.fm.goal(goal.id)!.status !== 'planning');
    await until(() => !!hh.fm.status.usage?.stale);
    expect(answers).toBe(2);
    expect(hh.fm.status.usage).toStrictEqual({ ...first, stale: true, error: 'usage request failed: usage endpoint unavailable' });
  });

  it('an API key team publishes mode api once, spawns nothing for it, and stays quiet across turns', async () => {
    repo = await demoRepo();
    const hh = foreman(['--workers', 'kit', '--repo', repo]);
    const S = '00000000-0000-4000-8000-000000000078';
    const m = (o: Record<string, unknown>) => ({ parent_tool_use_id: null, uuid: S, ...o }) as unknown as SDKMessage;
    let queries = 0;
    let turns = 0;
    let usageCalls = 0;
    // the lead's turns plan nothing; the usage method is there but must never be called
    const queryFn = () => {
      queries++;
      async function* turn(): AsyncGenerator<SDKMessage> {
        turns++;
        yield m({ type: 'system', subtype: 'init', session_id: S, model: 'fake', cwd: '', tools: [] });
        yield m({ type: 'result', subtype: 'success', is_error: false, result: 'Nothing to do.', num_turns: 1, total_cost_usd: 0.01, session_id: S, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
      }
      return Object.assign(turn(), {
        close() {},
        accountInfo: async () => ({ email: 'x' }),
        [METHOD]: async () => {
          usageCalls++;
          return sample();
        },
      });
    };
    const setStatus = vi.spyOn(hh.fm, 'setStatus');
    await hh.fm.start(new ClaudeBackend(hh.fm, hh.cfg.claude, { queryFn: queryFn as never, skipAuthCheck: true }));
    await until(() => !!hh.fm.status.usage);
    expect(hh.fm.status.usage).toStrictEqual({ mode: 'api', windows: [], fetchedAt: expect.any(Number) });
    expect(queries).toBe(0);
    // turns start (the busy cadence) and end (a poll trigger): nothing more is published
    for (const text of ['Nothing to do here', 'Nothing to do there either']) {
      const goal = await hh.fm.submitGoal(text);
      await until(() => hh.fm.goal(goal.id)!.status !== 'planning');
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(turns).toBeGreaterThanOrEqual(2);
    expect(usageCalls).toBe(0);
    expect(setStatus.mock.calls.filter(([patch]) => 'usage' in patch)).toHaveLength(1);
    const published = hh.events.flatMap((e) => (e.type === 'foreman.status' && e.status.usage ? [JSON.stringify(e.status.usage)] : []));
    expect(new Set(published).size).toBe(1);
  });

  it('--no-usage (config.json claude.usagePoll: false) never polls', async () => {
    const { seen, queryFn } = fakeSdk(() => sample());
    const hh = foreman(['--use-claude-login', '--no-usage', '--workers', 'kit']);
    expect(hh.cfg.claude.usagePoll).toBe(false);
    await hh.fm.start(new ClaudeBackend(hh.fm, hh.cfg.claude, { queryFn, skipAuthCheck: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.queries).toHaveLength(0);
    expect(hh.fm.status.usage).toBeUndefined();
    const usagePoll = (args: string[]) => loadConfig(['--home', home!, ...args], {}).claude.usagePoll;
    expect(usagePoll([])).toBe(true);
    expect(usagePoll(['--no-usage'])).toBe(false);
    fs.writeFileSync(path.join(home!, 'config.json'), JSON.stringify({ claude: { usagePoll: false } }));
    expect(usagePoll([])).toBe(false);
    expect(usagePoll(['--usage'])).toBe(true);
  });

  it('a mixed team polls only its Claude engine', async () => {
    const sdk = fakeSdk(() => sample());
    const hh = foreman(['--use-claude-login', '--worker-engine', 'codex', '--workers', 'kit']);
    const claude = new ClaudeEngine(hh.fm, hh.cfg.claude, sdk.queryFn);
    const codex: Engine = new CodexEngine(hh.fm, hh.cfg.codex);
    expect(codex.usage).toBeUndefined();
    const polled = vi.spyOn(claude, 'usage');
    const team = new TeamBackend(hh.fm, hh.cfg.claude, { name: 'claude', engines: { lead: claude, worker: codex }, skipAuthCheck: true });
    await hh.fm.start(team);
    await until(() => !!hh.fm.status.usage);
    expect(polled).toHaveBeenCalledTimes(1);
    expect(sdk.seen.args).toEqual([{ skipBehaviors: true }]);
    expect(hh.fm.status.usage!.windows).toStrictEqual(MAX_WINDOWS);
    // the busy cadence counts Claude turns only: a Codex worker at work spends no Claude plan
    const running = team['running'];
    expect(team['usageBusy']()).toBe(false);
    running.set('kit', {} as never);
    expect(team['usageBusy']()).toBe(false);
    running.set('marlow', {} as never);
    expect(team['usageBusy']()).toBe(true);
    running.clear();
  });

  it('a Codex-only team never sets usage', async () => {
    const hh = foreman(['--workers', 'kit'], 'codex');
    const codex = new CodexEngine(hh.fm, hh.cfg.codex);
    await hh.fm.start(new TeamBackend(hh.fm, hh.cfg.claude, { name: 'codex', engines: { lead: codex, worker: codex }, skipAuthCheck: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(hh.fm.status.usage).toBeUndefined();
    expect(hh.events.some((e) => e.type === 'foreman.status' && e.status.usage !== undefined)).toBe(false);
  });

  it('the sim never sets usage', async () => {
    const hh = foreman([], 'sim');
    await hh.fm.start(new SimBackend(hh.fm, hh.cfg.sim));
    expect(hh.fm.status.usage).toBeUndefined();
    expect(hh.fm.snapshot()).not.toHaveProperty('foreman.usage');
  });
});
