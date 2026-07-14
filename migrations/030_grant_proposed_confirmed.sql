-- 030 · grant_proposed_confirmed (T-0030 E3.4) — additive ALTER TABLE.
--
-- Adds proposed_by / confirmed_by nullable text columns to choros."grant",
-- matching the proposal/confirmation semantics already present in
-- role_assignment (migration 020). No new table, no RLS change, no
-- known_tenant_tables.txt change (AC-19 vacuously holds).
--
-- ADDITIVE & IDEMPOTENT: ADD COLUMN IF NOT EXISTS; re-running is safe.
-- The grant table PK (tenant_id, id), RLS policy, and GRANT to choros_app
-- remain unchanged.

ALTER TABLE choros."grant"
  ADD COLUMN IF NOT EXISTS proposed_by  text NULL,
  ADD COLUMN IF NOT EXISTS confirmed_by text NULL;
