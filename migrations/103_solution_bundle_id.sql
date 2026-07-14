-- 103 · solution_bundle_id (T-0465 D8-G4) — group one DRAFT solution as ONE promote unit.
--
-- The text-first solution builder (bot) generates a whole solution in ONE shot:
-- an application (+ its section) + cascaded related applications + a process — all
-- DRAFT. The human reviews the draft VISUALLY in the sections (Приложения / Модельер)
-- via deep-links, then promotes the WHOLE bundle as ONE unit.
--
-- To make "the whole bundle" addressable we tag every artifact the bot writes in a
-- single confirmation with a shared bundle_id (a free-form uuid the assistant route
-- mints per confirmed plan). The bundle-promote endpoint
-- (POST /api/solution-bundles/:bundleId/promote) then resolves every tagged artifact
-- and promotes them together (apps/registry_defs via promoteTier; processes via
-- the publish path) — co-equal with promoting them one-by-one in the sections.
--
-- WHY ADDITIVE COLUMNS (not a new table): a new tenant table would change
-- ci/checks/known_tenant_tables.txt (FF-11b: must stay byte-unchanged). Tagging
-- existing already-registered tables with a nullable column is the additive,
-- contract-clean way (D-056). bundle_id is a LOGICAL grouping key — NO cross-table
-- FK (same convention as process_app_binding/075). NULL = not part of a bot bundle
-- (the visual constructor's hand-made artifacts), so the column is purely additive
-- and changes nothing for existing rows or the visual flow.
--
-- This is NOT a tier column: it does NOT participate in the draft→published lock
-- (tier_published_locked trigger / FF-1 / FF-10). It only records bundle membership.
--
-- Idempotency (NF-1): ADD COLUMN IF NOT EXISTS; re-running is safe.
-- known_tenant_tables.txt BYTE-UNCHANGED (additive nullable columns on already-
-- registered tenant tables — no new table, no RLS change, no PK change).
--
-- Migration slot: 103 (per T-0465 brief; highest occupied slot on this branch is 093).

ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS bundle_id uuid NULL;

ALTER TABLE choros.registry_def
  ADD COLUMN IF NOT EXISTS bundle_id uuid NULL;

ALTER TABLE choros.process_definition
  ADD COLUMN IF NOT EXISTS bundle_id uuid NULL;

-- Lookup index: the bundle-promote endpoint resolves "all artifacts in this bundle"
-- per tenant. Partial index (WHERE bundle_id IS NOT NULL) keeps it small — only
-- bot-bundled rows are indexed, never the visual-constructor majority.
CREATE INDEX IF NOT EXISTS application_bundle_idx
  ON choros.application (tenant_id, bundle_id) WHERE bundle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS registry_def_bundle_idx
  ON choros.registry_def (tenant_id, bundle_id) WHERE bundle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS process_definition_bundle_idx
  ON choros.process_definition (tenant_id, bundle_id) WHERE bundle_id IS NOT NULL;
