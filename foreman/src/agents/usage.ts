// Keeps `foreman.status.usage` fresh (docs/design/usage-display.md). The team polls the engine's
// usage() once after the auth check, after every turn, and on a timer: every minute while a turn
// runs, every 5 minutes when idle. One poll at a time: a trigger during a poll runs one more poll
// when it ends (triggers never queue). A failed poll backs off (the interval doubles from 60 s up
// to 30 min, turn ends do not poll meanwhile) and republishes the last good windows as stale.
// API mode has no plan windows to refresh: its first answer is published and polling ends.
import type { Logger } from '../context.js';
import type { Usage } from '../protocol.js';
import { truncate } from '../util/text.js';

export const USAGE_BUSY_MS = 60_000;
export const USAGE_IDLE_MS = 5 * 60_000;
export const USAGE_MAX_BACKOFF_MS = 30 * 60_000;

export interface UsagePollerOptions {
  /** the engine's usage() (it never throws; a throw still counts as a failed poll) */
  poll(): Promise<Usage>;
  publish(usage: Usage): void;
  /** a turn is running: the faster cadence */
  busy(): boolean;
  log: Logger;
}

export class UsagePoller {
  private timer: NodeJS.Timeout | undefined;
  private inflight = false;
  /** a trigger arrived during the poll: one more poll when it ends */
  private dirty = false;
  private started = false;
  private stopped = false;
  /** the last successful result, republished as stale when a poll fails */
  private good: Usage | undefined;
  /** failed polls in a row (the backoff exponent) */
  private failures = 0;
  /** when the last poll ended: the timer counts from there */
  private lastPollAt = 0;
  /** backing off: turn ends before this do not poll */
  private nextAllowedAt = 0;

  constructor(private opts: UsagePollerOptions) {}

  /** The first poll (the auth check succeeded), then the timer. */
  start(): void {
    if (this.stopped) return;
    this.started = true;
    this.run();
  }

  /** A turn ended: fresh numbers, unless backing off. */
  trigger(): void {
    if (!this.started || this.stopped) return;
    if (Date.now() < this.nextAllowedAt) {
      if (!this.inflight) this.schedule(); // no poll, but the cadence may have changed
      return;
    }
    this.run();
  }

  /** A turn started: the cadence may have changed. */
  reschedule(): void {
    if (this.started && !this.stopped && !this.inflight) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private run(): void {
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    this.inflight = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.pollOnce()
      .catch((e) => this.opts.log.debug(`usage poll: ${(e as Error)?.message ?? e}`))
      .finally(() => {
        this.inflight = false;
        if (this.stopped) return;
        // a failed poll is not repeated for a trigger that came meanwhile: once per interval
        if (this.dirty && Date.now() >= this.nextAllowedAt) this.run();
        else {
          this.dirty = false;
          this.schedule();
        }
      });
  }

  private async pollOnce(): Promise<void> {
    let u: Usage;
    try {
      u = await this.opts.poll();
    } catch (e) {
      u = { mode: this.good?.mode ?? 'subscription', windows: [], fetchedAt: Date.now(), error: `usage poll failed: ${truncate((e as Error)?.message ?? String(e), 160)}` };
    }
    this.lastPollAt = Date.now();
    if (this.stopped) return;
    if (!u.error) {
      this.failures = 0;
      this.nextAllowedAt = 0;
      this.good = u;
      this.opts.publish(u);
      // the auth mode cannot change while the Foreman runs: nothing more to learn, no status churn
      if (u.mode === 'api') {
        this.opts.log.debug('usage: api mode, no plan windows; not polling again');
        this.stop();
      }
      return;
    }
    this.failures++;
    this.nextAllowedAt = this.lastPollAt + this.backoff();
    this.opts.log.debug(`usage poll failed (${this.failures} in a row, next in ${Math.round(this.interval() / 1000)} s): ${u.error}`);
    // the last good windows stay up, marked stale, with the fetchedAt they were obtained at
    this.opts.publish(this.good ? { ...this.good, stale: true, error: u.error } : { ...u, windows: [] });
  }

  /** after failures: 60 s doubled per failure in a row, at most 30 min */
  private backoff(): number {
    return Math.min(USAGE_MAX_BACKOFF_MS, USAGE_BUSY_MS * 2 ** this.failures);
  }

  private interval(): number {
    const cadence = this.opts.busy() ? USAGE_BUSY_MS : USAGE_IDLE_MS;
    return this.failures ? Math.max(cadence, this.backoff()) : cadence;
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.run();
      },
      Math.max(0, this.lastPollAt + this.interval() - Date.now()),
    );
    this.timer.unref?.();
  }
}
