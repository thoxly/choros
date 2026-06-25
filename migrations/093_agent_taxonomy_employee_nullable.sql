-- 093 · Agent taxonomy + decouple org-place (T-0473, E-AGENTS L1)
--
-- Spec: docs/specs/agent-registry-and-llm-keys.spec.md §3, §4 points 1–2.
--
-- THE ROOT DECOUPLING. Until now EVERY agent had to be an
-- employee(kind='agent') on an org position (migration 032 FK-pinned
-- agent_card.employee_id NOT NULL → employee(tenant_id, id, kind='agent')).
-- A "DeepSeek assistant" or a platform "configurator" had no meaningful
-- org-place, so one had to be invented. This migration splits the THREE
-- orthogonal questions the old single FK conflated:
--   (A) org-place      → employee_id (now OPTIONAL)
--   (B) function       → agent_type  (NEW discriminator)
--   (C) registry id    → id          (NEW surrogate key, org-independent)
--
-- AFTER THIS MIGRATION:
--   * agent_card is the REGISTRY, keyed by its own surrogate (tenant_id, id).
--   * agent_type ∈ {workforce, system, assistant}:
--       - workforce → HAS an org-place (employee_id set); shown in org structure.
--       - system    → acts OVER the platform (configurator/docs/implementation);
--                     no org-place (employee_id may be NULL).
--       - assistant → tenant chat helper; no org-place.
--   * employee_id is NULLable; when set it still discriminates kind='agent' via
--     the composite FK (MATCH SIMPLE: the FK is skipped when employee_id IS NULL,
--     so an org-less agent is permitted — the "partial discriminator").
--
-- ADDITIVE / IDEMPOTENT / APPEND-ONLY:
--   * Next free slot after 092. No new relation (defer-no-new-table / new-relation
--     guards untripped — this only ALTERs the existing 032 agent_card).
--   * Every step guarded (ADD COLUMN IF NOT EXISTS, conditional constraint
--     drop/add) so a re-run is a no-op.
--   * The existing per-tenant UNIQUE (tenant_id, kc_client_id) and the 092 global
--     UNIQUE (kc_client_id) are UNTOUCHED — agent identity for the KC-first hire
--     flow and the cross-tenant resolver is unchanged.
--
-- DATA SAFETY (verified against live data before authoring):
--   The only agent_card writers are the seed migrations (032/044/059/062 — all in
--   the single dev tenant) and insertAgentRows (KC-first hire). All existing rows
--   have employee_id set, so the surrogate id backfill and the new NOT NULL on id
--   apply cleanly. The backfill of agent_type matches the THREE platform seeds by
--   their stable kc_client_id (agent-config / agent-implementation / agent-docs-author).
--   Everything else stays the DEFAULT 'workforce' (recon/invoice/triage/s-ledger/
--   s-ocr keep their org-place — correct, they ARE workforce). assistant-agent is
--   created per-tenant as an EMPLOYEE only (register.ts) and writes NO agent_card
--   row today, so there is nothing to backfill to 'assistant' yet; the value is
--   available for the L2 assistant-card work.

-- ── Step 1: agent_type discriminator (NEW). ───────────────────────────────────
-- NOT NULL DEFAULT 'workforce' so every existing row is a valid workforce agent
-- until the backfill below reclassifies the platform seeds.
ALTER TABLE choros.agent_card
  ADD COLUMN IF NOT EXISTS agent_type text NOT NULL DEFAULT 'workforce';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_card_agent_type_chk'
  ) THEN
    ALTER TABLE choros.agent_card
      ADD CONSTRAINT agent_card_agent_type_chk
      CHECK (agent_type IN ('workforce', 'system', 'assistant'));
  END IF;
END $$;

-- ── Step 2: surrogate registry id (NEW). ──────────────────────────────────────
-- The org-independent identity. DEFAULT gen_random_uuid() backfills existing
-- rows; then pin NOT NULL. pgcrypto's gen_random_uuid is available in pg13+.
ALTER TABLE choros.agent_card
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

