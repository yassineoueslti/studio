-- ===========================================================================
-- Destination-maintained match keys for deduplication.
--
-- Guide §13.1 requires normalizing before matching. Storing the normalized
-- keys on the destination row -- rather than re-deriving them in a LIKE scan at
-- query time -- makes candidate lookup an indexed equality probe, and makes the
-- comparison symmetric: both sides went through the same normalization.
-- ===========================================================================

ALTER TABLE bl_contacts ADD COLUMN IF NOT EXISTS normalized_name_key TEXT;
ALTER TABLE bl_contacts ADD COLUMN IF NOT EXISTS address_key         TEXT;

CREATE INDEX IF NOT EXISTS idx_bl_contacts_name_key
  ON bl_contacts (tenant_id, normalized_name_key)
  WHERE normalized_name_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bl_contacts_address_key
  ON bl_contacts (tenant_id, address_key)
  WHERE address_key IS NOT NULL;
