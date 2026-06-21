-- 076 · «Согласование» (approvals) registry seed (T-0335 [E15-S1b])
--
-- SCOPE — DATA ONLY (registry-content plane):
--   Seeds the «ТЭЛ Согласования» (procurement-approval) SYSTEM APPLICATION and TWO
--   registry_def rows under the dev tenant:
--     1. «Заявки»        (slug='purchases')      — the PRIMARY record registry that
--        process.started events bind to via process_app_binding.
--     2. «Согласование»  (slug='soglasovanie')   — the APPROVALS registry that
--        applyStepResult (T-0335 step-applier.ts) appends new records into each time
--        a purchase-approval step is completed (A-class step, ADR F1).
--
--   NO DDL — zero table creation. Rides the existing T-0014 tables:
--     application → registry_def (migrations 003/004/005).
--   ci/checks/known_tenant_tables.txt is NOT changed.
--
-- WHY MIGRATION-SEED, NOT ENDPOINT:
--   The applier reads the approvals registry by slug INSIDE the approve tx. The
--   registry must already exist when the first approval fires — the write-API (B-11)
--   is a future task. This follows the I-1-exception pattern (same as 056_*, 059_*,
--   062_*, 073_*): one-directional genesis, idempotent, no app-layer mock.
--
-- ADDITIVE & IDEMPOTENT:
--   application:   INSERT ... ON CONFLICT (tenant_id, slug) DO NOTHING
--   registry_def:  INSERT ... ON CONFLICT (tenant_id, application_id, slug) DO NOTHING
--   Re-running is a no-op; no data is lost.
--   Runs as choros_migrator (BYPASSRLS) — literal tenant_id, no GUC required.
--
-- is_system = true: this is a SYSTEM application (ADR §5 "core/system-directory"
--   class — its core fields are pinned and not deleteable via the UI).
--
-- Stable UUIDs (DEV_TENANT = a0000000-…-0001, namespace a7):
--   application    tel-approval                 = a7000000-0000-0000-0000-000000000001
--   registry_def   purchases (Заявки)           = a7000000-0000-0000-0000-000000000002
--   registry_def   soglasovanie (Согласование)  = a7000000-0000-0000-0000-000000000003

-- Application: tel-approval (ТЭЛ procurement-approval application)
INSERT INTO choros.application
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000001',
   'tel-approval',
   'Согласование заявок (ТЭЛ)',
   'Системное приложение для линейного ТЭЛ-процесса (telLinear / purchase-approval). '
     || 'is_system=true: provisioned via genesis-seed, not deleteable via UI.',
   0, 0)
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Registry 1: «Заявки» — PRIMARY record registry (purchases / applications submitted).
-- This is the registry that process.started events bind to via process_app_binding.
--
-- record_schema: the AUTHORITATIVE schema for the purchase record (T-0345 — the
--   registry is the single source of truth; the live submit path derives the
--   FormDef from this schema via deriveFormDefFromSchema and validates against it).
--
-- T-0364 (deploy-acceptance fix): this schema MUST mirror the canonical purchase
--   form (src/core/form-schema.ts PURCHASE / web/src/forms/form-defs.js). The
--   purchase form (the ТЭЛ «Заявка на закупку») submits these exact field keys —
--   supplier, category, subject, qty, price, due, budget, method, reason, urgent.
--   The previous minimal demo schema (title/amount/requester/status) did NOT match
--   the form, so once T-0345 made the registry govern validation, EVERY purchase
--   field was rejected as UNKNOWN_FIELD → 400 (the validator enforces a closed
--   field set, regardless of additionalProperties). Aligning the schema here makes
--   a real purchase submission valid AND keeps the registry as the single source of
--   truth — the form derives FROM this schema, never the reverse.
--
--   Field-type derivation (field-type-dictionary.deriveFieldType):
--     string + enum[]          → "enum"      (supplier, category, budget, method)
--     string                   → "text"      (subject)
--     number                   → "number"    (qty, price)
--     string + format="date"   → "date"      (due)
--     string + x-choros-widget="textarea" → "textarea" (reason)
--     boolean                  → "boolean"   (urgent)
--   required = [supplier, subject, budget] (mirrors PURCHASE FieldDef.required).
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000002',
   'a7000000-0000-0000-0000-000000000001',
   'purchases',
   'Заявки',
   'Реестр заявок на закупку (PRIMARY, T-0335). Каждая заявка = одна запись; '
     || 'процесс purchase-approval работает с этим реестром как целевым.',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "purchases",
      "type": "object",
      "additionalProperties": true,
      "required": ["supplier", "subject", "budget"],
      "properties": {
        "supplier": {
          "type": "string",
          "title": "Поставщик",
          "enum": ["ООО «Вектор»", "АО «Линия»", "ООО «Стек-Трейд»", "Новый контрагент…"]
        },
        "category": {
          "type": "string",
          "title": "Категория",
          "enum": ["IT-оборудование", "Программное обеспечение", "Услуги", "Канцелярия и АХО"]
        },
        "subject": { "type": "string", "title": "Предмет закупки", "maxLength": 500 },
        "qty": { "type": "number", "title": "Кол-во", "minimum": 1, "maximum": 100000 },
        "price": { "type": "number", "title": "Цена за ед.", "minimum": 0, "maximum": 1000000000 },
        "due": { "type": "string", "format": "date", "title": "Срок поставки" },
        "budget": {
          "type": "string",
          "title": "ЦФО · статья бюджета",
          "enum": ["ИТ-инфраструктура · CAPEX", "Операционные ИТ · OPEX", "Развитие продукта · CAPEX"]
        },
        "method": {
          "type": "string",
          "title": "Способ закупки",
          "enum": ["Прямая", "Тендер", "Рамочный"]
        },
        "reason": {
          "type": "string",
          "title": "Обоснование",
          "x-choros-widget": "textarea",
          "maxLength": 2000
        },
        "urgent": { "type": "boolean", "title": "Срочная закупка" }
      }
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;

-- Registry 2: «Согласование» — APPROVALS registry.
-- applyStepResult (step-applier.ts) resolves this by slug='soglasovanie' under the
-- application and INSERTs one record per completed A-class step. The ref_field
-- 'purchase_ref' (if a cross_app_ref definition exists) links each approval record
-- back to the primary «Заявки» record.
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000003',
   'a7000000-0000-0000-0000-000000000001',
   'soglasovanie',
   'Согласование',
   'Реестр актов согласования (T-0335 step-applier). '
     || 'Каждая запись = один акт согласования шага (A-class, F1 ADR). '
     || 'Ссылка на первичную заявку — поле purchase_ref (cross_app_ref).',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "soglasovanie",
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "decision": {
          "type": "string",
          "enum": ["approve", "reject"],
          "title": "Решение"
        },
        "approved_by": { "type": "string", "title": "Согласовал" },
        "purchase_ref": {
          "type": "string",
          "title": "Ссылка на заявку (cross_app_ref)"
        },
        "comment": { "type": "string", "title": "Комментарий" }
      }
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;
