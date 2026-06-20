-- 083 · Core system registries seed (T-0354 / E16 §7)
--
-- SCOPE — DATA ONLY (registry-content plane):
--   Seeds the core backbone system registries needed by all tenants:
--     1. «Контрагенты»             (slug='kontragenty')      — B2B hub, referenced by all
--     2. «Валюты»                  (slug='valyuty')          — universal currency table
--     3. «Производственный календарь» (slug='prod-kalendar') — working-day SLA machinery
--     4. «Единицы измерения»       (slug='edinitsy')         — optional, universal for goods
--
--   All four belong to a single system application «core-registries» (slug='core-registries').
--   NO DDL — zero table creation. Rides the existing T-0014 tables:
--     application → registry_def (migrations 003/004).
--   ci/checks/known_tenant_tables.txt is NOT changed.
--
-- DOCTRINE (spec §7):
--   Core = (a) universal for all tenants, (b) integrity/upgrade/integration critical,
--   (c) read by machinery. These are seeded registry_def rows, NOT separate tables.
--   The application-layer enforce extend-not-replace guard: a request that DELETEs or
--   RENAMEs a standard field of an is_system registry → 403 SYSTEM_REGISTRY_FIELD_PROTECTED.
--   Tenants MAY add their own fields (additionalProperties: true).
--
-- NOT CORE (tenant templates — do not seed here):
--   номенклатура/товары, прайсы, категории, статусы, источники лидов.
--   Оргструктура/Пользователи/Роли — already core elsewhere.
--
-- ADDITIVE & IDEMPOTENT:
--   application:   INSERT ... ON CONFLICT (tenant_id, slug) DO NOTHING
--   registry_def:  INSERT ... ON CONFLICT (tenant_id, application_id, slug) DO NOTHING
--   Re-running is a no-op; no data is lost.
--   Runs as choros_migrator (BYPASSRLS) — literal tenant_id, no GUC required.
--
-- is_system = true: standard fields are pinned (extend-not-replace ADR §7).
--
-- Stable UUIDs (DEV_TENANT = a0000000-…-0001, namespace a8):
--   application    core-registries              = a8000000-0000-0000-0000-000000000001
--   registry_def   kontragenty (Контрагенты)    = a8000000-0000-0000-0000-000000000002
--   registry_def   valyuty (Валюты)             = a8000000-0000-0000-0000-000000000003
--   registry_def   prod-kalendar (Произв.кал.)  = a8000000-0000-0000-0000-000000000004
--   registry_def   edinitsy (Единицы изм.)      = a8000000-0000-0000-0000-000000000005

-- ─────────────────────────────────────────────────────────────────────────────
-- Application: core-registries
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO choros.application
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000001',
   'core-registries',
   'Системные справочники',
   'Системное приложение для универсальных core-справочников (E16 §7). '
     || 'is_system=true: поля защищены — тенант может добавить своё, '
     || 'но не удалить/переименовать стандартное. Создано через genesis-seed.',
   0, 0)
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registry 1: «Контрагенты» — B2B counterparty hub
--
-- Используется всеми процессами и реестрами, которые ссылаются на юридическое лицо.
-- Часто синхронизируется с 1С: поля inn/kpp/ogrn — стандартные реквизиты.
-- standard fields: name, inn, kpp, ogrn, legal_address, contact_email, phone
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000002',
   'a8000000-0000-0000-0000-000000000001',
   'kontragenty',
   'Контрагенты',
   'Реестр контрагентов (B2B hub). Стандартные поля: ИНН/КПП/ОГРН, '
     || 'юридический адрес, контакты. Тенант может добавлять свои поля.',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "kontragenty",
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "name": {
          "type": "string",
          "title": "Наименование"
        },
        "inn": {
          "type": "string",
          "title": "ИНН",
          "pattern": "^[0-9]{10,12}$"
        },
        "kpp": {
          "type": "string",
          "title": "КПП",
          "pattern": "^[0-9]{9}$"
        },
        "ogrn": {
          "type": "string",
          "title": "ОГРН"
        },
        "legal_address": {
          "type": "string",
          "title": "Юридический адрес"
        },
        "contact_email": {
          "type": "string",
          "format": "email",
          "title": "Email контакта"
        },
        "phone": {
          "type": "string",
          "title": "Телефон"
        }
      },
      "required": ["name"]
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registry 2: «Валюты» — universal currency reference
--
-- Крошечный, стабильный, нужен всем. Стандарт: ISO 4217.
-- standard fields: code (ISO), name, symbol, decimal_places
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000003',
   'a8000000-0000-0000-0000-000000000001',
   'valyuty',
   'Валюты',
   'Реестр валют (ISO 4217). Стандартные поля: код, наименование, символ, '
     || 'знаков после запятой. Тенант может добавлять свои поля.',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "valyuty",
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "code": {
          "type": "string",
          "title": "Код (ISO 4217)",
          "pattern": "^[A-Z]{3}$"
        },
        "name": {
          "type": "string",
          "title": "Наименование"
        },
        "symbol": {
          "type": "string",
          "title": "Символ"
        },
        "decimal_places": {
          "type": "integer",
          "title": "Знаков после запятой",
          "minimum": 0,
          "maximum": 8
        }
      },
      "required": ["code", "name"]
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registry 3: «Производственный календарь» — working-day SLA calendar
--
-- Нужен машинерии для расчёта SLA «через N рабочих дней».
-- Каждая запись = один день. is_working_day=false для выходных и праздников.
-- standard fields: date, is_working_day, description (опц. метка праздника)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000004',
   'a8000000-0000-0000-0000-000000000001',
   'prod-kalendar',
   'Производственный календарь',
   'Реестр рабочих/нерабочих дней (SLA-машинерия). Каждая запись = один день. '
     || 'is_working_day=false для выходных и праздников. Тенант может добавлять поля.',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prod-kalendar",
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "date": {
          "type": "string",
          "format": "date",
          "title": "Дата"
        },
        "is_working_day": {
          "type": "boolean",
          "title": "Рабочий день"
        },
        "description": {
          "type": "string",
          "title": "Описание (праздник и пр.)"
        }
      },
      "required": ["date", "is_working_day"]
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registry 4 (optional): «Единицы измерения» — units of measure
--
-- Универсален для товарных позиций (номенклатуры — которая сама НЕ core).
-- standard fields: code, name, symbol
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000005',
   'a8000000-0000-0000-0000-000000000001',
   'edinitsy',
   'Единицы измерения',
   'Реестр единиц измерения (ОКЕИ). Тенант может добавлять свои поля.',
   '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "edinitsy",
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "code": {
          "type": "string",
          "title": "Код (ОКЕИ)"
        },
        "name": {
          "type": "string",
          "title": "Наименование"
        },
        "symbol": {
          "type": "string",
          "title": "Обозначение"
        }
      },
      "required": ["code", "name"]
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT (tenant_id, application_id, slug) DO NOTHING;
