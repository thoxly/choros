-- 126 · employee_login (T-0625 fix, ADR-T0583-user-mgmt follow-up) — additive
-- human-readable KC username column for choros.employee.
--
-- WHY. `employee.slug` for a KC-backed human account is the KC user UUID
-- (= JWT `sub`, the T-0342/T-0366 identity-resolution invariant — see
-- src/db/org.ts resolveActorSlugFromAuth). Reusing `slug` to DISPLAY a login
-- means GET /api/users/accounts shows a raw KC UUID instead of the login the
-- owner typed (T-0625 LIVE_PROOF bug: list shows UUID, not the human login).
--
-- FIX. Store the human-readable KC username (the `login` field the owner
-- typed at POST /api/users time) in a NEW nullable column, separate from the
-- identity-bearing `slug`. GET /api/users/accounts reads `login`, falling
-- back to `slug` only for rows created before this migration (dev-silo seed
-- humans like `e-kravtsova` have no KC login at all — slug IS their only
-- label, which is the correct legacy reading).
--
-- ADDITIVE ONLY: one ALTER TABLE ADD COLUMN. No new table, no FK, no RLS
-- policy (inherits employee's existing RLS FORCE policy). Idempotent via
-- IF NOT EXISTS (mirrors 125_employee_deactivated_at.sql style).

ALTER TABLE choros.employee
  ADD COLUMN IF NOT EXISTS login text NULL;
