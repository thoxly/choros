-- 074 · process_definition (T-0252 E8 C1) — tenant-scoped BPMN process definition store.
--
-- Holds the canonical XML + lifecycle state for each process definition created via the
-- modeler. The publish path: POST /api/process-defs/:key/publish lints the stored XML,
-- deploys to Flowable via deployBpmn(), and records the deployment_id here.
--
-- Tenant-table contract (T-0013, verbatim as in 046_notification.sql / 058_files_attachments.sql):
--   tenant_id-leading PK, ENABLE+FORCE ROW LEVEL SECURITY, exactly ONE isolation predicate
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   GRANT SELECT,INSERT,UPDATE,DELETE ... TO choros_app,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips via
--   schema_migrations; repeating this file is safe.
--
-- Migration slot: 074 (073 is the highest occupied slot on this branch).

CREATE TABLE IF NOT EXISTS choros.process_definition (
  tenant_id     uuid    NOT NULL,
  id            uuid    NOT NULL,
  process_key   text    NOT NULL,
  name          text    NOT NULL,
  bpmn_xml      text    NOT NULL,
  version       int     NOT NULL,
  status        text    NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),
  deployment_id text    NULL,
  created_at    bigint  NOT NULL,
  updated_at    bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, process_key, version)
);

ALTER TABLE choros.process_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.process_definition FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'process_definition'
      AND policyname = 'process_definition_tenant_isolation'
  ) THEN
    CREATE POLICY process_definition_tenant_isolation ON choros.process_definition
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.process_definition TO choros_app;
