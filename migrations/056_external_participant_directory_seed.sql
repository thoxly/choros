-- @demo-seed (T-0549): fake reference-company content; skipped when CHOROS_SEED_DEMO=off (clean prod).
-- 056 · external-participant directory seed (T-0205 / ADR T-0122 §2.1, FR-1)
--
-- SCOPE — v1 = DATA ONLY (founder decision, gap-map §3а; spec T-0122 FR-1):
--   An external participant (контрагент / посетитель) is modelled as an ORDINARY
--   tenant RECORD (choros.record, T-0014) in a contractor DIRECTORY (registry_def),
--   NOT as a Keycloak account, tenant-user, or role. "Внешний участник как ДАННЫЕ =
--   запись справочника." The tokenized «внешняя поверхность» channel
--   (external_surface / external_token, ADR §2.2–§2.9) is Stage-2 and EXPLICITLY
--   OUT OF SCOPE here — this migration introduces NO new authority subsystem,
--   NO new table, only an additive seed of the directory the records live in
--   (ADR: «связь — кросс-реестровая ссылка, не новый тип сущности»;
--    «события — строки, не новая таблица»).
--
-- WHY A SEED, NOT DDL: the external participant rides the EXISTING tenant tables
--   application → registry_def → record (migrations 003/004/005). All three are
--   already FORCE-RLS T-0013 tenant tables in known_tenant_tables.txt and are
--   already proven cross-tenant-isolated by ci/checks/db/cross_tenant.test.ts.
--   This seed only materialises the directory those records belong to. No change
--   to known_tenant_tables.txt is needed (no new table on disk).
--
-- ADDITIVE & IDEMPOTENT (same discipline as 026/044): INSERT-only with stable
--   UUIDs + ON CONFLICT DO NOTHING ⇒ re-running yields identical row counts.
--   No DDL, no edit to any prior migration. Runs as choros_migrator (RLS bypass) —
--   literal tenant_id, no GUC required (same as 044_config_agent_seed.sql).
--
-- is_system = true: this is a core/system directory (authoring-redlines.ts §5:
--   "core/system-directory (контрагенты, оргструктура, пользователи)" — pinned;
--   drop/rename of its core fields is blocked by the authoring floor).
--
-- Stable UUIDs (DEV_TENANT = a0000000-…-0001):
--   application  external-directory  = a5000000-0000-0000-0000-000000000001
--   registry_def external-participant = a5000000-0000-0000-0000-000000000002

INSERT INTO choros.application
  (tenant_id, id, slug, display_name, description, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a5000000-0000-0000-0000-000000000001',
   'external-directory',
   'Внешние справочники',
   'Справочники внешних сторон (контрагенты, посетители) — данные, не учётки (T-0122 §2.1).',
   0, 0)
ON CONFLICT DO NOTHING;

-- record_schema (T-0014 §3.3 JSONB object model): the minimal v1 shape of an
-- external participant as DATA. Fields are intentionally descriptive only — no
-- credentials, no token, no access surface (that is Stage-2).
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, description,
   record_schema, is_system, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001',
   'a5000000-0000-0000-0000-000000000002',
   'a5000000-0000-0000-0000-000000000001',
   'external-participant',
   'Внешние участники',
   'Справочник внешних сторон (контрагент по договору, посетитель). Запись = данные '
     || 'о стороне; доступ-без-учётки (токен/QR) — отдельный Stage-2 примитив, не здесь.',
   '{
      "type": "object",
      "properties": {
        "display_name": { "type": "string", "title": "Наименование" },
        "kind":         { "type": "string", "title": "Тип", "enum": ["counterparty", "visitor"] },
        "inn":          { "type": "string", "title": "ИНН" },
        "contact_email":{ "type": "string", "title": "Контактный e-mail" },
        "note":         { "type": "string", "title": "Примечание" }
      },
      "required": ["display_name", "kind"]
    }'::jsonb,
   true,
   0, 0)
ON CONFLICT DO NOTHING;
