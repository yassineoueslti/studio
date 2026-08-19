-- ===========================================================================
-- BuilderLync destination sandbox  (bl_* tables)
--
-- This is a stand-in for the real BuilderLync application database, built to
-- the contract documented in docs/DESTINATION_INVENTORY.md (Guide §1.1).
-- It exists so the migration engine's guarantees -- idempotency, resume after
-- crash, per-record batch results, tenant isolation -- are provable today,
-- before BuilderLync's own ingestion endpoints exist.
--
-- It is deliberately Postgres-backed rather than in-memory: proving "kill the
-- worker mid-migration, restart, no duplicates" (Scope §83 Safe Restart)
-- requires destination state to outlive the process.
--
-- When the real BuilderLync API is available, set DESTINATION_DRIVER=http.
-- Nothing outside src/destination/ may reference a bl_* table.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Idempotency ledger (Guide §1.3, Scope §45)
-- Key format: mig_<migration_id>:<source_platform>:<object_type>:<source_id>
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bl_idempotency_keys (
  idempotency_key  TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  object_type      TEXT NOT NULL,
  object_id        TEXT NOT NULL,
  -- The stored outcome. A replayed request returns this instead of writing.
  result_status    TEXT NOT NULL,          -- CREATED | UPDATED | MERGED | SKIPPED
  content_hash     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_idem_tenant ON bl_idempotency_keys (tenant_id, object_type);

-- ---------------------------------------------------------------------------
-- Core CRM objects. Every table carries:
--   tenant_id                -- Scope §47 tenant isolation
--   external_source_*        -- Scope §64 support traceability
--   created_by_migration_id  -- Scope §63 targeted rollback
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bl_accounts (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  name                    TEXT NOT NULL,
  legal_name              TEXT,
  phone                   TEXT,
  email                   TEXT,
  website                 TEXT,
  address_json            JSONB,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_locations (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  account_id              TEXT,
  name                    TEXT NOT NULL,
  branch_code             TEXT,
  phone                   TEXT,
  address_json            JSONB,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_users (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  first_name              TEXT,
  last_name               TEXT,
  email                   TEXT,
  phone                   TEXT,
  role                    TEXT,
  team                    TEXT,
  location_id             TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  -- Scope §19: historical employees arrive inactive rather than having their
  -- work reassigned to current staff.
  is_historical           BOOLEAN NOT NULL DEFAULT FALSE,
  source_role             TEXT,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_users_tenant_email ON bl_users (tenant_id, email);

CREATE TABLE IF NOT EXISTS bl_companies (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  name                    TEXT NOT NULL,
  phone                   TEXT,
  email                   TEXT,
  website                 TEXT,
  address_json            JSONB,
  assigned_user_id        TEXT,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_contacts (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  first_name              TEXT,
  last_name               TEXT,
  company_id              TEXT,
  company_name            TEXT,
  email                   TEXT,
  phone                   TEXT,
  secondary_emails        JSONB NOT NULL DEFAULT '[]'::jsonb,
  secondary_phones        JSONB NOT NULL DEFAULT '[]'::jsonb,
  address_json            JSONB,
  lead_source             TEXT,
  assigned_user_id        TEXT,
  tags                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  communication_prefs     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Normalized match keys, maintained by the destination. Deduplication reads
  -- these; it never re-normalizes destination data at query time.
  normalized_email        TEXT,
  normalized_phone        TEXT,
  source_created_at       TIMESTAMPTZ,
  source_updated_at       TIMESTAMPTZ,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  merged_by_migration_id  UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_contacts_tenant_email ON bl_contacts (tenant_id, normalized_email)
  WHERE normalized_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bl_contacts_tenant_phone ON bl_contacts (tenant_id, normalized_phone)
  WHERE normalized_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bl_contacts_external     ON bl_contacts (tenant_id, external_source_platform, external_source_id);
CREATE INDEX IF NOT EXISTS idx_bl_contacts_migration    ON bl_contacts (created_by_migration_id);

CREATE TABLE IF NOT EXISTS bl_pipelines (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  name                    TEXT NOT NULL,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_pipeline_stages (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  pipeline_id             TEXT,
  name                    TEXT NOT NULL,
  position                INTEGER NOT NULL DEFAULT 0,
  is_won                  BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost                 BOOLEAN NOT NULL DEFAULT FALSE,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_opportunities (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  name                    TEXT,
  contact_id              TEXT,
  pipeline_id             TEXT,
  stage_id                TEXT,
  status                  TEXT,
  value_cents             BIGINT,
  currency                TEXT NOT NULL DEFAULT 'USD',
  assigned_user_id        TEXT,
  lead_source             TEXT,
  lost_reason             TEXT,
  closed_at               TIMESTAMPTZ,
  source_created_at       TIMESTAMPTZ,
  source_updated_at       TIMESTAMPTZ,
  custom_fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_opps_contact ON bl_opportunities (tenant_id, contact_id);

CREATE TABLE IF NOT EXISTS bl_jobs (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  job_number              TEXT,
  name                    TEXT,
  contact_id              TEXT,
  opportunity_id          TEXT,
  address_json            JSONB,
  job_type                TEXT,
  status                  TEXT,
  stage_id                TEXT,
  value_cents             BIGINT,
  currency                TEXT NOT NULL DEFAULT 'USD',
  lead_source             TEXT,
  start_date              DATE,
  completion_date         DATE,
  assigned_user_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_created_at       TIMESTAMPTZ,
  source_updated_at       TIMESTAMPTZ,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_jobs_contact    ON bl_jobs (tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_bl_jobs_job_number ON bl_jobs (tenant_id, job_number);
CREATE INDEX IF NOT EXISTS idx_bl_jobs_external   ON bl_jobs (tenant_id, external_source_platform, external_source_id);

CREATE TABLE IF NOT EXISTS bl_tags (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  name                    TEXT NOT NULL,
  color                   TEXT,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_custom_fields (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  entity_type             TEXT NOT NULL,
  key                     TEXT NOT NULL,
  label                   TEXT,
  field_type              TEXT NOT NULL DEFAULT 'text',
  options                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_notes (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  parent_entity_type      TEXT,
  parent_id               TEXT,
  body                    TEXT,
  body_format             TEXT NOT NULL DEFAULT 'text',
  -- Guide §9.4: historical notes stay historical. authored_at/author come from
  -- the source, not from the import clock.
  authored_at             TIMESTAMPTZ,
  author_user_id          TEXT,
  author_source_name      TEXT,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  updated_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_notes_parent ON bl_notes (tenant_id, parent_entity_type, parent_id);

CREATE TABLE IF NOT EXISTS bl_activities (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  parent_entity_type      TEXT,
  parent_id               TEXT,
  activity_type           TEXT NOT NULL,  -- call|email|sms|meeting|status_change|log
  subject                 TEXT,
  body                    TEXT,
  direction               TEXT,
  occurred_at             TIMESTAMPTZ,
  user_id                 TEXT,
  author_source_name      TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_activities_parent ON bl_activities (tenant_id, parent_entity_type, parent_id);

CREATE TABLE IF NOT EXISTS bl_tasks (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  parent_entity_type      TEXT,
  parent_id               TEXT,
  title                   TEXT,
  description             TEXT,
  status                  TEXT,
  due_at                  TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  assigned_user_id        TEXT,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bl_appointments (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  parent_entity_type      TEXT,
  parent_id               TEXT,
  title                   TEXT,
  location                TEXT,
  starts_at               TIMESTAMPTZ,
  ends_at                 TIMESTAMPTZ,
  assigned_user_id        TEXT,
  status                  TEXT,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Files / images (Scope §10.7-10.8). Binary content is addressed by storage_key
-- rather than stored inline; the sandbox writes bytes under FILE_STORAGE_ROOT.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bl_files (
  id                      TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  parent_entity_type      TEXT,
  parent_id               TEXT,
  file_name               TEXT NOT NULL,
  original_name           TEXT,
  mime_type               TEXT,
  size_bytes              BIGINT,
  storage_key             TEXT NOT NULL,
  content_hash            TEXT,
  kind                    TEXT NOT NULL DEFAULT 'document',  -- document|image|attachment
  width                   INTEGER,
  height                  INTEGER,
  album                   TEXT,
  uploaded_by_user_id     TEXT,
  source_created_at       TIMESTAMPTZ,
  external_source_platform TEXT,
  external_source_id      TEXT,
  created_by_migration_id UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bl_files_parent   ON bl_files (tenant_id, parent_entity_type, parent_id);
CREATE INDEX IF NOT EXISTS idx_bl_files_filename ON bl_files (tenant_id, file_name);
