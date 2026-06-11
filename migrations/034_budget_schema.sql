-- 034 · budget schema (T-0023 · E4.9) — four tenant-isolated tables implementing
-- two-ceiling AND-composed budget semantics: instance_budget, agent_budget,
-- reservation (idempotent tool_call_id + TTL), spend_ledger (append-only).
--
-- Day-1 scope: schema + semantics (constraints / FK / trigger). Runtime
-- reservation enforcement at the agent call boundary is Stage-2 (E5.9).
-- No Choros src/**/*.ts reads these tables on day-1 (FR-10 / AC-23).
--
-- Migration-slot contract: 032 = T-0020 agent_card; 033 = reserved; 034/035 = T-0023
-- (slot 035 intentionally left unused); 036–037 reserved; 038 = T-0041 egress_policy.
--
-- Intra-file FK order (all composite, tenant_id-leading per T-0013 invariant):
--   1. instance_budget    (no FK to sibling tables)
--   2. agent_budget       (FK → employee)
--   3. reservation        (FK → instance_budget, agent_budget)
--   4. spend_ledger       (FK → reservation, employee, instance_budget, agent_budget)
--   5. Guarded ALTER TABLE agent_card ADD CONSTRAINT … (§3.5)
--   6. Dev seed (idempotent ON CONFLICT DO NOTHING)
--
-- T-0013 isolation invariants applied to all four tables:
--   tenant_id NOT NULL, leading PK column, ENABLE+FORCE RLS,
--   default-DENY policy USING/WITH CHECK current_setting('choros.tenant_id', true)::uuid,
--   choros_app NOBYPASSRLS role — DML only.
--
-- spend_ledger append-only: same two-layer pattern as audit_event (migration 006 /
-- T-0016): (a) GRANT SELECT, INSERT only to choros_app; (b) BEFORE UPDATE/DELETE
-- trigger raises restrict_violation for ALL roles including choros_migrator.

-- ============================================================
-- 1. instance_budget
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.instance_budget (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL,
  process_instance_id text              NULL,
  currency           text           NOT NULL,
  ceiling            numeric(18,6)  NOT NULL,
  remaining_cache    numeric(18,6)  NOT NULL,
  created_at         bigint         NOT NULL,
  updated_at         bigint         NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT instance_budget_ceiling_positive
    CHECK (ceiling > 0)
);

ALTER TABLE choros.instance_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.instance_budget FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'instance_budget'
      AND policyname = 'instance_budget_tenant_isolation'
  ) THEN
    CREATE POLICY instance_budget_tenant_isolation ON choros.instance_budget
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.instance_budget TO choros_app;

-- ============================================================
-- 2. agent_budget
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.agent_budget (
  tenant_id       uuid           NOT NULL,
  id              uuid           NOT NULL,
  employee_id     uuid           NOT NULL,
  window_kind     text           NOT NULL,
  window_ref      text               NULL,
  currency        text           NOT NULL,
  ceiling         numeric(18,6)  NOT NULL,
  remaining_cache numeric(18,6)  NOT NULL,
  created_at      bigint         NOT NULL,
  updated_at      bigint         NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT agent_budget_window_kind_chk
    CHECK (window_kind IN ('instance', 'daily', 'monthly', 'total')),

  CONSTRAINT agent_budget_ceiling_positive
    CHECK (ceiling > 0),

  CONSTRAINT agent_budget_employee_fk
    FOREIGN KEY (tenant_id, employee_id)
    REFERENCES choros.employee (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS agent_budget_lookup_idx
  ON choros.agent_budget (tenant_id, employee_id, window_kind, window_ref);

ALTER TABLE choros.agent_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.agent_budget FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'agent_budget'
      AND policyname = 'agent_budget_tenant_isolation'
  ) THEN
    CREATE POLICY agent_budget_tenant_isolation ON choros.agent_budget
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.agent_budget TO choros_app;

-- ============================================================
-- 3. reservation
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.reservation (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL,
  tool_call_id       text           NOT NULL,
  instance_budget_id uuid               NULL,
  agent_budget_id    uuid               NULL,
  held               numeric(18,6)  NOT NULL,
  currency           text           NOT NULL,
  status             text           NOT NULL,
  expires_at         bigint         NOT NULL,
  created_at         bigint         NOT NULL,
  finalized_at       bigint             NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT reservation_tool_call_id_uniq
    UNIQUE (tenant_id, tool_call_id),

  CONSTRAINT reservation_held_positive
    CHECK (held > 0),

  CONSTRAINT reservation_status_chk
    CHECK (status IN ('open', 'spent', 'released')),

  CONSTRAINT reservation_at_least_one_budget
    CHECK (instance_budget_id IS NOT NULL OR agent_budget_id IS NOT NULL),

  CONSTRAINT reservation_instance_budget_fk
    FOREIGN KEY (tenant_id, instance_budget_id)
    REFERENCES choros.instance_budget (tenant_id, id),

  CONSTRAINT reservation_agent_budget_fk
    FOREIGN KEY (tenant_id, agent_budget_id)
    REFERENCES choros.agent_budget (tenant_id, id)
);

ALTER TABLE choros.reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.reservation FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'reservation'
      AND policyname = 'reservation_tenant_isolation'
  ) THEN
    CREATE POLICY reservation_tenant_isolation ON choros.reservation
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.reservation TO choros_app;

