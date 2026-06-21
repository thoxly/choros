-- 085 · telLinear → tel-approval process_app_binding seed (E15 step→entity last mile, T-0362/T-0335)
--
-- CONTEXT:
--   The approve step-applier (src/db/step-applier.ts applyStepResult) resolves a
--   process instance to its target application via choros.process_app_binding
--   (resolveInstanceTargetOnClient: process.started.proc_key → application_id).
--   Migration 076 seeded the «tel-approval» application + its «Заявки» (purchases)
--   and «Согласование» (soglasovanie) registry_def rows, but NO binding row linked
--   the telLinear process to that application. With the binding table empty,
--   resolveInstanceTarget returns reason='no_app_binding' → the applier SKIPS (no
--   «Согласование» record is written on approve). This was surfaced live on the
--   deployed E15 honest-gate once the approve authz gate (T-0362) started returning
--   200: the approve succeeded but no entity row landed.
--
-- WHAT THIS ADDS (pure INSERT, zero DDL, zero new tables):
--   One binding row: process_key='telLinear' → application_id=tel-approval.
--   trigger_type defaults to 'launcher' (telLinear is started explicitly via the
--   launch affordance / POST /api/processes/start — NOT on_create, so this does NOT
--   engage the create=start path, which is a separate effort). This gives the
--   applier the instance→application→registry resolution it needs to write the
--   «Согласование» entity on approve.
--
-- IDEMPOTENT: ON CONFLICT on the natural key (tenant_id, process_key, application_id)
-- DO NOTHING. Safe to re-apply.
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- tel-approval application = a7000000-0000-0000-0000-000000000001 (migration 076)
-- binding id               = a7000000-0000-0000-0000-000000000004 (next in a7 namespace)

INSERT INTO choros.process_app_binding
  (tenant_id, id, process_key, application_id, created_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'a7000000-0000-0000-0000-000000000004',
    'telLinear',
    'a7000000-0000-0000-0000-000000000001',
    0, 0
  )
ON CONFLICT (tenant_id, process_key, application_id) DO NOTHING;
