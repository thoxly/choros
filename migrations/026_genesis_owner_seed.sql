-- 026 · genesis owner seed (T-0029 E3.3) — bootstrap the genesis tenant-owner
-- into a real, fully-capable mgmt-admin.
--
-- ADDITIVE & IDEMPOTENT: INSERT-only into the EXISTING employee / "grant" /
-- role_assignment tables — NO DDL, NO new table (AC-16 vacuous; mgmt-grants ride
-- the already-registered `grant` table). Numbered ≥ 026 (022 = T-0034, 023–025 =
-- T-0062 reserved in flight) — no edit to any prior migration (AC-17). Stable
-- UUIDs + ON CONFLICT DO NOTHING ⇒ re-running yields identical row counts (AC-12).
--
-- "ADMIN IS NOT A SUBSYSTEM" (FR-1): administration is the pattern *hold a
-- delegable grant on `mgmt_object:X`*. This seed makes the already-seeded but
-- grant-less `tenant-owner` role (slug 'tenant-owner', e0000000-…-0001, migration
-- 019) the un-parented root of the delegation lattice (FR-4/FR-5).
--
-- THE FOREST-ROOT SEAM (ADR §3): the dev org is a 3-ROOT forest — fin / cs / plat
-- all have parent_id NULL (migration 014); there is NO single org node above them.
-- Synthesizing a super-root would EDIT migration 014's seeds (violates additive-
-- only, AC-17). Instead the owner's mgmt-grant scope and the genesis assignment's
-- org_scope are an org-`set` over the three roots:
--   {kind:set, members:[node(fin), node(cs), node(plat)]}
-- The lattice already supports scope-sets (NF-2, no new algebra); a child grant
-- within any one subtree is ⊑ the set (isNarrowerOrEqual returns true when the
-- child fits SOME member).
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- department fin  = b0000000-0000-0000-0000-000000000001
-- department cs   = b0000000-0000-0000-0000-000000000002
-- department plat = b0000000-0000-0000-0000-000000000003
-- role tenant-owner = e0000000-0000-0000-0000-000000000001 (migration 019)
-- genesis employee  = d0000000-0000-0000-0000-0000000000ff (e-owner, NEW here)
-- genesis assignment= f0000000-0000-0000-0000-0000000000ff (NEW here)
-- mgmt-grant UUIDs use prefix e1000000 with sequential suffixes.

-- ---------------------------------------------------------------------------
-- 1. Genesis-owner employee (e-owner) — the human the owner role is assigned to.
--    kind 'human', position_id NULL (the owner is not slotted into a position).
-- ---------------------------------------------------------------------------
INSERT INTO choros.employee
  (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-0000000000ff',
   NULL, 'human', 'e-owner', 'Владелец (genesis)', 0, 0)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 16 delegable mgmt-grants on the tenant-owner role: the four
--    mgmt_object:{role,agent,process,grant} kinds × {create,read,update,delete},
--    plus an `invoke` grant on mgmt_object:agent (the E5.1 hiring/invoke shape).
--    All delegable = true; scope = org-set over the 3-root forest.
--    grant.role_id → tenant-owner; granted_by 'seed'.
-- ---------------------------------------------------------------------------
INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  -- mgmt_object:role × CRUD
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:role',    NULL, 'create', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:role',    NULL, 'read',   '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:role',    NULL, 'update', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:role',    NULL, 'delete', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  -- mgmt_object:agent × CRUD
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:agent',   NULL, 'create', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:agent',   NULL, 'read',   '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:agent',   NULL, 'update', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:agent',   NULL, 'delete', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  -- mgmt_object:process × CRUD
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:process', NULL, 'create', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:process', NULL, 'read',   '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:process', NULL, 'update', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000c', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:process', NULL, 'delete', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  -- mgmt_object:grant (the rights-on-rights object) × CRUD
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000d', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:grant',   NULL, 'create', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000e', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:grant',   NULL, 'read',   '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:grant',   NULL, 'update', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:grant',   NULL, 'delete', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0),
  -- mgmt_object:agent × invoke (E5.1 hiring/invoke shape)
  ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000001', 'mgmt_object:agent',   NULL, 'invoke', '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb, NULL, true, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. One confirmed genesis assignment binding e-owner → tenant-owner, with
--    org_scope = the 3-root org-set (the admin/org ceiling). confirmed_by set
--    ⇒ effective (T-0022 contract); source 'genesis'; proposed_by NULL (direct).
-- ---------------------------------------------------------------------------
INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until, source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-0000000000ff',
   'd0000000-0000-0000-0000-0000000000ff',
   'e0000000-0000-0000-0000-000000000001',
   '{"kind":"set","members":[{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000002","nodeLevel":"department"},{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000003","nodeLevel":"department"}]}'::jsonb,
   NULL, NULL, 'genesis', 'seed', NULL, 'seed', 0, 0)
ON CONFLICT DO NOTHING;
