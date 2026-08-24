import { describe, expect, it } from 'vitest';
import {
  addressKey, normalizeAddress, normalizeBoolean, normalizeDate, normalizeEmail,
  normalizeEmails, normalizeMoneyCents, normalizePhone, normalizePhones,
  normalizeState, normalizeTags, normalizeText, nullIfEmpty, splitFullName,
} from '../src/transformers/normalize.js';
import { contentHash, idempotencyKey } from '../src/canonical/hash.js';
import { jaroWinkler } from '../src/dedupe/matcher.js';
import { computeDelay, withRetry } from '../src/pipeline/retry.js';
import { RateLimiter, mapWithConcurrency } from '../src/pipeline/ratelimit.js';
import { MigrationError, classifyError, isRetryable } from '../src/domain/errors.js';
import {
  assertTransition, canTransition, isAccountedFor, IllegalStateTransitionError,
  ACCOUNTED_FOR_RECORD_STATES, RECORD_STATES,
} from '../src/domain/states.js';
import { missingDependencies, sequence } from '../src/domain/entities.js';
import { validateCanonical } from '../src/canonical/index.js';

/**
 * Unit tests for the pure layers: normalization, hashing, matching, retry,
 * state machines and canonical validation (Scope §58 "Unit Tests").
 */

describe('normalization (Scope §21)', () => {
  it('normalizes phone numbers to a stable comparison key regardless of formatting', () => {
    const variants = ['(512) 555-0142', '512-555-0142', '512.555.0142', '+15125550142', '5125550142'];
    const normalized = variants.map((v) => normalizePhone(v));
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('+15125550142');
  });

  it('strips extensions before extracting digits', () => {
    expect(normalizePhone('512-555-0142 x22')).toBe('+15125550142');
    expect(normalizePhone('512-555-0142 ext. 4501')).toBe('+15125550142');
  });

  it('rejects placeholder numbers that would otherwise collide across customers', () => {
    expect(normalizePhone('0000000000')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('normalizes email casing and rejects malformed addresses', () => {
    expect(normalizeEmail('  John.Smith@Example.COM ')).toBe('john.smith@example.com');
    expect(normalizeEmail('mailto:a@b.co')).toBe('a@b.co');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });

  it('splits multi-valued email and phone cells that exports pack into one column', () => {
    expect(normalizeEmails('A@x.com; b@y.com , A@X.COM')).toEqual(['a@x.com', 'b@y.com']);
    expect(normalizePhones('512-555-0142 / 512.555.0143')).toEqual(['+15125550142', '+15125550143']);
  });

  it('parses the date formats that appear together in one export column', () => {
    expect(normalizeDate('2024-03-15T10:00:00Z')?.getUTCFullYear()).toBe(2024);
    // US M/D/YYYY, parsed deterministically rather than by runtime locale.
    expect(normalizeDate('3/15/2024')?.getUTCMonth()).toBe(2);
    expect(normalizeDate('3/15/2024')?.getUTCDate()).toBe(15);
    // Excel serial.
    expect(normalizeDate(45000)?.getUTCFullYear()).toBe(2023);
    // Epoch seconds and milliseconds.
    expect(normalizeDate(1_710_000_000)?.getUTCFullYear()).toBe(2024);
    expect(normalizeDate(1_710_000_000_000)?.getUTCFullYear()).toBe(2024);
  });

  it('returns null for unparseable and placeholder dates rather than Invalid Date', () => {
    expect(normalizeDate('0000-00-00')).toBeNull();
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('1850-01-01')).toBeNull();
  });

  it('parses money into integer minor units, including accounting negatives', () => {
    expect(normalizeMoneyCents('$1,234.56')).toBe(123_456);
    expect(normalizeMoneyCents('(500.00)')).toBe(-50_000);
    expect(normalizeMoneyCents('-250')).toBe(-25_000);
    expect(normalizeMoneyCents(1234.5)).toBe(123_450);
    expect(normalizeMoneyCents('')).toBeNull();
  });

  it('expands state names and canonicalizes postal codes', () => {
    expect(normalizeState('california')).toBe('CA');
    expect(normalizeState('California')).toBe('CA');
    expect(normalizeState('CA')).toBe('CA');
    expect(normalizeAddress({ line1: '1 A St', postal_code: '902101234' })?.postal_code).toBe('90210-1234');
  });

  it('treats sentinel strings as empty', () => {
    for (const sentinel of ['', '   ', 'null', 'N/A', 'none', '-']) {
      expect(nullIfEmpty(sentinel)).toBeNull();
    }
    expect(nullIfEmpty('real value')).toBe('real value');
  });

  it('splits both "First Last" and "Last, First" name columns', () => {
    expect(splitFullName('John Smith')).toEqual({ first: 'John', last: 'Smith' });
    expect(splitFullName('Smith, John')).toEqual({ first: 'John', last: 'Smith' });
    expect(splitFullName('Cher')).toEqual({ first: 'Cher', last: null });
  });

  it('produces an address key that ignores street-suffix spelling', () => {
    const a = normalizeAddress({ line1: '123 Maple Street', postal_code: '78701' });
    const b = normalizeAddress({ line1: '123 Maple St.', postal_code: '78701' });
    expect(addressKey(a)).toBe(addressKey(b));
    expect(addressKey(a)).not.toBeNull();
  });

  it('deduplicates tags case-insensitively while preserving order', () => {
    expect(normalizeTags('hail, Hail, wind')).toEqual(['hail', 'wind']);
  });

  it('strips control characters that CRM exports smuggle into text', () => {
    const withControlChars = ['Hello', String.fromCharCode(0), ' ', String.fromCharCode(7), 'World'].join('');
    expect(normalizeText(withControlChars)).toBe('Hello World');
    expect(normalizeText('  spaced   out  ')).toBe('spaced out');
  });

  it('coerces the boolean spellings that appear across CRMs', () => {
    for (const truthy of ['yes', 'Y', 'true', '1', 'active']) expect(normalizeBoolean(truthy)).toBe(true);
    for (const falsy of ['no', 'N', 'false', '0', 'inactive']) expect(normalizeBoolean(falsy)).toBe(false);
    expect(normalizeBoolean('maybe')).toBeNull();
  });
});

describe('content hashing and idempotency keys (Scope §11, §45)', () => {
  it('hashes independently of key order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it('ignores volatile fields so re-extraction does not look like a change', () => {
    const base = { name: 'A', migration_id: 'x', raw_source_reference: 'r1', transformer_version: 'v1', warnings: [] };
    const later = {
      name: 'A', migration_id: 'y', raw_source_reference: 'r2', transformer_version: 'v2',
      warnings: [{ code: 'X', message: 'm' }],
    };
    expect(contentHash(base)).toBe(contentHash(later));
  });

  it('changes when real content changes', () => {
    expect(contentHash({ name: 'A' })).not.toBe(contentHash({ name: 'B' }));
  });

  it('builds the documented idempotency key format', () => {
    expect(
      idempotencyKey({ migrationId: '123', sourcePlatform: 'jobnimbus', objectType: 'contact', sourceObjectId: '87562' }),
    ).toBe('mig_123:jobnimbus:contact:87562');
  });
});

describe('error taxonomy (Scope §36)', () => {
  it('classifies HTTP statuses into the standard codes', () => {
    expect(classifyError({ status: 401 })).toBe('AUTHENTICATION_ERROR');
    expect(classifyError({ status: 403 })).toBe('PERMISSION_ERROR');
    expect(classifyError({ status: 404 })).toBe('SOURCE_NOT_FOUND');
    expect(classifyError({ status: 429 })).toBe('RATE_LIMIT');
    expect(classifyError({ status: 503 })).toBe('BUILDERLYNC_API_ERROR');
    expect(classifyError({ code: 'ECONNRESET' })).toBe('SOURCE_TIMEOUT');
    expect(classifyError(new Error('boom'))).toBe('UNKNOWN_ERROR');
  });

  it('marks transient failures retryable and permission failures not', () => {
    expect(isRetryable('RATE_LIMIT')).toBe(true);
    expect(isRetryable('SOURCE_TIMEOUT')).toBe(true);
    expect(isRetryable('BUILDERLYNC_API_ERROR')).toBe(true);
    expect(isRetryable('PERMISSION_ERROR')).toBe(false);
    expect(isRetryable('VALIDATION_ERROR')).toBe(false);
    expect(isRetryable('AUTHENTICATION_ERROR')).toBe(false);
  });
});

describe('state machines (Scope §13, Guide §4.2)', () => {
  it('permits the documented happy-path chain', () => {
    const chain = [
      'DRAFT', 'CONNECTION_TEST', 'DISCOVERING', 'READY_FOR_MAPPING', 'READY', 'QUEUED',
      'EXTRACTING', 'NORMALIZING', 'IMPORTING', 'FILES_IMPORTING', 'VALIDATING',
      'WAITING_FOR_REVIEW', 'COMPLETED',
    ] as const;
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(canTransition(chain[i]!, chain[i + 1]!), `${chain[i]} -> ${chain[i + 1]}`).toBe(true);
    }
  });

  it('rejects a nonsensical jump', () => {
    expect(() => assertTransition('DRAFT', 'COMPLETED')).toThrow(IllegalStateTransitionError);
    expect(() => assertTransition('CANCELLED', 'QUEUED')).toThrow(IllegalStateTransitionError);
  });

  it('allows pause, fail and cancel from any active state, and resume from both', () => {
    for (const state of ['EXTRACTING', 'IMPORTING', 'FILES_IMPORTING', 'VALIDATING'] as const) {
      expect(canTransition(state, 'PAUSED')).toBe(true);
      expect(canTransition(state, 'FAILED')).toBe(true);
      expect(canTransition(state, 'CANCELLED')).toBe(true);
    }
    expect(canTransition('PAUSED', 'QUEUED')).toBe(true);
    expect(canTransition('FAILED', 'QUEUED')).toBe(true);
  });

  it('counts exactly the six dispositions as accounted for', () => {
    expect([...ACCOUNTED_FOR_RECORD_STATES].sort()).toEqual(
      ['CREATED', 'FAILED', 'MERGED', 'SKIPPED', 'UNSUPPORTED', 'UPDATED'].sort(),
    );
    // In-flight states must NOT count, or the reconciliation gate is vacuous.
    for (const state of ['DISCOVERED', 'QUEUED', 'PROCESSING'] as const) {
      expect(isAccountedFor(state)).toBe(false);
    }
    expect(RECORD_STATES.filter(isAccountedFor)).toHaveLength(6);
  });
});

