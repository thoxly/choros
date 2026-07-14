-- 133 · application.created_by (T-0690) — author-of-own-draft delete floor.
--
-- CONTEXT: DELETE /api/applications/:id (T-0566, assertMayDeleteConfig) only ever
-- granted owner/admin or an `authoring_draft` capability grant — a rank-and-file
-- author of their OWN draft application got 403 for their own sandbox, contrary
-- to the "draft = personal sandbox of the author" model (столп 5, LIVE_PROOF
-- T-0689). The DB had no way to even ASK who authored an application — this
-- migration adds that fact.
--
-- Adds created_by (nullable text, actor slug) to choros.application, mirroring
-- the SAME shape already used for choros.record.created_by (migration 005) and
-- choros.list_view.created_by (migration 123): a plain, unconstrained actor-slug
-- column, populated by the write path — not a new authority mechanism.
--
-- Existing rows get NULL (unknown authorship — we do not GUESS a creator for
-- pre-migration applications; no audit trail records application authorship
-- today, so there is nothing honest to backfill). NULL never equals any actor
-- slug, so pre-migration applications stay locked to owner/admin/authoring_draft
-- — the safe, unchanged default. New INSERTs (createApplication,
-- src/http/applications.ts) populate it from the authenticated actor going
-- forward, enabling the T-0690 self-service floor: created_by = actor AND
-- tier = 'draft' AND same tenant (RLS-scoped) → the author may delete their own.
--
-- ADDITIVE & IDEMPOTENT: ADD COLUMN IF NOT EXISTS; re-running is safe.
-- known_tenant_tables.txt BYTE-UNCHANGED (additive column on an already-
-- registered tenant table — no new table, no RLS change, no PK change).

ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS created_by text NULL;
