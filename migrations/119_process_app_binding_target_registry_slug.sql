-- 119 · process_app_binding.target_registry_slug (T-0575 [W1/деТЭЛ] BUG-017)
--
-- ADR-T0575-detel-primitives.md §2.3: the step-applier (src/db/step-applier.ts
-- applyStepResult) resolves the target registry for a completed step's result
-- ENTITY (today: the «Согласование» record) by a buffer literal
-- `SOGLASOVANIE_SLUG = "soglasovanie"` — a single, process-agnostic slug baked
-- into the code. Any process bound to an application whose approvals registry
-- is NOT named "soglasovanie" cannot resolve a target at all (fail-closed
-- throw, FF-G3) — the slug must become PER-(process,app) CONFIGURATION, not a
-- code constant.
--
-- WHY process_app_binding (not form_binding/045, not a new table): 075 already
-- links (process_key, application_id) — the natural owner of "which registry
-- does THIS process's step-result belong to under THIS app". form_binding
-- (045) is the FIELD-CONTRACT table (process_key, form_key); conflating the
-- two would break its natural key (D-056 additive discipline; ADR §2.3 /
-- rejected alternative B1). A new dedicated table (rejected alternative B2)
-- would be a new RLS surface + migration + DAO for a single 1:1 scalar
-- attribute of an existing owning row — disproportionate.
--
-- NULL-SEMANTICS (additive, backward-compatible):
--   NULL      = "use the default step-result slug" — resolves via the
--               config-primitive resolveDefaultStepResultSlug() (env
--               CHOROS_DEFAULT_STEP_RESULT_SLUG, defaulting to "soglasovanie"
--               for exact ТЭЛ-compatibility). EVERY row that existed before
--               this migration is NULL — zero behavior change for them.
--   non-NULL  = the literal registry_def.slug under this binding's
--               application_id that step-applier resolves into (per-process
--               configuration, replacing the single code-wide constant).
--
-- ADDITIVE ONLY: ALTER TABLE ... ADD COLUMN IF NOT EXISTS on the EXISTING
-- tenant table choros.process_app_binding (075). No new table, no new RLS
-- policy, no row touched. The existing RLS predicate
-- (process_app_binding_tenant_isolation) is NOT modified.
--
-- known_tenant_tables.txt: NOT modified (process_app_binding already listed).
--
-- FROZEN-CHECK SANCTION:
--   dual-control-isolation.sh (FF-DC7): 119 ALTERs a known tenant table, which
--   triggers FF-DC7. Additive relief for this migration (T0575-DC-MIG119-GUARD)
--   is appended to that check, mirroring the 082/109/115/116/117 precedent
--   (ADD COLUMN on an existing table, no dual-control authority domain touched:
--   no grant/confirmation/confirmed2_by column involved).
--   defer-no-new-table.sh Check-2: no CREATE TABLE statement here — only
--   ADD COLUMN — so Check-2 does not apply, no relief needed.
--   Check-1 also does not apply: known_tenant_tables.txt is unchanged.
--
-- TEL DATA (not code): the second statement below sets the ТЭЛ
-- process_app_binding row (085 seed, telLinear → tel-approval) to the explicit
-- literal 'soglasovanie' — the SAME value the NULL default already resolves
-- to. This is a data-completeness statement (ADR §3: "ТЭЛ-binding получает
-- target=soglasovanie ДАННЫМИ"), not a behavior change; it makes the ТЭЛ
-- config-as-data intent explicit and observable in the row itself rather than
-- implicit via the NULL default. Idempotent (plain UPDATE, no-op if the 085
-- seed row is absent, e.g. CHOROS_SEED_DEMO=off).
--
-- Idempotency (NF-1): ADD COLUMN IF NOT EXISTS; the UPDATE is a no-op re-apply.
-- Migration slot: 119 (117 is the highest slot on origin/dev at rebase time;
-- 118 was not yet present — ADR-T0575 §4/D1 sanctions using 119 directly, the
-- orchestrator-reserved slot, rather than renumbering to 118).

ALTER TABLE choros.process_app_binding
  ADD COLUMN IF NOT EXISTS target_registry_slug text NULL;

-- @demo-seed-adjacent data completion (non-DDL, no-op when the 085 seed row is
-- absent): make the ТЭЛ binding's target-registry explicit as DATA. Safe under
-- CHOROS_SEED_DEMO=off (no-op UPDATE touching zero rows when 085 never ran).
UPDATE choros.process_app_binding
   SET target_registry_slug = 'soglasovanie'
 WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
   AND process_key = 'telLinear'
   AND application_id = 'a7000000-0000-0000-0000-000000000001'
   AND target_registry_slug IS NULL;
