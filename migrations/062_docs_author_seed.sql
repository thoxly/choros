-- 062 · docs-author seed (T-0209 · P-1 · docs-pipeline) — governance apparatus for the
-- system DocsAuthorAgent as a first-class employee (ADR T-0209-docsauthor-seed.adr.md,
-- research-3-docs-pipeline.md §1.1/§8 P-1 critical path).
--
-- Design discipline:
--   - PURE DATA SEED: no CREATE TABLE, no DDL beyond INSERTs. known_tenant_tables.txt
--     is NOT changed (doc_page/doc_ref/doc_log already listed from migration 061 / T-0238).
--   - IDEMPOTENT: every INSERT uses ON CONFLICT DO NOTHING (AC-09 / Check-2).
--   - FK ORDER: steps 1..5 ordered by FK dependency (role → employee → agent_card
--     → role_assignment → grant).
--   - DRAFT-BOUNDARY: ZERO grants on operation='delete' or operation='read' for doc_page.
--     Exactly two grants: {doc_page,create} and {doc_page,update} — structural absence
--     of publish-equivalent authority (ADR §2, D060-DRAFT-boundary). delegable=false on
--     both (cannot sub-delegate write authority — mirrors 044/053/059 DRAFT-boundary).
--   - resource_type='doc_page' is a TEXT column (no DB CHECK on grant.resource_type —
--     same as 'authoring_draft' in 044). Matches isToolReachable resourceType for P-2
--     doc_page_author tool (resource_ops=[{doc_page,create},{doc_page,update}]).
--   - Promote-seam deferred: no 'published'/'status' column added (SEAM-2 / T-0134d / P-9).
--
-- Dev-tenant constants:
--   DEV_TENANT_UUID    = a0000000-0000-0000-0000-000000000001
--   ROLE_DOCS_AUTHOR   = e0000000-0000-0000-0000-000000000005  (e0 namespace, next after e0...004)
--   EMPLOYEE_ID        = d0000000-0000-0000-0000-000000000015  (d0 namespace, next after d0...014)
--   BUDGET_POLICY_ID   = b0000000-0000-0000-0000-000000000001  (existing instance_budget, migration 034)
--   ORG_SCOPE_NODE     = b0000000-0000-0000-0000-000000000001  (fin dept root, migration 026)
--   ASSIGNMENT_UUID    = f0000000-0000-0000-0000-000000000004  (f0 namespace, next after f0...003)
--   GRANT UUIDs        = e2000000-0000-0000-0000-000000000018 (create)
--                        e2000000-0000-0000-0000-000000000019 (update)
--   (grant ceiling before this migration: e2...017 from migration 060_template_def.sql)
--   mcp_tool namespace NOT consumed by P-1 (P-2 task for doc_page_author tool)

-- ============================================================
-- Step 1. role — docs-author
-- ============================================================

INSERT INTO choros.role
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000005',
   'docs-author',
   'Docs Author Agent',
   'System docs-author role — doc_page create/update boundary only (T-0209 P-1 / research-3-docs-pipeline §1.1)',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 2. employee — seed docs-author (kind='agent', position_id=NULL)
-- ============================================================

INSERT INTO choros.employee
  (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000015',
   NULL, 'agent', 'docs-author-seed', 'Агент-документатор (seed)',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 3. agent_card — employee_id=d0...015, kc_client_id='agent-docs-author',
--          budget_policy_id=b0...001 (existing instance_budget), LLM fields NULL (dormant)
--          Dormant: llm_endpoint/llm_model/llm_secret_handle/autonomy_threshold all NULL.
--          Runtime activation deferred to P-3 REGEN motor (not P-1 scope).
-- ============================================================

INSERT INTO choros.agent_card
  (tenant_id, employee_id, employee_kind, kc_client_id,
   llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
   budget_policy_id, escalation_rule_id, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000015',
   'agent', 'agent-docs-author',
   NULL, NULL, NULL, NULL,
   'b0000000-0000-0000-0000-000000000001', NULL,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 4. role_assignment — docs-author (e0...005) → d0...015
--          org_scope = fin dept node (b0...001, nodeLevel=department, ADR §5)
--          confirmed_by NOT NULL = CONFIRMED (migration 020 contract: NULL = proposal → zero grants)
-- ============================================================

INSERT INTO choros.role_assignment
  (tenant_id, id, employee_id, role_id, org_scope,
   valid_from, valid_until, source, granted_by, proposed_by, confirmed_by,
   created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000004',
   'd0000000-0000-0000-0000-000000000015',
   'e0000000-0000-0000-0000-000000000005',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, NULL, 'seed', 'seed', NULL, 'seed',
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 5. grant × 2 — doc_page {create, update} for role docs-author
--          resource_type='doc_page' (TEXT column, no DB CHECK — ADR §4 / 044 §2.2 pattern)
--          scope = fin dept org node (b0...001, same as role_assignment org_scope — AC-08)
--          delegable=false (structural DRAFT-boundary — cannot sub-delegate write authority)
--          NO 'delete' grant (AC-03 — structural absence of destructive authority)
--          NO 'read' grant (AC-05 — read is external docs-MCP surface, T-0134g, different role)
--          PK UUIDs: e2000000-0000-0000-0000-000000000018 (create), ...000000000019 (update)
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000018',
   'e0000000-0000-0000-0000-000000000005',
   'doc_page', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0),
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000019',
   'e0000000-0000-0000-0000-000000000005',
   'doc_page', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;
