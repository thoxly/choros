-- 059 · implementation-agent seed (T-0207 · B-1) — governance apparatus for the
-- implementation-agent as a first-class employee (ADR T-0129 §3, §14 B-1).
--
-- Design discipline (mirrors migration 044 byte-pattern):
--   - PURE DATA SEED: no CREATE TABLE, no DDL beyond INSERTs. known_tenant_tables.txt
--     is NOT changed (NF-1 / AC-14 / grant-trail-no-new-table).
--   - IDEMPOTENT: every INSERT uses ON CONFLICT DO NOTHING (AC-09 / Check-3).
--   - FK ORDER: steps 1..6 ordered by FK dependency (role → employee → agent_card
--     → role_assignment → mcp_tool → grant).
--   - DRAFT-BOUNDARY: ZERO grants on resource_type='authoring_published' (AC-03 / FF-2).
--   - resource_ops camelCase form byte-for-byte identical to migration 040 seed
--     (ADR §2.1): {"resourceType":"authoring_draft","operation":"<op>"} and
--     {"resourceType":"implementation_op","operation":"<op>"}.
--   - CHECK mcp_tool_pure_empty_chk satisfied: declares='[]' AND pure_compute=true.
--   - ADDITIVE: migration 044 (config-agent) is NOT touched (ADR §3 — отдельная роль).
--
-- Dev-tenant constants (mirrors 044 namespace discipline):
--   DEV_TENANT_UUID       = a0000000-0000-0000-0000-000000000001
--   ROLE_IMPL_AGENT       = e0000000-0000-0000-0000-000000000004  (e0 namespace, next after e0...003)
--   EMPLOYEE_ID           = d0000000-0000-0000-0000-000000000014  (d0 namespace, next after d0...013)
--   BUDGET_POLICY_ID      = b0000000-0000-0000-0000-000000000001  (existing instance_budget, migration 034)
--   ORG_SCOPE_NODE        = b0000000-0000-0000-0000-000000000001  (fin dept root, migration 026)
--   ASSIGNMENT_UUID       = f0000000-0000-0000-0000-000000000003  (f0 namespace, next after f0...002)
--
--   NEW mcp_tool UUIDs    = 10000000-0000-0000-0000-00000000000c .. 000000000011
--     (after 10...00b from 044/053; 6 tools: assemble_bundle + 5 implementation_op)
--
--   GRANT UUIDs           = e2000000-0000-0000-0000-00000000000a .. 000000000015
--     (after e2...009 from 044/053; 12 grants: 7 authoring_draft inherited + 5 implementation_op)
--
-- Tools registered (ADR §4 / §14 B-1):
--   Inherited authoring_draft tools (grants point to role e0...004; mcp_tool rows already exist
--   from migration 044 — no new mcp_tool rows for these 7):
--     emit_form_code, edit_jsonschema, author_dmn, scaffold_external_worker,
--     write_object_migration, open_draft_branch, request_promote
--   New implementation_op tools (new mcp_tool rows in this migration):
--     assemble_bundle          — assembles coherent draft bundle (authoring_draft)
--     ask_interview_question   — raise discrepancy question / record claim (implementation_op)
--     propose_scenarios        — generate simulation scenarios (implementation_op)
--     run_simulation           — run mode-1 route-calculation (implementation_op)
--     propose_pilot_scope      — propose scoped pilot rollout (implementation_op)
--
-- Structural DRAFT-boundary (ADR §4 / AC-03):
--   implementation-agent role receives ZERO grants with resource_type='authoring_published'.
--   Promote is physically unreachable — not a policy flag, a structural absence of grant.
--   FF implementation-agent-seed.sh Check-4 machines this invariant.

-- ============================================================
-- Step 1. role — implementation-agent
-- ============================================================

INSERT INTO choros.role
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000004',
   'implementation-agent',
   'Implementation Agent',
   'System implementation-agent role — authoring_draft + implementation_op boundary only (T-0207 B-1 / ADR T-0129 §3)',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 2. employee — seed implementation-agent (kind='agent', position_id=NULL)
-- ============================================================

