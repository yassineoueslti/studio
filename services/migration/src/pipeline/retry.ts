import { MigrationError, toMigrationError } from '../domain/errors.js';
import type { RateLimitProfile } from '../adapters/types.js';

/**
 * Retry level 1 of 3 (Scope §29): automatic request retry for transient
 * failures, with exponential backoff and jitter (Scope §25).
 *
 * Levels 2 (batch retry) and 3 (record retry) are driven from the migration
 * API and live in the orchestrator, because they need durable state; this
 * module only handles the in-process, single-request case.
 */

export interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  /** Called before each wait, for logging and the migration_retry_total metric. */
  onRetry?: (info: { attempt: number; delayMs: number; error: MigrationError }) => void;
  /** Injection point for tests; defaults to real time. */
  sleep?: (ms: number) => Promise<void>;
}

export function retryOptionsFrom(profile: RateLimitProfile, overrides: Partial<RetryOptions> = {}): RetryOptions {
  return {
    attempts: profile.retryAttempts,
    initialDelayMs: profile.retryDelayMs,
    multiplier: profile.backoffMultiplier,
    maxDelayMs: profile.maxRetryDelayMs,
    ...overrides,
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter (delay = random(0, computed)). Chosen over fixed backoff because
 * a migration issues many concurrent requests: without jitter every worker
 * retries on the same tick and reproduces the 429 that caused the backoff.
 */
export function computeDelay(attempt: number, options: RetryOptions, random: () => number = Math.random): number {
  const exponential = options.initialDelayMs * options.multiplier ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  return Math.round(random() * capped);
}

/**
 * Run `fn`, retrying transient failures. A non-retryable error (per the error
 * taxonomy) is rethrown immediately: retrying a PERMISSION_ERROR just burns
 * the customer's rate-limit budget to receive the same 403.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError: MigrationError | undefined;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new MigrationError('UNKNOWN_ERROR', 'Operation aborted before completion', {});
    }

    try {
      return await fn(attempt);
    } catch (err) {
      const error = toMigrationError(err);
      lastError = error;

      if (!error.retryable || attempt === options.attempts) throw error;

      const delayMs = computeDelay(attempt, options);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new MigrationError('UNKNOWN_ERROR', 'Retry loop exited without a result', {});
}
