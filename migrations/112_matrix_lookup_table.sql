-- 112 · matrix_lookup_table (T-0407 · D7-8) — normative parameter matrix.
--
-- ADR: docs/specs/forms-data-contract-foundation.spec.md §3.1 / PD-20 / ADR §6.
-- Foundations: T-0013 (RLS-contract), T-0017 (tenant-scoped FK discipline),
--              T-0119 (migration discipline), T-0004 (registry_def).
--
-- Tenant-table contract (T-0013, verbatim as in 068_cross_app_ref.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- PURPOSE:
--   A matrix_lookup_table defines a 2-axis normative parameter table
--   (axis_a_value × axis_b_value → numeric_value). Example:
--     project_type × task_type → hours_norm
--   Records in registries that carry an `x-matrix-lookup` annotation on a field
--   get their derived value resolved by a single indexed PK scan against this table
--   (PD-20: "агрегаты считает БД"; O(1) per lookup, no GROUP BY).
--
-- HOP-CAP / NO-ROLLUP-OF-ROLLUP (ADR §6):
--   The lookup is a direct value read — NOT an aggregate of derived values.
--   A matrix table stores PRIMITIVE values (numeric). A `matrix-lookup` field
--   on a record is derived, hence never stored in record.data and never subject
--   to further rollup-of-rollup (the binding contract enforces read-only).
--
-- Schema:
--   matrix_lookup_table: PK (tenant_id, id).
--     display_name text    — human label for the table (shown in authoring UI).
--     description  text    — optional longer description.
--     created_at   bigint, updated_at bigint.
--
--   matrix_lookup_cell: PK (tenant_id, table_id, axis_a_value, axis_b_value).
--     FK (tenant_id, table_id) → matrix_lookup_table(tenant_id, id).
--     axis_a_value text   — axis-A parameter value (e.g. 'crm').
--     axis_b_value text   — axis-B parameter value (e.g. 'design').
--     numeric_value numeric NOT NULL — the cell value (e.g. 40 hours).
--     RLS shares the parent table_id tenant_id — covered by the same predicate.
--
-- Design invariants:
--   1. Only primitive numeric values in cells (no derived/rollup values).
--   2. The lookup is a single PK scan: (tenant_id, table_id, axis_a, axis_b).
--   3. NULL cell → the field returns NULL (no default; caller decides display).
--   4. axis_a_value and axis_b_value are TEXT — the field values on the record
--      are cast to text for the lookup (enum values are text; numeric→text::text).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policies and indexes;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 112 (109 dual-control / 110 timer on dev; 111 reserved by T-0534).

-- ---------------------------------------------------------------------------
-- matrix_lookup_table — the header/metadata row for a normative parameter table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.matrix_lookup_table (
  tenant_id    uuid    NOT NULL,
  id           uuid    NOT NULL,
  display_name text    NOT NULL,
  description  text    NULL,
  created_at   bigint  NOT NULL,
  updated_at   bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE choros.matrix_lookup_table ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.matrix_lookup_table FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'matrix_lookup_table'
      AND policyname = 'matrix_lookup_table_tenant_isolation'
  ) THEN
    CREATE POLICY matrix_lookup_table_tenant_isolation ON choros.matrix_lookup_table
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.matrix_lookup_table TO choros_app;

-- ---------------------------------------------------------------------------
-- matrix_lookup_cell — one cell in the 2-axis matrix
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.matrix_lookup_cell (
  tenant_id     uuid    NOT NULL,
  table_id      uuid    NOT NULL,
  axis_a_value  text    NOT NULL,
  axis_b_value  text    NOT NULL,
  numeric_value numeric NOT NULL,

  PRIMARY KEY (tenant_id, table_id, axis_a_value, axis_b_value),

  CONSTRAINT matrix_lookup_cell_table_fk
    FOREIGN KEY (tenant_id, table_id)
    REFERENCES choros.matrix_lookup_table (tenant_id, id)
    ON DELETE CASCADE
);

ALTER TABLE choros.matrix_lookup_cell ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.matrix_lookup_cell FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'matrix_lookup_cell'
      AND policyname = 'matrix_lookup_cell_tenant_isolation'
  ) THEN
    CREATE POLICY matrix_lookup_cell_tenant_isolation ON choros.matrix_lookup_cell
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.matrix_lookup_cell TO choros_app;

-- Index: axis lookup (covered by PK already; explicit for composite scans on table_id only)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'matrix_lookup_cell'
      AND indexname  = 'matrix_lookup_cell_table_idx'
  ) THEN
    CREATE INDEX matrix_lookup_cell_table_idx
      ON choros.matrix_lookup_cell (tenant_id, table_id);
  END IF;
END
$$;
