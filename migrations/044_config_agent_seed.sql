-- 044 · config-agent seed (T-0077 · E11.6) — governance apparatus for the
-- system config-agent as a first-class employee (ADR §1, spec §0).
--
-- Design discipline:
--   - PURE DATA SEED: no CREATE TABLE, no DDL beyond INSERTs. known_tenant_tables.txt
--     is NOT changed (NF-1 / AC-14 / grant-trail-no-new-table).
--   - IDEMPOTENT: every INSERT uses ON CONFLICT DO NOTHING (AC-09 / Check-3).
--   - FK ORDER: steps 1..6 ordered by FK dependency (role → employee → agent_card
--     → role_assignment → mcp_tool → grant).
--   - DRAFT-BOUNDARY: ZERO grants on resource_type='authoring_published' (AC-05).
--   - resource_ops camelCase form byte-for-byte identical to migration 040 seed
--     (ADR §2.1): {"resourceType":"authoring_draft","operation":"<op>"}.
--   - CHECK mcp_tool_pure_empty_chk satisfied: declares='[]' AND pure_compute=true.
--
-- Dev-tenant constants:
--   DEV_TENANT_UUID  = a0000000-0000-0000-0000-000000000001
--   ROLE_CONFIG_AGENT= e0000000-0000-0000-0000-000000000003  (e0 namespace, next after e0...002)
--   EMPLOYEE_ID      = d0000000-0000-0000-0000-000000000013  (d0 namespace, next after d0...012)
--   BUDGET_POLICY_ID = b0000000-0000-0000-0000-000000000001  (existing instance_budget, migration 034)
--   ORG_SCOPE_NODE   = b0000000-0000-0000-0000-000000000001  (fin dept root, migration 026)
--   ASSIGNMENT_UUID  = f0000000-0000-0000-0000-000000000002  (f0 namespace, next after f0...001)
--   MCP_TOOL UUIDs   = 10000000-0000-0000-0000-00000000000{4..a}  (after 10...001/002/003 from 040)
--   GRANT UUIDs      = e2000000-0000-0000-0000-00000000000{1..7}

-- ============================================================
-- Step 1. role — config-agent
-- ============================================================

INSERT INTO choros.role
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000003',
   'config-agent',
   'Config Agent',
   'System config-agent role — authoring_draft boundary only (T-0077 E11.6)',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 2. employee — seed config-agent (kind='agent', position_id=NULL)
-- ============================================================

INSERT INTO choros.employee
  (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000013',
   NULL, 'agent', 'config-agent-seed', 'Config-агент (seed)',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 3. agent_card — employee_id=d0...013, kc_client_id='agent-config',
--          budget_policy_id=b0...001 (existing instance_budget), LLM fields NULL (dormant)
-- ============================================================

INSERT INTO choros.agent_card
  (tenant_id, employee_id, employee_kind, kc_client_id,
   llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
   budget_policy_id, escalation_rule_id, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000013',
   'agent', 'agent-config',
   NULL, NULL, NULL, NULL,
   'b0000000-0000-0000-0000-000000000001', NULL,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 4. role_assignment — config-agent (e0...003) → d0...013
--          org_scope = fin dept node (b0...001, nodeLevel=department, ADR §5)
--          confirmed_by NOT NULL = CONFIRMED (migration 020 contract: NULL = proposal → zero grants)
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   valid_from, valid_until, source, granted_by, proposed_by, confirmed_by,
   created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002',
   'd0000000-0000-0000-0000-000000000013',
   'e0000000-0000-0000-0000-000000000003',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, NULL, 'seed', 'seed', NULL, 'seed',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 5. mcp_tool — 7 authoring_draft tools
--          declares='[]', pure_compute=true (satisfies mcp_tool_pure_empty_chk)
--          resource_ops camelCase byte-for-byte identical to migration 040 form
--          PK UUIDs: 10000000-0000-0000-0000-000000000004 .. 00a
-- ============================================================

INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000004',
   'emit_form_code',
   'Create Floor-2 React component in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb,
   0, 0),
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000005',
   'edit_jsonschema',
   'Update JSON Schema in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"update"}]'::jsonb,
   0, 0),
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000006',
   'author_dmn',
   'Create/update DMN decision table in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb,
   0, 0),
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000007',
   'scaffold_external_worker',
   'Generate external-task worker in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb,
   0, 0),
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000008',
   'write_object_migration',
   'Create object migration in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb,
   0, 0),
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000009',
   'open_draft_branch',
   'Open draft branch for edits in authoring_draft',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb,
   0, 0),
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000a',
   'request_promote',
   'Request promote draft -> published (human-gated)',
   '[]'::jsonb, true,
   '[{"resourceType":"authoring_draft","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 6. grant — 7 authoring_draft grants for role config-agent
--          resource_type='authoring_draft' (TEXT column, no DB CHECK — ADR §2.2)
--          scope = fin dept org node (b0...001, same as role_assignment org_scope)
--          delegable=false (structural DRAFT-boundary)
--          PK UUIDs: e2000000-0000-0000-0000-00000000000{1..7}
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000002',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000003',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000004',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000005',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000006',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000007',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;
