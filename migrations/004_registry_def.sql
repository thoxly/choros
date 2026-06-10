-- 004 · registry_def (T-0014 §3.2) — a registry definition under an application.
--
-- Tenant table. Composite FK is tenant_id-leading (AC-7):
--   (tenant_id, application_id) → application(tenant_id, id).
-- Scoped uniqueness: UNIQUE (tenant_id, application_id, slug).
-- Carries record_schema jsonb NOT NULL (the JSONB object model, AC-15).

CREATE TABLE choros.registry_def (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  application_id uuid NOT NULL,
  slug           text NOT NULL,
  display_name   text NOT NULL,
  description    text NULL,
  record_schema  jsonb NOT NULL,
  is_system      boolean NOT NULL DEFAULT false,
  created_at     bigint NOT NULL,
  updated_at     bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, application_id, slug),
  FOREIGN KEY (tenant_id, application_id)
    REFERENCES choros.application (tenant_id, id)
);

ALTER TABLE choros.registry_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.registry_def FORCE ROW LEVEL SECURITY;

CREATE POLICY registry_def_tenant_isolation ON choros.registry_def
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.registry_def TO choros_app;
