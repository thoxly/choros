-- 094 · LLM connection registry (T-0474, E-AGENTS L2)
--
-- Spec: docs/specs/agent-registry-and-llm-keys.spec.md §4 point 3, §8 L2.
--
-- THE L2 DECOUPLING. Until now the LLM config lived inline on agent_card
-- (llm_endpoint / llm_model / llm_secret_handle, migration 032) — one config per
-- agent, no way to name a reusable connection profile, no place for price/currency.
-- This migration introduces NAMED, tenant-isolated connection profiles
-- (choros.llm_connection) and points agent_card at one via a NULLable FK.
--
--   (A) connection profile  → llm_connection (NEW, tenant-isolated, RLS)
--   (B) agent → profile      → agent_card.llm_connection_id (NEW NULLable FK)
--   (C) legacy inline config → agent_card.llm_endpoint/llm_model/llm_secret_handle
--                              DEPRECATED (kept for the transition; readers fall
--                              back to them when llm_connection_id IS NULL).
--
-- SECRET CUSTODY (spec NOTE / RL-3): secret_handle is an OPAQUE REFERENCE
-- (app://<id> / env://<NAME> / vault://<path>), NEVER a raw key. The app://
-- encrypted store (app_secret) and AEAD resolution are L3 (a later migration) —
-- this table only carries the handle column, same custody class as the existing
-- agent_card.llm_secret_handle.
--
-- ADDITIVE / IDEMPOTENT / APPEND-ONLY:
--   * Next free slot after 093 (no sibling takes 094).
--   * Same tenant-table contract as 016_employee / 032_agent_card / 034_budget:
--     tenant_id leading PK column, ENABLE+FORCE RLS, tenant-isolation policy on
--     current_setting('choros.tenant_id', true)::uuid, choros_app DML grant,
--     listed in ci/checks/known_tenant_tables.txt.
--   * Every step guarded (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--     conditional policy/constraint creation) so a re-run is a no-op.
--   * The legacy llm_* columns are KEPT (not dropped) — readers still fall back to
--     them while live data migrates and while older agent_card writers exist. They
--     are DEPRECATED in favour of the connection profile (see column comments).

-- ── Step 1: the llm_connection table (NEW, tenant-isolated). ───────────────────
-- A named, reusable LLM connection profile. Many agent_card rows may point at one
-- profile; the tenant's assistant references a DEFAULT profile (is_default).
CREATE TABLE IF NOT EXISTS choros.llm_connection (
  tenant_id             uuid    NOT NULL,
  id                    uuid    NOT NULL DEFAULT gen_random_uuid(),
  name                  text    NOT NULL,                 -- human label, e.g. "DeepSeek (prod)"
  provider              text    NOT NULL,                 -- deepseek | openai | anthropic | self-hosted | other
  endpoint              text    NULL,                     -- OpenAI-compatible base URL (https); NULL = not yet set
  model                 text    NULL,                     -- model id, e.g. "deepseek-chat"
  secret_handle         text    NULL,                     -- RL-3 OPAQUE handle (app:///env:///vault://), NEVER a raw key
  price_input_per_1k    numeric(12,6) NULL,               -- cost per 1k input tokens (display/accounting; L5)
  price_output_per_1k   numeric(12,6) NULL,               -- cost per 1k output tokens
  currency              text    NOT NULL DEFAULT 'USD',   -- ISO-4217-ish currency code for the prices above
  is_default            boolean NOT NULL DEFAULT false,   -- the tenant's default profile (assistant uses it)
  created_by            text    NULL,                     -- actor slug/sub that created the profile (audit hint)
  created_at            bigint  NOT NULL,
  updated_at            bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT llm_connection_provider_chk
    CHECK (provider IN ('deepseek', 'openai', 'anthropic', 'self-hosted', 'other')),
  CONSTRAINT llm_connection_name_nonempty_chk
    CHECK (length(btrim(name)) > 0)
);

-- At most ONE default profile per tenant. Partial UNIQUE so non-default rows are
-- unconstrained; the application flips the previous default off when setting a new one.
CREATE UNIQUE INDEX IF NOT EXISTS llm_connection_one_default_per_tenant
  ON choros.llm_connection (tenant_id)
  WHERE is_default;

ALTER TABLE choros.llm_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.llm_connection FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'llm_connection'
      AND policyname = 'llm_connection_tenant_isolation'
  ) THEN
    CREATE POLICY llm_connection_tenant_isolation ON choros.llm_connection
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.llm_connection TO choros_app;

-- ── Step 2: agent_card.llm_connection_id → FK to llm_connection (NULLable). ────
-- An agent may reference a named connection profile. NULL = no profile yet → the
-- reader falls back to the DEPRECATED inline columns (transition compatibility).
-- Composite FK (tenant_id, llm_connection_id) → llm_connection(tenant_id, id):
-- tenant-scoped, MATCH SIMPLE so it is skipped when llm_connection_id IS NULL.
ALTER TABLE choros.agent_card
  ADD COLUMN IF NOT EXISTS llm_connection_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_card_llm_connection_fk'
  ) THEN
    ALTER TABLE choros.agent_card
      ADD CONSTRAINT agent_card_llm_connection_fk
      FOREIGN KEY (tenant_id, llm_connection_id)
      REFERENCES choros.llm_connection (tenant_id, id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS agent_card_llm_connection_idx
  ON choros.agent_card (tenant_id, llm_connection_id)
  WHERE llm_connection_id IS NOT NULL;

-- ── Step 3: deprecate the inline llm_* columns (KEEP for transition). ──────────
-- They are NOT dropped: existing readers (agent-card-llm.ts, agent-provision.ts,
-- run-precheck.ts) still fall back to them when no connection profile is attached,
-- and the KC-first agent-hire path still writes them. The fallback is removed in a
-- later cleanup migration once all readers resolve through llm_connection_id.
COMMENT ON COLUMN choros.agent_card.llm_endpoint IS
  'DEPRECATED (094): use llm_connection_id → llm_connection.endpoint. Kept for transition; reader fallback only.';
COMMENT ON COLUMN choros.agent_card.llm_model IS
  'DEPRECATED (094): use llm_connection_id → llm_connection.model. Kept for transition; reader fallback only.';
COMMENT ON COLUMN choros.agent_card.llm_secret_handle IS
  'DEPRECATED (094): use llm_connection_id → llm_connection.secret_handle (RL-3 opaque handle). Kept for transition.';

-- ── Step 4: MIGRATE existing inline LLM config → a generated profile per agent. ─
-- For every agent_card that has ANY inline LLM field set AND is not yet pointed at
-- a profile, generate ONE llm_connection profile and point the card at it. The
-- provider is inferred from the endpoint host (deepseek/openai/anthropic), else
-- 'other'. The opaque secret_handle is carried VERBATIM (never decoded — RL-3).
--
-- A per-row loop (not a set-based join) so each card maps to its OWN freshly-
-- generated profile id deterministically — two cards with identical inline config
-- still get two distinct profiles, never a cross-match. Idempotent: the
-- llm_connection_id IS NULL guard makes a re-run a no-op (already-migrated cards
-- are skipped). At authoring time the only inline-configured cards are per-tenant
-- assistant/agent rows set via the T-0382 llm-config route; seeds leave them NULL,
-- so this loop is empty on a fresh dev DB and only fires where a tenant actually
-- configured a key.
DO $$
DECLARE
  rec        RECORD;
  new_conn_id uuid;
  prov       text;
BEGIN
  FOR rec IN
    SELECT ac.tenant_id, ac.id AS card_id,
           ac.llm_endpoint, ac.llm_model, ac.llm_secret_handle
      FROM choros.agent_card ac
     WHERE ac.llm_connection_id IS NULL
       AND (ac.llm_endpoint IS NOT NULL
            OR ac.llm_model IS NOT NULL
            OR ac.llm_secret_handle IS NOT NULL)
  LOOP
    prov := CASE
      WHEN rec.llm_endpoint ILIKE '%deepseek%'  THEN 'deepseek'
      WHEN rec.llm_endpoint ILIKE '%openai%'    THEN 'openai'
      WHEN rec.llm_endpoint ILIKE '%anthropic%' THEN 'anthropic'
      ELSE 'other'
    END;

    new_conn_id := gen_random_uuid();

    INSERT INTO choros.llm_connection
      (tenant_id, id, name, provider, endpoint, model, secret_handle,
       price_input_per_1k, price_output_per_1k, currency, is_default,
       created_by, created_at, updated_at)
    VALUES
      (rec.tenant_id, new_conn_id, 'Migrated from agent_card', prov,
       rec.llm_endpoint, rec.llm_model, rec.llm_secret_handle,
       NULL, NULL, 'USD', false, 'migration-094', 0, 0);

    UPDATE choros.agent_card
       SET llm_connection_id = new_conn_id
     WHERE tenant_id = rec.tenant_id
       AND id        = rec.card_id;
  END LOOP;
END
$$;
