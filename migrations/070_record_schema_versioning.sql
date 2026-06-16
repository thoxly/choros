-- 070 · record-schema versioning (T-0085) — per-record expand/contract object-schema versioning
--
-- ADR: docs/design/T-0085-record-schema-versioning.adr.md
-- Spec: docs/specs/T-0085-record-schema-versioning.spec.md
--
-- Design: single migration applies columns + triggers + history table + rollback-safe function
--   in one transaction. Existing records/registries seeded at version 1.
--   Trigger immutability on record.schema_version (no UPDATE allowed).
--   Trigger default-on-insert: record inherits registry's current version.
--   Trigger increment-on-change: registry_def.record_schema_version bumps on schema change.
--   Audit trigger appends to registry_schema_history after version increment.
--   Forward-only rollback gate: fn_check_rollback_safe(tenant_id, registry_id, target_version).
--
-- Rebuilt from salvage/T-0085-prior (was migration 056, rebased to 070 for current dev head 069).

-- ============================================================
-- Step 1. ALTER TABLE record: add schema_version column
--
-- Two-step: backfill existing rows to 1, then DROP DEFAULT so new INSERT
-- goes through the BEFORE INSERT trigger (fn_record_schema_version_default)
-- which reads the registry's current record_schema_version.
-- Without DROP DEFAULT, pg applies DEFAULT 1 before the trigger fires and
-- the trigger's IS NULL check never fires — all new records get v1 always.
-- ============================================================

ALTER TABLE choros.record ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE choros.record ALTER COLUMN schema_version DROP DEFAULT;

-- ============================================================
-- Step 2. ALTER TABLE registry_def: add record_schema_version column
-- ============================================================

ALTER TABLE choros.registry_def ADD COLUMN record_schema_version integer NOT NULL DEFAULT 1;

-- ============================================================
-- Step 3. CREATE TABLE registry_schema_history
--
-- Tenant table. PK (tenant_id, registry_id, schema_version).
-- ENABLE+FORCE RLS, default-DENY policy (NF-1: single tenant_id predicate).
-- SELECT+INSERT grant to choros_app (append-only history; no UPDATE/DELETE).
-- FK (tenant_id, registry_id) → registry_def(tenant_id, id).
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.registry_schema_history (
  tenant_id         uuid    NOT NULL,
  registry_id       uuid    NOT NULL,
  schema_version    integer NOT NULL,
  schema_json       jsonb   NOT NULL,
  created_at        bigint  NOT NULL,

  PRIMARY KEY (tenant_id, registry_id, schema_version),

  CONSTRAINT registry_schema_history_registry_fk
    FOREIGN KEY (tenant_id, registry_id)
    REFERENCES choros.registry_def (tenant_id, id)
);

ALTER TABLE choros.registry_schema_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.registry_schema_history FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'registry_schema_history'
      AND policyname = 'registry_schema_history_tenant_isolation'
  ) THEN
    EXECUTE $p$
      CREATE POLICY registry_schema_history_tenant_isolation
        ON choros.registry_schema_history
        USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid)
    $p$;
  END IF;
END $$;

GRANT SELECT, INSERT ON choros.registry_schema_history TO choros_app;

-- ============================================================
-- Step 4. Trigger: record_schema_version_default (BEFORE INSERT on record)
--         Populate schema_version from registry's current record_schema_version if NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_record_schema_version_default()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.schema_version IS NULL THEN
    SELECT record_schema_version INTO NEW.schema_version
      FROM choros.registry_def
     WHERE tenant_id = NEW.tenant_id AND id = NEW.registry_id;
    IF NEW.schema_version IS NULL THEN
      NEW.schema_version := 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'record_schema_version_default'
      AND tgrelid = 'choros.record'::regclass
  ) THEN
    EXECUTE $t$
      CREATE TRIGGER record_schema_version_default
        BEFORE INSERT ON choros.record
        FOR EACH ROW
        EXECUTE FUNCTION choros.fn_record_schema_version_default()
    $t$;
  END IF;
END $$;

-- ============================================================
-- Step 5. Trigger: record_schema_version_immutable (BEFORE UPDATE on record)
--         Prevent any UPDATE to schema_version; raise restrict_violation.
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_record_schema_version_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.schema_version != OLD.schema_version THEN
    RAISE EXCEPTION 'record.schema_version is immutable after creation'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'record_schema_version_immutable'
      AND tgrelid = 'choros.record'::regclass
  ) THEN
    EXECUTE $t$
      CREATE TRIGGER record_schema_version_immutable
        BEFORE UPDATE ON choros.record
        FOR EACH ROW
        EXECUTE FUNCTION choros.fn_record_schema_version_immutable()
    $t$;
  END IF;
END $$;

-- ============================================================
-- Step 6. Trigger: registry_def_schema_version_increment (BEFORE UPDATE on registry_def)
--         Increment record_schema_version by 1 when record_schema changes (IS DISTINCT FROM).
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_registry_def_schema_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.record_schema IS DISTINCT FROM OLD.record_schema THEN
    NEW.record_schema_version := OLD.record_schema_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'registry_def_schema_version_increment'
      AND tgrelid = 'choros.registry_def'::regclass
  ) THEN
    EXECUTE $t$
      CREATE TRIGGER registry_def_schema_version_increment
        BEFORE UPDATE ON choros.registry_def
        FOR EACH ROW
        EXECUTE FUNCTION choros.fn_registry_def_schema_version_increment()
    $t$;
  END IF;
END $$;

-- ============================================================
-- Step 7. Trigger: registry_def_schema_version_audit (AFTER UPDATE on registry_def)
--         Append row to registry_schema_history when record_schema changes.
--         AFTER trigger (not BEFORE) so NEW.record_schema_version already has the
--         incremented value from the BEFORE trigger above.
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_registry_def_schema_version_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.record_schema IS DISTINCT FROM OLD.record_schema THEN
    INSERT INTO choros.registry_schema_history
      (tenant_id, registry_id, schema_version, schema_json, created_at)
    VALUES
      (NEW.tenant_id, NEW.id, NEW.record_schema_version, NEW.record_schema,
       EXTRACT(EPOCH FROM clock_timestamp())::bigint * 1000);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'registry_def_schema_version_audit'
      AND tgrelid = 'choros.registry_def'::regclass
  ) THEN
    EXECUTE $t$
      CREATE TRIGGER registry_def_schema_version_audit
        AFTER UPDATE ON choros.registry_def
        FOR EACH ROW
        EXECUTE FUNCTION choros.fn_registry_def_schema_version_audit()
    $t$;
  END IF;
END $$;

-- ============================================================
-- Step 8. SQL Function: fn_check_rollback_safe
--
-- Returns TRUE iff rollback to target_version is safe:
-- no records exist with schema_version > p_target_version for this registry.
-- Returns TRUE when no records exist (empty registry = safe to rollback to any version).
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_check_rollback_safe(
  p_tenant_id     uuid,
  p_registry_id   uuid,
  p_target_version integer
)
RETURNS boolean AS $$
DECLARE
  v_max integer;
BEGIN
  SELECT MAX(schema_version) INTO v_max
    FROM choros.record
   WHERE tenant_id = p_tenant_id AND registry_id = p_registry_id;
  IF v_max IS NULL THEN
    RETURN true;
  END IF;
  RETURN v_max <= p_target_version;
END;
$$ LANGUAGE plpgsql;
