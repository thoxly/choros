-- @demo-seed (T-0549): fake reference-company content; skipped when CHOROS_SEED_DEMO=off (clean prod).
-- 089 · Seed cross_app_ref definition: «Согласование» → «Заявки» (T-0368, E16)
--
-- CONTEXT:
--   The step-applier (src/db/step-applier.ts, T-0335/T-0352) uses getCrossAppRef
--   to look up a definition linking the «Согласование» (source) registry to the
--   primary «Заявки» (target) registry. When found, it writes the originating
--   «Заявки» record's UUID into the ref_field key of the newly-created
--   «Согласование» record — the cross-application pointer. Without a seed row
--   getCrossAppRef returns null and the pointer is never written, even though
--   T-0356 correctly passes primaryRecordId through the resolver.
--
-- WHAT THIS SEEDS:
--   cross_app_ref row:
--     source_registry_id = «Согласование» (slug='soglasovanie')
--                        = a7000000-0000-0000-0000-000000000003  (migration 076)
--     target_registry_id = «Заявки» (slug='purchases')
--                        = a7000000-0000-0000-0000-000000000002  (migration 076)
--     ref_field          = 'purchase_ref'
--                          the JSONB key inside the «Согласование» record's data
--                          that will hold the originating «Заявки» record's UUID.
--     label              = 'Заявка-источник'
--     ref_strength       = 'weak'   (independent lifecycle; the purchase record
--                          is not cascade-deleted if the approval record is removed)
--
-- This is the only cross_app_ref definition for the telLinear (ТЭЛ) scenario;
-- it is the minimal seed needed to prove the T-0368 pointer-write e2e.
--
-- STABLE UUIDs (T-0368 namespace b9; FRESH — not reused from any prior migration):
--   dev tenant       = a0000000-0000-0000-0000-000000000001  (migration 013)
--   cross_app_ref id = b9000000-0000-0000-0000-000000000001
--   source (soglasovanie) = a7000000-0000-0000-0000-000000000003
--   target (purchases)    = a7000000-0000-0000-0000-000000000002
--
-- IDEMPOTENT: ON CONFLICT (tenant_id, id) DO NOTHING — re-running is a no-op.
-- Additional safety: the UNIQUE constraint
--   cross_app_ref_source_field_uniq (tenant_id, source_registry_id, ref_field)
-- also prevents duplicate ref_field keys for the same source; the first INSERT wins.
--
-- NO DDL — zero table creation. The cross_app_ref table was created by
-- migration 068_cross_app_ref.sql. This migration only inserts a data row.
-- ci/checks/known_tenant_tables.txt is NOT changed.
--
-- Runs as choros_migrator (BYPASSRLS) — literal tenant_id, no GUC required.

INSERT INTO choros.cross_app_ref
  (tenant_id, id, source_registry_id, target_registry_id, ref_field, label, ref_strength, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',   -- dev tenant (migration 013)
    'b9000000-0000-0000-0000-000000000001',   -- fresh UUID (T-0368 namespace b9)
    'a7000000-0000-0000-0000-000000000003',   -- source: «Согласование» (migration 076)
    'a7000000-0000-0000-0000-000000000002',   -- target: «Заявки» (migration 076)
    'purchase_ref',                           -- ref_field key in the approval record data
    'Заявка-источник',                        -- display label
    'weak',                                   -- independent lifecycle
    0,                                        -- created_at (epoch sentinel, migration convention)
    0                                         -- updated_at
  )
ON CONFLICT (tenant_id, id) DO NOTHING;
