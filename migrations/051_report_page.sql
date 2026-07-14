-- 051 · report_page (T-0175 · T-0121a) — tenant-scoped report/page metadata (two-floor model).
--
-- ADR: docs/design/T-0121-reports-pages.adr.md §2.1 + §9 (T-0121a decomposition).
-- Foundations: T-0013 (RLS-contract), T-0014 (application table, migration 003),
--              T-0017 (tenant-scoped FK discipline), T-0119 (migration discipline).
--
-- Tenant-table contract (T-0013, verbatim as in 046_notification.sql / 038_egress_policy.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Schema (ADR T-0121 §2.1):
--   PK (tenant_id, id)
--   UNIQUE (tenant_id, app_id, slug)                                         — URL uniqueness
--   FK (tenant_id, app_id) → choros.application(tenant_id, id)              — tenant-scoped both sides
--   CHECK report_page_floor_chk    floor IN ('1','2')
--   CHECK report_page_tier_chk     tier  IN ('draft','published')
--   CHECK report_page_floor_payload_chk  Floor-1 ⇒ page_def IS NOT NULL; Floor-2 ⇒ page_code IS NOT NULL
--
-- page_code stored as text (raw TSX/JS). NOT binary / large-object (ADR §2.1, §10 / T-0119).
--
-- Out-of-scope (T-0121b–T-0121h): TS compat helpers, API handlers, bundle-coherence extension,
--   mcp_tool seed (author_report_page), floor renderer, static analysis. DDL only here.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy and constraints;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 051 (050_tier_delete_fix.sql is the highest occupied slot before this task).

CREATE TABLE IF NOT EXISTS choros.report_page (
  tenant_id  uuid    NOT NULL,
  id         uuid    NOT NULL,
  app_id     uuid    NOT NULL,
  slug       text    NOT NULL,
  title      text    NOT NULL,
  floor      text    NOT NULL,
  tier       text    NOT NULL DEFAULT 'draft',
  page_def   jsonb   NULL,
  page_code  text    NULL,
  bundle_ref text    NULL,
  created_at bigint  NOT NULL,
  updated_at bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT report_page_app_fk
    FOREIGN KEY (tenant_id, app_id)
    REFERENCES choros.application(tenant_id, id),

  CONSTRAINT report_page_slug_uniq
    UNIQUE (tenant_id, app_id, slug),

  CONSTRAINT report_page_floor_chk
    CHECK (floor IN ('1', '2')),

  CONSTRAINT report_page_tier_chk
    CHECK (tier IN ('draft', 'published')),

  CONSTRAINT report_page_floor_payload_chk
    CHECK (
      (floor = '1' AND page_def IS NOT NULL)
      OR
      (floor = '2' AND page_code IS NOT NULL)
    )
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.report_page ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.report_page FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'report_page'
      AND policyname = 'report_page_tenant_isolation'
  ) THEN
    CREATE POLICY report_page_tenant_isolation ON choros.report_page
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.report_page TO choros_app;
