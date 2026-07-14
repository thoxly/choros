-- 107 · spend_ledger LLM cost-tracking extension (T-0477, E-AGENTS L5)
--
-- Spec: docs/specs/agent-registry-and-llm-keys.spec.md §7
--
-- The existing spend_ledger (migration 034) was designed around the
-- "ceiling/reservation" budget system (Stage-2). Its reservation_id and
-- employee_id columns are NOT NULL, which prevents recording LLM-chat costs
-- directly without first creating a reservation and an agent_budget row.
--
-- Stage-1 (this task, T-0477) is ACCOUNTING + DISPLAY ONLY — no ceilings.
-- We extend the table ADDITIVELY:
--
--   1. Make reservation_id NULLable — required fields for the ceiling path;
--      can stay NULL for the L5 LLM-tracking path (no reservation → no ceiling gate).
--   2. Make employee_id NULLable — similar: known for agent-step calls, NULL OK for
--      assistant chat (the actor is tracked via agent_slug in description).
--   3. Add llm_connection_id uuid NULL → FK on llm_connection (T-0474). Which
--      named connection profile was charged?
--   4. Add prompt_tokens / completion_tokens / total_tokens integer columns
--      (NULL = unknown / not recorded by provider).
--
-- All changes are ADDITIVE (ADD COLUMN IF NOT EXISTS / DROP NOT NULL on existing
-- constraints) and guarded to be re-run-safe.
-- No data is migrated — the existing zero rows are unaffected.
-- The append-only trigger and RLS policy from migration 034 are preserved as-is.

-- ── Step 1: relax the NOT NULL constraint on reservation_id ─────────────────
-- The FK still exists; NULL means "not associated with a reservation" (LLM path).
ALTER TABLE choros.spend_ledger
  ALTER COLUMN reservation_id DROP NOT NULL;

-- ── Step 2: relax the NOT NULL constraint on employee_id ────────────────────
-- The FK still exists; NULL means "not a workforce-agent call" (LLM assistant path).
ALTER TABLE choros.spend_ledger
  ALTER COLUMN employee_id DROP NOT NULL;

-- ── Step 3: add llm_connection_id (NULLable FK → llm_connection) ────────────
ALTER TABLE choros.spend_ledger
  ADD COLUMN IF NOT EXISTS llm_connection_id uuid NULL;

-- FK guarded: only if llm_connection exists (it does after 094, but guard for CI).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'choros' AND table_name = 'llm_connection'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spend_ledger_llm_connection_fk'
  )
  THEN
    ALTER TABLE choros.spend_ledger
      ADD CONSTRAINT spend_ledger_llm_connection_fk
      FOREIGN KEY (tenant_id, llm_connection_id)
      REFERENCES choros.llm_connection (tenant_id, id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Index: spend aggregates by connection (Расход screen).
CREATE INDEX IF NOT EXISTS spend_ledger_conn_idx
  ON choros.spend_ledger (tenant_id, llm_connection_id, recorded_at)
  WHERE llm_connection_id IS NOT NULL;

-- ── Step 4: token count columns ─────────────────────────────────────────────
ALTER TABLE choros.spend_ledger
  ADD COLUMN IF NOT EXISTS prompt_tokens    integer NULL;
ALTER TABLE choros.spend_ledger
  ADD COLUMN IF NOT EXISTS completion_tokens integer NULL;
ALTER TABLE choros.spend_ledger
  ADD COLUMN IF NOT EXISTS total_tokens      integer NULL;

-- ── Step 5: additional index for time-window aggregates ──────────────────────
-- Расход screen aggregates by agent_slug stored in description; secondary by recorded_at.
CREATE INDEX IF NOT EXISTS spend_ledger_time_idx
  ON choros.spend_ledger (tenant_id, recorded_at);
