-- 057 · agent_instruction (T-0123 E5 / competence layer) — per-agent competence
-- instruction ("должностная инструкция"): the versioned CONFIG artifact that
-- holds how an agent interprets a task and forms its answer. Day-1 SCHEMA ONLY;
-- runtime-dormant (the LLM consumer is Stage-2 E5.6–E5.10).
--
-- Implements docs/design/T-0123-agent-competency-layer.adr.md §1/§2/§3.
--
-- ADDITIVE TO T-0020 (FF-COMP-1): this is a NEW table — it does NOT touch
-- 032_agent_card.sql and adds NO column to agent_card / employee. The 032 DDL
-- deliberately reserved this seam ("NO prompt/instruction column here — the
-- competence layer (T-0123) adds it via additive migration").
--
-- VERSIONING REUSES T-0087 VERBATIM (FF-COMP-3, NF-1): the table carries the SAME
-- `tier text NOT NULL DEFAULT 'draft' CHECK (tier IN ('draft','published'))` column
-- contract as 049_tier.sql, and the SAME fail-closed published-lock trigger function
-- choros.tier_published_locked() (defined in 049) is attached here. T-0123 introduces
-- NO tier values, NO promote service, NO lock mechanism and NO promote audit type of
-- its own. Promote draft→published runs through the existing
-- POST /api/artifacts/:id/promote → promoteTier → decidePromote (agent-self-promote
-- forbidden), for which agent_instruction is registered in CONFIG_TABLES
-- (src/http/artifacts.ts). NOTE on FF-1 (tier-isolation.sh): that check requires the
-- ALTER-TABLE-ADD-COLUMN tier idiom for tables in tier_bearing_tables.txt — which is
-- the 049 in-place pattern. agent_instruction is a NEW table whose tier column is
-- inline in CREATE TABLE, so it is intentionally NOT listed in tier_bearing_tables.txt;
-- FF-COMP-3 (agent-instruction-tier-reuse.sh) verifies the inline-CREATE tier contract.
--
-- FR-2 ENFORCEMENT — instruction only for kind='agent' (same composite-FK idiom as
-- 032): employee_kind column pinned by CHECK = 'agent', FK
-- (tenant_id, employee_id, employee_kind) -> employee(tenant_id, id, kind). A row can
-- only reference an employee whose kind='agent'; pointing at a kind='human' row
-- violates the FK (employee_tenant_id_id_kind_key UNIQUE was added by 032). No trigger.
--
-- DEFERRED FK (T-0017/T-0033/032 lesson — an impossible FK fails to apply = BUILD
-- bounce): bundle_id is a forward-compat pointer to the coherence bundle
-- (E12.1/T-0082). T-0082 has NOT landed (no `bundle` table). Column is uuid NULL with
-- NO FK; T-0082 adds the FK additively (mirrors 032 escalation_rule_id). (AC-4)
--
-- TENANT-TABLE CONTRACT (T-0013, verbatim as in 032_agent_card.sql / 058):
--   tenant_id leading PK, ENABLE+FORCE RLS, isolation policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT, listed in ci/checks/known_tenant_tables.txt.
--   Composite tenant-leading FK ⇒ cross-tenant reference is structurally impossible.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner skips
--   via schema_migrations; repeating this file is safe. NO seed instructions ("no
--   instruction" = absence of a row, AC-10); any future seed INSERT must be
--   ON CONFLICT DO NOTHING.
--
-- Migration slot: 057 (056 and 058 are taken; the ADR contracts reference 057).

CREATE TABLE IF NOT EXISTS choros.agent_instruction (
  tenant_id         uuid    NOT NULL,                       -- T-0013 leading key; RLS anchor
  id                uuid    NOT NULL,                        -- artifact id (target for POST /api/artifacts/:id/promote)
  employee_id       uuid    NOT NULL,                        -- the owning agent
  employee_kind     text    NOT NULL DEFAULT 'agent',        -- FK discriminator; pinned to 'agent' by CHECK (032 idiom)
  tier              text    NOT NULL DEFAULT 'draft',        -- T-0087/049 contract; CHECK below
  instruction_text  text    NOT NULL,                        -- main competence text (AC-1)
  answer_form       text    NULL,                            -- answer-form param ('sum'/'sum_with_breakdown'/…); NULL = unset
  instruction_meta  jsonb   NOT NULL DEFAULT '{}'::jsonb,    -- extensible envelope of extra form params (no migration per case)
  bundle_id         uuid    NULL,                            -- forward-compat pointer to E12.1/T-0082 bundle; NO FK day-1 (dormant)
  created_at        bigint  NOT NULL,
  updated_at        bigint  NOT NULL,

  -- Promotable-artifact idiom: promoteTier addresses the row by (tenant_id, id).
  PRIMARY KEY (tenant_id, id),

  -- One instruction artifact per agent (one row carries its own tier;
  -- draft↔published is the column value, not a second row).
  UNIQUE (tenant_id, employee_id),

  -- T-0087 tier contract — EXACTLY the 049 literal set.
  CONSTRAINT agent_instruction_tier_check
    CHECK (tier IN ('draft','published')),

  -- Only kind='agent' employees may own an instruction (FR-2).
  CONSTRAINT agent_instruction_employee_kind_chk
    CHECK (employee_kind = 'agent'),

  -- Composite tenant-leading FK into employee's (tenant_id, id, kind) UNIQUE (032):
  -- references only kind='agent'; cross-tenant reference is structurally impossible.
  CONSTRAINT agent_instruction_employee_fk
    FOREIGN KEY (tenant_id, employee_id, employee_kind)
    REFERENCES choros.employee(tenant_id, id, kind)
);

ALTER TABLE choros.agent_instruction ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.agent_instruction FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros' AND tablename = 'agent_instruction'
      AND policyname = 'agent_instruction_tenant_isolation'
  ) THEN
    CREATE POLICY agent_instruction_tenant_isolation ON choros.agent_instruction
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.agent_instruction TO choros_app;

-- Published-lock (FF-COMP-7, AC-5) — REUSE the T-0087 trigger function from 049.
-- Fail-closed: direct UPDATE/DELETE of a published row is forbidden unless the
-- transaction set choros.promoting='1' (only promoteTier does). This is the SAME
-- CREATE TRIGGER … EXECUTE FUNCTION choros.tier_published_locked() as application/grant.
DROP TRIGGER IF EXISTS tier_published_locked ON choros.agent_instruction;
CREATE TRIGGER tier_published_locked
  BEFORE UPDATE OR DELETE ON choros.agent_instruction
  FOR EACH ROW EXECUTE FUNCTION choros.tier_published_locked();

-- NO seed instructions — "no instruction" (AC-10) is the absence of a row. No
-- existing agent_card / employee row is changed by this migration.
