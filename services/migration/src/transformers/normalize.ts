/**
 * Data normalization (Scope §21, Guide §13.1).
 *
 * Normalization runs before anything is written *and* before anything is
 * matched. Two records that differ only in phone formatting are the same
 * customer; deduplication can only know that if both sides were normalized
 * with the same rules.
 *
 * Every function here is total: it never throws on bad input, it returns null
 * and lets the caller decide the disposition.
 */

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Lowercase, trimmed, validated. Returns null for anything unusable. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase().replace(/^mailto:/, '');
  if (!trimmed || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Split a multi-valued email cell. CSV exports routinely pack several
 * addresses into one field with inconsistent separators.
 */
export function normalizeEmails(input: unknown): string[] {
  if (Array.isArray(input)) {
    return dedupePreserveOrder(input.map(normalizeEmail).filter((v): v is string => v !== null));
  }
  if (typeof input !== 'string') return [];
  return dedupePreserveOrder(
    input
      .split(/[;,|]/)
      .map(normalizeEmail)
      .filter((v): v is string => v !== null),
  );
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Normalize to E.164 where the number is confidently North American, otherwise
 * to a digit string prefixed with '+' when the source supplied one.
 *
 * A full libphonenumber dependency is deliberately avoided here: the migration
 * only needs a *stable, comparable* key. Being wrong about the display format
 * of an international number is recoverable; being non-deterministic is not,
 * because it would break duplicate matching between two runs.
 */
export function normalizePhone(input: unknown, defaultCountry: 'US' | 'INTL' = 'US'): string | null {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;

  const raw = input.trim();
  if (!raw) return null;

  // Drop extensions before digit extraction: "555-1234 x22" must not become
  // an 11-digit number ending in 22.
  const withoutExtension = raw.replace(/\s*(?:ext|x|extension)\.?\s*\d+\s*$/i, '');
  const hadPlus = withoutExtension.trimStart().startsWith('+');
  const digits = withoutExtension.replace(/\D/g, '');

  if (!digits) return null;
  // Reject obvious junk: placeholder rows like "0000000000" are not phone
  // numbers and must not become a match key that collides across customers.
  if (/^0+$/.test(digits)) return null;
  if (digits.length < 7) return null;
  if (digits.length > 15) return null;

  if (!hadPlus && defaultCountry === 'US') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  }
  return `+${digits}`;
}

export function normalizePhones(input: unknown): string[] {
  if (Array.isArray(input)) {
    return dedupePreserveOrder(input.map((v) => normalizePhone(v)).filter((v): v is string => v !== null));
  }
  if (typeof input !== 'string') return [];
  return dedupePreserveOrder(
    input
      .split(/[;,|/]/)
      .map((v) => normalizePhone(v))
      .filter((v): v is string => v !== null),
  );
}

// ---------------------------------------------------------------------------
// Names and free text
// ---------------------------------------------------------------------------

/** Control characters, including the C1 range some CRM exports smuggle in. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');
/** Combining marks, stripped only for comparison keys, never for stored text. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036F]', 'g');

/** Collapse whitespace, strip control characters, return null when empty. */
export function normalizeText(input: unknown, maxLength?: number): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' || typeof input === 'boolean') input = String(input);
  if (typeof input !== 'string') return null;

  let cleaned = input.replace(CONTROL_CHARS, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (maxLength && cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
  return cleaned;
}

/** Case- and accent-insensitive comparison key for name matching. */
export function normalizeNameKey(input: unknown): string | null {
  const text = normalizeText(input);
  if (!text) return null;
  return (
    text
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

/** Split a single "full name" cell that many exports use instead of two fields. */
export function splitFullName(input: unknown): { first: string | null; last: string | null } {
  const text = normalizeText(input);
  if (!text) return { first: null, last: null };

  // "Last, First" is as common as "First Last" in CRM exports.
  if (text.includes(',')) {
    const [last, ...rest] = text.split(',');
    return { first: normalizeText(rest.join(',')), last: normalizeText(last) };
  }

  const parts = text.split(' ');
  if (parts.length === 1) return { first: text, last: null };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] ?? null };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const US_STATES: Readonly<Record<string, string>> = Object.freeze({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'puerto rico': 'PR',
});

const STATE_ABBREVIATIONS = new Set(Object.values(US_STATES));

/** "california" / "California" / "CA" -> "CA". Unknown values pass through. */
export function normalizeState(input: unknown): string | null {
  const text = normalizeText(input);
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper.length === 2 && STATE_ABBREVIATIONS.has(upper)) return upper;
  return US_STATES[text.toLowerCase()] ?? text;
}

export function normalizePostalCode(input: unknown): string | null {
  const text = normalizeText(input);
  if (!text) return null;
  // US ZIP+4 arrives as "902101234" or "90210-1234"; keep the canonical hyphen.
  const digits = text.replace(/\s/g, '');
  const zipPlusFour = /^(\d{5})-?(\d{4})$/.exec(digits);
  if (zipPlusFour) return `${zipPlusFour[1]}-${zipPlusFour[2]}`;
  if (/^\d{5}$/.test(digits)) return digits;
  return text.toUpperCase();
}

export function normalizeCountry(input: unknown): string | null {
  const text = normalizeText(input);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (['us', 'usa', 'united states', 'united states of america', 'u.s.', 'u.s.a.'].includes(lower)) return 'US';
  if (['ca', 'canada'].includes(lower)) return 'CA';
  if (text.length === 2) return text.toUpperCase();
  return text;
}

export interface RawAddress {
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
  state?: unknown;
  postal_code?: unknown;
  country?: unknown;
}

export interface NormalizedAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

export function normalizeAddress(input: RawAddress | null | undefined): NormalizedAddress | null {
  if (!input) return null;
  const address: NormalizedAddress = {
    line1: normalizeText(input.line1, 255),
    line2: normalizeText(input.line2, 255),
    city: normalizeText(input.city, 120),
    state: normalizeState(input.state),
    postal_code: normalizePostalCode(input.postal_code),
    country: normalizeCountry(input.country),
  };
  // An address with nothing but a country is noise, not an address.
  const meaningful = address.line1 ?? address.city ?? address.postal_code;
  return meaningful ? address : null;
}

const STREET_SUFFIXES =
  /\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|circle|cir|place|pl|suite|ste|apartment|apt|unit)\b/g;

/** Comparison key for address-based duplicate matching (Scope §20). */
export function addressKey(address: NormalizedAddress | null): string | null {
  if (!address?.line1) return null;
  const street = address.line1.toLowerCase().replace(STREET_SUFFIXES, '').replace(/[^a-z0-9]/g, '');
  if (!street) return null;
  const postal = address.postal_code?.slice(0, 5) ?? '';
  return `${street}|${postal}`;
}

// ---------------------------------------------------------------------------
// Dates, money, booleans
// ---------------------------------------------------------------------------

/**
 * Parse a source date defensively. CRM exports contain Excel serials, epoch
 * seconds, epoch millis, ISO strings and US-formatted strings, often in the
 * same column. Returns null rather than an Invalid Date so the caller can
 * record a warning and keep the record (Scope §60 "invalid dates").
 */
export function normalizeDate(input: unknown): Date | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;

  if (typeof input === 'number') return fromNumericTimestamp(input);

  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return null;
    // Placeholder zero-dates from legacy systems must not become 1899 or 1970.
    if (/^0{4}-0{2}-0{2}/.test(text) || text === '0') return null;

    if (/^-?\d+(\.\d+)?$/.test(text)) return fromNumericTimestamp(Number(text));

    // US M/D/YYYY is checked before Date() because Date() reads it as US in
    // some runtimes and as D/M in others -- non-determinism the engine cannot
    // tolerate, since the same export must hash identically on every run.
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
    if (us) {
      const [, m, d, y] = us;
      const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      return Number.isNaN(date.getTime()) ? null : plausible(date);
    }

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return plausible(parsed);
  }
  return null;
}

