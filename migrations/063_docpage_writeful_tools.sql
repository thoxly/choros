-- 063 · docpage writeful tools (T-0210 · P-2 · docs-pipeline) — mcp_tool seed for
-- the two internal writeful doc tools: doc_page_author and doc_ref_set.
--
-- Design discipline (ADR docs/design/T-0210-docpage-writeful-tools.adr.md):
--   - PURE DATA SEED: no CREATE TABLE, no DDL. No new grants. known_tenant_tables.txt
--     untouched (doc_page/doc_ref/doc_log already listed from migration 061 / T-0238).
--   - IDEMPOTENT: every INSERT uses ON CONFLICT DO NOTHING (AC-09, idempotent re-run).
--   - NO NEW GRANTS: P-1 grants e2...018 {doc_page,create} and e2...019 {doc_page,update}
--     are necessary and sufficient for both P-2 tools (ADR §2, §6).
--   - doc_ref_set RIDES doc_page:update — doc_ref rows are children of doc_page
--     (FK page_id → doc_page ON DELETE CASCADE, migration 061). Setting refs is a
--     sub-operation of updating a page; no separate doc_ref resource_type (NF-1).
--   - declares='[]', pure_compute=true on both tools (satisfies mcp_tool_pure_empty_chk).
--   - resource_ops camelCase byte-for-byte identical to migration 040/044 form:
--     {"resourceType":"doc_page","operation":"<op>"}
--
-- Dev-tenant constants:
--   DEV_TENANT_UUID   = a0000000-0000-0000-0000-000000000001
--   doc_page_author   UUID = 10000000-0000-0000-0000-000000000013 (next free after 10...012 from 060)
--   doc_ref_set       UUID = 10000000-0000-0000-0000-000000000014 (next after 10...013)
--   (migration 062 consumed zero mcp_tool slots — next free was 10...013 from P-2 perspective)
--   Grant UUIDs added = NONE (next free grant remains e2...01a for future migrations)

-- ============================================================
-- Step 1. mcp_tool — doc_page_author
--   resource_ops: [{doc_page,create},{doc_page,update}] — full page authoring lifecycle
--   Mirrors author_template (migration 060) bundle pattern: create+update in one tool
--   because the create-vs-update decision is a runtime concern (slug exists or not),
--   not a separate tool concern. Paired with doc_ref_set for typed references.
-- ============================================================

INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000013',
   'doc_page_author',
   'Create or update a doc_page in the agent-maintained wiki. Writes body/title/slug/scope/stale/authored_by. Paired with doc_ref_set for typed references. Draft-first: no promote authority (SEAM-2).',
   '[]'::jsonb,
   true,
   '[{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 2. mcp_tool — doc_ref_set
--   resource_ops: [{doc_page,update}] — rides doc_page:update authority (ADR §2)
--   doc_ref = child of doc_page (FK page_id → doc_page ON DELETE CASCADE, migration 061).
--   Setting refs is a sub-operation of updating a page; no separate doc_ref resource_type
--   (research §1.1 invariant "ноль новых механизмов прав"). P-1 grant e2...019 sufficient.
-- ============================================================

INSERT INTO choros.mcp_tool
  (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000014',
   'doc_ref_set',
   'Set/replace the typed doc_ref rows for a given doc_page (ref_kind, ref_target, broken flag). Rides doc_page:update authority (doc_ref = child of doc_page, FK CASCADE). No separate doc_ref resource_type (research §1.1 NF-1).',
   '[]'::jsonb,
   true,
   '[{"resourceType":"doc_page","operation":"update"}]'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;