describe('entity sequencing (Scope §14)', () => {
  it('orders entities by dependency, not by request order', () => {
    const ordered = sequence(['job', 'contact', 'user']).map((p) => p.entity);
    expect(ordered).toEqual(['user', 'contact', 'job']);
  });

  it('separates structural gaps that orphan records from metadata-only gaps', () => {
    const gaps = missingDependencies(['job']);
    const jobGap = gaps.find((g) => g.entity === 'job');

    // A job stores contact_id: without contacts it is genuinely orphaned.
    expect(jobGap?.missingRequired).toContain('contact');
    // A job stores its status and tags as values, so their definitions are
    // metadata fidelity, not correctness.
    expect(jobGap?.missingEnrichment).toContain('status_definition');
    expect(jobGap?.missingEnrichment).toContain('user');
    expect(jobGap?.missingRequired).not.toContain('user');
  });

  it('treats the obvious first selection as structurally complete', () => {
    // "users, contacts, jobs" is what anyone tries first. It must not be
    // blocked for missing tag and custom-field definitions.
    const gaps = missingDependencies(['user', 'contact', 'job']);
    for (const gap of gaps) {
      expect(gap.missingRequired, `${gap.entity} should have no structural gap`).toHaveLength(0);
    }
  });

  it('satisfies a polymorphic parent when any one option is selected', () => {
    // A note attaches to a contact or a job; selecting either is enough.
    const withContact = missingDependencies(['contact', 'note']).find((g) => g.entity === 'note');
    expect(withContact?.missingRequired ?? []).toHaveLength(0);

    const withJob = missingDependencies(['contact', 'job', 'note']).find((g) => g.entity === 'note');
    expect(withJob?.missingRequired ?? []).toHaveLength(0);

    // Selecting neither leaves the note with nothing to attach to.
    const orphaned = missingDependencies(['note']).find((g) => g.entity === 'note');
    expect(orphaned?.missingRequired.length).toBeGreaterThan(0);
  });

  it('reports no gaps at all when the full chain is selected', () => {
    const selected = ['account', 'user', 'tag', 'custom_field', 'status_definition', 'contact', 'job'] as const;
    for (const gap of missingDependencies([...selected])) {
      expect(gap.missingRequired).toHaveLength(0);
      expect(gap.missingEnrichment).toHaveLength(0);
    }
  });
});

