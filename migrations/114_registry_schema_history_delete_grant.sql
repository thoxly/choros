-- 114 · registry_schema_history DELETE grant for choros_app (T-0566).
--
-- WHY: T-0566 adds DELETE /api/applications/:id — a cascade hard-delete of an
-- application and everything it owns (its registry_defs + those defs' records +
-- dependents). registry_schema_history (migration 070) FK-references registry_def
-- (tenant_id, registry_id) with NO ON DELETE CASCADE, so the cascade must delete
-- the history rows before the registry_def, under the app role (choros_app).
--
-- migration 070 granted only SELECT, INSERT on registry_schema_history to
-- choros_app (append-only write-once history). Deleting a registry_def was never a
-- runtime path before T-0566, so no DELETE grant existed. This migration adds it —
-- the app role may now remove history rows, but ONLY as part of deleting the owning
-- registry_def (the cascade is tenant-scoped under RLS + the tier-lock GUC bypass);
-- ordinary schema-version writes remain append-only (the app code never issues a
-- bare DELETE against history outside the application-delete cascade).
--
-- Additive & idempotent: GRANT is idempotent; re-running is safe. No DDL/data
-- change, no RLS change — the tenant-isolation policy from 070 is untouched.

GRANT DELETE ON choros.registry_schema_history TO choros_app;
