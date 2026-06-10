-- 015 · position (T-0017 E3.1) — positions hanging off departments.
--
-- A position belongs to exactly one department (not a tree). Multiple employees
-- may hold the same position. FK includes tenant_id on both sides (NF-2).
--
-- Dev silo seed: 8 positions across 3 departments. Stable UUIDs, idempotent.

CREATE TABLE choros.position (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL,
  department_id uuid NOT NULL,
  slug          text NOT NULL,
  title         text NOT NULL,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, department_id, slug),
  FOREIGN KEY (tenant_id, department_id)
    REFERENCES choros.department(tenant_id, id)
);

ALTER TABLE choros.position ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.position FORCE ROW LEVEL SECURITY;

CREATE POLICY position_tenant_isolation ON choros.position
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.position TO choros_app;

-- Dev silo seed — 8 positions. Stable UUIDs, idempotent.
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- dept fin  = b0000000-0000-0000-0000-000000000001
-- dept cs   = b0000000-0000-0000-0000-000000000002
-- dept plat = b0000000-0000-0000-0000-000000000003
-- positions:
--   fin-ctrl = c0000000-0000-0000-0000-000000000001
--   fin-appr = c0000000-0000-0000-0000-000000000002
--   fin-cfo  = c0000000-0000-0000-0000-000000000003
--   cs-l1    = c0000000-0000-0000-0000-000000000004
--   cs-l2    = c0000000-0000-0000-0000-000000000005
--   plat-int = c0000000-0000-0000-0000-000000000006
--   plat-svc = c0000000-0000-0000-0000-000000000007
INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'fin-ctrl', 'Контролёр расчётов',     0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'fin-appr', 'Согласующий счетов',     0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'fin-cfo',  'Финансовый директор',    0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'cs-l1',    'Линия поддержки L1',     0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 'cs-l2',    'Эскалации L2',           0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000003', 'plat-int', 'Интеграции',             0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000003', 'plat-svc', 'Сервисные коннекторы',   0, 0)
ON CONFLICT DO NOTHING;
