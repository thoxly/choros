-- 038 · egress_policy (T-0041 · E4.8) — the BYO-LLM data-egress policy axis: a
-- per-tenant declarative allowlist of which DataClass values MAY egress to which
-- client-hosted LLM endpoint pattern. Day-1 = schema + policy expressibility +
-- isolation; the runtime gate at agent call-time is Stage-2 (E5.10 / T-0045).
-- The table is schema-DORMANT: no Choros runtime (src/**/*.ts) reads it on day-1
-- (same dormancy as agent_card, T-0020).
--
-- RUN SEAM (ADR §0): migrations 032–037 are allocated to other in-flight tasks;
-- T-0041 uses number 038 (039 is the reserve slot, unused — no seed file needed,
-- deny-by-default = empty table). known_tenant_tables.txt is appended additively.
--
-- Same tenant-table contract as 017_data_classification.sql / 008_grant.sql:
--   tenant_id leading PK, ENABLE+FORCE RLS, tenant-isolation policy on
--   current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- NO cross-table FK: `class` is the closed DataClass axis (the shared join symbol
-- imported from src/core/data-classification.ts, T-0033) — a CHECK enumerates the
-- closed set, exactly mirroring data_classification.class. `allowed_endpoint` is a
-- plain text endpoint pattern (a base URL such as 'https://api.openai.com/v1'),
-- NOT a secret-handle reference (BYO-LLM secret custody = T-0025, out of scope).
-- Neither column maps to a single foreign row, so no relational target exists —
-- mirrors data_classification's deferred-FK discipline (T-0017 lesson).
--
-- DENY-BY-DEFAULT (FR-4): the table is an allowlist — the ABSENCE of a row for a
-- (class, allowed_endpoint) pair means egress is NOT permitted. No catch-all
-- "allow all" row is seeded for any tenant; the dev tenant starts EMPTY.
--
-- IDEMPOTENCY (NF-3 / AC-10): the runner (migrations/run.mjs) records each applied
-- version in choros.schema_migrations and SKIPS already-recorded versions, so a
-- second run is a no-op. IF NOT EXISTS / DO-guards below make the DDL itself
-- re-runnable as a belt-and-braces second line of defence.

CREATE TABLE IF NOT EXISTS choros.egress_policy (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  class            text NOT NULL,    -- DataClass; CHECK enumerates the closed set
  allowed_endpoint text NOT NULL,    -- client-hosted LLM endpoint pattern (base URL); NO FK, NOT a secret handle
  description      text,             -- nullable human-readable rationale (informational)
  created_at       bigint NOT NULL,  -- epoch-ms
  updated_at       bigint NOT NULL,  -- epoch-ms
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT egress_policy_class_chk
    CHECK (class IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT egress_policy_class_endpoint_uniq
    UNIQUE (tenant_id, class, allowed_endpoint)
);

ALTER TABLE choros.egress_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.egress_policy FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename = 'egress_policy'
      AND policyname = 'egress_policy_tenant_isolation'
  ) THEN
    CREATE POLICY egress_policy_tenant_isolation ON choros.egress_policy
      USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.egress_policy TO choros_app;
