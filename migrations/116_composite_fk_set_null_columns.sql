-- 116 · Fix composite-FK `ON DELETE SET NULL` nulling tenant_id (schema defect,
--       discovered empirically while authoring T-0574's live-Postgres tests)
--
-- THE DEFECT. Three tenant-scoped composite FKs declare a bare `ON DELETE SET
-- NULL`:
--
--   094  agent_card_llm_connection_fk    (tenant_id, llm_connection_id) → llm_connection
--   107  spend_ledger_llm_connection_fk  (tenant_id, llm_connection_id) → llm_connection
--   113  application_section_fk          (tenant_id, section_id)        → section
--
-- On a composite FK, a bare SET NULL nulls EVERY referencing column — including
-- tenant_id, which is NOT NULL on all three child tables. So the declared action
-- can never actually run: deleting a referenced llm_connection/section row aborts
-- with `null value in column "tenant_id" ... violates not-null constraint`
-- (reproduced live in ci/checks/db/llm-connection-fk-set-null.test.ts).
--
-- Today the defect is DORMANT everywhere:
--   * llm_connection has NO delete path yet (routes are GET/POST only) — but the
--     first DELETE route/script would 500 on any profile referenced by an
--     agent_card or spend_ledger row.
--   * sections.ts deleteSection() detaches applications explicitly BEFORE the
--     DELETE, side-stepping the FK action it (wrongly) assumed would work.
--
-- THE FIX. PostgreSQL 15+ column-specific referential action:
--   `ON DELETE SET NULL (<child-col>)` nulls ONLY the named column(s); tenant_id
-- is left untouched and the (tenant_id, NULL) pair drops out of MATCH SIMPLE
-- enforcement — exactly the intended "child loses the link, keeps its tenant"
-- semantics. The project pins postgres:16 everywhere (docker-compose*.yml,
-- .github/workflows/ci.yml), so the syntax is safe.
--
-- ADDITIVE / IDEMPOTENT:
--   * Next free slot after 115.
--   * Each block: drop the constraint ONLY if it exists in the defective
--     all-columns form (pg_constraint.confdelsetcols IS NULL / empty = bare SET
--     NULL), then (re)create it with the column list ONLY if absent. A re-run —
--     or a DB where the constraint was already created correctly — is a no-op.
--   * No data change; ADD CONSTRAINT re-validates existing rows, which were
--     valid under the identical FK columns/target before (small tables).
--   * Referenced tables are guaranteed present: 094 creates llm_connection and
--     113 creates section unconditionally, both before 116.

-- ── 1/3: agent_card_llm_connection_fk (migration 094) ─────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'agent_card_llm_connection_fk'
      AND conrelid = 'choros.agent_card'::regclass
      AND (confdelsetcols IS NULL OR cardinality(confdelsetcols) = 0)
  ) THEN
    ALTER TABLE choros.agent_card
      DROP CONSTRAINT agent_card_llm_connection_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'agent_card_llm_connection_fk'
      AND conrelid = 'choros.agent_card'::regclass
  ) THEN
    ALTER TABLE choros.agent_card
      ADD CONSTRAINT agent_card_llm_connection_fk
      FOREIGN KEY (tenant_id, llm_connection_id)
      REFERENCES choros.llm_connection (tenant_id, id)
      ON DELETE SET NULL (llm_connection_id);
  END IF;
END
$$;

-- ── 2/3: spend_ledger_llm_connection_fk (migration 107) ───────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'spend_ledger_llm_connection_fk'
      AND conrelid = 'choros.spend_ledger'::regclass
      AND (confdelsetcols IS NULL OR cardinality(confdelsetcols) = 0)
  ) THEN
    ALTER TABLE choros.spend_ledger
      DROP CONSTRAINT spend_ledger_llm_connection_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'spend_ledger_llm_connection_fk'
      AND conrelid = 'choros.spend_ledger'::regclass
  ) THEN
    ALTER TABLE choros.spend_ledger
      ADD CONSTRAINT spend_ledger_llm_connection_fk
      FOREIGN KEY (tenant_id, llm_connection_id)
      REFERENCES choros.llm_connection (tenant_id, id)
      ON DELETE SET NULL (llm_connection_id);
  END IF;
END
$$;

-- ── 3/3: application_section_fk (migration 113) ───────────────────────────────
-- After this fix the FK action finally matches what sections.ts deleteSection()
-- documents ("the composite FK ON DELETE SET NULL would also do this") — the
-- explicit pre-detach there remains as a visible-contract redundancy, no longer
-- a load-bearing workaround.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'application_section_fk'
      AND conrelid = 'choros.application'::regclass
      AND (confdelsetcols IS NULL OR cardinality(confdelsetcols) = 0)
  ) THEN
    ALTER TABLE choros.application
      DROP CONSTRAINT application_section_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'application_section_fk'
      AND conrelid = 'choros.application'::regclass
  ) THEN
    ALTER TABLE choros.application
      ADD CONSTRAINT application_section_fk
      FOREIGN KEY (tenant_id, section_id)
      REFERENCES choros.section (tenant_id, id)
      ON DELETE SET NULL (section_id);
  END IF;
END
$$;
