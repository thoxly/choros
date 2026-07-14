-- 047 · email_channel_config (T-0168 E-N.1) — per-tenant email channel configuration.
--
-- Tenant-table contract (T-0013, verbatim as in 043_invoke_proposal.sql / 045_form_binding.sql):
--   tenant_id leading PK (one row per tenant), ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Schema (ADR T-0120 §4.2):
--   PK (tenant_id)  — single row per tenant for the email channel config
--   smtp_handle text NOT NULL — opaque handle to SMTP credential (RL-3, T-0025 custody);
--     raw secrets are structurally blocked by validateSecretHandleShape at the app layer.
--   is_enabled boolean DEFAULT false — channel is off until explicitly enabled.
--   updated_by text NOT NULL, updated_at bigint NOT NULL — audit-trail fields.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips via
--   schema_migrations; repeating this file is safe.
--
-- Migration slot: 047 (immediately follows 046_notification.sql).

CREATE TABLE IF NOT EXISTS choros.email_channel_config (
  tenant_id    uuid     NOT NULL,
  smtp_host    text     NOT NULL,
  smtp_port    integer  NOT NULL,
  smtp_tls     boolean  NOT NULL DEFAULT true,
  from_address text     NOT NULL,
  from_name    text     NULL,
  smtp_handle  text     NOT NULL,
  is_enabled   boolean  NOT NULL DEFAULT false,
  updated_by   text     NOT NULL,
  updated_at   bigint   NOT NULL,

  PRIMARY KEY (tenant_id)
);

-- Row-level security: each choros_app session sees only its own tenant's row.
ALTER TABLE choros.email_channel_config ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.email_channel_config FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'email_channel_config'
      AND policyname = 'email_channel_config_tenant_isolation'
  ) THEN
    CREATE POLICY email_channel_config_tenant_isolation ON choros.email_channel_config
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.email_channel_config TO choros_app;
