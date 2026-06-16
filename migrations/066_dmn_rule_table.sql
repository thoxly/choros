-- T-0075 · E11.4 — DMN-middle: storage for declarative rule tables
--
-- Stores per-tenant DMN decision tables as JSON. The pure evaluator
-- (src/core/dmn-middle.ts) operates on the in-memory DmnRuleTable shape;
-- this migration provides the persistence layer for tenant-authored rule tables.
--
-- Design invariants (NF-1, one predicate per table, default-DENY):
--   - Every table is scoped to tenant_id (silo isolation via RLS).
--   - RLS policy: ONE USING predicate per operation — tenant_id = current_tenant().
--   - No direct writes from pure core; the DB adapter layer handles CRUD.
--   - definition JSONB holds the serialized DmnRuleTable (id, name, hitPolicy, rules[]).
--   - process_def_id links the table to a process definition (nullable → global scope).
--   - status: 'draft' | 'published' — only 'published' tables are loaded at runtime.
--     Authoring happens in 'draft'; promote is human-gated (§4 two-floor governance).
--
-- Migration is ADDITIVE: new table only, no existing table changes.
-- Runner (migrations/run.mjs) is gap-tolerant.

BEGIN;

CREATE TABLE IF NOT EXISTS dmn_rule_table (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
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
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast tenant-scoped lookup by process + status (runtime hot path).
CREATE INDEX IF NOT EXISTS idx_dmn_rule_table_tenant_process
  ON dmn_rule_table (tenant_id, process_def_id, status);

-- ---------------------------------------------------------------------------
-- Row Level Security — NF-1: ONE USING predicate per table, default-DENY.
-- ---------------------------------------------------------------------------

ALTER TABLE dmn_rule_table ENABLE ROW LEVEL SECURITY;

-- current_tenant() is defined by migration 001 (tenant bootstrap).
-- RLS policy: only rows whose tenant_id matches the session tenant are visible.
-- One predicate per operation (SELECT, INSERT, UPDATE, DELETE) — NF-1.

CREATE POLICY dmn_rule_table_tenant_select
  ON dmn_rule_table FOR SELECT
  USING (tenant_id = current_tenant());

CREATE POLICY dmn_rule_table_tenant_insert
  ON dmn_rule_table FOR INSERT
  WITH CHECK (tenant_id = current_tenant());

CREATE POLICY dmn_rule_table_tenant_update
  ON dmn_rule_table FOR UPDATE
  USING (tenant_id = current_tenant())
  WITH CHECK (tenant_id = current_tenant());

CREATE POLICY dmn_rule_table_tenant_delete
  ON dmn_rule_table FOR DELETE
  USING (tenant_id = current_tenant());

COMMIT;
