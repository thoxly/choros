-- 061 · doc_page + doc_ref + doc_log (T-0238 · T-0134a) — tenant-scoped doc-wiki layer.
--
-- ADR: docs/design/T-0134-agent-docs.adr.md §2.1/§2.2/§2.3 + §9 (T-0134a decomposition).
-- Foundations: T-0013 (RLS-contract), T-0017 (tenant-scoped FK discipline),
--              T-0119 (migration discipline), T-0014 (application table, migration 003).
--
-- Tenant-table contract (T-0013, verbatim as in 051_report_page.sql / 052_report_page_dep.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- NF-1 invariant (ADR §2.1): RLS policy has ONLY the tenant_id predicate — NO scope predicate.
--   scope='system' docs are per-tenant projections (ADR §2.4); they live as ordinary tenant rows
--   and are read via the single tenant_id RLS path, with no second predicate or context-switch.
--
-- Schema:
--   doc_page:  PK (tenant_id, id); UNIQUE (tenant_id, slug); CHECK scope IN (system,tenant);
--              app_id nullable FK → application; stale boolean; authored_by/authored_at/updated_at.
--   doc_ref:   PK (tenant_id, id); FK page_id → doc_page ON DELETE CASCADE;
--              ref_kind CHECK IN (closed vocab); ref_target jsonb (typed, not free text);
--              UNIQUE (tenant_id, page_id, ref_kind, ref_target).
--   doc_log:   PK (tenant_id, id); FK page_id → doc_page ON DELETE CASCADE;
--              op text NOT NULL (open-vocab, no CHECK — pattern T-0016); index (tenant_id, page_id, at).
--
-- FK order: doc_page must be created before doc_ref/doc_log (both reference it).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policies and indexes;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 061 (060_template_def.sql is the highest occupied slot before this task).

-- ---------------------------------------------------------------------------
-- doc_page — unit of content in the agent-maintained wiki (ADR §2.1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.doc_page (
  tenant_id       uuid    NOT NULL,
  id              uuid    NOT NULL,
  slug            text    NOT NULL,
  title           text    NOT NULL,
  body            text    NOT NULL,
  scope           text    NOT NULL DEFAULT 'tenant',
  catalog_version text    NULL,
  app_id          uuid    NULL,
  stale           boolean NOT NULL DEFAULT false,
  authored_by     text    NOT NULL,
  authored_at     bigint  NOT NULL,
  updated_at      bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT doc_page_slug_uniq
    UNIQUE (tenant_id, slug),

  CONSTRAINT doc_page_scope_chk
    CHECK (scope IN ('system', 'tenant')),

  CONSTRAINT doc_page_app_fk
    FOREIGN KEY (tenant_id, app_id)
    REFERENCES choros.application(tenant_id, id)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
-- NF-1: single predicate — tenant_id only; no scope predicate (ADR §2.1 block-invariant).
ALTER TABLE choros.doc_page ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.doc_page FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'doc_page'
      AND policyname = 'doc_page_tenant_isolation'
  ) THEN
    CREATE POLICY doc_page_tenant_isolation ON choros.doc_page
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.doc_page TO choros_app;

-- ---------------------------------------------------------------------------
-- doc_ref — registry of typed references from a doc_page to a live system element (ADR §2.2)
-- Sibling of report_page_dep (T-0121): «doc_page ↔ referent in live system».
-- ref_kind vocab is closed (extensible via additive migration only).
-- ref_target is jsonb — typed machine-resolvable identifier, NOT free text (FF-DOCREF-TYPED).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.doc_ref (
  tenant_id   uuid    NOT NULL,
  id          uuid    NOT NULL,
  page_id     uuid    NOT NULL,
  ref_kind    text    NOT NULL,
  ref_target  jsonb   NOT NULL,
  broken      boolean NOT NULL DEFAULT false,
  created_at  bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT doc_ref_page_fk
    FOREIGN KEY (tenant_id, page_id)
    REFERENCES choros.doc_page(tenant_id, id)
    ON DELETE CASCADE,

  CONSTRAINT doc_ref_kind_chk
    CHECK (ref_kind IN ('code_symbol', 'rest_endpoint', 'schema_field', 'process', 'config_key')),

  CONSTRAINT doc_ref_page_kind_target_uniq
    UNIQUE (tenant_id, page_id, ref_kind, ref_target)
);

-- Row-level security: single tenant_id predicate (NF-1, ADR §2.2).
ALTER TABLE choros.doc_ref ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.doc_ref FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'doc_ref'
      AND policyname = 'doc_ref_tenant_isolation'
  ) THEN
    CREATE POLICY doc_ref_tenant_isolation ON choros.doc_ref
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.doc_ref TO choros_app;

-- ---------------------------------------------------------------------------
-- doc_log — changelog of doc edits (LLM-wiki 'log' member) (ADR §2.3)
-- op is open-vocab text (NO CHECK constraint) — pattern T-0016 (audit_event.type).
-- Index on (tenant_id, page_id, at) for efficient page-history queries.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.doc_log (
  tenant_id    uuid   NOT NULL,
  id           uuid   NOT NULL,
  page_id      uuid   NOT NULL,
  op           text   NOT NULL,
  agent_actor  text   NOT NULL,
  diff_summary text   NULL,
  at           bigint NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT doc_log_page_fk
    FOREIGN KEY (tenant_id, page_id)
    REFERENCES choros.doc_page(tenant_id, id)
    ON DELETE CASCADE
);

-- Row-level security: single tenant_id predicate (NF-1, ADR §2.3).
ALTER TABLE choros.doc_log ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.doc_log FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'doc_log'
      AND policyname = 'doc_log_tenant_isolation'
  ) THEN
    CREATE POLICY doc_log_tenant_isolation ON choros.doc_log
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.doc_log TO choros_app;

-- Index on (tenant_id, page_id, at) for page-history queries (ADR §2.3).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'doc_log'
      AND indexname  = 'doc_log_tenant_page_at_idx'
  ) THEN
    CREATE INDEX doc_log_tenant_page_at_idx ON choros.doc_log (tenant_id, page_id, at);
  END IF;
END
$$;
