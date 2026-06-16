-- 072 · isolated_env_escalation (T-0088 E12.7) — on-demand physical isolation config-flip.
--
-- Adds a `physical_isolation_requested` boolean flag to choros.tenant.
-- This flag is the MODEL SEAM for declaring a tenant escalated to a physically
-- isolated contour (ось C — extensibility-and-authoring.md §8).
--
-- DECISION (ADR §8 / T-0087 AC-8):
--   DEFAULT = logical tiers in one silo (physical_isolation_requested = FALSE).
--   Setting this flag to TRUE is a config-flip that SIGNALS the intent to
--   provision a physically isolated contour for this tenant. It does NOT
--   auto-provision anything — actual contour provisioning is a human-gated
--   deploy-time operation (GT-4, founder-gated). The flag is:
--     • Reversible (flip back to FALSE re-enters logical-tier mode).
--     • Config-only (no data is copied, no contour is created here).
--     • Read by the system to route / gate escalation-aware operations.
--
-- ADDITIVE & IDEMPOTENT: ADD COLUMN IF NOT EXISTS. Re-running is safe.
-- known_tenant_tables.txt BYTE-UNCHANGED (additive column on already-registered
-- tenant table — no new table, no RLS change, no PK change).
--
-- role-criticality-migration-excludes.txt: this migration is listed there
-- (T-0088) to suppress false-positive role-criticality drift alarms on
-- additive-only column changes.

ALTER TABLE choros.tenant
  ADD COLUMN IF NOT EXISTS physical_isolation_requested boolean NOT NULL DEFAULT false;

-- NOTE: No new table, no new RLS policy, no new index (flag is a simple boolean
-- on the existing tenant root; queried only at escalation-check time, not in
-- hot-path joins). The existing FORCE RLS + choros_app GRANT on choros.tenant
-- cover this column automatically — no additional GRANT needed.
