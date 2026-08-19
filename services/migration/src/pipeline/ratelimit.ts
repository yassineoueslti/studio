import type { RateLimitProfile } from '../adapters/types.js';

/**
 * Client-side throttle (Scope §25). Each adapter declares requests per second
 * and per minute; this enforces both so the engine stays inside a vendor's
 * limits rather than discovering them through 429s.
 *
 * Guide §8.4: "Do not let n8n automatically retry indefinitely" -- being polite
 * up front is cheaper than backing off after the fact, and some vendors
 * penalise sustained overage beyond the individual request.
 */
export class RateLimiter {
  private readonly perSecond: number;
  private readonly perMinute: number;
  private secondWindowStart = 0;
  private secondCount = 0;
  private minuteWindowStart = 0;
  private minuteCount = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    profile: Pick<RateLimitProfile, 'requestsPerSecond' | 'requestsPerMinute'>,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.perSecond = Math.max(1, profile.requestsPerSecond);
    this.perMinute = Math.max(1, profile.requestsPerMinute);
  }

  /**
   * Resolve when it is safe to issue the next request. Serialized through a
   * promise chain so concurrent callers queue in order instead of all reading
   * the same stale counter and bursting past the limit together.
   */
  async acquire(): Promise<void> {
    const turn = this.queue.then(() => this.reserve());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async reserve(): Promise<void> {
    for (;;) {
      const now = this.now();

      if (now - this.secondWindowStart >= 1000) {
        this.secondWindowStart = now;
        this.secondCount = 0;
      }
      if (now - this.minuteWindowStart >= 60_000) {
        this.minuteWindowStart = now;
        this.minuteCount = 0;
      }

      if (this.secondCount < this.perSecond && this.minuteCount < this.perMinute) {
        this.secondCount += 1;
        this.minuteCount += 1;
        return;
      }

      const waitForSecond = this.secondCount >= this.perSecond ? 1000 - (now - this.secondWindowStart) : 0;
      const waitForMinute = this.minuteCount >= this.perMinute ? 60_000 - (now - this.minuteWindowStart) : 0;
      await this.sleep(Math.max(1, waitForSecond, waitForMinute));
    }
  }
}

/**
 * Bounded-concurrency map. Scope §22: file libraries must move in controlled
 * batches rather than a single unbounded Promise.all that opens ten thousand
 * sockets and exhausts memory.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, concurrency);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}
