/**
 * Migration and record state machines.
 *
 * Scope §13 defines the state vocabulary; Guide §4.2 defines the happy-path
 * transition chain. Both are encoded here as data so that every state change in
 * the platform goes through one guarded function. An illegal transition is a
 * programming error, not a data condition, so it throws.
 */

export const MIGRATION_STATES = [
  'DRAFT',
  'CONNECTION_TEST',
  'DISCOVERING',
  'READY_FOR_MAPPING',
  'READY',
  'QUEUED',
  'EXTRACTING',
  'NORMALIZING',
  'IMPORTING',
  'FILES_IMPORTING',
  'VALIDATING',
  'WAITING_FOR_REVIEW',
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
  'PAUSED',
  'FAILED',
  'CANCELLED',
  // Scope §53: reached by the Finalize Migration action after cutover delta.
  'CUTOVER_COMPLETE',
] as const;

export type MigrationState = (typeof MIGRATION_STATES)[number];

/** States from which no further work happens without operator action. */
export const TERMINAL_MIGRATION_STATES: readonly MigrationState[] = [
  'CANCELLED',
  'CUTOVER_COMPLETE',
];

/** States that mean "the transfer finished and produced a report". */
export const COMPLETED_MIGRATION_STATES: readonly MigrationState[] = [
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS',
];

/**
 * States during which the orchestrator is actively moving data. Used by the
 * "conflicting migration already running" preflight check (Scope §16).
 */
export const ACTIVE_MIGRATION_STATES: readonly MigrationState[] = [
  'QUEUED',
  'EXTRACTING',
  'NORMALIZING',
  'IMPORTING',
  'FILES_IMPORTING',
  'VALIDATING',
];

/**
 * Legal transitions. PAUSED/FAILED/CANCELLED are reachable from any active
 * state, so they are added programmatically below rather than repeated.
 */
const BASE_TRANSITIONS: Record<MigrationState, MigrationState[]> = {
  DRAFT: ['CONNECTION_TEST', 'DISCOVERING'],
  CONNECTION_TEST: ['DRAFT', 'DISCOVERING', 'READY_FOR_MAPPING'],
  DISCOVERING: ['READY_FOR_MAPPING'],
  READY_FOR_MAPPING: ['READY', 'DISCOVERING'],
  READY: ['QUEUED', 'READY_FOR_MAPPING'],
  QUEUED: ['EXTRACTING'],
  EXTRACTING: ['NORMALIZING', 'IMPORTING'],
  NORMALIZING: ['IMPORTING'],
  IMPORTING: ['FILES_IMPORTING', 'VALIDATING', 'EXTRACTING'],
  FILES_IMPORTING: ['VALIDATING', 'EXTRACTING'],
  VALIDATING: ['WAITING_FOR_REVIEW', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'],
  // Re-queueing after review is the normal path once an operator has resolved
  // duplicates or retried failures and wants the migration re-run.
  WAITING_FOR_REVIEW: ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'EXTRACTING', 'QUEUED'],
  // A completed migration can be re-entered for catch-up/delta sync (Scope §50)
  // and finalized by cutover (Scope §53).
  COMPLETED: ['QUEUED', 'VALIDATING', 'CUTOVER_COMPLETE'],
  COMPLETED_WITH_WARNINGS: ['QUEUED', 'VALIDATING', 'CUTOVER_COMPLETE'],
  PAUSED: ['QUEUED', 'EXTRACTING', 'IMPORTING', 'FILES_IMPORTING', 'CANCELLED'],
  // Scope §29: a failed migration is retryable, it is not a dead end.
  FAILED: ['QUEUED', 'EXTRACTING', 'IMPORTING', 'FILES_IMPORTING', 'CANCELLED'],
  CANCELLED: [],
  CUTOVER_COMPLETE: [],
};

const INTERRUPTIBLE: readonly MigrationState[] = [
  'CONNECTION_TEST',
  'DISCOVERING',
  'QUEUED',
  'EXTRACTING',
  'NORMALIZING',
  'IMPORTING',
  'FILES_IMPORTING',
  'VALIDATING',
  'WAITING_FOR_REVIEW',
];

