-- 013 · tenant (T-0017 E3.1) — tenancy root table.
--
-- Every other org table has tenant_id FK → tenant(tenant_id, id).
-- The tenant row IS the tenancy root; tenant_id = id for every row.
-- RLS policy: row visible iff id = current_setting('choros.tenant_id', true)::uuid
-- (self-referential: T-0013 default-DENY pattern applied to the root table).
--
-- Dev silo seed (ON CONFLICT DO NOTHING — idempotent).

CREATE TABLE choros.tenant (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL,
  slug         text NOT NULL,
  display_name text NOT NULL,
  created_at   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (slug)
);

ALTER TABLE choros.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.tenant FORCE ROW LEVEL SECURITY;

-- tenant row is visible iff its id matches the tenant_id GUC.
-- Default-DENY: without GUC, current_setting returns NULL → predicate false → 0 rows.
CREATE POLICY tenant_isolation ON choros.tenant
  USING (id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.tenant TO choros_app;

-- Dev silo seed — stable UUID, idempotent.
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'dev',
  'Dev Silo',
  0
)
ON CONFLICT DO NOTHING;
