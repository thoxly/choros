-- 014 · department (T-0017 E3.1) — adjacency-list org tree.
--
-- parent_id NULL → root department. Self-referential FK includes tenant_id on both
-- sides (NF-2 cross-tenant FK isolation). Cycle prevention is application-layer
-- (ancestor walk before INSERT/UPDATE parent_id) per ADR §1.1.
--
-- Dev silo seed: 3 root departments (fin, cs, plat). Stable UUIDs, idempotent.

CREATE TABLE choros.department (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL,
  parent_id    uuid NULL,
  slug         text NOT NULL,
  display_name text NOT NULL,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, parent_id)
    REFERENCES choros.department(tenant_id, id)
);

ALTER TABLE choros.department ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.department FORCE ROW LEVEL SECURITY;

CREATE POLICY department_tenant_isolation ON choros.department
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.department TO choros_app;

-- Dev silo seed — fin, cs, plat. Stable UUIDs, idempotent.
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- fin  = b0000000-0000-0000-0000-000000000001
-- cs   = b0000000-0000-0000-0000-000000000002
-- plat = b0000000-0000-0000-0000-000000000003
INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', NULL, 'fin',  'Финансы',          0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', NULL, 'cs',   'Клиентский сервис', 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', NULL, 'plat', 'Платформа',         0, 0)
ON CONFLICT DO NOTHING;
