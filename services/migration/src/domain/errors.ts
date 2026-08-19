/**
 * Standardized migration error taxonomy (Scope §36).
 *
 * Every failure surfaced to an operator or customer carries one of these codes.
 * The code determines two operational decisions: whether the pipeline may retry
 * automatically, and whether the customer can fix it themselves.
 */

export const ERROR_CODES = [
  'AUTHENTICATION_ERROR',
  'PERMISSION_ERROR',
  'RATE_LIMIT',
  'SOURCE_NOT_FOUND',
  'VALIDATION_ERROR',
  'DUPLICATE_CONFLICT',
  'MAPPING_ERROR',
  'DEPENDENCY_MISSING',
  'FILE_DOWNLOAD_ERROR',
  'FILE_UPLOAD_ERROR',
  'SOURCE_TIMEOUT',
  'BUILDERLYNC_API_ERROR',
  'UNSUPPORTED_FIELD',
  'UNKNOWN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorCodeProfile {
  /** May the pipeline retry this automatically (Scope §29 level 1/2)? */
  readonly retryable: boolean;
  /** Does resolution require the customer to act (reconnect, grant scope)? */
  readonly requiresCustomerAction: boolean;
  /** Operator-facing one-liner used in the error dashboard (Scope §35). */
  readonly summary: string;
}

export const ERROR_PROFILES: Readonly<Record<ErrorCode, ErrorCodeProfile>> = Object.freeze({
  AUTHENTICATION_ERROR: {
    retryable: false,
    requiresCustomerAction: true,
    summary: 'Source credentials were rejected. The connection must be re-authorized.',
  },
  PERMISSION_ERROR: {
    retryable: false,
    requiresCustomerAction: true,
    summary: 'The source credential lacks permission for this object.',
  },
  RATE_LIMIT: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'The source API throttled the request. Backing off and retrying.',
  },
  SOURCE_NOT_FOUND: {
    retryable: false,
    requiresCustomerAction: false,
    summary: 'The source record no longer exists at the source platform.',
  },
  VALIDATION_ERROR: {
    retryable: false,
    requiresCustomerAction: false,
    summary: 'The record failed canonical schema validation and was not written.',
  },
  DUPLICATE_CONFLICT: {
    retryable: false,
    requiresCustomerAction: true,
    summary: 'A duplicate candidate needs a human merge decision.',
  },
  MAPPING_ERROR: {
    retryable: false,
    requiresCustomerAction: true,
    summary: 'A required field, stage, status or user mapping is missing or invalid.',
  },
  DEPENDENCY_MISSING: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'A parent record this object depends on has not been migrated yet.',
  },
  FILE_DOWNLOAD_ERROR: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'The asset could not be downloaded from the source platform.',
  },
  FILE_UPLOAD_ERROR: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'The asset could not be uploaded to BuilderLync storage.',
  },
  SOURCE_TIMEOUT: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'The source API did not respond within the timeout window.',
  },
  BUILDERLYNC_API_ERROR: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'BuilderLync ingestion returned an error or was unavailable.',
  },
  UNSUPPORTED_FIELD: {
    retryable: false,
    requiresCustomerAction: false,
    summary: 'The source field has no BuilderLync equivalent and was not migrated.',
  },
  UNKNOWN_ERROR: {
    retryable: true,
    requiresCustomerAction: false,
    summary: 'An unclassified error occurred.',
  },
});

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_PROFILES[code].retryable;
}

export interface MigrationErrorContext {
  readonly entity?: string;
  readonly sourceId?: string;
  readonly batchId?: string;
  readonly migrationId?: string;
  /** Non-secret diagnostic context. Never place credentials here (Scope §46). */
  readonly raw?: Record<string, unknown>;
}

/**
 * The single error type the pipeline throws. Carrying the code on the error
 * means retry/no-retry is decided by the taxonomy rather than by string
 * matching on messages at the call site.
 */
export class MigrationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context: MigrationErrorContext;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    context: MigrationErrorContext = {},
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.retryable = options.retryable ?? ERROR_PROFILES[code].retryable;
    this.context = context;
    this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/**
 * Classify an arbitrary thrown value into the taxonomy. HTTP status codes are
 * mapped per Scope §25 (429/500/502/503/504 + network faults are transient).
 */
export function classifyError(err: unknown): ErrorCode {
  if (err instanceof MigrationError) return err.code;

  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;

  if (typeof status === 'number') {
    if (status === 401) return 'AUTHENTICATION_ERROR';
    if (status === 403) return 'PERMISSION_ERROR';
    if (status === 404) return 'SOURCE_NOT_FOUND';
    if (status === 409) return 'DUPLICATE_CONFLICT';
    if (status === 422) return 'VALIDATION_ERROR';
    if (status === 429) return 'RATE_LIMIT';
    if (status >= 500) return 'BUILDERLYNC_API_ERROR';
  }

  const code = (err as { code?: string })?.code;
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return 'SOURCE_TIMEOUT';
  }

  return 'UNKNOWN_ERROR';
}

export function toMigrationError(
  err: unknown,
  context: MigrationErrorContext = {},
): MigrationError {
  if (err instanceof MigrationError) return err;
  const code = classifyError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new MigrationError(code, message, context, { cause: err });
}
