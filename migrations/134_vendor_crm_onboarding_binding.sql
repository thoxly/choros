-- @demo-seed (T-0549): fake reference-company content; skipped when CHOROS_SEED_DEMO=off (clean prod).
-- 134 · vendor-crm onboarding wiring (T-0249 / B-11) — DATA ONLY (case content plane)
--
-- SCOPE — pure INSERT, zero DDL, zero new tables, zero ALTER:
--   Two rows wire the (already-seeded, migration 073) vendor-crm application and
--   its customer-subscription registry into a WORKING dogfood CRM, using ONLY the
--   generic platform primitives:
--     (1) process_app_binding — customer-onboarding process ← vendor-crm app,
--         trigger_type='on_create' so POST /api/records (records.ts) starts the
--         onboarding process the moment a customer record is created (E16 create=
--         start, S1 seam). This is the SAME table/mechanism telLinear uses
--         (migrations 085/087) — no new machinery.
--     (2) list_view — a saved "Клиенты" list over the customer-subscription
--         registry (the CRM list UI is the GENERIC grid, T-0581, reading this
--         view — no bespoke screen).
--
-- ANTI-CASE (D-064): the case content (process key, registry, view columns) lives
-- HERE, in seed data — NOT in generic src/. records.ts / list-views.ts / inbox.ts
-- carry no vendor/customer literal (ci/checks/customer-crm-anti-case.sh).
--
-- trigger_registry_id (migration 122) — REQUIRED here, not optional:
--   customer-subscription is seeded is_system=true (migration 073). The on_create
--   NULL-fallback (getOnCreateBinding / binding-trigger-dao.ts) fires only on the
--   application's PRIMARY registry, defined as the first is_system=FALSE registry.
--   A system registry is never that primary, so WITHOUT an explicit
--   trigger_registry_id this binding would never fire. We pin it to the
--   customer-subscription registry id (a6...0002) so create=start works.
--
-- submit_task_key (migration 121) = 'task-fill-card':
--   On create=start the founder has ALREADY filled the card fields (they are the
--   POST /api/records body). The first userTask «Заполнить карточку клиента»
--   (task-fill-card) is therefore legitimately auto-completable — its data already
--   exists on the record. The instance then waits at «Проверить данные» for a human.
--   (Matches the telLinear task-submit precedent, migration 121.)
--
-- ADDITIVE & IDEMPOTENT:
--   process_app_binding: ON CONFLICT (tenant_id, process_key, application_id) DO NOTHING.
--   list_view:           ON CONFLICT (tenant_id, registry_def_id, name)       DO NOTHING.
--   Runs as choros_migrator (BYPASSRLS) — literal tenant_id, no GUC required
--   (same pattern as 073/085/087).
--
-- Stable UUIDs (DEV_TENANT = a0000000-…-0001, a6 namespace = vendor-crm, migration 073):
--   application    vendor-crm            = a6000000-0000-0000-0000-000000000001
--   registry_def   customer-subscription = a6000000-0000-0000-0000-000000000002
--   process_app_binding (this file)      = a6000000-0000-0000-0000-000000000003
--   list_view «Клиенты» (this file)      = a6000000-0000-0000-0000-000000000004
--
-- Migration slot: 134 (133 is the highest occupied slot at authoring time).

-- (1) process_app_binding: customer-onboarding ← vendor-crm, on_create.
INSERT INTO choros.process_app_binding
  (tenant_id, id, process_key, application_id,
   trigger_type, field_mapping, submit_task_key, trigger_registry_id,
   created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a6000000-0000-0000-0000-000000000003',
   'customer-onboarding',
   'a6000000-0000-0000-0000-000000000001',
   'on_create',
   '{"plan":"plan","not_after":"not_after","status":"status"}'::jsonb,
   'task-fill-card',
   'a6000000-0000-0000-0000-000000000002',
   0, 0)
ON CONFLICT (tenant_id, process_key, application_id) DO NOTHING;

-- (2) list_view «Клиенты»: the CRM list over customer-subscription (generic grid).
--   config columns reference ONLY known record_schema fields (migration 073).
--   source='records' + owner_actor=NULL = the shared tenant-wide records view
--   (migration 130). Bare ON CONFLICT DO NOTHING: the name-uniqueness index is
--   EXPRESSION-based (list_view_name_scoped_uniq, migration 130) so a bare target
--   is not expressible — DO NOTHING (no target) is the idempotent catch-all.
INSERT INTO choros.list_view
  (tenant_id, id, registry_def_id, application_id,
   type, name, is_default, config, source, owner_actor, created_at, updated_at, created_by)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a6000000-0000-0000-0000-000000000004',
   'a6000000-0000-0000-0000-000000000002',
   'a6000000-0000-0000-0000-000000000001',
   'list',
   'Клиенты',
   true,
   '{
      "columns": [
        {"field_key": "company_name",  "visible": true},
        {"field_key": "contact_name",  "visible": true},
        {"field_key": "contact_email", "visible": true},
        {"field_key": "plan",          "visible": true},
        {"field_key": "status",        "visible": true},
        {"field_key": "not_after",     "visible": true}
      ],
      "filters": [],
      "sort": []
    }'::jsonb,
   'records', NULL,
   0, 0,
   'vendor-crm-seed')
ON CONFLICT DO NOTHING;
