-- 075 · process_app_binding (T-0270 E13) — process↔application visibility binding.
--
-- Makes "how processes connect to the applications the user built in the constructor"
-- a REAL, queryable link. A binding row records: this process DEFINITION (process_key)
-- belongs to / drives this APPLICATION (application_id), optionally through a named form
-- (form_key). The processes screen reads these rows to show «процессы ↔ приложения».
--
-- WHY A NEW TABLE (not form_binding/045): form_binding is the (process_key, form_key)
-- FIELD-CONTRACT table (which form fields a process step reads/writes). It carries NO
-- application linkage. The process↔application relationship is a distinct concept — a
-- process can be bound to an application without (yet) pinning a specific form. Reusing
-- form_binding would conflate the field-contract with the app-membership link and
-- violate its (tenant_id, process_key, form_key) natural key. A dedicated additive table
-- keeps both contracts clean (D-056 additive discipline).
--
-- Tenant-table contract (T-0013, verbatim as in 074_process_definition.sql):
--   tenant_id-leading PK, ENABLE+FORCE ROW LEVEL SECURITY, exactly ONE isolation predicate
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   GRANT SELECT,INSERT,UPDATE,DELETE ... TO choros_app,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- Design discipline (T-0017 FK lesson):
--   - PK (tenant_id, id) is self-contained.
--   - application_id is a LOGICAL reference (uuid) — NO cross-table FK declared, to avoid
--     coupling across migration owners (same convention as bundle_version_instance/071,
--     connector/054). The POST handler verifies the app exists in the caller's tenant via
--     an RLS SELECT before inserting (runtime integrity, not a DB FK).
--   - form_key is NULLABLE — a process may be bound to an app before a form is chosen.
--   - Natural key UNIQUE (tenant_id, process_key, application_id) — one binding per
--     (process, app) pair; re-binding the same pair upserts (handler-side).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips via
--   schema_migrations; repeating this file is safe.
--
-- Migration slot: 075 (074 is the highest occupied slot on this branch).

CREATE TABLE IF NOT EXISTS choros.process_app_binding (
  tenant_id      uuid    NOT NULL,
  id             uuid    NOT NULL,
  process_key    text    NOT NULL,
  application_id uuid    NOT NULL,
  form_key       text    NULL,
  created_at     bigint  NOT NULL,
  updated_at     bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT process_app_binding_natural_key
    UNIQUE (tenant_id, process_key, application_id),

  CONSTRAINT process_app_binding_process_key_nonempty
    CHECK (char_length(process_key) > 0)
);

ALTER TABLE choros.process_app_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.process_app_binding FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'process_app_binding'
      AND policyname = 'process_app_binding_tenant_isolation'
  ) THEN
    CREATE POLICY process_app_binding_tenant_isolation ON choros.process_app_binding
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.process_app_binding TO choros_app;
