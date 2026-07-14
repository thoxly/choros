-- 003 · application (T-0014 §3.1) — top of the JSONB object model.
--
-- Tenant table. Scoped uniqueness: UNIQUE (tenant_id, slug) — the same slug is
-- allowed across tenants, forbidden within one (AC-8). Never UNIQUE(slug) alone.

CREATE TABLE choros.application (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL,
  slug         text NOT NULL,
  display_name text NOT NULL,
  description  text NULL,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

ALTER TABLE choros.application ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.application FORCE ROW LEVEL SECURITY;

CREATE POLICY application_tenant_isolation ON choros.application
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.application TO choros_app;
