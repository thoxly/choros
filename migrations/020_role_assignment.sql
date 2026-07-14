-- 020 · role_assignment (T-0022 E3.2) — binds an employee to a role.
--
-- The binding that makes a role an ASSIGNABLE principal: one employee (human OR
-- agent — identically, no fork: the subject is employee.id regardless of kind)
-- to one role, within an org_scope SET of org-tree nodes, over a validity window
-- [valid_from, valid_until) (half-open), recording who proposed and who confirmed.
--
-- THE PROPOSAL/CONFIRMATION CONTRACT (FR-4, fixed here; workflow = T-0039):
--   confirmed_by IS NULL     => PROPOSAL — recorded but NOT effective; contributes
--                               ZERO grants to the resolver's getGrants result.
--   confirmed_by IS NOT NULL => CONFIRMED — eligible to contribute grants (subject
--                               to validity window + org_scope containment).
-- This is enforced at the RESOLUTION boundary (the T-0053 DB-backed getGrants
-- JOIN), NOT by a DB CHECK here — grant-resolver.ts is NOT edited (NF-6, AC-20).
--
-- org_scope (FR-3, NF-3): a grant-lattice.ts ScopeElement of hierarchy "org"
-- (a single {kind:node,hierarchy:org,nodeId:<dept|pos id>,nodeLevel:...} OR a
-- {kind:set,members:[...]} of them). NO new scope algebra — containment is the
-- EXISTING AncestryOracle over the org hierarchy. The DB enforces NOT NULL +
-- valid jsonb only; deeper structural validation (nodeId resolves, hierarchy==org)
-- is an application/write-API invariant (mirrors grant.scope jsonb, migration 008).
--
-- validity window (FR-2): valid_from/valid_until are bigint NULL (epoch-ms);
-- NULL valid_from = "since beginning of time", NULL valid_until = "no end";
-- window is [valid_from, valid_until) — half-open, matching grant-lattice.ts
-- isEffective. NO DB CHECK forbids valid_from > valid_until — window sanity is
-- application-layer (AC-10), consistent with how `grant` stores its window.
--
-- NO UNIQUE(employee_id, role_id) (FR-2): multiple assignments of the same
-- (employee, role) legitimately coexist when they differ by org_scope or window
-- (same person "approver" in fin until Q3, in cs from Q4). De-duplication is an
-- application concern, not a schema invariant — consistent with `grant`.
--
-- NF-2 no cross-tenant FK: every FK includes tenant_id on both sides
-- (tenant_id, employee_id) -> employee(tenant_id, id) and
-- (tenant_id, role_id) -> role(tenant_id, id).
--
-- Dev silo seed: 1 confirmed assignment wiring a real employee to a real role
-- within a real org department node (AC-16). Idempotent via fixed UUID PK +
-- ON CONFLICT DO NOTHING.

CREATE TABLE choros.role_assignment (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL,
  employee_id  uuid NOT NULL,
  role_id      uuid NOT NULL,
  org_scope    jsonb NOT NULL,
  valid_from   bigint NULL,
  valid_until  bigint NULL,
  source       text NOT NULL,
  granted_by   text NOT NULL,
  proposed_by  text NULL,
  confirmed_by text NULL,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)
    REFERENCES choros.employee(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES choros.role(tenant_id, id)
);

ALTER TABLE choros.role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.role_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY role_assignment_tenant_isolation ON choros.role_assignment
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.role_assignment TO choros_app;

-- Dev silo seed — 1 confirmed assignment. Stable UUID, idempotent.
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- employee e-mironov (fin-appr) = d0000000-0000-0000-0000-000000000004
-- role budget-approver          = e0000000-0000-0000-0000-000000000002
-- department fin                = b0000000-0000-0000-0000-000000000001
-- assignment UUID prefix f0000000:
--   ra-mironov-budget-fin = f0000000-0000-0000-0000-000000000001
-- org_scope = single org-node ScopeElement over the fin department subtree.
-- confirmed_by NOT NULL => CONFIRMED (effective). proposed_by NULL (created direct).
INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until, source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000004',
   'e0000000-0000-0000-0000-000000000002',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, NULL, 'manual', 'seed', NULL, 'seed', 0, 0)
ON CONFLICT DO NOTHING;
