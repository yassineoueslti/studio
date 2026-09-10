import type { EntityType } from '../domain/entities.js';

/**
 * Historical fidelity: preserving "when it actually happened" when the
 * destination will not let us say so.
 *
 * BuilderLync stamps `created_at` with the time of the write and does not
 * accept a caller-supplied value. That is a hard constraint we cannot
 * negotiate, and it collides directly with Guide §9.4:
 *
 *   "Historical notes should remain historical. Do not rewrite imported
 *    historical notes as newly created user activity WITHOUT STORING THE
 *    ORIGINAL SOURCE TIMESTAMPS/AUTHOR METADATA."
 *
 * Read that emphasis carefully -- the guide anticipates this exact situation.
 * The requirement is not "set the created date" (which may be impossible); it
 * is "do not let history masquerade as new activity". So this module makes the
 * original date and author survive in the places BuilderLync *will* accept
 * them, in three layers:
 *
 *   1. Dedicated `source_created_at` / `source_updated_at` fields. Machine
 *      readable, exact, used by delta sync and reconciliation. Invisible to a
 *      user browsing the UI.
 *   2. A dated attribution prefix on note and activity bodies. Visible to a
 *      human reading the record. This is the layer that actually stops a
 *      five-year-old call log from reading as something that happened today.
 *   3. Optional mirroring of the original date into a custom field, so it can
 *      be displayed, sorted and filtered like any other BuilderLync field.
 *
 * Without layer 2 in particular, a contractor opening a migrated customer sees
 * a decade of history all stamped with the migration date -- which is the
 * single most common complaint about badly executed CRM migrations, and the
 * thing the customer was paying to avoid.
 */

export interface HistoricalFidelityPolicy {
  /**
   * Prefix note and activity bodies with their original date and author.
   * On by default: the destination cannot express the real date any other way
   * that a human will see.
   */
  stampBodies: boolean;
  /** Mirror the original created date into a custom field for display/sort. */
  mirrorDatesToCustomFields: boolean;
  /** Custom-field key used when mirroring. */
  customFieldKey: string;
  /**
   * Include the original author's name in the prefix. Separate from the date
   * because some sources do not record an author at all, and a prefix reading
   * "[2021-03-14 · Unknown]" is worse than one reading "[2021-03-14]".
   */
  includeAuthor: boolean;
}

export const DEFAULT_HISTORICAL_FIDELITY: HistoricalFidelityPolicy = Object.freeze({
  stampBodies: true,
  mirrorDatesToCustomFields: true,
  customFieldKey: 'migrated_original_date',
  includeAuthor: true,
});

/** Entities whose bodies represent a moment in time and read wrongly undated. */
const BODY_BEARING_ENTITIES: ReadonlySet<EntityType> = new Set(['note', 'activity']);

/**
 * Marker written into stamped bodies.
 *
 * Its purpose is idempotency: a migration can legitimately re-run over the same
 * record (a delta pass, a retry), and stamping an already-stamped body would
 * produce "[2021-03-14] [2021-03-14] Called the homeowner". Detecting our own
 * prefix is what makes the transformation safe to apply repeatedly -- which it
 * must be, because the whole engine is built on being replayable.
 */
const STAMP_PATTERN = /^\[\d{4}-\d{2}-\d{2}(?:[^\]]*)\]\s/;

export function isAlreadyStamped(body: string): boolean {
  return STAMP_PATTERN.test(body);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the attribution prefix. Returns null when there is nothing truthful to
 * say -- an undated note gets no prefix rather than a fabricated one.
 */
export function buildAttributionPrefix(
  occurredAt: Date | null,
  authorName: string | null,
  policy: HistoricalFidelityPolicy,
): string | null {
  if (!occurredAt) return null;
  const author = policy.includeAuthor && authorName ? ` · ${authorName}` : '';
  return `[${formatDate(occurredAt)}${author}]`;
}

export interface FidelityOutcome {
  /** True when the payload was modified. */
  changed: boolean;
  /** Warnings to attach to the record (Scope §3.4 explainability). */
  warnings: Array<{ code: string; message: string; field?: string }>;
}

/**
 * Apply the policy to one canonical object, in place.
 *
 * Runs after the adapter's normalize() and before validation, so every adapter
 * inherits it without having to remember -- the failure mode this guards
 * against is silent and only noticed by the customer months later.
 */
export function applyHistoricalFidelity(
  entity: EntityType,
  payload: Record<string, unknown>,
  policy: HistoricalFidelityPolicy = DEFAULT_HISTORICAL_FIDELITY,
): FidelityOutcome {
  const warnings: FidelityOutcome['warnings'] = [];
  let changed = false;

  const sourceCreatedAt = asDate(payload['source_created_at']);

  // --- layer 2: visible attribution on time-bearing records --------------
  if (policy.stampBodies && BODY_BEARING_ENTITIES.has(entity)) {
    const body = typeof payload['body'] === 'string' ? payload['body'] : null;

    // Notes carry authored_at; activities carry occurred_at. Fall back to the
    // source created date so a record is dated whenever the source knew.
    const occurredAt =
      asDate(payload['authored_at']) ?? asDate(payload['occurred_at']) ?? sourceCreatedAt;
    const authorName =
      (typeof payload['author_source_name'] === 'string' ? payload['author_source_name'] : null);

    if (body && !isAlreadyStamped(body)) {
      const prefix = buildAttributionPrefix(occurredAt, authorName, policy);
      if (prefix) {
        payload['body'] = `${prefix} ${body}`;
        changed = true;
      } else {
        // Worth surfacing: an undated note in the destination is genuinely
        // indistinguishable from one written today, and nothing can fix that
        // after the fact.
        warnings.push({
          code: 'HISTORY_UNDATED',
          message:
            'The source did not supply a date for this record, so it cannot be visibly distinguished ' +
            'from newly created activity in BuilderLync.',
          field: 'authored_at',
        });
      }
    }
  }

  // --- layer 3: mirror the original date into a custom field -------------
  if (policy.mirrorDatesToCustomFields && sourceCreatedAt) {
    const existing = payload['custom_fields'];
    const customFields: Record<string, unknown> =
      existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};

    // Never overwrite a real source custom field that happens to collide.
    if (customFields[policy.customFieldKey] === undefined) {
      customFields[policy.customFieldKey] = formatDate(sourceCreatedAt);
      payload['custom_fields'] = customFields;
      changed = true;
    }
  }

  // Deliberately NOT warned per record: that BuilderLync stamps its own
  // created date is a universal platform limitation, true of every row in
  // every migration. A warning per record would write one row per contact --
  // hundreds of thousands on a large account -- and bury the exceptional
  // warnings that actually need a human. The limitation is disclosed once in
  // the migration report, with counts, by the reporting layer.

  return { changed, warnings };
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
