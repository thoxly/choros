-- 046 · notification (T-0168 E-N.1) — in-app notification row for one recipient.
--
-- Tenant-table contract (T-0013, verbatim as in 043_invoke_proposal.sql / 045_form_binding.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Schema (ADR T-0120 §4.1):
--   PK (tenant_id, id)
--   FK (tenant_id, recipient_id) → choros.employee(tenant_id, id)  [tenant-scoped both sides]
--   is_read boolean DEFAULT false (badge/keyset-indexed)
--   expires_at bigint NULL (TTL for temporary notifications; unread rows never auto-expire)
--
-- Indexes:
--   Badge partial  idx_notification_unread   (tenant_id, recipient_id) WHERE is_read = false
--   Keyset listing idx_notification_listing  (tenant_id, recipient_id, created_at, id)
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips via
--   schema_migrations (migration 001_schema_migrations.sql); repeating this file is safe.
--
-- No queue/delivery/dispatch tables here (FF-NB-OUTBOX): delivery uses the existing
--   choros.outbox (T-0062, migration 024/025).
--
-- Migration slot: 046 (045_form_binding.sql is the highest occupied slot on this branch).

CREATE TABLE IF NOT EXISTS choros.notification (
  tenant_id    uuid    NOT NULL,
  id           uuid    NOT NULL,
  recipient_id uuid    NOT NULL,
  event_kind   text    NOT NULL,
  title        text    NOT NULL,
  body         text    NOT NULL,
  object_ref   text    NULL,
  is_read      boolean NOT NULL DEFAULT false,
  created_at   bigint  NOT NULL,
  expires_at   bigint  NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT notification_recipient_fk
    FOREIGN KEY (tenant_id, recipient_id)
    REFERENCES choros.employee(tenant_id, id)
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.notification ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.notification FORCE   ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'notification'
      AND policyname = 'notification_tenant_isolation'
  ) THEN
    CREATE POLICY notification_tenant_isolation ON choros.notification
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.notification TO choros_app;

-- Badge partial index: small, hot index for unread-count queries.
-- EXPLAIN(unread-count SELECT) must use this index (FF-UNREAD-INDEXED / AC-11 / AC-17).
CREATE INDEX IF NOT EXISTS idx_notification_unread
  ON choros.notification (tenant_id, recipient_id)
  WHERE is_read = false;

-- Keyset listing index: supports GET /api/notifications keyset pagination by (created_at, id).
CREATE INDEX IF NOT EXISTS idx_notification_listing
  ON choros.notification (tenant_id, recipient_id, created_at, id);
