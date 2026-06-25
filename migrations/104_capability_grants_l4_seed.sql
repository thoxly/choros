-- 104 · Capability grants for agents/keys authorization (T-0475, E-AGENTS L4)
--
-- Spec: docs/specs/agent-registry-and-llm-keys.spec.md §6.
--
-- THE L4 AUTHORIZATION SEED. Two new CAPABILITY grants (spec §6):
--   (A) llm_connection:configure — author/edit an LLM connection + key. Held by
--       the genesis owner (short-circuit in code) OR an explicit grantee. This
--       migration grants it to role-configurator on the dev/seed tenant so a
--       NON-owner configurator (e-configurator, migration 088) can configure
--       connections — and so the live acceptance test ("holder CAN configure,
--       plain member CANNOT") has a real grant to resolve.
--   (B) system_agent:operate — configure/run a SYSTEM agent (configurator /
--       docs-author / implementation). Spec §6 ties it to authoring_draft
--       (T-0462): an authoring_draft holder operates system agents BY
--       CONSTRUCTION (canOperateSystemAgent accepts either). We seed the explicit
--       grant too so the capability exists in the lattice independently of the
--       authoring_draft tie (a future role may hold system_agent:operate WITHOUT
--       authoring_draft).
--
-- WHY role-configurator (dev tenant): it is the admin role that already holds the
-- authoring_draft grants (migration 088), assigned to e-configurator AND (via
-- 088 C2) the assistant-agent. Granting the two capabilities here keeps the
-- configurator role the single "platform-admin" role on the dev tenant. The
-- genesis owner does NOT need these rows (the code owner-short-circuit covers it),
-- but on the dev tenant the owner is NOT assigned role-configurator, so the
-- NON-owner e-configurator is the testable holder.
--
-- CAPABILITY, NOT mgmt_object (spec §2 decision 2 / §6): these are NOT delegable
-- scoped-admin (org-place) grants. resource_type carries the capability token
-- verbatim (choros."grant".resource_type is free text — no DB CHECK, migration
-- 008). delegable=false (a capability, not an admin-delegation root). scope is the
-- fin-dept node ⊥-equivalent used by the other role-configurator grants (088 D1/D2)
-- so getGrantsForSubject returns them for e-configurator unchanged.
--
-- The new-tenant path (register.ts, T-0475) seeds the SAME two grants on the
-- per-tenant role-configurator so self-registered tenants get them too.
--
-- ADDITIVE / IDEMPOTENT / APPEND-ONLY:
--   * Next free slot after 103. No DDL, no new table — pure INSERT (defer-no-new-
--     table / new-relation guards untripped).
--   * ON CONFLICT DO NOTHING on the grant PK (tenant_id, id) → safe re-run.
--   * confirmed_by='seed' (NOT NULL) so getGrantsForSubject (confirmed_by IS NOT
--     NULL) returns them.
--
-- UUID NAMESPACE DISCIPLINE (no collisions with existing migrations):
--   grant llm_connection:configure = e2000000-0000-0000-0000-00000000001c  (after e2...001b from 088)
--   grant system_agent:operate     = e2000000-0000-0000-0000-00000000001d  (after e2...001c)
--
-- DEV_TENANT_UUID    = a0000000-0000-0000-0000-000000000001
-- role-configurator  = e0000000-0000-0000-0000-000000000008  (migration 088 A)
-- ORG_SCOPE_NODE     = b0000000-0000-0000-0000-000000000001  (fin dept, same as 088 D1/D2)

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, proposed_by, confirmed_by,
   valid_from, valid_until, created_at)
VALUES
  -- A. llm_connection:configure for role-configurator (CONFIRMED).
  (
    'a0000000-0000-0000-0000-000000000001',
    'e2000000-0000-0000-0000-00000000001c',
    'e0000000-0000-0000-0000-000000000008',
    'llm_connection:configure', NULL, 'configure',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, false, 'seed', NULL, 'seed',
    NULL, NULL, 0
  ),
  -- B. system_agent:operate for role-configurator (CONFIRMED).
  (
    'a0000000-0000-0000-0000-000000000001',
    'e2000000-0000-0000-0000-00000000001d',
    'e0000000-0000-0000-0000-000000000008',
    'system_agent:operate', NULL, 'operate',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, false, 'seed', NULL, 'seed',
    NULL, NULL, 0
  )
ON CONFLICT DO NOTHING;
