-- 088 · Configurator authoring_draft grant seed (T-0367, E17 follow-up)
--
-- CONTEXT:
--   The E17 «Ассистент» chat (T-0361 / T-0363) correctly classifies configurator
--   intent and fail-closes when the user lacks the `authoring_draft` grant:
--   «У вас недостаточно прав для настройки системы (требуется грант authoring_draft)».
--   However, NO deployed persona holds a CONFIRMED authoring_draft grant in the live DB:
--     (a) config-agent grants (migration 044) are inserted WITHOUT confirmed_by → NULL,
--         so `getGrantsForSubject` (grants-dao.ts:145 "confirmed_by IS NOT NULL") returns
--         [] for config-agent → grant check always fails.
--     (b) The `assistant-agent` employee (the E17 agent slug in assistant.ts:604) does
--         NOT exist in the employee table at all → getGrantsForSubject returns [] → the
--         intersection (agent ∩ user) is always empty.
--   The configurator draft-write SQL (registry_def.record_schema jsonb_set, etc.) has
--   unit-test coverage but has NEVER been live-exercised because both sides of the
--   intersection are empty. This migration seeds the minimal DB state to enable a live
--   round-trip test on the deployed :3000 instance.
--
-- WHAT THIS MIGRATION ADDS (pure INSERT / UPDATE, zero DDL, zero new tables):
--   A. role row: role-configurator (e0...0008) — human configurators.
--
--   B. employee rows:
--      - e-configurator (d0...0016, kind='human') — test persona to log in as.
--      - assistant-agent (d0...0017, kind='agent') — the E17 assistant-agent slug
--        that assistant.ts:604 uses as agentSlug (default "assistant-agent"). Without
--        this row, getGrantsForSubject returns [] for the agent side → intersection
--        is always empty regardless of user grants.
--
--   C. role_assignment rows (CONFIRMED: confirmed_by='seed', unbounded window):
--      - e-configurator → role-configurator (f0...0007)
--      - assistant-agent → role-configurator (f0...0008)
--
--   D. grant rows (confirmed_by='seed'): authoring_draft create + update for
--      role-configurator (e2...001a, e2...001b). DRAFT-ONLY — ZERO grants with
--      resource_type='authoring_published'. The promote gate remains human-only.
--
-- PERSONA CHOICE — role-configurator / e-configurator:
--   A dedicated human persona (e-configurator) + dedicated role (role-configurator)
--   mirrors the established agent-employee seed pattern (044/059/062) while keeping
--   the configurator test persona cleanly separated from ТЭЛ workflow personas
--   (e-orlov, e-larina). The assistant-agent is co-assigned to role-configurator
--   so the intersection (agent ∩ user) includes authoring_draft on both sides.
--   In production, role-configurator can be reassigned to real admin employees via
--   the role_assignment mechanism without changing grant rows.
--
-- IDEMPOTENT:
--   All INSERTs use ON CONFLICT DO NOTHING on their respective PK / UNIQUE keys.
--   Re-applying is always a safe no-op.
--
-- UUID NAMESPACE DISCIPLINE (no collisions with existing migrations):
--   role-configurator       = e0000000-0000-0000-0000-000000000008  (after e0...0007 from 084)
--   e-configurator (emp)    = d0000000-0000-0000-0000-000000000016  (after d0...0015 from 062)
--   assistant-agent (emp)   = d0000000-0000-0000-0000-000000000017  (after d0...0016)
--   ra e-configurator→role  = f0000000-0000-0000-0000-000000000007  (after f0...0006 from 084)
--   ra assistant-agent→role = f0000000-0000-0000-0000-000000000008  (after f0...0007)
--   grant authoring_draft/create = e2000000-0000-0000-0000-00000000001a  (after e2...0019 from 060)
--   grant authoring_draft/update = e2000000-0000-0000-0000-00000000001b  (after e2...001a)
--
-- DEV_TENANT_UUID     = a0000000-0000-0000-0000-000000000001
-- ORG_SCOPE_NODE      = b0000000-0000-0000-0000-000000000001  (fin dept, same as 044/084)
-- BUDGET_POLICY_ID    = b0000000-0000-0000-0000-000000000001  (existing instance_budget, mig 034)

