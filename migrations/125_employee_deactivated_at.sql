-- 125 · employee_deactivated_at (T-0583, ADR-T0583-user-mgmt §2.5) — additive
-- account-deactivation marker for choros.employee.
--
-- WHY. T-0583 lets a tenant owner (or covering mgmt_object:employee holder)
-- create a KC-backed login for a human FROM THE PRODUCT (POST /api/users) and
-- deactivate/reactivate it (PATCH /api/users/:employee_id). Deactivation must
-- disable the Keycloak login (KC enabled:false, src/keycloak/admin-port.ts
-- setUserEnabled) AND be visible on the employee row itself, independent of
-- role_assignment.valid_until (revoking a ROLE is not the same thing as
-- disabling an ACCOUNT — see ADR §3 rejected-alternatives table).
--
-- deactivated_at bigint NULL — epoch-ms of deactivation; NULL = active. A
-- generic timestamp, NOT an enum/status string (D-064: no case-specific
-- vocabulary invited by a `status text` column). Nullable, no default — every
-- existing row (created before this migration) is implicitly active (NULL),
-- which is the correct backward-compatible reading.
--
-- ADDITIVE ONLY: one ALTER TABLE ADD COLUMN. No new table, no FK, no RLS
-- policy (the column inherits employee's existing RLS FORCE policy — same
-- row, same tenant_id). Idempotent via IF NOT EXISTS (safe to re-run, mirrors
-- the style of prior additive column migrations in this repo).

ALTER TABLE choros.employee
  ADD COLUMN IF NOT EXISTS deactivated_at bigint NULL;
