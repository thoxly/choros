-- 043 · invoke_proposal (T-0024 E5.4) — first-class invoke-grant target table.
--
-- Tenant-table contract (identical to 022_effect_resource.sql / 032_agent_card.sql):
--   tenant_id leading PK, ENABLE+FORCE RLS, tenant-isolation policy on
--   current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- Design discipline (T-0017 FK lesson):
--   - PK (tenant_id, id) is self-contained; no cross-table FK is declared.
--   - caller_id / target_id are logical employee references validated in the
--     application layer (mirroring effect_resource's self-contained discipline).
--   - No seed INSERTs → migration is pure DDL (idempotency-seed-check vacuous).
--
-- Migration slot: 043 (041=T-0060, 042=T-0042 — HARD seam).

CREATE TABLE choros.invoke_proposal (
  tenant_id  uuid    NOT NULL,
  id         uuid    NOT NULL,
  caller_id  uuid    NOT NULL,
  target_id  uuid    NOT NULL,
  goal       text    NOT NULL,
  context    jsonb   NULL,
  status     text    NOT NULL,
  created_at bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT invoke_proposal_status_chk
    CHECK (status IN ('proposed', 'cancelled'))
);

-- Row-level security: each choros_app session sees only its own tenant's rows.
ALTER TABLE choros.invoke_proposal ENABLE  ROW LEVEL SECURITY;
ALTER TABLE choros.invoke_proposal FORCE   ROW LEVEL SECURITY;

CREATE POLICY invoke_proposal_tenant_isolation
  ON choros.invoke_proposal
  USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

-- Grant DML to the application role (choros_app = NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE
  ON choros.invoke_proposal TO choros_app;
