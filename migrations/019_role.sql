-- 019 · role (T-0022 E3.2) — the first-class principal grants attach to.
--
-- T-0018: grants NEVER attach to a person/agent directly — humans and agents
-- reach grants only through role assignments. `role` is that principal: the
-- named, cross-cutting capability bundle. It is a T-0013 tenant table.
--
-- A role is CROSS-CUTTING: it is NOT bound to a department or position at the
-- role level — scoping happens at assignment time via role_assignment.org_scope
-- (FR-1). A "budget approver" role can be assigned within fin, cs, or any subtree.
--
-- role.id is FROZEN (NF-4): referenced as a live FK by grant.role_id (migration
-- 021) and as a point-in-time value by actor_event.role_at_event (T-0019, NOT a
-- live FK). No re-keying after this migration.
--
-- T-0013 invariants: tenant_id NOT NULL leading PK column (no default),
-- ENABLE+FORCE RLS, default-DENY isolation policy on the choros.tenant_id GUC,
-- DML grant to the NOBYPASSRLS choros_app role.
--
-- Dev silo seed: tenant-owner genesis role (the single root admin role T-0029
-- E3.3 references) + budget-approver cross-cutting functional role. Idempotent
-- via UNIQUE (tenant_id, slug) + ON CONFLICT DO NOTHING.

CREATE TABLE choros.role (
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

ALTER TABLE choros.role ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.role FORCE ROW LEVEL SECURITY;

CREATE POLICY role_tenant_isolation ON choros.role
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.role TO choros_app;

-- Dev silo seed — 2 roles. Stable UUIDs, idempotent (slug = idempotency key).
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- role UUIDs use prefix e0000000 with sequential suffixes:
--   tenant-owner    = e0000000-0000-0000-0000-000000000001 (genesis root admin role, T-0029)
--   budget-approver = e0000000-0000-0000-0000-000000000002 (cross-cutting functional role)
INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'tenant-owner',    'Владелец тенанта',   'Genesis root admin role — full mgmt authority (T-0029 E3.3)', 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 'budget-approver', 'Согласующий бюджет', 'Cross-cutting functional role — budget approval',            0, 0)
ON CONFLICT DO NOTHING;
