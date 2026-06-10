-- 006 · audit_event (T-0016 §3.1) — append-only, hash-chained audit floor.
--
-- Tenant table. PK (tenant_id, seq); UNIQUE (tenant_id, id). Carries scope jsonb
-- and payload jsonb NOT NULL (AC-15). Append-only is enforced two ways:
--   (a) choros_app is granted SELECT, INSERT only — no UPDATE/DELETE (AC-12);
--   (b) BEFORE UPDATE / BEFORE DELETE triggers reject mutation for ALL roles,
--       including choros_migrator (defence in depth — T-0016 §4.6 / FF-APPEND).

CREATE TABLE choros.audit_event (
  tenant_id     uuid NOT NULL,
  seq           bigint NOT NULL,
  id            uuid NOT NULL,
  type          text NOT NULL,
  actor         text NOT NULL,
  subject       text NULL,
  scope         jsonb NULL,
  via           text NULL,
  proposed_by   text NULL,
  confirmed_by  text NULL,
  payload       jsonb NOT NULL,
  occurred_at   bigint NOT NULL,
  prev_hash     bytea NOT NULL,
  row_hash      bytea NOT NULL,
  vocab_version smallint NOT NULL,
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, id)
);

ALTER TABLE choros.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.audit_event FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_event_tenant_isolation ON choros.audit_event
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- No-mutate trigger function: rejects any UPDATE/DELETE on the audit log.
CREATE OR REPLACE FUNCTION choros.audit_event_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is forbidden', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON choros.audit_event
  FOR EACH ROW EXECUTE FUNCTION choros.audit_event_immutable();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON choros.audit_event
  FOR EACH ROW EXECUTE FUNCTION choros.audit_event_immutable();

-- Append-only for the runtime role: SELECT/INSERT only (no UPDATE/DELETE).
GRANT SELECT, INSERT ON choros.audit_event TO choros_app;
