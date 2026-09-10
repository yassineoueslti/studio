-- ===========================================================================
-- Enforce source identity uniqueness in the DESTINATION, not just in code.
--
-- The sandbox destination previously decided create-vs-update by SELECTing for
-- an existing row and then INSERTing. Two concurrent workers writing the same
-- source record both miss the SELECT and both INSERT, producing duplicate
-- destination rows for one source object -- exactly the failure idempotency
-- exists to prevent. An adversarial test with three concurrent identical
-- batches produced 19 duplicates.
--
-- Check-then-act cannot be made safe by ordering or by transaction isolation
-- alone; the guarantee has to live in a constraint. This mirrors what
-- migration_object_map already does for the migration ledger, and lets the
-- writer use INSERT ... ON CONFLICT so concurrent writes collapse atomically.
--
-- Duplicates are cleaned before the index is created. That is acceptable here
-- ONLY because these bl_* tables are a development/test stand-in for
-- BuilderLync -- production refuses to start with DESTINATION_DRIVER=sandbox.
-- ===========================================================================

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'bl_accounts', 'bl_locations', 'bl_users', 'bl_companies', 'bl_contacts',
    'bl_pipelines', 'bl_pipeline_stages', 'bl_opportunities', 'bl_jobs',
    'bl_tags', 'bl_custom_fields', 'bl_notes', 'bl_activities', 'bl_tasks',
    'bl_appointments', 'bl_files'
  ]
  LOOP
    -- Keep the earliest row per source identity, discard later duplicates.
    EXECUTE format($f$
      DELETE FROM %I a USING %I b
       WHERE a.tenant_id = b.tenant_id
         AND a.external_source_platform = b.external_source_platform
         AND a.external_source_id = b.external_source_id
         AND a.external_source_id IS NOT NULL
         AND a.ctid > b.ctid
    $f$, target, target);

    EXECUTE format($f$
      CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_source_identity
          ON %I (tenant_id, external_source_platform, external_source_id)
       WHERE external_source_id IS NOT NULL
    $f$, target, target);
  END LOOP;
END $$;
