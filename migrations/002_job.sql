-- 002 · job (T-0013 §3.2) — the work queue, successor of the in-memory JobStore.
--
-- T-0053 owns the FULL job table DDL (ADR §1.3). The sister task T-0114 adds only
-- its store code and any schema evolution as additive 010_+ migrations — it never
-- re-creates or edits this baseline table.
--
-- Tenant table: tenant_id uuid NOT NULL (no default) as leading PK column,
-- ENABLE+FORCE RLS, one default-DENY policy keyed on choros.tenant_id (T-0013 §3.1).

CREATE TABLE choros.job (
  tenant_id  uuid  NOT NULL,
  id         uuid  NOT NULL,
  topic      text  NOT NULL,
  variables  jsonb NOT NULL,
  state      text  NOT NULL CHECK (state IN ('CREATED', 'LOCKED', 'COMPLETED', 'FAILED')),
  retries    integer NOT NULL,
  lock_owner text   NULL,
  lock_expiry bigint NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE choros.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.job FORCE ROW LEVEL SECURITY;

-- Default-DENY: with no permissive policy, no row is visible/modifiable. The one
-- permissive policy grants access only inside a tenant context (the GUC). When
-- the GUC is unset, current_setting(...,true) is NULL ⇒ the predicate is never
-- true ⇒ zero rows (AC-6).
CREATE POLICY job_tenant_isolation ON choros.job
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.job TO choros_app;
