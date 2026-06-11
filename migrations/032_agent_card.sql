-- 032 · agent_card (T-0020 E5.1) — per-agent card: BYO-LLM config + control
-- parameters for employee(kind='agent') rows. Day-1 SCHEMA ONLY; runtime-dormant.
--
-- RUN SEAM (ADR §4): 031 is taken by T-0044 (grant_confirmed2_by). T-0020 uses 032.
-- 034-035 reserved for T-0023 (budget), 036+ for other tasks. Lexicographic order
-- in run.mjs makes 032 append additively after the org foundation (013-016).
--
-- Same tenant-table contract as 016_employee.sql / 017_data_classification.sql:
--   tenant_id leading PK, ENABLE+FORCE RLS, tenant-isolation policy on
--   current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--   listed in ci/checks/known_tenant_tables.txt.
--
-- FR-2 ENFORCEMENT — card only for kind='agent':
--   A plain FK to employee(tenant_id, id) cannot restrict on kind. We use the
--   DB-native composite-FK-into-a-redundant-key idiom:
--     1. Add UNIQUE (tenant_id, id, kind) on choros.employee (additive, safe — a
--        superset of the existing (tenant_id, id) PK; no data change).
--     2. agent_card carries a generated/stored `employee_kind` column pinned by
--        CHECK (employee_kind = 'agent').
--     3. FK (tenant_id, employee_id, employee_kind) -> employee(tenant_id, id, kind).
--   Net effect: a row can only reference an employee whose kind='agent'; pointing
--   at a kind='human' row violates the FK (PG error 23503). No trigger needed.
--
-- DEFERRED FKs (T-0017/T-0033 lesson — an impossible FK fails to apply = BUILD
-- bounce):
--   * budget_policy_id -> instance_budget(...) is NOT declared here: T-0023 has
--     not landed (no instance_budget table). Column is uuid NULL; T-0023 (or a
--     follow-up migration) adds the FK additively. (FR-9 / AC-16)
--   * escalation_rule_id has NO target table at all yet. Column is uuid NULL with
--     NO FK; the future escalation-rule task adds it. (FR-8 / AC-17)
--
-- EXTENSIBILITY (product-audit 2026-06-11 seam): NO prompt/instruction column
-- here — the competence layer (T-0123) adds it via additive migration. The table
-- is deliberately narrow so T-0123 / Stage-2 (confidence_source, autonomy_floor)
-- land as ALTER TABLE ADD COLUMN without touching this DDL.

-- Step 1: additive UNIQUE on employee to make (tenant_id, id, kind) FK-targetable.
ALTER TABLE choros.employee
  ADD CONSTRAINT employee_tenant_id_id_kind_key UNIQUE (tenant_id, id, kind);

-- Step 2: the agent_card table.
CREATE TABLE choros.agent_card (
  tenant_id          uuid NOT NULL,
  employee_id        uuid NOT NULL,
  employee_kind      text NOT NULL DEFAULT 'agent',  -- pinned to 'agent' by CHECK; FK discriminator
  kc_client_id       text NOT NULL,                  -- Keycloak service-account clientId (T-0054 §3.5 linkage seam)
  llm_endpoint       text NULL,                       -- BYO-LLM base URL; NULL = not configured (dormant)
  llm_model          text NULL,                       -- model id; NULL = not configured (dormant)
  llm_secret_handle  text NULL,                       -- RL-3 OPAQUE handle, never a raw key (NF-3, T-0025 owns lifecycle)
  autonomy_threshold numeric(5,4) NULL,               -- soft gate [0,1]; NULL = dormant (E5.7 enforces, Stage-2)
  budget_policy_id   uuid NULL,                        -- FK -> instance_budget deferred to T-0023 (FR-9)
  escalation_rule_id uuid NULL,                        -- NO FK (target table absent yet) (FR-8)
  created_at         bigint NOT NULL,
  updated_at         bigint NOT NULL,
  PRIMARY KEY (tenant_id, employee_id),
  UNIQUE (tenant_id, kc_client_id),
  CONSTRAINT agent_card_employee_kind_chk
    CHECK (employee_kind = 'agent'),
  CONSTRAINT agent_card_autonomy_threshold_chk
    CHECK (autonomy_threshold IS NULL OR (autonomy_threshold >= 0 AND autonomy_threshold <= 1)),
  CONSTRAINT agent_card_employee_fk
    FOREIGN KEY (tenant_id, employee_id, employee_kind)
    REFERENCES choros.employee(tenant_id, id, kind)
);

ALTER TABLE choros.agent_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.agent_card FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_card_tenant_isolation ON choros.agent_card
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.agent_card TO choros_app;

-- Dev silo seed — the 5 agent employees from 016_employee.sql.
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- employee UUIDs (suffix): a-recon=0002, a-invoice=0003, a-triage=0006,
--                          s-ledger=0011, s-ocr=0012
-- kc_client_id: a-* agents use the T-0054 service-account clientIds (agent-<slug-tail>);
--   s-ledger/s-ocr have no KC client yet (T-0042 provisions) — seeded with their slug
--   as a placeholder. UNIQUE (tenant_id, kc_client_id) accepts these.
-- LLM fields + autonomy_threshold are NULL (dormant). Idempotent via ON CONFLICT.
INSERT INTO choros.agent_card
  (tenant_id, employee_id, employee_kind, kc_client_id,
   llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold,
   budget_policy_id, escalation_rule_id, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'agent', 'agent-recon',   NULL, NULL, NULL, NULL, NULL, NULL, 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003', 'agent', 'agent-invoice', NULL, NULL, NULL, NULL, NULL, NULL, 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000006', 'agent', 'agent-triage',  NULL, NULL, NULL, NULL, NULL, NULL, 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000011', 'agent', 's-ledger',      NULL, NULL, NULL, NULL, NULL, NULL, 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000012', 'agent', 's-ocr',         NULL, NULL, NULL, NULL, NULL, NULL, 0, 0)
ON CONFLICT DO NOTHING;