-- ── Step 3: make (tenant_id, id) the primary key. ─────────────────────────────
-- Drop the old PK (tenant_id, employee_id) — required so employee_id can become
-- NULLable — and promote the surrogate. No FK in the schema references the old
-- agent_card PK (verified), so this is safe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_card_pkey' AND conrelid = 'choros.agent_card'::regclass
  ) AND NOT EXISTS (
    -- Re-keyed already? (PK now covers id.)
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'choros.agent_card'::regclass AND i.indisprimary
      AND a.attname = 'id'
  ) THEN
    ALTER TABLE choros.agent_card DROP CONSTRAINT agent_card_pkey;
    ALTER TABLE choros.agent_card ADD CONSTRAINT agent_card_pkey PRIMARY KEY (tenant_id, id);
  END IF;
END $$;

-- ── Step 4: employee_id (and its discriminator employee_kind) become OPTIONAL. ─
-- An org-less agent (system/assistant) has employee_id IS NULL. The composite FK
-- agent_card_employee_fk (tenant_id, employee_id, employee_kind) is MATCH SIMPLE,
-- so it is NOT enforced when employee_id IS NULL — this is the "partial FK
-- discriminator": kind='agent' is checked ONLY when an org-place is attached.
--
-- employee_kind KEEPS its DEFAULT 'agent' (a long-standing insert convention —
-- callers that set employee_id omit employee_kind and rely on the default to make
-- the FK target kind='agent'). It only becomes NULLable so an org-less inserter
-- MAY null it; whether an org-less row carries 'agent' (vestigial, FK skipped) or
-- NULL, it is permitted. The relaxed CHECK below admits both.
ALTER TABLE choros.agent_card ALTER COLUMN employee_id   DROP NOT NULL;
ALTER TABLE choros.agent_card ALTER COLUMN employee_kind DROP NOT NULL;

-- Relax the discriminator CHECK so an org-less row may carry employee_kind IS NULL,
-- while an org-attached row pins 'agent' (so the composite FK can only target a
-- kind='agent' row). NOTE: this is intentionally NOT a strict pair-check —
-- employee_kind defaults to 'agent' even for an org-less row whose employee_id is
-- NULL, and the FK (MATCH SIMPLE) is simply skipped there. The discriminator is
-- "preserved only when employee_id is set" (spec §4.2), which MATCH SIMPLE gives.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_card_employee_kind_chk'
  ) THEN
    ALTER TABLE choros.agent_card DROP CONSTRAINT agent_card_employee_kind_chk;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_card_employee_kind_partial_chk'
  ) THEN
    ALTER TABLE choros.agent_card
      ADD CONSTRAINT agent_card_employee_kind_partial_chk
      CHECK (employee_kind IS NULL OR employee_kind = 'agent');
  END IF;
END $$;

-- Preserve "at most one agent_card per employee" now that (tenant_id, employee_id)
-- is no longer the PK. Partial UNIQUE so multiple org-less (NULL employee_id) rows
-- are allowed. Existing code addresses agent_card by (tenant_id, employee_id);
-- this keeps that lookup single-valued.
CREATE UNIQUE INDEX IF NOT EXISTS agent_card_tenant_employee_uq
  ON choros.agent_card (tenant_id, employee_id)
  WHERE employee_id IS NOT NULL;

-- ── Step 5: backfill agent_type for the platform seeds. ───────────────────────
-- Match by stable kc_client_id (044/059/062). Idempotent (re-running re-asserts
-- the same value). Everything not matched stays 'workforce' (correct default for
-- recon/invoice/triage/s-ledger/s-ocr — they have an org-place).
UPDATE choros.agent_card
   SET agent_type = 'system'
 WHERE kc_client_id IN ('agent-config', 'agent-implementation', 'agent-docs-author')
   AND agent_type <> 'system';
