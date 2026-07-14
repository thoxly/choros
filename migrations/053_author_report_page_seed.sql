-- 053 · author_report_page seed (T-0180 · T-0121f) — mcp_tool seed for config-agent:
--     author_report_page tool (create/update report_page in authoring_draft tier).
--
-- ADR: docs/design/T-0121-reports-pages.adr.md §6.1 (T-0121f decomposition).
-- Pattern: migration 044_config_agent_seed.sql (T-0077 §2.1-§2.3).
--
-- Design discipline (identical to migration 044 contract):
--   - PURE DATA SEED: no CREATE TABLE, no DDL beyond INSERTs. known_tenant_tables.txt
--     is NOT changed (no new table — NF-1 / AC-14 / grant-trail-no-new-table).
--   - IDEMPOTENT: every INSERT uses ON CONFLICT DO NOTHING (mirrors 044 AC-09).
--   - FK ORDER: mcp_tool INSERT before grant INSERT (grant has no FK on mcp_tool,
--     but ordering matches 044 discipline for readability).
--   - DRAFT-BOUNDARY: resource_ops and grants are STRICTLY authoring_draft.
--     ZERO resource_ops entries for authoring_published / mgmt_object:report_page/promote
--     (config-agent is DRAFT-only; human-only promote gate per ADR §6.1/§9.2).
--   - resource_ops camelCase form byte-for-byte identical to migration 040/044 seed:
--     {"resourceType":"authoring_draft","operation":"<op>"}.
--   - CHECK mcp_tool_pure_empty_chk satisfied: declares='[]' AND pure_compute=true.
--
-- Dev-tenant constants (same namespace as migration 044):
--   DEV_TENANT_UUID  = a0000000-0000-0000-0000-000000000001  (all seed rows MUST use this — T-0077 §2.3)
--   ROLE_CONFIG_AGENT= e0000000-0000-0000-0000-000000000003  (migration 044 step 1)
--   MCP_TOOL UUID    = 10000000-0000-0000-0000-00000000000b  (next after 00a used in 044)
--   GRANT UUIDs      = e2000000-0000-0000-0000-000000000008 (create)
--                      e2000000-0000-0000-0000-000000000009 (update)
--
-- WARNING (T-0077 §2.3): seed MUST target dev-tenant a0000000-0000-0000-0000-000000000001.
--   resolveAgentToolset(tenantId) is tenant-scoped under RLS — a row in any other tenant
--   is invisible to the config-agent and breaks toolset discovery silently.
--
-- Audit-vocab (frozen seam per ADR §6.1): report_page.authored, report_page.promoted,
--   report_page.demoted, report_page_dep.registered, report_page_dep.updated,
--   report_page_dep.deleted, report_page.schema_destructive_force.
--   These vocab strings are data-layer; this migration does NOT emit events.

-- ============================================================
-- Step 1. mcp_tool — author_report_page (authoring_draft create + update)
--         PK: 10000000-0000-0000-0000-00000000000b
--         resource_ops: both create and update (Floor-1 auto-dep-derive + Floor-2 manual deps)
-- ============================================================

INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-00000000000b',
   'author_report_page',
   'Create or update a report_page in authoring_draft tier. Floor-1: deps auto-derived from page_def. Floor-2: pass deps[]. Promote is human-gated (ADR T-0121 §6.1).',
   '[]'::jsonb,
   true,
   '[{"resourceType":"authoring_draft","operation":"create"},{"resourceType":"authoring_draft","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 2. grant — authoring_draft/create for role config-agent
--         PK: e2000000-0000-0000-0000-000000000008
--         Mirrors migration 044 step 6 pattern (delegable=false, scope=fin dept node)
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000008',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'create',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 3. grant — authoring_draft/update for role config-agent
--         PK: e2000000-0000-0000-0000-000000000009
-- ============================================================

INSERT INTO choros."grant"
  (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
   "constraint", delegable, granted_by, valid_from, valid_until, created_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'e2000000-0000-0000-0000-000000000009',
   'e0000000-0000-0000-0000-000000000003',
   'authoring_draft', NULL, 'update',
   '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
   NULL, false, 'seed', NULL, NULL, 0)
ON CONFLICT DO NOTHING;
