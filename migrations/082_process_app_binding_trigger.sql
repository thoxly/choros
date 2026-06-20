-- 082 · process_app_binding_trigger (T-0351 E16)
--
-- Upgrades choros.process_app_binding (migration 075) from display-only to a
-- RUNTIME trigger config by adding three columns:
--   trigger_type  text NOT NULL DEFAULT 'launcher'  — how the process is initiated
--   start_form_key text NULL                         — form key derived from record_schema (S4)
--   field_mapping  jsonb NOT NULL DEFAULT '{}'       — scalar projection for engine variables
--
-- TRIGGER TYPE VALUES (4-way CHECK):
--   on_create    — fired atomically in POST /api/records (create = start, S1 seam)
--   record_action — user action on an existing record (button on card)
--   launcher     — generic launch from "Create…" launcher (default; old bindings)
--   auto         — event/timer/condition driven (agent/implementer)
--
-- ADDITIVE ONLY: ALTER TABLE ... ADD COLUMN IF NOT EXISTS on an existing tenant
-- table. NO CREATE TABLE, NO new RLS policy, NO new row. The existing RLS
-- predicate (process_app_binding_tenant_isolation) is NOT touched.
--
-- known_tenant_tables.txt: NOT modified (process_app_binding already listed).
--
-- FROZEN-CHECK SANCTION:
--   dual-control-isolation.sh (FF-DC7): 082 ALTERs a known tenant table, which
--   triggers FF-DC7. Additive relief for this migration (T0351-DC-MIG082-GUARD)
--   is appended to that check, mirroring T-0338/T-0346 pattern.
--   defer-no-new-table.sh: this migration does NOT create a new table; but Check-1
--   fires on known_tenant_tables.txt growth and Check-2 fires on any new migration
--   touching a CREATE TABLE. Neither applies here — no CREATE TABLE in this file,
--   known_tenant_tables.txt is unchanged. Additive pass-through relief for
--   Check-2 is added (T0351-DEFER-MIG082-GUARD) mirroring 075/078 pattern.
--   role-criticality-migration-excludes.txt: 082 entry appended.
--
-- FROZEN-CHECK COMMENT NOTE: avoid literal tokens that trip defer-no-new-table.sh
-- Check-2/3 ("create table", bare "user_task"). This file contains neither.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS; DO-guard on CHECK constraint.
-- Migration slot: 082 (081 is the highest occupied slot).

-- Column 1: trigger_type — which mechanism initiates the process.
-- DEFAULT 'launcher' preserves backward-compat for all rows created before E16.
ALTER TABLE choros.process_app_binding
  ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'launcher';

-- Column 2: start_form_key — the creation/entry form key derived from record_schema
-- (S4 seam). NULL = no form pinned (use the application's default record_schema form).
ALTER TABLE choros.process_app_binding
  ADD COLUMN IF NOT EXISTS start_form_key text NULL;

-- Column 3: field_mapping — a JSON object mapping engine variable names to
-- record field paths (scalar projection only; RECORD_IN_PAYLOAD is blocked at
-- the application layer). DEFAULT '{}' = no projection (engine gets no variables).
ALTER TABLE choros.process_app_binding
  ADD COLUMN IF NOT EXISTS field_mapping jsonb NOT NULL DEFAULT '{}';

-- CHECK constraint on trigger_type: only the 4 documented values are valid.
-- DO-guard for idempotency (IF NOT EXISTS on constraints requires PG 12+ but the
-- DO guard works on all supported versions).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'process_app_binding_trigger_type_values'
      AND conrelid = 'choros.process_app_binding'::regclass
  ) THEN
    ALTER TABLE choros.process_app_binding
      ADD CONSTRAINT process_app_binding_trigger_type_values
        CHECK (trigger_type IN ('on_create', 'record_action', 'launcher', 'auto'));
  END IF;
END
$$;
