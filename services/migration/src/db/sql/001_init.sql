-- ===========================================================================
-- BuilderLync Migration Engine - core schema
-- Guide §2, Scope §11-12.
--
-- Design rules encoded here:
--   * tenant_id is on every row that can hold customer data (Scope §47).
--   * migration_object_map carries the idempotency guarantee (Scope §11).
--   * Nothing in this schema stores a plaintext credential (Scope §46).
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- migrations (Guide §2.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migrations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                TEXT NOT NULL,
  source_platform          TEXT NOT NULL,
  source_tenant_id         TEXT,
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_by               TEXT NOT NULL,
  configuration_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  statistics_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Scope §66: every migration records the three versions that produced it.
  connector_version        TEXT NOT NULL DEFAULT 'unknown',
  schema_version           TEXT NOT NULL DEFAULT 'unknown',
  destination_api_version  TEXT NOT NULL DEFAULT 'unknown',
  -- Scope §62: customer acceptance.
  accepted_by              TEXT,
  accepted_at              TIMESTAMPTZ,
  migration_report_version TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migrations_tenant        ON migrations (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_migrations_status        ON migrations (status);
CREATE INDEX IF NOT EXISTS idx_migrations_tenant_status ON migrations (tenant_id, status);

-- ---------------------------------------------------------------------------
-- migration_sources: one connected source account per migration. AccuLynx may
-- contribute several rows (multi-location credentials, Scope §7.2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_sources (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id       UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id          TEXT NOT NULL,
  source_platform    TEXT NOT NULL,
  source_tenant_id   TEXT,
  label              TEXT,
  connector_version  TEXT NOT NULL DEFAULT 'unknown',
  capabilities_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  connection_status  TEXT NOT NULL DEFAULT 'UNTESTED',
  last_tested_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migration_sources_migration ON migration_sources (migration_id);

-- ---------------------------------------------------------------------------
-- migration_credentials: ciphertext only (Scope §46, Guide §19).
-- The plaintext never exists in this table, in logs, or in API responses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_credentials (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_source_id UUID NOT NULL REFERENCES migration_sources(id) ON DELETE CASCADE,
  tenant_id           TEXT NOT NULL,
  credential_type     TEXT NOT NULL,          -- api_key | oauth2 | basic | file_upload
  ciphertext          BYTEA NOT NULL,
  iv                  BYTEA NOT NULL,
  auth_tag            BYTEA NOT NULL,
  key_version         INTEGER NOT NULL DEFAULT 1,
  expires_at          TIMESTAMPTZ,
  rotated_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migration_credentials_source ON migration_credentials (migration_source_id);

-- ---------------------------------------------------------------------------
-- migration_object_map (Guide §2.2, Scope §11)
--
-- The most important table in the platform. The unique constraint is what makes
-- a replayed migration update instead of duplicate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_object_map (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id            UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id               TEXT NOT NULL,
  source_platform         TEXT NOT NULL,
  source_tenant_id        TEXT,
  source_object_type      TEXT NOT NULL,
  source_object_id        TEXT NOT NULL,
  builderlync_object_type TEXT NOT NULL,
  builderlync_object_id   TEXT,
  source_updated_at       TIMESTAMPTZ,
  builderlync_updated_at  TIMESTAMPTZ,
  content_hash            TEXT,
  migration_status        TEXT NOT NULL,
  transformer_version     TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_object_map_identity
    UNIQUE (tenant_id, source_platform, source_object_type, source_object_id)
);

CREATE INDEX IF NOT EXISTS idx_object_map_migration   ON migration_object_map (migration_id, source_object_type);
CREATE INDEX IF NOT EXISTS idx_object_map_destination ON migration_object_map (tenant_id, builderlync_object_type, builderlync_object_id);
CREATE INDEX IF NOT EXISTS idx_object_map_source_id   ON migration_object_map (source_object_id);

-- ---------------------------------------------------------------------------
-- migration_batches (Scope §28) and migration_checkpoints (Scope §27)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_batches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id     UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id        TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  batch_number     INTEGER NOT NULL,
  batch_label      TEXT NOT NULL,               -- e.g. 'Contacts Batch 001'
  status           TEXT NOT NULL DEFAULT 'PENDING',
  record_count     INTEGER NOT NULL DEFAULT 0,
  created_count    INTEGER NOT NULL DEFAULT 0,
  updated_count    INTEGER NOT NULL DEFAULT 0,
  merged_count     INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  cursor_json      JSONB,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_batch UNIQUE (migration_id, entity_type, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_batches_migration_status ON migration_batches (migration_id, status);
CREATE INDEX IF NOT EXISTS idx_batches_entity           ON migration_batches (migration_id, entity_type, batch_number);

CREATE TABLE IF NOT EXISTS migration_checkpoints (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id      UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  cursor_json       JSONB,
  page_state        TEXT,
  last_source_id    TEXT,
  records_processed INTEGER NOT NULL DEFAULT 0,
  batch_number      INTEGER NOT NULL DEFAULT 0,
  extraction_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_checkpoint UNIQUE (migration_id, entity_type)
);

-- ---------------------------------------------------------------------------
-- migration_records: the per-record ledger that guarantees Scope §3.4
-- ("there should never be unexplained missing records").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_records (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id           UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  batch_id               UUID REFERENCES migration_batches(id) ON DELETE SET NULL,
  tenant_id              TEXT NOT NULL,
  entity_type            TEXT NOT NULL,
  source_object_id       TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'DISCOVERED',
  disposition            TEXT,
  builderlync_object_id  TEXT,
  content_hash           TEXT,
  transformer_version    TEXT,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  last_error_code        TEXT,
  last_error_message     TEXT,
  -- Scope §30: bounded raw payload retention for troubleshooting.
  raw_payload            JSONB,
  raw_payload_expires_at TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_record UNIQUE (migration_id, entity_type, source_object_id)
);

CREATE INDEX IF NOT EXISTS idx_records_migration_state ON migration_records (migration_id, entity_type, state);
CREATE INDEX IF NOT EXISTS idx_records_batch           ON migration_records (batch_id);
CREATE INDEX IF NOT EXISTS idx_records_source_id       ON migration_records (source_object_id);
CREATE INDEX IF NOT EXISTS idx_records_raw_expiry      ON migration_records (raw_payload_expires_at)
  WHERE raw_payload IS NOT NULL;

-- ---------------------------------------------------------------------------
-- migration_errors / migration_warnings (Guide §2.4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_errors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id      UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  batch_id          UUID REFERENCES migration_batches(id) ON DELETE SET NULL,
  tenant_id         TEXT NOT NULL,
  entity            TEXT,
  source_id         TEXT,
  error_code        TEXT NOT NULL,
  message           TEXT NOT NULL,
  retryable         BOOLEAN NOT NULL DEFAULT FALSE,
  raw_context       JSONB,
  attempt_count     INTEGER NOT NULL DEFAULT 1,
  resolution_status TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | RETRIED | RESOLVED | IGNORED
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_errors_migration  ON migration_errors (migration_id, resolution_status);
CREATE INDEX IF NOT EXISTS idx_errors_code       ON migration_errors (migration_id, error_code);
CREATE INDEX IF NOT EXISTS idx_errors_entity     ON migration_errors (migration_id, entity);
CREATE INDEX IF NOT EXISTS idx_errors_retryable  ON migration_errors (migration_id, retryable, resolution_status);

CREATE TABLE IF NOT EXISTS migration_warnings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id      UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  batch_id          UUID REFERENCES migration_batches(id) ON DELETE SET NULL,
  tenant_id         TEXT NOT NULL,
  entity            TEXT,
  source_id         TEXT,
  warning_code      TEXT NOT NULL,
  message           TEXT NOT NULL,
  raw_context       JSONB,
  resolution_status TEXT NOT NULL DEFAULT 'OPEN',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_warnings_migration ON migration_warnings (migration_id, entity);

-- ---------------------------------------------------------------------------
-- migration_files (Scope §23-24): file integrity ledger, independent of the
-- record pipeline so an asset can retry without touching its parent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_files (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id            UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id               TEXT NOT NULL,
  entity_type             TEXT NOT NULL,           -- document | image | attachment
  source_file_id          TEXT NOT NULL,
  source_filename         TEXT,
  source_url              TEXT,
  source_size_bytes       BIGINT,
  source_hash             TEXT,
  mime_type               TEXT,
  parent_entity_type      TEXT,
  parent_source_id        TEXT,
  parent_builderlync_id   TEXT,
  destination_file_id     TEXT,
  destination_url         TEXT,
  destination_hash        TEXT,
  destination_size_bytes  BIGINT,
  download_status         TEXT NOT NULL DEFAULT 'PENDING',
  upload_status           TEXT NOT NULL DEFAULT 'PENDING',
  state                   TEXT NOT NULL DEFAULT 'DISCOVERED',
  failure_reason          TEXT,
  failure_code            TEXT,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  next_retry_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_file UNIQUE (migration_id, entity_type, source_file_id)
);

CREATE INDEX IF NOT EXISTS idx_files_migration_state ON migration_files (migration_id, state);
CREATE INDEX IF NOT EXISTS idx_files_parent          ON migration_files (migration_id, parent_entity_type, parent_source_id);
CREATE INDEX IF NOT EXISTS idx_files_filename        ON migration_files (source_filename);

-- ---------------------------------------------------------------------------
-- Mapping tables (Guide §2.5, Scope §17-19)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_mappings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id  UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL,
  mapping_type  TEXT NOT NULL,     -- field | stage | status | user | tag | lead_source | job_type | pipeline
  config_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_mapping UNIQUE (migration_id, mapping_type)
);

CREATE TABLE IF NOT EXISTS migration_field_mappings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id          UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id             TEXT NOT NULL,
  entity_type           TEXT NOT NULL,
  source_field          TEXT NOT NULL,
  source_field_type     TEXT,
  destination_field     TEXT,
  destination_field_type TEXT,
  -- Scope §17: auto | suggested | manual | ignore | create_custom_field
  mapping_action        TEXT NOT NULL DEFAULT 'auto',
  confidence            NUMERIC(4,3),
  transform_expression  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_field_mapping UNIQUE (migration_id, entity_type, source_field)
);

CREATE TABLE IF NOT EXISTS migration_stage_mappings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id              UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id                 TEXT NOT NULL,
  source_pipeline_id        TEXT,
  source_pipeline_name      TEXT,
  source_stage_id           TEXT NOT NULL,
  source_stage_name         TEXT,
  destination_pipeline_id   TEXT,
  destination_stage_id      TEXT,
  destination_stage_name    TEXT,
  -- Scope §18: use_existing | create_new | merge_into
  mapping_action            TEXT NOT NULL DEFAULT 'use_existing',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stage_mapping UNIQUE (migration_id, source_stage_id)
);

CREATE TABLE IF NOT EXISTS migration_status_mappings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id       UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id          TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  source_status      TEXT NOT NULL,
  destination_status TEXT,
  mapping_action     TEXT NOT NULL DEFAULT 'use_existing',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_status_mapping UNIQUE (migration_id, entity_type, source_status)
);

CREATE TABLE IF NOT EXISTS migration_user_mappings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id             UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id                TEXT NOT NULL,
  source_user_id           TEXT NOT NULL,
  source_user_email        TEXT,
  source_user_name         TEXT,
  destination_user_id      TEXT,
  -- Scope §19: create_user | map_existing | import_inactive_historical
  --            | map_to_account_owner | leave_unassigned
  mapping_action           TEXT NOT NULL DEFAULT 'import_inactive_historical',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_mapping UNIQUE (migration_id, source_user_id)
);

CREATE TABLE IF NOT EXISTS migration_tag_mappings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id         UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id            TEXT NOT NULL,
  source_tag           TEXT NOT NULL,
  destination_tag      TEXT,
  destination_tag_id   TEXT,
  mapping_action       TEXT NOT NULL DEFAULT 'use_existing',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_tag_mapping UNIQUE (migration_id, source_tag)
);

-- ---------------------------------------------------------------------------
-- Deduplication (Scope §20, Guide §13)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_duplicate_candidates (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id           UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id              TEXT NOT NULL,
  entity_type            TEXT NOT NULL,
  source_object_id       TEXT NOT NULL,
  candidate_builderlync_id TEXT,
  match_tier             INTEGER NOT NULL,     -- 1..4, Guide §13.2
  match_signals          JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence             NUMERIC(4,3) NOT NULL,
  -- Guide §13.4: a confirmed decision is persisted so retries and delta sync
  -- reuse it instead of re-asking.
  decision               TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|MERGE|CREATE_NEW|SKIP
  decided_by             TEXT,
  decided_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_duplicate_candidate UNIQUE (migration_id, entity_type, source_object_id, candidate_builderlync_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicates_pending ON migration_duplicate_candidates (migration_id, decision);

-- ---------------------------------------------------------------------------
-- Validation results (Scope §37-39)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_validation_results (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id   UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL,
  validation_step TEXT NOT NULL,
  entity_type    TEXT,
  passed         BOOLEAN NOT NULL,
  detail_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_migration ON migration_validation_results (migration_id, validation_step);

-- ---------------------------------------------------------------------------
-- Audit log (Scope §49)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id UUID REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  actor_type   TEXT NOT NULL DEFAULT 'user',  -- user | staff | system | n8n
  action       TEXT NOT NULL,
  detail_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_migration ON migration_audit_log (migration_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_tenant    ON migration_audit_log (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Delta sync state (Scope §50-51) and webhook inbox (Scope §52)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_sync_state (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id       UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id          TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  -- Guide §18.1: the watermark. Whichever of these the source supports.
  watermark_updated_at TIMESTAMPTZ,
  watermark_cursor   TEXT,
  strategy           TEXT NOT NULL DEFAULT 'updated_at',  -- webhook|updated_at|cursor|reconciliation_scan
  last_sync_at       TIMESTAMPTZ,
  last_sync_status   TEXT,
  records_synced     INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sync_state UNIQUE (migration_id, entity_type)
);

CREATE TABLE IF NOT EXISTS migration_webhook_inbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT,
  migration_id   UUID REFERENCES migrations(id) ON DELETE SET NULL,
  vendor         TEXT NOT NULL,
  vendor_event_id TEXT,
  event_type     TEXT,
  payload        JSONB NOT NULL,
  payload_hash   TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'RECEIVED',  -- RECEIVED|DUPLICATE|QUEUED|PROCESSED|FAILED
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT
);

-- Scope §52 / Guide §18.3: dedupe on vendor event id where the vendor supplies
-- one, and fall back to a payload hash where it does not (ProLine).
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_vendor_event
  ON migration_webhook_inbox (vendor, vendor_event_id)
  WHERE vendor_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_payload_hash
  ON migration_webhook_inbox (vendor, payload_hash)
  WHERE vendor_event_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_status ON migration_webhook_inbox (status, received_at);

-- ---------------------------------------------------------------------------
-- Discovery results (Scope §15): what the source said it had, before writing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_discovery (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id    UUID NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  supported       BOOLEAN NOT NULL DEFAULT TRUE,
  capability_note TEXT,
  detail_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_migration_discovery UNIQUE (migration_id, entity_type)
);
