-- @demo-seed (T-0549): fake reference-company content; skipped when CHOROS_SEED_DEMO=off (clean prod).
-- 073 · vendor-crm seed (T-0244 / ADR §5 I-1-exception)
--
-- SCOPE — DATA ONLY (registry-content plane):
--   Provisions the system application `vendor-crm` and its system registry_def
--   `customer-subscription` (record_schema JSON Schema draft-07) into the
--   founder tenant. No DDL, no new tables — rides the existing T-0014 tables
--   (application → registry_def → record, migrations 003/004/005).
--
-- WHY MIGRATION-SEED, NOT ENDPOINT:
--   The application/registry_def write-path (REST endpoints) does not yet exist
--   in src/ — endpoints for org-plane (employees/roles/etc.) exist via T-0140,
--   but registry-content write-API is a separate out-of-envelope task (B-11).
--   This seed follows the documented I-1-exception pattern (same as 056_*,
--   059_*, 062_*): ONE-DIRECTIONAL genesis, idempotent, no app-layer mock.
--
-- ADDITIVE & IDEMPOTENT:
--   application:   INSERT ... ON CONFLICT (tenant_id, slug) DO NOTHING
--   registry_def:  INSERT ... ON CONFLICT (tenant_id, application_id, slug) DO NOTHING
--   Re-running is a no-op; no data is lost.
--   Runs as choros_migrator (BYPASSRLS) — literal tenant_id, no GUC required
--   (same pattern as 044_*, 056_*, 059_*).
--
-- is_system = true: vendor-crm is a SYSTEM application (authoring-redlines.ts §5
--   "core/system-directory" class — its core fields are pinned by the floor).
--
-- Stable UUIDs (DEV_TENANT = a0000000-…-0001):
--   application    vendor-crm              = a6000000-0000-0000-0000-000000000001
--   registry_def   customer-subscription   = a6000000-0000-0000-0000-000000000002

-- Application: vendor-crm
INSERT INTO choros.application
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a6000000-0000-0000-0000-000000000001',
   'vendor-crm',
   'Vendor / CRM',
   'Vendor-side CRM for managing B2B customer subscriptions (T-0244 dogfood). '
     || 'is_system=true: provisioned via genesis-seed, not deleteable via UI.',
   0, 0)
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Registry: customer-subscription (record_schema = JSON Schema draft-07)
-- additionalProperties: false (structural injection guard, ADR §3.1)
-- status enum embedded in data (T-0014 model: status is record field, not column)
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a6000000-0000-0000-0000-000000000002',
   'a6000000-0000-0000-0000-000000000001',
   'customer-subscription',
   'Клиент / Подписка',
   'Запись клиента B2B: тариф, статус подписки, онбординг-процесс, ключ активации. '
     || 'Статус управляется status-машиной (customerStatusModel). '
     || 'circuit_id/activation_key_issued_at — только процессный актор (field-grant §3.5).',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "customer-subscription",
      "type": "object",
      "additionalProperties": false,
      "required": ["company_name", "contact_name", "contact_email", "plan", "not_after", "status"],
      "properties": {
        "company_name": {
          "type": "string",
          "title": "Наименование компании"
        },
        "contact_name": {
          "type": "string",
          "title": "Контактное лицо"
        },
        "contact_email": {
          "type": "string",
          "format": "email",
          "title": "E-mail контакта"
        },
        "plan": {
          "type": "string",
          "enum": ["pilot", "standard", "enterprise"],
          "title": "Тарифный план"
        },
        "not_after": {
          "type": "string",
          "format": "date",
          "title": "Дата окончания подписки"
        },
        "status": {
          "type": "string",
          "enum": ["draft", "trial", "active", "expired", "custom", "archived"],
          "title": "Статус",
          "default": "draft"
        },
        "circuit_id": {
          "type": "string",
          "title": "ID контура (только процессный актор)"
        },
        "activation_key_issued_at": {
          "type": "string",
          "format": "date-time",
          "title": "Метка выпуска ключа (только процессный актор)"
        },
        "custom_terms": {
          "type": "string",
          "title": "Индивидуальные условия (текст, без автоматизации)"
        },
        "notes": {
          "type": "string",
          "title": "Заметки"
        }
      }
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;
