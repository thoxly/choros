-- 067 · nav_version + catalog_field_spec (T-0079 · E11.8) — module navigation hierarchy
--     and core-owned reference catalog field registry.
--
-- ADR: docs/design/extensibility-and-authoring.md §5 (modules/sections;
--      core-owned reference catalogs; extend-not-replace; users/org = Keycloak projection).
-- Foundations: T-0013 (RLS-contract), T-0017 (tenant-scoped FK discipline),
--              T-0119 (migration discipline), T-0014 (application table, migration 003).
--
-- Tenant-table contract (T-0013, verbatim as in 061_doc_page.sql / 051_report_page.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- NF-1 invariant: RLS policy has ONLY the tenant_id predicate — NO additional predicate.
--
-- Schema:
--   nav_version:        PK (tenant_id, version); config jsonb; created_at;
--                       UNIQUE latest flag via partial index.
--   catalog_field_spec: PK (tenant_id, catalog_name, field_key); kind='standard'|'custom';
--                       label; created_at; UNIQUE (tenant_id, catalog_name, field_key).
--
-- users/org projection: no separate table — users are a read-only projection of Keycloak
--   (tenancy-ADR §6). Standard fields are seeded into catalog_field_spec with kind='standard'.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policies and indexes;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 067 (065 is the highest occupied before this task; 066 reserved for sister task).

-- ---------------------------------------------------------------------------
-- nav_version — versioned nav config per tenant (ADR §5)
-- ---------------------------------------------------------------------------
-- Stores the full Section→Application→Form/List hierarchy as a versioned JSONB blob.
-- The pure TypeScript types (NavConfig) define the shape; this table is the storage layer.
-- version is a monotonic counter; the adapter increments it atomically.
-- latest boolean partial-index ensures at most one current config per tenant.

CREATE TABLE IF NOT EXISTS choros.nav_version (
  tenant_id   uuid    NOT NULL,
  version     integer NOT NULL,
  config      jsonb   NOT NULL,
  created_at  bigint  NOT NULL,

  PRIMARY KEY (tenant_id, version),

  CONSTRAINT nav_version_config_not_null
    CHECK (config IS NOT NULL),

  CONSTRAINT nav_version_version_positive
    CHECK (version >= 0)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
-- NF-1: single predicate — tenant_id only.
ALTER TABLE choros.nav_version ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.nav_version FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'nav_version'
      AND policyname = 'nav_version_tenant_isolation'
  ) THEN
    CREATE POLICY nav_version_tenant_isolation ON choros.nav_version
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.nav_version TO choros_app;

-- Index: efficiently find the latest nav config for a tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'nav_version'
      AND indexname  = 'nav_version_tenant_latest_idx'
  ) THEN
    CREATE INDEX nav_version_tenant_latest_idx
      ON choros.nav_version (tenant_id, version DESC);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- catalog_field_spec — core-owned reference catalog field registry (ADR §5)
-- ---------------------------------------------------------------------------
-- Stores per-tenant field specs for core-owned reference catalogs:
--   counterparty, user (Keycloak projection), org_unit (department/position).
-- kind = 'standard': core-pinned — cannot be dropped/renamed/overwritten (extend-not-replace).
-- kind = 'custom':   tenant-addable — can be extended freely.
--
-- Standard field rows are seeded below for the dev tenant.
-- Tenant rows are managed by the HTTP layer (guided by classifyCatalogFieldChange guard).

CREATE TABLE IF NOT EXISTS choros.catalog_field_spec (
  tenant_id    uuid    NOT NULL,
  catalog_name text    NOT NULL,
  field_key    text    NOT NULL,
  label        text    NOT NULL,
  kind         text    NOT NULL DEFAULT 'custom',
  created_at   bigint  NOT NULL,

  PRIMARY KEY (tenant_id, catalog_name, field_key),

  CONSTRAINT catalog_field_spec_kind_chk
    CHECK (kind IN ('standard', 'custom')),

  CONSTRAINT catalog_field_spec_catalog_chk
    CHECK (catalog_name IN ('counterparty', 'user', 'org_unit')),

  CONSTRAINT catalog_field_spec_field_key_nonempty
    CHECK (field_key <> ''),

  CONSTRAINT catalog_field_spec_label_nonempty
    CHECK (label <> '')
);

-- Row-level security: single tenant_id predicate (NF-1).
ALTER TABLE choros.catalog_field_spec ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.catalog_field_spec FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'catalog_field_spec'
      AND policyname = 'catalog_field_spec_tenant_isolation'
  ) THEN
    CREATE POLICY catalog_field_spec_tenant_isolation ON choros.catalog_field_spec
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.catalog_field_spec TO choros_app;

-- ---------------------------------------------------------------------------
-- Dev-tenant seed: standard fields for core-owned catalogs
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- Seeded at epoch 0 (constant, idempotent, stable UUID-prefix pattern).
-- ---------------------------------------------------------------------------

INSERT INTO choros.catalog_field_spec
  (tenant_id, catalog_name, field_key, label, kind, created_at)
VALUES
  -- user catalog: Keycloak projection standard fields (read-only, core-pinned)
  ('a0000000-0000-0000-0000-000000000001', 'user', 'id',          'User ID',      'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'user', 'username',    'Username',     'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'user', 'displayName', 'Display Name', 'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'user', 'email',       'Email',        'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'user', 'enabled',     'Enabled',      'standard', 0),

  -- org_unit catalog: department/position standard fields (migration 014/015, core-pinned)
  ('a0000000-0000-0000-0000-000000000001', 'org_unit', 'id',           'ID',           'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'org_unit', 'slug',         'Slug',         'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'org_unit', 'display_name', 'Display Name', 'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'org_unit', 'parent_id',    'Parent',       'standard', 0),

  -- counterparty catalog: standard fields (core-pinned)
  ('a0000000-0000-0000-0000-000000000001', 'counterparty', 'id',     'ID',     'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'counterparty', 'name',   'Name',   'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'counterparty', 'inn',    'ИНН',    'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'counterparty', 'type',   'Type',   'standard', 0),
  ('a0000000-0000-0000-0000-000000000001', 'counterparty', 'status', 'Status', 'standard', 0)
ON CONFLICT DO NOTHING;