describe('retry and backoff (Scope §25, §29)', () => {
  it('retries transient failures and eventually succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new MigrationError('RATE_LIMIT', 'throttled');
        return 'ok';
      },
      { attempts: 5, initialDelayMs: 1, multiplier: 2, maxDelayMs: 10, sleep: async () => undefined },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new MigrationError('PERMISSION_ERROR', 'forbidden');
        },
        { attempts: 5, initialDelayMs: 1, multiplier: 2, maxDelayMs: 10, sleep: async () => undefined },
      ),
    ).rejects.toThrow('forbidden');
    // One attempt only: retrying a 403 burns quota to receive the same 403.
    expect(attempts).toBe(1);
  });

  it('gives up after the configured attempt budget', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new MigrationError('SOURCE_TIMEOUT', 'timeout');
        },
        { attempts: 3, initialDelayMs: 1, multiplier: 2, maxDelayMs: 10, sleep: async () => undefined },
      ),
    ).rejects.toThrow('timeout');
    expect(attempts).toBe(3);
  });

  it('applies exponential backoff bounded by maxDelayMs, with jitter', () => {
    const options = { attempts: 10, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 5000 };
    // Full jitter: with random() pinned to 1 the delay is the computed ceiling.
    expect(computeDelay(1, options, () => 1)).toBe(1000);
    expect(computeDelay(2, options, () => 1)).toBe(2000);
    expect(computeDelay(3, options, () => 1)).toBe(4000);
    expect(computeDelay(4, options, () => 1)).toBe(5000);
    expect(computeDelay(9, options, () => 1)).toBe(5000);
    // Jitter spreads retries so concurrent workers do not resynchronize.
    expect(computeDelay(3, options, () => 0)).toBe(0);
    expect(computeDelay(3, options, () => 0.5)).toBe(2000);
  });
});

