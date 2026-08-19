import type { ContactCandidate, DestinationClient } from '../destination/types.js';
import { addressKey, normalizeNameKey, type NormalizedAddress } from '../transformers/normalize.js';

/**
 * Deduplication (Scope §20, Guide §13).
 *
 * Matching runs in confidence tiers, and the tier decides the *action*, not a
 * score threshold scattered across call sites:
 *
 *   Tier 1  existing source-ID mapping        -> deterministic, always update
 *   Tier 2  exact normalized email or phone   -> update (configurable)
 *   Tier 3  combined identity signals         -> merge or review, per config
 *   Tier 4  fuzzy candidate                   -> review only, never auto-merge
 *
 * Guide §13.3 is the load-bearing rule: a weak fuzzy match must never merge two
 * customers automatically. Merging the wrong two contractors' customers is not
 * a migration defect the customer can undo.
 */

export type MatchTier = 1 | 2 | 3 | 4;

export type MatchAction = 'UPDATE_EXISTING' | 'MERGE' | 'REVIEW' | 'CREATE_NEW';

export interface MatchInput {
  tenantId: string;
  sourcePlatform: string;
  sourceObjectId: string;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
  firstName: string | null;
  lastName: string | null;
  address: NormalizedAddress | null;
}

export interface MatchResult {
  action: MatchAction;
  tier: MatchTier | null;
  confidence: number;
  builderLyncId: string | null;
  signals: Record<string, unknown>;
}

/** Scope §20: which tiers may act automatically is a customer-visible choice. */
export interface DedupePolicy {
  /** Tier 2 exact email/phone. Default: update the existing record. */
  onExactContactMatch: 'UPDATE_EXISTING' | 'REVIEW' | 'CREATE_NEW';
  /** Tier 3 combined signals. Default: review, because it is not proof. */
  onHighConfidenceMatch: 'MERGE' | 'REVIEW' | 'CREATE_NEW';
  /** Tier 4 is fixed at REVIEW by Guide §13.3 and is not configurable. */
  minimumFuzzyConfidence: number;
}

export const DEFAULT_DEDUPE_POLICY: DedupePolicy = Object.freeze({
  onExactContactMatch: 'UPDATE_EXISTING',
  onHighConfidenceMatch: 'REVIEW',
  minimumFuzzyConfidence: 0.72,
});

/**
 * Tier 1 is resolved by the caller against migration_object_map before this
 * runs, because a known mapping short-circuits every destination query. This
 * function handles tiers 2-4.
 */
export async function matchContact(
  destination: DestinationClient,
  input: MatchInput,
  policy: DedupePolicy = DEFAULT_DEDUPE_POLICY,
): Promise<MatchResult> {
  const nameKey = buildNameKey(input.firstName, input.lastName);
  const addrKey = addressKey(input.address);

  // A candidate set with no identity signal at all cannot be matched. Scope §60
  // explicitly lists "contacts without email or phone": those create new
  // records rather than colliding with every other contact missing an email.
  if (!input.normalizedEmail && !input.normalizedPhone && !nameKey) {
    return { action: 'CREATE_NEW', tier: null, confidence: 0, signals: { reason: 'no_identity_signal' }, builderLyncId: null };
  }

  const candidates = await destination.findContactCandidates({
    tenantId: input.tenantId,
    normalizedEmail: input.normalizedEmail,
    normalizedPhone: input.normalizedPhone,
    nameKey,
    addressKey: addrKey,
  });

  if (candidates.length === 0) {
    return { action: 'CREATE_NEW', tier: null, confidence: 0, signals: {}, builderLyncId: null };
  }

  // --- Tier 2: exact normalized email or phone ---------------------------
  const exact = candidates.find(
    (c) =>
      (input.normalizedEmail && c.normalized_email === input.normalizedEmail) ||
      (input.normalizedPhone && c.normalized_phone === input.normalizedPhone),
  );
  if (exact) {
    const matchedOn = input.normalizedEmail && exact.normalized_email === input.normalizedEmail ? 'email' : 'phone';
    return {
      action: policy.onExactContactMatch,
      tier: 2,
      confidence: 0.99,
      builderLyncId: exact.builderlync_id,
      signals: { matched_on: matchedOn },
    };
  }

  // --- Tier 3: combined identity signals ---------------------------------
  const combined = candidates
    .map((c) => ({ candidate: c, score: combinedIdentityScore(input, c, nameKey, addrKey) }))
    .filter((s) => s.score.tier3)
    .sort((a, b) => b.score.confidence - a.score.confidence)[0];

  if (combined) {
    return {
      action: policy.onHighConfidenceMatch,
      tier: 3,
      confidence: combined.score.confidence,
      builderLyncId: combined.candidate.builderlync_id,
      signals: combined.score.signals,
    };
  }

  // --- Tier 4: fuzzy candidate, review only ------------------------------
  const fuzzy = candidates
    .map((c) => ({ candidate: c, confidence: fuzzyConfidence(input, c, nameKey, addrKey) }))
    .filter((s) => s.confidence >= policy.minimumFuzzyConfidence)
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (fuzzy) {
    return {
      action: 'REVIEW',
      tier: 4,
      confidence: fuzzy.confidence,
      builderLyncId: fuzzy.candidate.builderlync_id,
      signals: { reason: 'fuzzy_candidate_requires_review' },
    };
  }

  return { action: 'CREATE_NEW', tier: null, confidence: 0, signals: {}, builderLyncId: null };
}

