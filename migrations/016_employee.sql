-- 016 · employee (T-0017 E3.1) — polymorphic executor table.
--
-- kind ∈ {human, agent}. No separate human/agent tables (FR-4, ADR §1.2).
-- service workers (s-ledger, s-ocr) map to kind='agent' (two-value constraint).
-- position_id is nullable (agents may not be assigned a position yet).
-- FK includes tenant_id on both sides (NF-2).
-- slug = Keycloak preferred_username for humans (T-0054 identity chain).
--
-- After this migration is applied, GET /api/org MUST read from real tables.
--
-- Dev silo seed: 7 human + 5 agent = 12 employees. Stable slugs, idempotent.

CREATE TABLE choros.employee (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL,
  position_id  uuid NULL,
  kind         text NOT NULL CHECK (kind IN ('human', 'agent')),
  slug         text NOT NULL,
  display_name text NOT NULL,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, position_id)
    REFERENCES choros.position(tenant_id, id)
);

ALTER TABLE choros.employee ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.employee FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_tenant_isolation ON choros.employee
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.employee TO choros_app;

-- Dev silo seed — 12 employees (7 human + 5 agent). Stable slugs, idempotent.
-- Slugs are the idempotency key via UNIQUE (tenant_id, slug).
-- UUIDs for employees use prefix d0000000 with sequential suffixes.
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- positions: fin-ctrl=c0000000-...-0001, fin-appr=c0000000-...-0002, fin-cfo=c0000000-...-0003
--            cs-l1=c0000000-...-0004, cs-l2=c0000000-...-0005
--            plat-int=c0000000-...-0006, plat-svc=c0000000-...-0007
INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  -- fin department
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'human', 'e-kravtsova', 'А. Кравцова',  0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'agent', 'a-recon',     'Сверка-агент', 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002', 'agent', 'a-invoice',   'Счёт-агент',   0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000002', 'human', 'e-mironov',   'Д. Миронов',   0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000003', 'human', 'e-larina',    'Е. Ларина',    0, 0),
  -- cs department
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000004', 'agent', 'a-triage',    'Триаж-агент',  0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000004', 'human', 'e-orlov',     'К. Орлов',     0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000004', 'human', 'e-savina',    'Н. Савина',    0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000005', 'human', 'e-petrov',    'И. Петров',    0, 0),
  -- plat department
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000010', 'c0000000-0000-0000-0000-000000000006', 'human', 'e-belov',     'С. Белов',     0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000011', 'c0000000-0000-0000-0000-000000000007', 'agent', 's-ledger',    'ledger-sync',  0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000012', 'c0000000-0000-0000-0000-000000000007', 'agent', 's-ocr',       'ocr-gateway',  0, 0)
ON CONFLICT DO NOTHING;
