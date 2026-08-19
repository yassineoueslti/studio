/**
 * Secret redaction (Scope §46, Guide §19: "Never log API keys or OAuth tokens",
 * "Redact secrets from n8n execution data and application logs").
 *
 * Redaction happens at the logging boundary rather than at every call site,
 * because the call sites that leak are always the ones nobody remembered.
 */

const SECRET_KEY_PATTERN =
  /^(.*(?:password|passwd|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|bearer|signature|cookie|session).*)$/i;

export const REDACTED = '[REDACTED]';

/** Header names stripped before any request/response is logged. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-builderlync-token',
]);

function looksLikeBearer(value: string): boolean {
  return /^Bearer\s+\S+/i.test(value) || /^Basic\s+\S+/i.test(value);
}

/**
 * Deep-redact a value for logging. Returns a structural copy; the input is
 * never mutated. Cycles are tolerated.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return looksLikeBearer(value) ? REDACTED : value;
  }

  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength}b]`;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) || SENSITIVE_HEADERS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(val, seen);
    }
  }
  return out;
}

/** Mask a credential for display in an admin UI: keeps shape, not the secret. */
export function maskCredential(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.min(12, value.length - 6))}${value.slice(-3)}`;
}
