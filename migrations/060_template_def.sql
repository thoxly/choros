-- 060 · template_def + template_dep (T-0235 / T-0124) — document-on-demand template model.
--
-- ADR: docs/design/T-0124-document-on-demand.adr.md §2.9 + §10 (step 1).
-- Foundations: T-0013 (RLS-contract), T-0014 (registry_def table, migration 004),
--              T-0017 (tenant-scoped FK discipline), T-0119 (migration discipline),
--              T-0121 (report_page_dep pattern — template_dep is an extension, not a 4th mechanism).
--
-- Tenant-table contract (T-0013, verbatim as in 046_notification.sql / 051_report_page.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Schema:
--   template_def PK (tenant_id, id)
--   template_dep PK (tenant_id, id)
--   UNIQUE (tenant_id, template_id, registry_def_id, field_key)
--   CHECK template_def_format_chk: format IN ('csv','html')           — closed day-1 set (FF-FORMAT-CLOSED)
--   CHECK template_def_tier_chk:   tier   IN ('draft','published')   — T-0087-discipline
--   CHECK template_dep_kind_chk:   dep_kind IN ('read','aggregate')  — mirrors report_page_dep (T-0121)
--
-- New tables: template_def, template_dep
-- NOT introduced: file*, *_token, render_log, external_* (FF-NO-DUP-SUBSYSTEM)
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policies and constraints;
--   runner skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 060 (059_implementation_agent_seed.sql is the highest occupied slot).

-- ============================================================
-- table: template_def
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.template_def (
  tenant_id       uuid    NOT NULL,
  id              uuid    NOT NULL,
  registry_id     uuid    NOT NULL,
  format          text    NOT NULL,
  body            text    NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  tier            text    NOT NULL DEFAULT 'draft',
  created_by      text    NOT NULL,
  created_at      bigint  NOT NULL,
  updated_at      bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT template_def_registry_fk
    FOREIGN KEY (tenant_id, registry_id)
    REFERENCES choros.registry_def(tenant_id, id),

  CONSTRAINT template_def_format_chk
    CHECK (format IN ('csv', 'html')),

  CONSTRAINT template_def_tier_chk
    CHECK (tier IN ('draft', 'published'))
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.template_def ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.template_def FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'template_def'
      AND policyname = 'template_def_tenant_isolation'
  ) THEN
    CREATE POLICY template_def_tenant_isolation ON choros.template_def
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.template_def TO choros_app;

-- ============================================================
-- table: template_dep
-- Зеркало report_page_dep (T-0121 §2.2): одна строка = шаблон зависит от
-- одного field_key одной registry_def.record_schema.
-- dep_kind ∈ {read, aggregate} — mirrors report_page_dep_kind_chk (T-0121).
-- stale boolean: escape-hatch discipline (mirrors T-0121 §5, FF-TEMPLATE-COHERENCE).
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.template_dep (
  tenant_id       uuid    NOT NULL,
  id              uuid    NOT NULL,
  template_id     uuid    NOT NULL,
  registry_def_id uuid    NOT NULL,
  field_key       text    NOT NULL,
  dep_kind        text    NOT NULL,
  stale           boolean NOT NULL DEFAULT false,
  created_at      bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT template_dep_template_fk
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES choros.template_def(tenant_id, id)
    ON DELETE CASCADE,

  CONSTRAINT template_dep_registry_def_fk
    FOREIGN KEY (tenant_id, registry_def_id)
    REFERENCES choros.registry_def(tenant_id, id),

  CONSTRAINT template_dep_template_field_uniq
    UNIQUE (tenant_id, template_id, registry_def_id, field_key),

  CONSTRAINT template_dep_kind_chk
    CHECK (dep_kind IN ('read', 'aggregate'))
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.template_dep ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.template_dep FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'template_dep'
      AND policyname = 'template_dep_tenant_isolation'
  ) THEN
    CREATE POLICY template_dep_tenant_isolation ON choros.template_dep
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.template_dep TO choros_app;

-- ============================================================
-- Step 3. mcp_tool seed — author_template (T-0235 / T-0124 §2.9 config-agent authoring)
--
-- Pattern: migration 053_author_report_page_seed.sql (author_report_page).
-- Mirrors 044_config_agent_seed.sql discipline:
--   - PURE DATA SEED: no CREATE TABLE, no DDL beyond INSERTs.
--   - IDEMPOTENT: ON CONFLICT DO NOTHING.
--   - DRAFT-BOUNDARY: authoring_draft only; NO promote grant (human-gated, ADR §2.9).
--   - CHECK mcp_tool_pure_empty_chk: declares='[]', pure_compute=true.
--
-- Dev-tenant constants (T-0077 §2.3):
--   DEV_TENANT_UUID  = a0000000-0000-0000-0000-000000000001
--   ROLE_CONFIG_AGENT= e0000000-0000-0000-0000-000000000003
--   MCP_TOOL UUID    = 10000000-0000-0000-0000-000000000012 (next after 000000000011 in 059)
--   GRANT UUIDs      = e2000000-0000-0000-0000-000000000016 (create)
--                      e2000000-0000-0000-0000-000000000017 (update)
-- ============================================================

INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000012',
   'author_template',
   'Create or update a template_def in authoring_draft tier. Deps auto-derived from template body placeholders. Promote is human-gated (ADR T-0124 §2.9). Stage-2: runtime agentic template generation.',
   '[]'::jsonb,
   true,
   '[{"resourceType":"authoring_draft","operation":"create"},{"resourceType":"authoring_draft","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000016',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000017',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;