-- ============================================================
-- A. role — role-configurator
-- ============================================================

INSERT INTO choros.role
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000008',
    'role-configurator',
    'Конфигуратор системы',
    'E17 configurator role — authoring_draft only; grants human access to AI-driven ' ||
    'draft authoring (add/update fields, forms, bindings, DMN tables). DRAFT-ONLY: ' ||
    'zero authoring_published grants (promote remains human-gated).',
    0, 0
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- B. employee rows
-- ============================================================

-- B1. e-configurator — test human persona for the configurator role
INSERT INTO choros.employee
  (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000016',
    NULL,
    'human',
    'e-configurator',
    'Администратор-конфигуратор',
    0, 0
  )
ON CONFLICT DO NOTHING;

-- B2. assistant-agent — the E17 AI-assistant agent employee.
--     assistant.ts:604 uses slug "assistant-agent" as the default agentSlug.
--     Without this row, getGrantsForSubject returns [] for the agent side of the
--     intersection, making hasAuthoringDraftGrant always return false.
--     kind='agent', position_id=NULL (mirrors config-agent-seed pattern, mig 044).
INSERT INTO choros.employee
  (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000017',
    NULL,
    'agent',
    'assistant-agent',
    'Ассистент (AI-агент E17)',
    0, 0
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- C. role_assignment rows (CONFIRMED: confirmed_by='seed')
--    org_scope: fin dept node (b0...001) — matches 044 / 084 pattern.
--    confirmed_by IS NOT NULL → CONFIRMED; getRoleSlugsForActor + getGrantsForSubject
--    both filter confirmed_by IS NOT NULL.
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   valid_from, valid_until, source, granted_by, proposed_by, confirmed_by,
   created_at, updated_at)
VALUES
  -- C1. e-configurator → role-configurator
  (
    'a0000000-0000-0000-0000-000000000001',
    'f0000000-0000-0000-0000-000000000007',
    'd0000000-0000-0000-0000-000000000016',
    'e0000000-0000-0000-0000-000000000008',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, NULL, 'seed', 'seed', NULL, 'seed', 0, 0
  ),
  -- C2. assistant-agent → role-configurator
  (
    'a0000000-0000-0000-0000-000000000001',
    'f0000000-0000-0000-0000-000000000008',
    'd0000000-0000-0000-0000-000000000017',
    'e0000000-0000-0000-0000-000000000008',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, NULL, 'seed', 'seed', NULL, 'seed', 0, 0
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- D. grant rows — authoring_draft create + update for role-configurator
--    confirmed_by='seed' (NOT NULL → returned by getGrantsForSubject DAO).
--    delegable=false (structural DRAFT-boundary, mirrors 044).
--    DRAFT-ONLY: resource_type='authoring_draft' ONLY.
--    ZERO grants with resource_type='authoring_published'.
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, proposed_by, confirmed_by,
   valid_from, valid_until, created_at)
VALUES
  -- D1. authoring_draft / create
  (
    'a0000000-0000-0000-0000-000000000001',
    'e2000000-0000-0000-0000-00000000001a',
    'e0000000-0000-0000-0000-000000000008',
    'authoring_draft', NULL, 'create',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, false, 'seed', NULL, 'seed',
    NULL, NULL, 0
  ),
  -- D2. authoring_draft / update
  (
    'a0000000-0000-0000-0000-000000000001',
    'e2000000-0000-0000-0000-00000000001b',
    'e0000000-0000-0000-0000-000000000008',
    'authoring_draft', NULL, 'update',
    '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    NULL, false, 'seed', NULL, 'seed',
    NULL, NULL, 0
  )
ON CONFLICT DO NOTHING;
