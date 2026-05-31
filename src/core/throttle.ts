import { logger } from '../logger.js';

/**
 * Concurrency limiter with rate-limit-aware backoff.
 *
 * A Claude subscription is governed by rolling usage windows, not pay-as-you-go
 * billing. An always-on agent fanning out work will exhaust the quota quickly,
 * so every agent turn passes through this gate:
 *   - at most `maxConcurrent` turns run at once;
 *   - when the SDK signals a rate-limit, we set a cooldown and queued work waits.
 */
export class Throttle {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private cooldownUntil = 0;

  constructor(private readonly maxConcurrent: number) {}

  /** Record that the engine hit a subscription rate limit; pause new work. */
  noteRateLimit(retryAfterMs = 60_000): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);
    logger.warn({ retryAfterMs }, 'rate limit hit — cooling down');
  }

  get pending(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const wait = this.cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