function fromNumericTimestamp(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  // Excel serial dates: days since 1899-12-30, in a range no epoch value hits.
  if (value > 0 && value < 60_000) {
    return plausible(new Date(Math.round((value - 25_569) * 86_400_000)));
  }
  // Epoch seconds vs milliseconds, distinguished by magnitude.
  if (Math.abs(value) < 1e11) return plausible(new Date(value * 1000));
  return plausible(new Date(value));
}

/** Reject dates outside a range any contractor CRM record could plausibly hold. */
function plausible(date: Date): Date | null {
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 2100) return null;
  return date;
}

/** Parse a money value into integer minor units. Handles "$1,234.56", "(500)". */
export function normalizeMoneyCents(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  if (typeof input !== 'string') return null;

  let text = input.trim();
  if (!text) return null;

  // Accounting negatives: (1,234.56)
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }

  const cleaned = text.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) * (negative ? -1 : 1);
}

const TRUE_VALUES = new Set(['true', 't', 'yes', 'y', '1', 'on', 'active', 'enabled']);
const FALSE_VALUES = new Set(['false', 'f', 'no', 'n', '0', 'off', 'inactive', 'disabled']);

export function normalizeBoolean(input: unknown): boolean | null {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  if (!lower) return null;
  if (TRUE_VALUES.has(lower)) return true;
  if (FALSE_VALUES.has(lower)) return false;
  return null;
}

const EMPTY_SENTINELS = ['null', 'n/a', 'na', 'none', '-', '--', 'undefined'];

/** Scope §21: consistent null/empty handling. "", "  ", "null", "N/A" -> null. */
export function nullIfEmpty(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    const lower = input.trim().toLowerCase();
    if (!lower || EMPTY_SENTINELS.includes(lower)) return null;
  }
  if (Array.isArray(input) && input.length === 0) return null;
  return input;
}

export function normalizeTags(input: unknown): string[] {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[;,|]/)
      : [];
  return dedupePreserveOrder(values.map((v) => normalizeText(v, 100)).filter((v): v is string => v !== null));
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
