-- 055 · fix demo mcp_tool tenant (T-0161) — delete the 3 dev-seed rows that
-- migration 040 placed in the wrong tenant (00000000-0000-0000-0000-000000000001
-- instead of the canonical dev-tenant a0000000-0000-0000-0000-000000000001).
--
-- Context (observation T-0077-архитектора):
--   Migration 040 seeded 3 demo mcp_tool rows (http-integration-tool,
--   slack-notify-tool, json-transform-tool) under tenant
--   00000000-0000-0000-0000-000000000001 (the genesis "bootstrap" tenant from
--   migration 026).  The canonical dev-tenant used by resolveAgentToolset,
--   migration 044 (config-agent-seed), and migration 053 (author_report_page)
--   is a0000000-0000-0000-0000-000000000001.  The 040 rows are invisible to
--   resolveAgentToolset and to all config-agent-seed DB fitness checks.
--
-- Decision: DELETE (not move).
--   The 3 rows are E5.3 demonstrator stubs (effect_resource/invoke semantics)
--   that do not match config-agent toolset semantics (authoring_draft).
--   No test, UI, or fitness check references them by UUID or name.  Moving them
--   into the dev-tenant would corrupt the AC-02 count (8 authoring_draft tools)
--   and mislead future operators about the config-agent scope.
--
-- Coordination: slot 054 is reserved by T-0128 (D1 decomposition) which has not
--   yet landed; max on-disk slot at time of writing is 053.  This migration takes
--   055, the next free slot.
--
-- Design discipline:
--   - IDEMPOTENT: DELETE … WHERE is safe to re-apply (no row = no-op).
--   - No DDL: data-mutation only (no CREATE/ALTER/DROP).
--   - Migrator role (choros_migrator) bypasses RLS — DELETE succeeds regardless
--     of choros.tenant_id session variable.
--   - The 040 migration file itself is NOT changed (freeze invariant per FF-10).

-- ============================================================
-- Step 1. Remove the 3 misplaced demo mcp_tool rows.
-- ============================================================
--   IDs: 10000000-0000-0000-0000-000000000001 (http-integration-tool)
--        10000000-0000-0000-0000-000000000002 (slack-notify-tool)
--        10000000-0000-0000-0000-000000000003 (json-transform-tool)
--   All under tenant 00000000-0000-0000-0000-000000000001.

DELETE FROM choros.mcp_tool
WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
  AND id IN (
    '10000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003'
  );
