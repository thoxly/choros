-- 048 · notification_preference (T-0168 E-N.1) — per-event, per-scope channel subscription.
--
-- Tenant-table contract (T-0013, verbatim as in 043_invoke_proposal.sql / 045_form_binding.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Schema (ADR T-0120 §4.3):
--   PK (tenant_id, event_kind, recipient_scope) — one subscription per (event × who)
--   channels text[] NOT NULL — active channels: {in_app, email, …} (ChannelDriver keys)
--   recipient_scope vocab: actor:<id> | role:<id> | object_owner | escalation_chain
--   updated_by text NOT NULL, updated_at bigint NOT NULL — audit-trail fields.
--
-- No FK beyond the tenant boundary (T-0017 discipline): no cross-table FK to employee/role.
-- UPSERT at the application layer (ON CONFLICT (tenant_id, event_kind, recipient_scope) DO UPDATE).
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips via
--   schema_migrations; repeating this file is safe.
--
-- Migration slot: 048 (immediately follows 047_email_channel_config.sql).

CREATE TABLE IF NOT EXISTS choros.notification_preference (
  tenant_id        uuid    NOT NULL,
  event_kind       text    NOT NULL,
  recipient_scope  text    NOT NULL,
  channels         text[]  NOT NULL,
  updated_by       text    NOT NULL,
  updated_at       bigint  NOT NULL,

  PRIMARY KEY (tenant_id, event_kind, recipient_scope)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.notification_preference ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.notification_preference FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'notification_preference'
      AND policyname = 'notification_preference_tenant_isolation'
  ) THEN
    CREATE POLICY notification_preference_tenant_isolation ON choros.notification_preference
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.notification_preference TO choros_app;
