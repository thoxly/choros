-- 068 · cross_app_ref (T-0080 · E11.9) — cross-application reference definitions.
--
-- ADR: docs/design/extensibility-and-authoring.md §6 (кросс-приложенческие данные:
--      references-not-copies; ACL at every hop; redacted projection; hop-cap).
-- Foundations: T-0013 (RLS-contract), T-0017 (tenant-scoped FK discipline),
--              T-0119 (migration discipline), T-0014 (application table, migration 003).
--
-- Tenant-table contract (T-0013, verbatim as in 061_doc_page.sql / 067_modules_nav.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- NF-1 invariant: RLS policy has ONLY the tenant_id predicate.
--
-- Schema:
--   cross_app_ref: PK (tenant_id, id); source_registry_id FK → registry_def;
--                  target_registry_id FK → registry_def (may differ from source);
--                  ref_field text — the JSONB key in the source record that holds
--                    the target record's UUID (the reference pointer);
--                  label text — display name for this reference definition;
--                  ref_strength text CHECK IN ('weak','strong') — weak = independent
--                    lifecycle (default), strong = cascade (master-detail, rare);
--                  created_at bigint; updated_at bigint.
--
-- Design invariants (§6):
--   1. A cross_app_ref row is a DEFINITION, not a copy of target data. The
--      target record fields are resolved live at traversal time via the single PDP.
--   2. ACL is re-checked at EACH hop in the application layer (cross-app-ref.ts).
--      This table only records WHICH field links WHICH registries — not payloads.
--   3. The hop_cap is a configuration constant in the application layer; it is NOT
--      stored per-row (§6: hard-capped traversal depth; the cap is uniform).
--   4. Cross-process data exposure is through the RLS channel; this table is
--      entirely within the tenant RLS boundary (current_setting predicate).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policies and indexes;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 068 (067_modules_nav.sql is the highest occupied slot before this task).
-- Sister task owns 069.

-- ---------------------------------------------------------------------------
-- cross_app_ref — definition table for cross-application reference links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.cross_app_ref (
  tenant_id          uuid    NOT NULL,
  id                 uuid    NOT NULL,
  source_registry_id uuid    NOT NULL,
  target_registry_id uuid    NOT NULL,
  ref_field          text    NOT NULL,
  label              text    NOT NULL,
  ref_strength       text    NOT NULL DEFAULT 'weak',
  created_at         bigint  NOT NULL,
  updated_at         bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT cross_app_ref_source_fk
    FOREIGN KEY (tenant_id, source_registry_id)
    REFERENCES choros.registry_def(tenant_id, id),

  CONSTRAINT cross_app_ref_target_fk
    FOREIGN KEY (tenant_id, target_registry_id)
    REFERENCES choros.registry_def(tenant_id, id),

  CONSTRAINT cross_app_ref_strength_chk
    CHECK (ref_strength IN ('weak', 'strong')),

  -- A given source registry can only have one ref_field pointing to a given target.
  CONSTRAINT cross_app_ref_source_field_uniq
    UNIQUE (tenant_id, source_registry_id, ref_field)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
-- NF-1: single predicate — tenant_id only (no scope predicate; §6 block-invariant).
ALTER TABLE choros.cross_app_ref ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.cross_app_ref FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'cross_app_ref'
      AND policyname = 'cross_app_ref_tenant_isolation'
  ) THEN
    CREATE POLICY cross_app_ref_tenant_isolation ON choros.cross_app_ref
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.cross_app_ref TO choros_app;

-- Index: efficiently find all ref definitions for a source registry (common query path).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'cross_app_ref'
      AND indexname  = 'cross_app_ref_source_idx'
  ) THEN
    CREATE INDEX cross_app_ref_source_idx ON choros.cross_app_ref (tenant_id, source_registry_id);
  END IF;
END
$$;
