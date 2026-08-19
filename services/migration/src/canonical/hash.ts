import { createHash } from 'node:crypto';

/**
 * Content hashing for change detection.
 *
 * Scope §11 stores a content_hash per mapped object. On replay, an unchanged
 * hash means the record can be SKIPPED instead of issuing a pointless
 * destination write -- which is the difference between a delta sync that costs
 * one API call and one that costs a hundred thousand.
 */

/** Fields that must not influence the hash: they change on every extraction. */
const VOLATILE_KEYS = new Set([
  'migration_id',
  'raw_source_reference',
  'transformer_version',
  'warnings',
  'source_created_at',
  'source_updated_at',
]);

/**
 * Deterministic JSON: object keys sorted recursively so that two payloads with
 * the same content but different key order hash identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => !VOLATILE_KEYS.has(k) && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Idempotency key (Guide §1.3, Scope §45).
 * Format: mig_<migrationId>:<platform>:<objectType>:<sourceId>
 */
export function idempotencyKey(parts: {
  migrationId: string;
  sourcePlatform: string;
  objectType: string;
  sourceObjectId: string;
}): string {
  return `mig_${parts.migrationId}:${parts.sourcePlatform}:${parts.objectType}:${parts.sourceObjectId}`;
}
