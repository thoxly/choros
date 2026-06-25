-- 104 · form_binding.layout (T-0481 E-FORMS F2) — the form-document layout column.
--
-- form-document-format.spec.md §7: the declarative FORM-DOCUMENT (the layout the
-- drag-n-drop editor AND the AI emitter both produce — ONE artefact, two drivers)
-- is stored as JSON in a new `layout jsonb` column on the EXISTING form_binding
-- table. The old `fields` snapshot (045) is deprecated but kept for back-compat:
-- a binding with NULL layout still renders from `fields` (the legacy thin path);
-- a binding WITH a layout renders the document via the ONE renderer
-- (FormDocumentRenderer.jsx). Migration of the snapshot into a minimal document
-- (a flat list of `field`-nodes) is a render-time/back-fill concern, not forced here.
--
-- WHY ADDITIVE NULLABLE COLUMN (not a new table): a new tenant table would change
-- ci/checks/known_tenant_tables.txt (FF-11b: must stay byte-unchanged). Adding a
-- nullable column to the already-registered form_binding table is the additive,
-- contract-clean way (D-056). NULL = legacy snapshot-only binding; non-NULL = a
-- form-document. RLS / PK / tenant-isolation policy are UNCHANGED — the column
-- inherits the existing row-level security of form_binding (045).
--
-- CHECK: layout, when present, must be a JSON object (the document root has
-- schemaVersion / source / root — never an array or scalar). NULL is allowed.
--
-- Idempotency (NF-1): ADD COLUMN IF NOT EXISTS; re-running is safe.
-- known_tenant_tables.txt BYTE-UNCHANGED (additive nullable column on an
-- already-registered tenant table — no new table, no RLS change, no PK change).
--
-- Migration slot: 104 (T-0481 brief; highest occupied slot on this branch is 103).

ALTER TABLE choros.form_binding
  ADD COLUMN IF NOT EXISTS layout jsonb NULL;

-- A layout, when present, is the form-document object (never an array/scalar).
-- Guard added separately + idempotently (no IF NOT EXISTS for constraints in PG,
-- so we DROP-then-ADD inside a DO block to keep re-runs safe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE constraint_name = 'form_binding_layout_is_object'
  ) THEN
    ALTER TABLE choros.form_binding
      ADD CONSTRAINT form_binding_layout_is_object
        CHECK (layout IS NULL OR jsonb_typeof(layout) = 'object');
  END IF;
END $$;
