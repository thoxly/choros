-- 081 · revoke_transition_journal (T-0346 E15-S3-followup, SECURITY)
--
-- SECURITY FIX: The materialized view choros.process_transition_journal (created in
-- migration 079) was granted SELECT to choros_app without RLS enforcement. Because
-- materialized views in PostgreSQL store a physical snapshot and do NOT re-evaluate
-- RLS policies on the underlying audit_event table at read time, a future caller
-- doing SELECT * FROM choros.process_transition_journal would see ALL tenants'
-- journal rows — a cross-tenant data leak.
--
-- ANALYSIS:
--   - All analytics code (src/db/transition-journal.ts) queries choros.audit_event
--     DIRECTLY with WHERE tenant_id = $N, inside a withTenant tx that sets
--     choros.tenant_id GUC — RLS is fully enforced on that path.
--   - The mat-view has ZERO production readers (confirmed: grep -rn
--     "process_transition_journal" src/ returns only the mat-view definition
--     in migration 079 and a dead-code comment in transition-journal.ts).
--   - Option B is correct: REVOKE the grant, drop the mat-view and its dependent
--     objects (indexes, refresh function). Analytics remain provably tenant-isolated
--     via the existing audit_event RLS path.
--
-- IDEMPOTENCY: All DROP commands use IF EXISTS. Safe to apply more than once.
--
-- FROZEN-CHECK SAFETY:
--   - No CREATE TABLE, no new RLS policy, no new tenant table.
--   - known_tenant_tables.txt: NOT modified (mat-views are not tenant tables).
--   - dual-control-isolation.sh FF-DC7: additive relief for this migration (081) is
--     appended to that check (T0346-DC-MIG081-GUARD) — mirrors T-0338 pattern.
--   - defer-no-new-table.sh: no new table added; no relief needed.
--   - role-criticality-migration-excludes.txt: 081 entry appended.
--
-- Owner: choros_migrator.
-- -------------------------------------------------------------------------

-- Step 1: Revoke the SELECT grant so choros_app can no longer read the mat-view.
-- REVOKE is idempotent (no-error if privilege does not exist).
DO $$
BEGIN
  REVOKE SELECT ON choros.process_transition_journal FROM choros_app;
EXCEPTION
  WHEN undefined_table THEN NULL;  -- already dropped
END;
$$;

-- Step 2: Revoke EXECUTE on the refresh function.
DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION choros.refresh_transition_journal() FROM choros_app;
EXCEPTION
  WHEN undefined_function THEN NULL;
END;
$$;

-- Step 3: Drop the refresh function.
DROP FUNCTION IF EXISTS choros.refresh_transition_journal();

-- Step 4: Drop the mat-view and all its dependent indexes (CASCADE).
-- The indexes idx_ptj_event_id, idx_ptj_tenant_instance, idx_ptj_tenant_activity
-- are dropped automatically via CASCADE.
DROP MATERIALIZED VIEW IF EXISTS choros.process_transition_journal CASCADE;

-- Note: the GIN index (idx_audit_transition_payload) and btree index
-- (idx_audit_transition_tenant_ts) created in migration 079 on choros.audit_event
-- are KEPT — they benefit the direct audit_event analytics queries in
-- src/db/transition-journal.ts and have no cross-tenant risk.