INSERT INTO choros.employee
  (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000014',
   NULL, 'agent', 'implementation-agent-seed', 'Агент-внедренец (seed)',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 3. agent_card — employee_id=d0...014, kc_client_id='agent-implementation',
--          budget_policy_id=b0...001 (existing instance_budget, migration 034),
--          LLM fields NULL (dormant — B-1 seed only, runtime activated in later increments)
-- ============================================================

INSERT INTO choros.agent_card
  (tenant_id, employee_id, employee_kind, kc_client_id,
   llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
   budget_policy_id, escalation_rule_id, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000014',
   'agent', 'agent-implementation',
   NULL, NULL, NULL, NULL,
   'b0000000-0000-0000-0000-000000000001', NULL,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 4. role_assignment — implementation-agent (e0...004) → d0...014
--          org_scope = fin dept node (b0...001, nodeLevel=department, ADR §5)
--          confirmed_by NOT NULL = CONFIRMED (migration 020 contract: NULL = proposal → zero grants)
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   valid_from, valid_until, source, granted_by, proposed_by, confirmed_by,
   created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000003',
   'd0000000-0000-0000-0000-000000000014',
   'e0000000-0000-0000-0000-000000000004',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, NULL, 'seed', 'seed', NULL, 'seed',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 5. mcp_tool — 6 NEW tool rows for implementation-agent
--          (7 authoring_draft tools already exist from migration 044 mcp_tool rows;
--           implementation-agent inherits them via grant rows in step 6 — no new rows needed)
--          declares='[]', pure_compute=true (satisfies mcp_tool_pure_empty_chk)
--          resource_ops camelCase byte-for-byte identical to migration 040 form
--          PK UUIDs: 10000000-0000-0000-0000-00000000000c .. 000000000011
-- ============================================================

INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  -- assemble_bundle: assembles coherent draft bundle (authoring_draft create)
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000c',
   'assemble_bundle',
   'Assemble coherent draft bundle (BPMN + forms + statuses + roles + grants) in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb,
   0, 0),
  -- ask_interview_question: raise discrepancy / record interview claim (implementation_op create)
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000d',
   'ask_interview_question',
   'Raise interview discrepancy question or record resolved claim against org-structure (implementation_op)',
   '[]'::jsonb, true,
   '[{"resourceType":"implementation_op","operation":"create"}]'::jsonb,
   0, 0),
  -- propose_scenarios: generate simulation scenario set (implementation_op create)
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000e',
   'propose_scenarios',
   'Generate simulation scenarios for bundle run (implementation_op)',
   '[]'::jsonb, true,
   '[{"resourceType":"implementation_op","operation":"create"}]'::jsonb,
   0, 0),
  -- run_simulation: mode-1 deterministic route calculation (implementation_op create)
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000f',
   'run_simulation',
   'Run mode-1 deterministic route-calculation over draft bundle (implementation_op)',
   '[]'::jsonb, true,
   '[{"resourceType":"implementation_op","operation":"create"}]'::jsonb,
   0, 0),
  -- propose_pilot_scope: propose scoped pilot rollout (implementation_op create)
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000010',
   'propose_pilot_scope',
   'Propose scoped pilot rollout (org-node + interval + TTL) for promoted bundle (implementation_op)',
   '[]'::jsonb, true,
   '[{"resourceType":"implementation_op","operation":"create"}]'::jsonb,
   0, 0),
  -- propose_pilot_scope update variant (for revising proposed scope)
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000011',
   'update_pilot_scope',
   'Update / revise proposed pilot scope (implementation_op update)',
   '[]'::jsonb, true,
   '[{"resourceType":"implementation_op","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 6. grant — authoring_draft (inherited) + implementation_op grants
--          for role implementation-agent (e0...004)
--
--   Part A — 7 authoring_draft grants (mirrors config-agent pattern; role=e0...004)
--   resource_type='authoring_draft', operations matching the 7 inherited tools:
--     create: emit_form_code, author_dmn, scaffold_external_worker, write_object_migration,
--             open_draft_branch, assemble_bundle (new tool 10...00c)
--     update: edit_jsonschema, request_promote
--
--   Part B — 5 implementation_op grants (new tools 10...00d..011)
--     create: ask_interview_question, propose_scenarios, run_simulation, propose_pilot_scope
--     update: update_pilot_scope
--
--   ZERO grants on resource_type='authoring_published' (ADR §4 / AC-03 / DRAFT-boundary)
--
--   scope = fin dept org node (b0...001, same as role_assignment org_scope)
--   delegable=false (structural DRAFT-boundary)
--   PK UUIDs: e2000000-0000-0000-0000-00000000000a .. 000000000015
--              (12 total: 7 authoring_draft + 5 implementation_op)
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  -- Part A: 7 authoring_draft grants for implementation-agent role (e0...004) ----------
  -- grant-1: authoring_draft create (emit_form_code / author_dmn / scaffold_external_worker etc.)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-00000000000a',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-2: authoring_draft update (edit_jsonschema)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-00000000000b',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-3: authoring_draft create (author_dmn)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-00000000000c',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-4: authoring_draft create (scaffold_external_worker)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-00000000000d',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-5: authoring_draft create (write_object_migration)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-00000000000e',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-6: authoring_draft create (open_draft_branch / assemble_bundle)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-00000000000f',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-7: authoring_draft update (request_promote)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000010',
   'e0000000-0000-0000-0000-000000000004',
   'authoring_draft', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- Part B: 5 implementation_op grants for implementation-agent role (e0...004) --------
  -- grant-8: implementation_op create (ask_interview_question)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000011',
   'e0000000-0000-0000-0000-000000000004',
   'implementation_op', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-9: implementation_op create (propose_scenarios)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000012',
   'e0000000-0000-0000-0000-000000000004',
   'implementation_op', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-10: implementation_op create (run_simulation)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000013',
   'e0000000-0000-0000-0000-000000000004',
   'implementation_op', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-11: implementation_op create (propose_pilot_scope)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000014',
   'e0000000-0000-0000-0000-000000000004',
   'implementation_op', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  -- grant-12: implementation_op update (update_pilot_scope)
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000015',
   'e0000000-0000-0000-0000-000000000004',
   'implementation_op', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;

-- STRUCTURAL DRAFT-BOUNDARY CONFIRMED: zero rows above have resource_type='authoring_published'.
-- Fitness check ci/checks/implementation-agent-seed.sh Check-4 machines this invariant.
