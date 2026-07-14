-- 054 · connector (T-0128 / T-0206) — per-tenant connector/integration STUB entity.
--
-- v1 data-model placeholder for future 1С / Active Directory / email / generic-HTTP
-- connectors. Extend-not-replace: a new tenant table reusing existing primitives
-- (T-0013 RLS canon, T-0025 secret custody, T-0034 effect-grant authority) — NO new
-- parallel authority/subsystem, NO live driver, NO real external call (NF-2/AC-14).
--
-- Tenant-table contract (T-0013, verbatim as in 047_email_channel_config.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, isolation policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT, listed in ci/checks/known_tenant_tables.txt.
--
-- Difference from email_channel_config: that table is one row per tenant (PK=tenant_id);
-- a connector has MANY rows per tenant, so the PK is composite (tenant_id, id) with
-- tenant_id leading (passes tenant_id_leading.sql).
--
-- Stub semantics: CRUD writes/reads config + opaque secret_handle + declarative status.
-- The right to INVOKE a connector is NOT introduced here: invocation = an `invoke` grant
-- on an effect_resource (T-0034). `backs_effect_resource_id` is a NULLABLE LOGICAL link
-- (NOT a foreign key) declaring which effect_resource this connector backs — it does NOT
-- participate in authorization (see ADR §5).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips via
--   schema_migrations; repeating this file is safe.
--
-- Migration slot: 054 (immediately follows 053_author_report_page_seed.sql).

CREATE TABLE IF NOT EXISTS choros.connector (
  tenant_id                uuid    NOT NULL,
  id                       uuid    NOT NULL,
  kind                     text    NOT NULL
    CHECK (kind IN ('1c', 'ad_ldap', 'smtp', 'http_generic')),
  -- 'http_generic' is a CLOSED kind value, NOT a promise of generic egress. Any connector
  -- (including http_generic) is un-invokable without a backing effect_resource + invoke
  -- grant (T-0034 verifyEffectGrants); closed-kind != open egress.
  display_name             text    NOT NULL,
  config                   jsonb   NOT NULL DEFAULT '{}'::jsonb, -- opaque; NEVER used in authz
  secret_handle            text    NULL,                          -- RL-3 opaque handle (T-0025)
  status                   text    NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('configured', 'disabled', 'error')),
  backs_effect_resource_id uuid    NULL,    -- declarative logical link (NOT a FK), T-0034
  created_by               text    NOT NULL,
  created_at               bigint  NOT NULL,
  updated_by               text    NOT NULL,
  updated_at               bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.connector ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.connector FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'connector'
      AND policyname = 'connector_tenant_isolation'
  ) THEN
    CREATE POLICY connector_tenant_isolation ON choros.connector
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.connector TO choros_app;
