-- 086 · Flip «Заявки» (purchases) to a user registry so the step-applier resolves it (E15, T-0362/T-0335)
--
-- CONTEXT:
--   The step-applier's instance→target resolver (src/db/process-instance-resolver.ts,
--   Step 3) selects the PRIMARY registry as the first registry with is_system = FALSE
--   ("the applier writes to user-defined registries"). Migration 076 seeded the
--   tel-approval application's «Заявки» (purchases) and «Согласование» (soglasovanie)
--   registry_def rows BOTH with is_system = TRUE (it marked the whole demo app as
--   system infrastructure). With no non-system registry under the application, the
--   resolver returns reason='no_registry' → applyStepResult fails closed (FF-G3) →
--   approve returns 500 and NO «Согласование» entity is written. Surfaced live once
--   the approve authz gate (T-0362) + binding seed (085) let the applier engage.
--
-- WHAT THIS DOES (pure UPDATE on a seed row, zero DDL, zero new tables):
--   Flip ONLY «Заявки» (purchases) to is_system = FALSE. «Заявки» holds real business
--   data (purchase requests) — it is a user-facing data registry, not infrastructure,
--   so is_system = FALSE is the semantically correct classification. The resolver then
--   returns it as the primary; the applier resolves «Согласование» by slug (unchanged,
--   is_system-agnostic) and writes the approval record. «Согласование» (soglasovanie)
--   stays is_system = TRUE (approvals-infrastructure registry, addressed by slug).
--
-- IDEMPOTENT: a plain UPDATE keyed on the seeded id/slug; re-running is a no-op once
-- the value is already FALSE. Safe to re-apply.
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- purchases (Заявки) registry = a7000000-0000-0000-0000-000000000002 (migration 076)

UPDATE choros.registry_def
   SET is_system = FALSE
 WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
   AND id        = 'a7000000-0000-0000-0000-000000000002'
   AND slug      = 'purchases'
   AND is_system IS DISTINCT FROM FALSE;
