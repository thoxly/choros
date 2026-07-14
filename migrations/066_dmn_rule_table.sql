-- T-0075 · E11.4 — DMN-middle: storage for declarative rule tables
--
-- Stores per-tenant DMN decision tables as JSON. The pure evaluator
-- (src/core/dmn-middle.ts) operates on the in-memory DmnRuleTable shape;
-- this migration provides the persistence layer for tenant-authored rule tables.
--
-- Tenant-table contract (T-0013, verbatim as in 061_doc_page.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Design invariants (NF-1, one predicate per table, default-DENY):
--   - Every table is scoped to tenant_id (silo isolation via RLS).
--   - RLS policy: single USING + WITH CHECK predicate — tenant_id only (NF-1).
--   - No direct writes from pure core; the DB adapter layer handles CRUD.
--   - definition JSONB holds the serialized DmnRuleTable (id, name, hitPolicy, rules[]).
--   - process_def_id links the table to a process definition (nullable → global scope).
--   - status: 'draft' | 'published' — only 'published' tables are loaded at runtime.
--     Authoring happens in 'draft'; promote is human-gated (§4 two-floor governance).
--
-- Migration is ADDITIVE: new table only, no existing table changes.
-- Runner (migrations/run.mjs) is gap-tolerant.

BEGIN;

CREATE TABLE IF NOT EXISTS choros.dmn_rule_table (
  tenant_id       UUID        NOT NULL,
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Serialised DmnRuleTable (id, name, hitPolicy, rules[]) as defined in
  -- src/core/dmn-middle.ts. Validated by the adapter before insert.
  definition      JSONB       NOT NULL,
  -- Nullable: NULL means the table applies to all processes of this tenant.
  -- When set, restricts the table to the named process definition key.
  process_def_id  TEXT        CHECK (char_length(process_def_id) <= 200),
  status          TEXT        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'published')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, id)
);

-- Index for fast tenant-scoped lookup by process + status (runtime hot path).
CREATE INDEX IF NOT EXISTS idx_dmn_rule_table_tenant_process
  ON choros.dmn_rule_table (tenant_id, process_def_id, status);

-- ---------------------------------------------------------------------------
-- Row Level Security — NF-1: single USING+WITH CHECK predicate, default-DENY.
-- current_setting('choros.tenant_id', true)::uuid is the established RLS predicate
-- used by every tenant table (see 061_doc_page.sql as reference).
-- ---------------------------------------------------------------------------

ALTER TABLE choros.dmn_rule_table ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.dmn_rule_table FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'dmn_rule_table'
      AND policyname = 'dmn_rule_table_tenant_isolation'
  ) THEN
    CREATE POLICY dmn_rule_table_tenant_isolation ON choros.dmn_rule_table
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.dmn_rule_table TO choros_app;

COMMIT;
