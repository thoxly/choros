-- 044 · tier (T-0087 E12.6) — two logical tiers (draft→published) in one silo.
--
-- Adds a `tier` column to every registered tier-bearing table:
--   config class:  application, registry_def, "grant"
--   data class:    record
--
-- ADDITIVE & IDEMPOTENT: ADD COLUMN IF NOT EXISTS; re-running is safe.
-- known_tenant_tables.txt BYTE-UNCHANGED (additive columns on already-registered
-- tenant tables — no new table, no RLS change, no PK change).
--
-- The published-locked trigger (tier_published_locked) on each CONFIG table
-- prevents direct UPDATE/DELETE of published rows unless the transaction-local
-- GUC `choros.promoting = '1'` is set — which only `promoteTier` does.
-- Data table (record) is NOT config-locked: its tier isolation is the read-scope
-- filter (readTierScope), not a write-lock.

-- ---------------------------------------------------------------------------
-- 1. Add tier column to config + data tables
-- ---------------------------------------------------------------------------

ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'draft'
  CONSTRAINT application_tier_check CHECK (tier IN ('draft','published'));

ALTER TABLE choros.registry_def
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'draft'
  CONSTRAINT registry_def_tier_check CHECK (tier IN ('draft','published'));

ALTER TABLE choros."grant"
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'draft'
  CONSTRAINT grant_tier_check CHECK (tier IN ('draft','published'));

ALTER TABLE choros.record
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'draft'
  CONSTRAINT record_tier_check CHECK (tier IN ('draft','published'));

-- ---------------------------------------------------------------------------
-- 2. Published-locked trigger function (config tables only)
-- ---------------------------------------------------------------------------
-- Fires BEFORE UPDATE OR DELETE on every config table.
-- Raises unless either:
--   (a) the row being mutated is still 'draft', OR
--   (b) the transaction is the sanctioned promote (choros.promoting = '1').
-- This is the fail-closed half of the dual-mechanism (ADR §2.2 / FF-2).

CREATE OR REPLACE FUNCTION choros.tier_published_locked()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tier = 'published'
     AND current_setting('choros.promoting', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION
      'tier published rows are managed/locked (T-0087 FR-4): direct write forbidden';
  END IF;
  RETURN NEW;  -- draft rows, or the sanctioned promote txn, pass through
END $$;

-- ---------------------------------------------------------------------------
-- 3. Attach trigger to each config table
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS tier_published_locked ON choros.application;
CREATE TRIGGER tier_published_locked
  BEFORE UPDATE OR DELETE ON choros.application
  FOR EACH ROW EXECUTE FUNCTION choros.tier_published_locked();

DROP TRIGGER IF EXISTS tier_published_locked ON choros.registry_def;
CREATE TRIGGER tier_published_locked
  BEFORE UPDATE OR DELETE ON choros.registry_def
  FOR EACH ROW EXECUTE FUNCTION choros.tier_published_locked();

DROP TRIGGER IF EXISTS tier_published_locked ON choros."grant";
CREATE TRIGGER tier_published_locked
  BEFORE UPDATE OR DELETE ON choros."grant"
  FOR EACH ROW EXECUTE FUNCTION choros.tier_published_locked();

-- NOTE: choros.record is a DATA table — NOT locked by the trigger.
-- Its tier isolation is enforced by the read-scope filter (readTierScope)
-- that adds AND tier = 'published' in the default context (FR-5 / AC-6).
