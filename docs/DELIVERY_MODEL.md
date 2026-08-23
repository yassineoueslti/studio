# Delivery Model

How a BuilderLync client migration actually runs, as settled at the
**Aug 21 delivery meeting**. This supersedes the simpler "migrate, then train,
then go live" sequence implied by the original scope.

## The change

The original sequence waited for migration to finish before training began.
That was changed because clients only discover mapping problems once they see
their own data in BuilderLync — and by then the migration is finished and the
mapping is expensive to revisit.

**Training now runs alongside the migration.** Client feedback on custom fields
and data mapping arrives while there is still time to act on it.

```
  Historical pass ──────────────────────────┐
  (bulk load, everything up to a cutoff)    │
                                            ├── feedback loop
  Client training ──────────────────────────┘   mapping corrections applied
        │                                       during, not after
        ▼
  Final delta pass
  (typically a weekend, source quiet)
        │
        ▼
  Go-live
```

## The three passes

| Pass | What it loads | When |
|---|---|---|
| `HISTORICAL` | Everything up to a cutoff | First. Training starts as soon as data is visible |
| `DELTA` | Records changed since the previous pass | Optional, as often as useful during training |
| `FINAL_DELTA` | The last catch-up | Immediately before go-live, source quiet |

Each pass records its own window and totals in `migration_passes`, so the
migration report can tell a client exactly what was loaded when.

### Why passes need naming

The engine could always run a delta — `updatedSince` has been supported since
the first build. What was missing was *naming the passes*, so an operator can
answer "which pass is this, and what still has to happen before go-live"
without reading batch tables.

### The watermark

A pass's watermark is captured **before** extraction starts, not after.

A record edited *while* a pass is running must be caught by the **next** pass.
Taking the watermark at the end would place that edit before the recorded
cutoff, and it would never be picked up again — a silent, permanent data loss
that no reconciliation check would catch, because the record was never
discovered in the first place.

### Delta passes reset checkpoints

`extraction_complete` on a checkpoint means "this entity is finished **for that
pass**", not "finished forever". Opening a delta pass clears the previous
pass's checkpoints, or the delta would skip every entity and silently import
nothing.

This is safe because **idempotency does not depend on checkpoints**.
`migration_object_map` still holds every source-to-destination mapping, so
records the previous pass loaded are skipped on their content hash rather than
re-created. Checkpoints are a resume optimisation; the object map is the
correctness guarantee.

## Export-based sources have no watermark

Roofr is export-assisted, so there is no `updated_at` to filter on. The two-pass
model still works, but by a different mechanism:

* the client produces a **fresh export** before go-live;
* every row is re-extracted;
* unchanged rows match on **content hash** and are recorded `SKIPPED`;
* only genuinely new or edited records are written.

Slower than a timestamp filter, correct all the same.

## Running it

```bash
# Pass 1 — historical. Training starts once this is visible to the client.
curl -X POST $API/api/migrations/$ID/start -H "$AUTH" -H "$JSON" -d '{}'

# During training: apply mapping feedback, then optionally catch up.
curl -X PUT  $API/api/migrations/$ID/mappings -H "$AUTH" -H "$JSON" -d '{...}'
curl -X POST $API/api/migrations/$ID/start    -H "$AUTH" -H "$JSON" -d '{"pass":"DELTA"}'

# Before go-live — the final pass, plus a readiness answer.
curl -X POST $API/api/migrations/$ID/final-delta -H "$AUTH"

# Is this client ready?
curl -s $API/api/migrations/$ID/onboarding -H "$AUTH"
```

## Go-live readiness

`GET /api/migrations/{id}/onboarding` answers with the **list of blockers**, not
a boolean. "Not ready" is useless to an onboarding specialist; "not ready
because QA has not been performed and the final delta has not run" is
actionable.

```jsonc
{
  "ready": false,
  "current_pass": "HISTORICAL",
  "blockers": [
    { "task_key": "qa_performed", "label": "QA performed on migrated data", "category": "data", "status": "PENDING" },
    { "task_key": "training_delivered", "label": "Client training delivered", "category": "training", "status": "IN_PROGRESS" }
  ],
  "progress": { "done": 11, "total": 20, "percent": 55 },
  "sla": { "days": 30, "due_at": "…", "days_remaining": 12, "breached": false },
  "passes": [ /* every pass, with its window and totals */ ]
}
```

## The checklist

Twenty items in four categories. It exists because migration and account
configuration are **different people's jobs running in parallel** — so "is this
client ready for go-live" needs one query, not a question asked across two
people in Slack.

| Category | Covers | Typically owned by |
|---|---|---|
| `data` | Connection, discovery, mappings, passes, QA, duplicates, files | Whoever runs the migration |
| `configuration` | Onboarding form, users, instant estimator, proposal module, integrations | Whoever configures the account |
| `training` | Scheduling, delivery, applying mapping feedback | Onboarding |
| `signoff` | Client acceptance, go-live date | Onboarding + client |

Items the system can prove — `historical_pass_complete`, `final_delta_complete`
— close themselves when the pass finishes. Nobody is asked to tick a box the
system already knows the answer to.

Items marked `NOT_APPLICABLE` are excluded from both the blocker list and the
completion percentage: a client with no proposal module should not be held up
by its checklist item, nor penalised on their progress bar.

## The 30-day SLA

Onboarding carries a **30-day SLA** measured from migration start. It is stored
per migration (`onboarding_sla_days`) rather than hardcoded, because it is a
commercial commitment that will differ by contract.

A migration only counts as **breached** if it is past due *and* still has
blockers. One that shipped inside the window does not retroactively breach as
the calendar moves on.

## What this does not change

The correctness guarantees are untouched, and the two-pass model depends on
them:

* **Idempotency** is what makes a second pass safe to run at all.
* **Reconciliation** still gates completion on every discovered record being
  accounted for, per pass.
* **Relationship integrity** still distinguishes a job that had no customer at
  the source from one that lost its customer in transit.
