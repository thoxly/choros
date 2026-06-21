-- 084 · TEL approver+initiator role seed + confirmed assignments (T-0362 E15-gap fix)
--
-- CONTEXT:
--   Migration 077 attempted to seed role-initiator (UUID ...0003) and role-approver
--   (UUID ...0004) but those UUIDs were already occupied by config-agent and
--   implementation-agent respectively. The INSERT ON CONFLICT DO NOTHING silently
--   skipped both rows. As a result the deployed DB has no role-initiator or
--   role-approver rows, and no role_assignment binding the canonical ТЭЛ employees
--   to those roles. This means resolveRolesForActor returns [] for e-larina (the
--   ТЭЛ approver persona) → inbox claim/approve gates throw 403 NOT_ELIGIBLE.
--
-- WHAT THIS MIGRATION ADDS (pure INSERT, zero DDL, zero new tables):
--   A. Two missing role rows with non-colliding UUIDs (suffix 0006/0007):
--      - role-initiator  id=e0000000-0000-0000-0000-000000000006
--      - role-approver   id=e0000000-0000-0000-0000-000000000007
--
--   B. Two CONFIRMED role_assignment rows:
--      - e-orlov  (d0000000-...-0007) → role-initiator  (U1/U2 ТЭЛ pool)
--      - e-larina (d0000000-...-0005) → role-approver   (U4 ТЭЛ pool)
--      org_scope: fin department node (b0000000-...-0001) — unbounded window.
--      confirmed_by='seed' satisfies the confirmed_by IS NOT NULL filter in
--      getRoleSlugsForActor (grants-dao.ts line 226).
--
-- SoD INVARIANT: role-initiator ≠ role-approver; e-orlov and e-larina are
-- different employees. Dual-control SoD (preparer≠approver) is preserved.
-- This seed does NOT assign any human to both roles simultaneously.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING on PK (tenant_id, id) and on the UNIQUE
-- (tenant_id, slug) index of choros.role. Safe to re-apply.
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- role-initiator  = e0000000-0000-0000-0000-000000000006
-- role-approver   = e0000000-0000-0000-0000-000000000007
-- e-orlov         = d0000000-0000-0000-0000-000000000007
-- e-larina        = d0000000-0000-0000-0000-000000000005
-- fin dept        = b0000000-0000-0000-0000-000000000001
-- ra e-orlov→ini  = f0000000-0000-0000-0000-000000000005
-- ra e-larina→apr = f0000000-0000-0000-0000-000000000006

-- A. Seed the two missing role rows (new non-colliding UUIDs).
INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000006',
    'role-initiator',
    'Инициатор заявки',
    'ТЭЛ-linear pool — U1/U2 «Подача заявки»: employees who may initiate purchase requests',
    0, 0
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000007',
    'role-approver',
    'Согласующий',
    'ТЭЛ-linear pool — U4 «Согласование»: employees with budget-approval authority',
    0, 0
  )
ON CONFLICT DO NOTHING;

-- B. Seed CONFIRMED role_assignment rows binding ТЭЛ employees to these roles.
-- confirmed_by IS NOT NULL → CONFIRMED; getRoleSlugsForActor filter passes.
-- valid_from/valid_until NULL → unbounded (effective forever).
INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   valid_from, valid_until, source, granted_by, proposed_by, confirmed_by,
   created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'f0000000-0000-0000-0000-000000000005',
    'd0000000-0000-0000-0000-000000000007',
    'e0000000-0000-0000-0000-000000000006',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, NULL, 'seed', 'seed', NULL, 'seed', 0, 0
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'f0000000-0000-0000-0000-000000000006',
    'd0000000-0000-0000-0000-000000000005',
    'e0000000-0000-0000-0000-000000000007',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, NULL, 'seed', 'seed', NULL, 'seed', 0, 0
  )
ON CONFLICT DO NOTHING;
