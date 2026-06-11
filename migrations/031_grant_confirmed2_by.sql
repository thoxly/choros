-- 031 · grant_confirmed2_by (T-0044 E4.6) — additive ALTER TABLE, mirrors 030.
--
-- Adds a single additive nullable text column `confirmed2_by` to
-- choros."grant" AND choros.role_assignment — the durable home for the SECOND
-- authenticated approver of a criticality-escalating change (rev-2 R-AUTH §9.4).
-- Mirrors migration 030 (proposed_by/confirmed_by) exactly: no new table, no RLS
-- change, no known_tenant_tables.txt change (additive column on an already-
-- registered tenant table; AC-16 vacuously holds).
--
-- Derived state machine (NOT a new state table):
--   confirmed_by IS NULL                              → proposed
--   confirmed_by NOT NULL AND confirmed2_by IS NULL   → semi-confirmed
--   confirmed2_by NOT NULL                            → confirmed
-- The "is this escalating, so does it need #2" bit is DERIVED from
-- criticalityDiff (T-0040) at the call-site — never stored (Q-1 derived-not-
-- stored spirit preserved for the DECISION; only the durable approver-identity
-- column is persisted).
--
-- ADDITIVE & IDEMPOTENT: ADD COLUMN IF NOT EXISTS; re-running is safe. The PKs,
-- RLS policies, and GRANT to choros_app on both tables remain unchanged.

ALTER TABLE choros."grant"
  ADD COLUMN IF NOT EXISTS confirmed2_by text NULL;

ALTER TABLE choros.role_assignment
  ADD COLUMN IF NOT EXISTS confirmed2_by text NULL;
