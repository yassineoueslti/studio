-- ===========================================================================
-- Onboarding workflow support.
--
-- Added after the Aug 21 delivery meeting, which changed how migrations are
-- actually run for BuilderLync clients:
--
--   * Client training now runs CONCURRENTLY with the historical migration,
--     not after it. Clients give feedback on custom fields and data mapping
--     while the bulk data is still loading.
--   * A second, smaller delta pass then runs (typically over a weekend) to
--     pick up jobs created since the historical pass, immediately before
--     go-live.
--   * Onboarding carries a 30-day SLA measured from migration start.
--
-- The engine already supported delta runs mechanically. What was missing was
-- naming the passes, so an operator can answer "which pass is this and what
-- still has to happen before go-live" without reading batch tables.
-- ===========================================================================

-- Which pass a migration is currently on.
--   HISTORICAL  bulk load of everything up to a cutoff; training runs alongside
--   DELTA       catch-up pass for records changed since the historical cutoff
--   FINAL_DELTA the last pass before go-live, run against a quiet source
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS current_pass TEXT NOT NULL DEFAULT 'HISTORICAL';

-- The watermark the next delta pass extracts from. Set when a pass completes,
-- so a delta run never has to guess where the previous pass stopped.
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS delta_watermark TIMESTAMPTZ;

-- Onboarding SLA (30 days from start, per the delivery meeting). Stored per
-- migration rather than hardcoded, because it is a commercial commitment that
-- will differ by contract.
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS onboarding_sla_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS go_live_target_at TIMESTAMPTZ;

-- Records each completed pass, so the migration report can show the client
-- exactly what was loaded when.
CREATE TABLE IF NOT EXISTS migration_passes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id      UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL,
  pass_type         TEXT NOT NULL,          -- HISTORICAL | DELTA | FINAL_DELTA
  pass_number       INTEGER NOT NULL,
  extracted_since   TIMESTAMPTZ,            -- NULL for the historical pass
  watermark_at      TIMESTAMPTZ,            -- cutoff this pass reached
  records_created   INTEGER NOT NULL DEFAULT 0,
  records_updated   INTEGER NOT NULL DEFAULT 0,
  records_skipped   INTEGER NOT NULL DEFAULT 0,
  records_failed    INTEGER NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'RUNNING',
  CONSTRAINT uq_migration_pass UNIQUE (migration_id, pass_number)
);

CREATE INDEX IF NOT EXISTS idx_passes_migration ON migration_passes (migration_id, pass_number);

-- ---------------------------------------------------------------------------
-- Onboarding checklist.
--
-- Account configuration (instant estimator, proposal module, user setup) runs
-- alongside data migration and is a different person's job. Tracking it here
-- means "is this client ready for go-live" is one query rather than a question
-- asked across two people in Slack.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_onboarding_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id   UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL,
  task_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  category       TEXT NOT NULL,          -- data | configuration | training | signoff
  -- Whether go-live should be blocked while this is outstanding.
  blocks_go_live BOOLEAN NOT NULL DEFAULT TRUE,
  status         TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | IN_PROGRESS | DONE | NOT_APPLICABLE
  owner          TEXT,
  notes          TEXT,
  completed_at   TIMESTAMPTZ,
  completed_by   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_onboarding_task UNIQUE (migration_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_migration ON migration_onboarding_tasks (migration_id, status);
