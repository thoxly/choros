-- 050 · tier_delete_fix (T-0185) — BEFORE DELETE must RETURN OLD, not NEW.
-- Owner: choros_migrator
--
-- Bug (T-0144 R-2 review): tier_published_locked (migration 049) returned NEW
-- in all paths — including the BEFORE DELETE branch.  For DELETE, NEW is NULL
-- in Postgres, so the trigger returned NULL, which suppresses the row deletion
-- entirely.  Every DELETE on application/registry_def/grant was silently no-op.
--
-- Fix: split return value by TG_OP:
--   DELETE, draft row          → RETURN OLD  (allow the delete)
--   DELETE, published row      → RAISE       (published-locked, same as UPDATE)
--   DELETE, sanctioned promote → RETURN OLD  (promoting GUC bypasses the lock)
--   UPDATE (any)               → RETURN NEW  (unchanged semantics from 049)
--
-- ADDITIVE & IDEMPOTENT: CREATE OR REPLACE on the function; triggers on the
-- three config tables already exist (DROP/CREATE each to pick up fresh function
-- definition just in case; trigger body is unchanged — function is the fix).
-- Re-running this migration is safe.

CREATE OR REPLACE FUNCTION choros.tier_published_locked()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tier = 'published'
     AND current_setting('choros.promoting', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION
      'tier published rows are managed/locked (T-0087 FR-4): direct write forbidden';
  END IF;

  -- For DELETE return OLD (the row to be deleted); for UPDATE return NEW.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

-- Re-attach triggers so they bind to the replaced function body.
-- (DROP IF EXISTS + CREATE is idempotent and guarantees BEFORE UPDATE OR DELETE.)

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
