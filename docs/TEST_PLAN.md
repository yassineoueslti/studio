# Test Plan

Guide §20 names eleven tests required before production. Every one is
implemented and passing; the table maps each to its test.

Run everything:

```bash
pnpm --filter @builderlync/migration test
```

| # | Guide §20 test | Status | Implementation |
|---|---|---|---|
| 1 | Small happy path (100 contacts, 20 jobs, 50 files) | PASS | `production-readiness.test.ts` → *Test 1* |
| 2 | Duplicate replay — run the same migration twice | PASS | *Test 2* (two cases: full replay, single-batch resend) |
| 3 | Mid-run crash — kill the worker, restart, resume | PASS | *Test 3* |
| 4 | API throttling — simulate 429, verify bounded backoff | PASS | *Test 4* (plus: a 403 is **not** retried) |
| 5 | Destination outage — retries must not duplicate | PASS | *Test 5* |
| 6 | Bad record — other records remain accounted for | PASS | *Test 6* |
| 7 | Expired credentials — actionable reconnect message | PASS | *Test 7* |
| 8 | Restricted access profile — preflight reports it | PASS | *Test 8* |
| 9 | File failures — explicit failures, never silent loss | PASS | *Test 9* |
| 10 | Tenant isolation — mismatched context rejected | PASS | *Test 10* (three cases) |
| 11 | Large-volume load | PASS | *Test 11* — 5,000 contacts + 1,000 jobs |

Additional coverage beyond the eleven:

| Area | Tests | File |
|---|---|---|
| Normalization, hashing, state machines, retry, rate limiting, fuzzy matching, canonical validation | 39 | `unit.test.ts` |
| n8n boundary: checkpoint round-trip, worker error intake, auth, payload tenant spoofing | 4 | `n8n-integration.test.ts` |
| n8n workflow JSON: structural validity, endpoint agreement, error routing, source-logic isolation | 11 | `n8n-integration.test.ts` |
| Migration API lifecycle over HTTP, per-record batch results, webhook deduplication | 4 | `production-readiness.test.ts` |

**73 tests total.**

## What these tests deliberately do *not* mock

The suite runs against a real PostgreSQL database and the real sandbox
destination driver. The guarantees under test — idempotency across process
restart, checkpoint resume, per-record batch accounting — are properties of
durable state. A mocked store would let all of them pass while the real system
failed, which makes the mock actively harmful here.

The one thing that *is* injected is failure: the mock adapter can produce 429s,
timeouts, auth rejections, permission denials, malformed records and
unretrievable assets on demand. That is what makes Tests 3–9 executable without
a vendor sandbox account.

## Sprint 1 acceptance run

Beyond the unit and integration suites, the guide's own Sprint 1 definition of
done (Guide §25 tasks 9–12) runs as a single script:

```bash
pnpm --filter @builderlync/migration demo
```

It migrates 5,000 contacts and 1,000 jobs, forces a worker crash mid-run,
resumes from checkpoint, replays the identical dataset, reconciles, and prints
the migration report. Seven acceptance criteria are asserted; the script exits
non-zero if any fail.

## Edge cases exercised by the fixtures

The mock source generator (`src/adapters/mock/fixtures.ts`) deliberately
produces the Scope §60 edge cases at controlled rates, from a fixed seed so
runs are reproducible:

- contacts with neither email nor phone
- duplicate contacts differing only in phone formatting and email casing
- jobs with no customer
- inactive and deleted employees who still own historical work
- mixed date formats in one column, including Excel serials and epoch values
- money as formatted strings, plain numbers, blanks
- names supplied as one combined column, sometimes `Last, First`
- HTML content, accented and non-ASCII names, extremely long notes
- assets the source lists but cannot serve
- deliberately malformed records that must fail canonical validation

## Before adding a vendor connector

Guide §24: *"vendor APIs change. Before coding any adapter, confirm the current
endpoint version, scopes, pagination method, rate limits, and object coverage in
the official documentation and lock those assumptions into connector contract
tests."*

Each planned connector carries its verification checklist in
`src/adapters/planned.ts`. Confirm every item against live documentation, write
contract tests that pin those assumptions, and only then implement extraction.