export const MIGRATION_TRANSITIONS: Readonly<Record<MigrationState, readonly MigrationState[]>> =
  Object.freeze(
    Object.fromEntries(
      MIGRATION_STATES.map((state) => {
        const allowed = new Set(BASE_TRANSITIONS[state]);
        if (INTERRUPTIBLE.includes(state)) {
          allowed.add('PAUSED');
          allowed.add('FAILED');
          allowed.add('CANCELLED');
        }
        if (state === 'READY' || state === 'READY_FOR_MAPPING' || state === 'DRAFT') {
          allowed.add('CANCELLED');
          allowed.add('FAILED');
        }
        return [state, Object.freeze([...allowed])];
      }),
    ) as Record<MigrationState, readonly MigrationState[]>,
  );

export class IllegalStateTransitionError extends Error {
  readonly from: MigrationState;
  readonly to: MigrationState;

  constructor(from: MigrationState, to: MigrationState) {
    super(
      `Illegal migration state transition ${from} -> ${to}. ` +
        `Legal targets from ${from}: ${MIGRATION_TRANSITIONS[from].join(', ') || '(none, terminal)'}`,
    );
    this.name = 'IllegalStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: MigrationState, to: MigrationState): boolean {
  return MIGRATION_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: MigrationState, to: MigrationState): void {
  if (from === to) return;
  if (!canTransition(from, to)) throw new IllegalStateTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Record-level states (Scope §13)
// ---------------------------------------------------------------------------

export const RECORD_STATES = [
  'DISCOVERED',
  'QUEUED',
  'PROCESSING',
  'CREATED',
  'UPDATED',
  'MERGED',
  'SKIPPED',
  'FAILED',
  'UNSUPPORTED',
] as const;

export type RecordState = (typeof RECORD_STATES)[number];

/**
 * Scope §3.4 / §38: the six states that count as "accounted for". A record in
 * DISCOVERED, QUEUED or PROCESSING is still in flight and therefore *not* yet
 * accounted for -- which is exactly what makes the reconciliation equation
 * Discovered = Created + Updated + Merged + Skipped + Unsupported + Failed
 * a meaningful completion gate rather than a tautology.
 */
export const ACCOUNTED_FOR_RECORD_STATES: readonly RecordState[] = [
  'CREATED',
  'UPDATED',
  'MERGED',
  'SKIPPED',
  'UNSUPPORTED',
  'FAILED',
];

export function isAccountedFor(state: RecordState): boolean {
  return ACCOUNTED_FOR_RECORD_STATES.includes(state);
}

/** Record states that may be retried (Scope §29 level 3: per-record retry). */
export function isRetryableRecordState(state: RecordState): boolean {
  return state === 'FAILED';
}

// ---------------------------------------------------------------------------
// Dispositions (Scope §3.4)
// ---------------------------------------------------------------------------

export const DISPOSITIONS = [
  'MIGRATED',
  'UPDATED',
  'MERGED',
  'SKIPPED',
  'UNSUPPORTED',
  'WARNING',
  'FAILED',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export function dispositionForRecordState(state: RecordState): Disposition | null {
  switch (state) {
    case 'CREATED':
      return 'MIGRATED';
    case 'UPDATED':
      return 'UPDATED';
    case 'MERGED':
      return 'MERGED';
    case 'SKIPPED':
      return 'SKIPPED';
    case 'UNSUPPORTED':
      return 'UNSUPPORTED';
    case 'FAILED':
      return 'FAILED';
    default:
      return null; // still in flight
  }
}

// ---------------------------------------------------------------------------
// Batch states (Scope §28)
// ---------------------------------------------------------------------------

export const BATCH_STATES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
] as const;

export type BatchState = (typeof BATCH_STATES)[number];

export const RESUMABLE_BATCH_STATES: readonly BatchState[] = [
  'PENDING',
  'PROCESSING',
  'FAILED',
];
