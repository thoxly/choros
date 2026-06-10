-- 007 · audit_head (T-0016 §3.2) — one forward-only head row per tenant.
--
-- Tenant table. PK (tenant_id) — exactly one row per tenant. The head's seq
-- advances strictly forward by +1 (audit_head_advance), and the head row can
-- never be deleted (audit_head_no_delete_trg) — both for ALL roles (T-0016 §4.6).
-- choros_app: SELECT, INSERT, UPDATE — NO DELETE (AC-12).

CREATE TABLE choros.audit_head (
  tenant_id     uuid NOT NULL,
  seq           bigint NOT NULL,
  row_hash      bytea NOT NULL,
  updated_at    bigint NOT NULL,
  vocab_version smallint NOT NULL,
  PRIMARY KEY (tenant_id)
);

ALTER TABLE choros.audit_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.audit_head FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_head_tenant_isolation ON choros.audit_head
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- Forward-only advance: an UPDATE may only move seq forward by exactly +1.
CREATE OR REPLACE FUNCTION choros.audit_head_advance()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.seq <> OLD.seq + 1 THEN
    RAISE EXCEPTION 'audit_head.seq must advance by exactly +1 (was %, attempted %)',
      OLD.seq, NEW.seq
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_head_advance
  BEFORE UPDATE ON choros.audit_head
  FOR EACH ROW EXECUTE FUNCTION choros.audit_head_advance();

-- No-delete: the head row is permanent.
CREATE OR REPLACE FUNCTION choros.audit_head_no_delete()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_head is permanent: DELETE is forbidden'
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_head_no_delete_trg
  BEFORE DELETE ON choros.audit_head
  FOR EACH ROW EXECUTE FUNCTION choros.audit_head_no_delete();

GRANT SELECT, INSERT, UPDATE ON choros.audit_head TO choros_app;
