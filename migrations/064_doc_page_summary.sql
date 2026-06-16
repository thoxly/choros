-- 064 · doc_page.summary (T-0214 · P-6 docs-pipeline) — one-line index column.
--
-- ADR: docs/design/T-0214-doc-summary.adr.md
-- Foundations: T-0238 (doc_page, migration 061), T-0062 (additive-nullable discipline, 023).
--
-- Additive nullable column choros.doc_page.summary (text, NULL):
--   - Nullable: backward-compatible; existing rows have summary IS NULL after migration.
--   - One-line CHECK: summary IS NULL OR (position(E'\n' in summary) = 0
--       AND char_length(summary) <= 200). DO-guarded (idempotent).
--   - COLUMN, not table → known_tenant_tables.txt is NOT touched (NF-2, mirrors 023).
--   - REGEN (planRegen/doc-regen.ts) populates summary deterministically from the
--     same LiveSnapshot content as body — no timestamp/uuid, stable across runs.
--   - readDocIndex (doc-page-store.ts) queries slug/title/summary/scope/stale/updated_at
--     WITHOUT selecting body (static guard: ci/checks/doc-summary-no-body-in-index.sh).
--
-- Idempotency: ADD COLUMN IF NOT EXISTS; DO-guarded constraint; runner skips via
--   schema_migrations; repeating this file is safe.

ALTER TABLE choros.doc_page ADD COLUMN IF NOT EXISTS summary text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'doc_page_summary_oneline'
  ) THEN
    ALTER TABLE choros.doc_page ADD CONSTRAINT doc_page_summary_oneline
      CHECK (summary IS NULL OR (position(E'\n' in summary) = 0 AND char_length(summary) <= 200));
  END IF;
END $$;
