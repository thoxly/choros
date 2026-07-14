-- 052 · report_page_dep (T-0175 · T-0121a) — tenant-scoped registry of report-page field dependencies.
--
-- ADR: docs/design/T-0121-reports-pages.adr.md §2.2 + §9 (T-0121a decomposition).
-- Foundations: T-0013 (RLS-contract), T-0014 (registry_def table, migration 004),
--              T-0017 (tenant-scoped FK discipline), T-0119 (migration discipline),
--              T-0175 / migration 051_report_page.sql (FK target — must be applied first).
--
-- Tenant-table contract (T-0013, verbatim as in 046_notification.sql / 038_egress_policy.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Schema (ADR T-0121 §2.2):
--   PK (tenant_id, id)
--   UNIQUE (tenant_id, page_id, registry_def_id, field_key)
--   FK (tenant_id, page_id)         → choros.report_page(tenant_id, id)  ON DELETE CASCADE
--   FK (tenant_id, registry_def_id) → choros.registry_def(tenant_id, id)
--   CHECK report_page_dep_kind_chk  dep_kind IN ('read','aggregate')
--
-- ON DELETE CASCADE on page_id FK: deleting a report_page removes its deps.
--   audit_event is append-only and survives deletion (ADR §7 NF-7).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 052 (051_report_page.sql must already be applied — FK dependency).

CREATE TABLE IF NOT EXISTS choros.report_page_dep (
  tenant_id       uuid    NOT NULL,
  id              uuid    NOT NULL,
  page_id         uuid    NOT NULL,
  registry_def_id uuid    NOT NULL,
  field_key       text    NOT NULL,
  dep_kind        text    NOT NULL,
  stale           boolean NOT NULL DEFAULT false,
  created_at      bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT report_page_dep_page_fk
    FOREIGN KEY (tenant_id, page_id)
    REFERENCES choros.report_page(tenant_id, id)
    ON DELETE CASCADE,

  CONSTRAINT report_page_dep_registry_def_fk
    FOREIGN KEY (tenant_id, registry_def_id)
    REFERENCES choros.registry_def(tenant_id, id),

  CONSTRAINT report_page_dep_page_field_uniq
    UNIQUE (tenant_id, page_id, registry_def_id, field_key),

  CONSTRAINT report_page_dep_kind_chk
    CHECK (dep_kind IN ('read', 'aggregate'))
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.report_page_dep ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.report_page_dep FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'report_page_dep'
      AND policyname = 'report_page_dep_tenant_isolation'
  ) THEN
    CREATE POLICY report_page_dep_tenant_isolation ON choros.report_page_dep
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.report_page_dep TO choros_app;
