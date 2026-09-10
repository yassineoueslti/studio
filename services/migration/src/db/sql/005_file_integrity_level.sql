-- ===========================================================================
-- Record how thoroughly each transferred asset could actually be checked.
--
-- Scope §23 asks for "a cryptographic hash when possible". Whether BuilderLync
-- returns a checksum is unconfirmed, so the engine verifies what it can and
-- records which level it reached, rather than reporting unverified uploads as
-- verified:
--
--   hash_verified  the destination's hash matched the bytes we sent
--   size_verified  no hash available; byte count matched (catches truncation,
--                  not silent corruption)
--   unverified     neither was available; the upload succeeded but nothing
--                  about its contents was proven
-- ===========================================================================

ALTER TABLE migration_files ADD COLUMN IF NOT EXISTS integrity_level TEXT;

CREATE INDEX IF NOT EXISTS idx_files_integrity
  ON migration_files (migration_id, integrity_level)
  WHERE state = 'CREATED';