describe('rate limiting (Scope §25)', () => {
  it('holds callers to the declared per-second budget', async () => {
    let now = 0;
    const limiter = new RateLimiter(
      { requestsPerSecond: 2, requestsPerMinute: 1000 },
      () => now,
      async (ms) => { now += ms; },
    );

    await limiter.acquire();
    await limiter.acquire();
    expect(now).toBe(0);
    // The third call in the same second must wait for the window to roll.
    await limiter.acquire();
    expect(now).toBeGreaterThanOrEqual(1000);
  });

  it('bounds concurrency rather than launching everything at once', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return item * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('preserves result order despite out-of-order completion', async () => {
    const results = await mapWithConcurrency([5, 1, 3], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n;
    });
    expect(results).toEqual([5, 1, 3]);
  });
});

describe('fuzzy matching (Guide §13.2 tier 4)', () => {
  it('scores identical strings at 1 and unrelated strings low', () => {
    expect(jaroWinkler('john smith', 'john smith')).toBe(1);
    expect(jaroWinkler('john smith', 'maria garcia')).toBeLessThan(0.6);
  });

  it('rewards a shared prefix, the dominant CRM typo pattern', () => {
    expect(jaroWinkler('christopher', 'christoph')).toBeGreaterThan(0.9);
    expect(jaroWinkler('', 'anything')).toBe(0);
  });
});

describe('canonical validation (Guide §3)', () => {
  it('accepts a well-formed contact and applies defaults', () => {
    const result = validateCanonical('contact', {
      migration_id: '00000000-0000-4000-8000-000000000000',
      source_platform: 'mock',
      source_object_type: 'contact',
      source_object_id: 'C1',
      transformer_version: 'mock-contact-v1.0.0',
      first_name: 'John',
    });
    expect(result.ok).toBe(true);
    expect((result.value as { tags: string[] }).tags).toEqual([]);
  });

  it('rejects a record with no source id and names the offending field', () => {
    const result = validateCanonical('contact', {
      migration_id: '00000000-0000-4000-8000-000000000000',
      source_platform: 'mock',
      source_object_type: 'contact',
      source_object_id: '',
      transformer_version: 'mock-contact-v1.0.0',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('source_object_id');
  });
});