function buildNameKey(first: string | null, last: string | null): string | null {
  const key = normalizeNameKey([first, last].filter(Boolean).join(' '));
  return key && key.length >= 3 ? key : null;
}

function candidateNameKey(candidate: ContactCandidate): string | null {
  return normalizeNameKey([candidate.first_name, candidate.last_name].filter(Boolean).join(' '));
}

interface CombinedScore {
  tier3: boolean;
  confidence: number;
  signals: Record<string, unknown>;
}

/**
 * Tier 3 requires a *name* agreement plus one corroborating signal. Name alone
 * is never enough -- "John Smith" is not an identity in a contractor CRM.
 *
 * The corroborating signal must be something that identifies a *household or
 * person*, not merely a population they belong to. Shared email domain was
 * tried and rejected: in a real dataset most residential customers sit on a
 * handful of consumer domains, so name-collision plus "both on gmail.com"
 * fires constantly and quietly withholds thousands of legitimate contacts for
 * review. Address and phone-suffix are the signals that actually discriminate.
 */
function combinedIdentityScore(
  input: MatchInput,
  candidate: ContactCandidate,
  nameKey: string | null,
  addrKey: string | null,
): CombinedScore {
  const signals: Record<string, unknown> = {};
  if (!nameKey) return { tier3: false, confidence: 0, signals };

  const candidateName = candidateNameKey(candidate);
  const namesAgree = candidateName !== null && candidateName === nameKey;
  if (!namesAgree) return { tier3: false, confidence: 0, signals };
  signals.name = 'exact';

  if (addrKey && candidate.address_key && addrKey === candidate.address_key) {
    signals.address = 'exact';
    return { tier3: true, confidence: 0.9, signals };
  }

  // Same subscriber number reached through a different country or area code.
  // An exact phone match would already have been caught by tier 2, so this is
  // specifically the reformatted/international case.
  if (input.normalizedPhone && candidate.normalized_phone) {
    const a = input.normalizedPhone.slice(-7);
    const b = candidate.normalized_phone.slice(-7);
    if (a.length === 7 && a === b) {
      signals.phone_suffix = 'exact';
      return { tier3: true, confidence: 0.85, signals };
    }
  }

  return { tier3: false, confidence: 0, signals };
}

/** Tier 4 score. Deliberately conservative; it only ever produces REVIEW. */
function fuzzyConfidence(
  input: MatchInput,
  candidate: ContactCandidate,
  nameKey: string | null,
  addrKey: string | null,
): number {
  let score = 0;
  const candidateName = candidateNameKey(candidate);

  if (nameKey && candidateName) {
    score += jaroWinkler(nameKey, candidateName) * 0.6;
  }
  if (addrKey && candidate.address_key) {
    score += addrKey === candidate.address_key ? 0.3 : jaroWinkler(addrKey, candidate.address_key) * 0.2;
  }
  if (input.normalizedPhone && candidate.normalized_phone) {
    // Last 7 digits agreeing is a real signal even when country/area differ.
    const a = input.normalizedPhone.slice(-7);
    const b = candidate.normalized_phone.slice(-7);
    if (a === b) score += 0.2;
  }
  return Math.min(score, 0.98);
}

/**
 * Jaro-Winkler similarity. Chosen over Levenshtein because it rewards a shared
 * prefix, which is the dominant pattern in the name typos and truncations that
 * CRM exports actually contain ("Christopher" vs "Christoph").
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i += 1) {
    if (a[i] === b[i]) prefix += 1;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}
