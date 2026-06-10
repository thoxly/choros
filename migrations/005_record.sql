-- 005 · record (T-0014 §3.3) — a data row under a registry_def.
--
-- Tenant table. Composite FK is tenant_id-leading (AC-7):
--   (tenant_id, registry_id) → registry_def(tenant_id, id).
-- No business-key uniqueness (identity is (tenant_id, id)).
-- Carries data jsonb NOT NULL (the JSONB object model, AC-15).

CREATE TABLE choros.record (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL,
  registry_id uuid NOT NULL,
  data        jsonb NOT NULL,
  created_at  bigint NOT NULL,
  updated_at  bigint NOT NULL,
  created_by  text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, registry_id)
    REFERENCES choros.registry_def (tenant_id, id)
);

ALTER TABLE choros.record ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.record FORCE ROW LEVEL SECURITY;

CREATE POLICY record_tenant_isolation ON choros.record
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.record TO choros_app;
