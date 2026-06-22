-- 091 · Corrective: fix role_assignment …090 org_scope to a valid org ScopeElement
--       (T-0412 / FF-16 fitness:db unblock) — ADDITIVE, IDEMPOTENT, immutability-safe.
--
-- WHY:
--   Migration 090 (agent-dispatch keystone seed) seeded role_assignment
--   f0000000-0000-0000-0000-000000000090 (a-triage agent → role-intake-agent) with
--   org_scope = '{}'::jsonb. An empty object is NOT a grant-lattice ScopeElement: it
--   has no `kind` field, so ci/checks/db/role-assignment-scope.test.ts (AC-21 / FF-16)
--   fails — "org_scope is not a valid org ScopeElement: {}". This fails the dev CI
--   `db` job, which skips deploy-acceptance → NOTHING auto-deploys.
--
--   FF-16 requires EVERY seeded role_assignment.org_scope to parse as the EXISTING
--   src/core/grant-lattice.ts `ScopeElement`: a node (hierarchy='org', nodeLevel ∈
--   {department, position}) or a set of such nodes. The '{}' comment in 090 ("tenant-
--   root scope, same shape as other dev assignments") was mistaken — every other
--   seeded dev assignment (020, 026, 044, 059, 062, 084, 088) uses an explicit org
--   node, NOT '{}'.
--
-- FIX:
--   Set org_scope to the canonical fin department org node
--   (b0000000-0000-0000-0000-000000000001, nodeLevel='department') — the SAME scope
--   used by every other seeded dev agent assignment: config-agent (044),
--   implementation-agent (059), docs-author (062), and the ТЭЛ initiator/approver
--   (084). The fin department node is a real seeded org node (014_department.sql), so
--   the scope references an existing lattice node. This is the appropriate, minimal,
--   consistent scope for the dormant a-triage agent's keystone role assignment.
--
-- WHY A NEW MIGRATION (not an edit of 090):
--   090 is already recorded in schema_migrations on the live server AND in CI's fresh
--   migrate; the runner SKIPS already-recorded versions, so editing 090 in place would
--   NOT re-run on the live DB and would violate applied-migration immutability. A
--   corrective UPDATE in a new file fixes BOTH a fresh CI DB (091 runs right after 090
--   seeds the row) AND the live server DB (091 is pending → applied on next migrate).
--
-- IDEMPOTENT: a plain UPDATE on a single PK row; re-applying it is a no-op once the
--   value is set. Targets exactly one row by id; touches nothing else.
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- ra a-triage→intake = f0000000-0000-0000-0000-000000000090
-- fin dept node      = b0000000-0000-0000-0000-000000000001 (014_department.sql)

UPDATE choros.role_assignment
SET org_scope = '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
    updated_at = updated_at
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND id        = 'f0000000-0000-0000-0000-000000000090';
