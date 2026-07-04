-- 127 · employee_email (T-0628 fix, follow-up on ADR-T0583-user-mgmt) — additive
-- separate email column for choros.employee, distinct from `login`.
--
-- WHY. T-0625 closed the 503-on-create bug (POST /api/users passed KC
-- email=login hardcoded; a non-email login 400'd on a real Keycloak realm,
-- which surfaced to the caller as a generic 503) by making `login` itself
-- mandatory-email-shaped. That is a NARROWER contract than what T-0628's own
-- LIVE_PROOF spec asks for: login should stay FREE-FORM (a non-email login
-- like `ivan.petrov` is a legitimate ordinary login), and email should be a
-- SEPARATE required field, validated on our side before any Keycloak call.
--
-- FIX. Store the email the owner typed at POST /api/users time in a NEW
-- nullable column, independent of `login` (migration 126) and `slug` (the KC
-- user UUID, migration 016). NULL for every row created before this
-- migration (dev-silo seed humans, T-0583/T-0625-era accounts) — same legacy
-- reading as `login`/`deactivated_at`: nullable, no backfill, no default.
--
-- ADDITIVE ONLY: one ALTER TABLE ADD COLUMN. No new table, no FK, no RLS
-- policy (inherits employee's existing RLS FORCE policy). Idempotent via
-- IF NOT EXISTS (mirrors 125_employee_deactivated_at.sql / 126_employee_login.sql style).

ALTER TABLE choros.employee
  ADD COLUMN IF NOT EXISTS email text NULL;