-- ============================================================
-- 4. spend_ledger  (append-only)
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.spend_ledger (
  tenant_id          uuid           NOT NULL,
  id                 uuid           NOT NULL,
  reservation_id     uuid           NOT NULL,
  tool_call_id       text           NOT NULL,
  employee_id        uuid           NOT NULL,
  instance_budget_id uuid               NULL,
  agent_budget_id    uuid               NULL,
  amount             numeric(18,6)  NOT NULL,
  currency           text           NOT NULL,
  description        text               NULL,
  recorded_at        bigint         NOT NULL,

  PRIMARY KEY (tenant_id, id),

  CONSTRAINT spend_ledger_amount_positive
    CHECK (amount > 0),

  CONSTRAINT spend_ledger_reservation_fk
    FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES choros.reservation (tenant_id, id),

  CONSTRAINT spend_ledger_employee_fk
    FOREIGN KEY (tenant_id, employee_id)
    REFERENCES choros.employee (tenant_id, id),

  CONSTRAINT spend_ledger_instance_budget_fk
    FOREIGN KEY (tenant_id, instance_budget_id)
    REFERENCES choros.instance_budget (tenant_id, id),

  CONSTRAINT spend_ledger_agent_budget_fk
    FOREIGN KEY (tenant_id, agent_budget_id)
    REFERENCES choros.agent_budget (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS spend_ledger_instance_idx
  ON choros.spend_ledger (tenant_id, instance_budget_id, recorded_at);

CREATE INDEX IF NOT EXISTS spend_ledger_agent_idx
  ON choros.spend_ledger (tenant_id, agent_budget_id, recorded_at);

ALTER TABLE choros.spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.spend_ledger FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'spend_ledger'
      AND policyname = 'spend_ledger_tenant_isolation'
  ) THEN
    CREATE POLICY spend_ledger_tenant_isolation ON choros.spend_ledger
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

-- Append-only trigger (T-0016 pattern verbatim):
-- defence layer (b) — rejects UPDATE/DELETE for ALL roles including owner.
CREATE OR REPLACE FUNCTION choros.spend_ledger_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'spend_ledger is append-only: % is forbidden', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'spend_ledger_no_update'
      AND tgrelid = 'choros.spend_ledger'::regclass
  ) THEN
    CREATE TRIGGER spend_ledger_no_update
      BEFORE UPDATE ON choros.spend_ledger
      FOR EACH ROW EXECUTE FUNCTION choros.spend_ledger_immutable();
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'spend_ledger_no_delete'
      AND tgrelid = 'choros.spend_ledger'::regclass
  ) THEN
    CREATE TRIGGER spend_ledger_no_delete
      BEFORE DELETE ON choros.spend_ledger
      FOR EACH ROW EXECUTE FUNCTION choros.spend_ledger_immutable();
  END IF;
END
$$;

-- Append-only for the runtime role: SELECT/INSERT only — NO UPDATE/DELETE.
-- defence layer (a).
GRANT SELECT, INSERT ON choros.spend_ledger TO choros_app;

-- ============================================================
-- 5. Guarded FK: agent_card.budget_policy_id → instance_budget(tenant_id, id)
--    (T-0020 seam — §3.5)
--    Guard 1: only if agent_card table exists (safe on fresh CI Postgres)
--    Guard 2: NOT EXISTS the named constraint (idempotent re-run)
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'choros' AND table_name = 'agent_card'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_card_budget_policy_fk'
  )
  THEN
    ALTER TABLE choros.agent_card
      ADD CONSTRAINT agent_card_budget_policy_fk
      FOREIGN KEY (tenant_id, budget_policy_id)
      REFERENCES choros.instance_budget (tenant_id, id);
  END IF;
END
$$;

-- ============================================================
-- 6. Dev seed — idempotent (ON CONFLICT DO NOTHING)
--    Dev silo tenant:  a0000000-0000-0000-0000-000000000001
--    agent a-recon:    d0000000-0000-0000-0000-000000000002 (migration 016)
-- ============================================================

INSERT INTO choros.instance_budget
  (tenant_id, id, process_instance_id, currency, ceiling, remaining_cache,
   created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'b0000000-0000-0000-0000-000000000001',
   NULL, 'USD', 100.000000, 100.000000, 0, 0)
ON CONFLICT DO NOTHING;

INSERT INTO choros.agent_budget
  (tenant_id, id, employee_id, window_kind, window_ref, currency,
   ceiling, remaining_cache, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'b1000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002',
   'total', NULL, 'USD', 50.000000, 50.000000, 0, 0)
ON CONFLICT DO NOTHING;
