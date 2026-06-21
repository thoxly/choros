-- 087 · Flip telLinear binding to on_create + add field_mapping (E16 T-0356)
--
-- CONTEXT:
--   Migration 085 seeded the telLinear → tel-approval process_app_binding with
--   trigger_type DEFAULT ('launcher'). The launcher path (POST /api/processes/start)
--   looks up the binding by process_key regardless of trigger_type, so it is
--   unaffected by this change. The on_create path (records.ts getOnCreateBinding)
--   requires trigger_type = 'on_create' — without this flip, creating a «Заявки»
--   record does NOT fire the telLinear process start.
--
--   field_mapping {"amount":"amount"} maps the purchases record's `amount` field
--   to the engine variable `amount`; the telLinear DMN evaluates approvalRequired
--   based on amount threshold (>5000000 → needs-approval → доп.согласование,
--   ≤5000000 → standard). Without the mapping the engine starts with no variables
--   and the gateway cannot route correctly.
--
-- WHAT THIS CHANGES (pure UPDATE, zero DDL, zero new tables):
--   binding id a7000000-0000-0000-0000-000000000004 (tenant a0000000-0000-0000-0000-000000000001)
--     trigger_type : 'launcher' → 'on_create'
--     field_mapping: NULL        → '{"amount":"amount"}'
--
-- COMPATIBILITY:
--   The launcher path (POST /api/processes/start / process-start.ts) resolves
--   by process_key — it does NOT filter on trigger_type. Flipping to on_create
--   therefore does NOT break the explicit launch route.
--   The applier (step-applier.ts / resolveInstanceTargetOnClient) also looks up
--   the binding by process_key — trigger_type is irrelevant there too. No applier
--   regression.
--
-- IDEMPOTENT: keyed on the seeded id; re-running is a no-op once already applied.
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
-- binding id       = a7000000-0000-0000-0000-000000000004 (migration 085)

UPDATE choros.process_app_binding
   SET trigger_type  = 'on_create',
       field_mapping = '{"amount":"amount"}'::jsonb,
       updated_at    = 0
 WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
   AND id        = 'a7000000-0000-0000-0000-000000000004';
