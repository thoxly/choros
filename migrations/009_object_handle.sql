-- 009 · object_handle (T-0015 §4.1) — the opaque addressing table.
--
-- Tenant table. id is the persisted opaque handle id (ObjectHandle.handleId).
-- The component UUIDs (application_id/registry_id/record_id) are denormalized
-- ResourceRef components, NOT FK-enforced (T-0015 §4.1 fixes them as nullable
-- components). NO payload/data/snapshot/view column — the handle names fields,
-- never values (T-0015 FF-1/FF-8). facet jsonb NULL (AC-15).

CREATE TABLE choros.object_handle (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL,
  ref_kind       text NOT NULL CHECK (ref_kind IN ('application', 'registry', 'record')),
  application_id uuid NULL,
  registry_id    uuid NULL,
  record_id      uuid NULL,
  facet          jsonb NULL,
  created_at     bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE choros.object_handle ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.object_handle FORCE ROW LEVEL SECURITY;

CREATE POLICY object_handle_tenant_isolation ON choros.object_handle
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.object_handle TO choros_app;
