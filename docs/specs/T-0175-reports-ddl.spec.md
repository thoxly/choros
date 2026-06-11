# Spec · T-0175 — Reports T-0121a: DDL report_page + report_page_dep

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0175 (product=choros, type=standard_code, prio 52)
**ADR consumed:** `docs/design/T-0121-reports-pages.adr.md` (status: ready) §2 (object model §2.1–§2.2) и §9 T-0121a (декомпозиция)
**Foundations:** T-0013 (RLS-контракт), T-0014 (registry_def, application), T-0017 (tenant-scoped FK дисциплина), T-0119 (миграционная дисциплина слотов)

---

## 1. Summary

Две SQL-миграции создают tenant-таблицы `report_page` и `report_page_dep` по схеме ADR T-0121 §2.1–§2.2 с полным T-0013-контрактом (ENABLE+FORCE RLS, default-DENY, `choros_app` DML); два имени добавляются в `ci/checks/known_tenant_tables.txt` аддитивно; два стема добавляются в `ci/checks/role-criticality-migration-excludes.txt` аддитивно.

---

## 2. Functional requirements

- **FR-1** Миграция `0NN_report_page.sql` создаёт таблицу `choros.report_page` с колонками точно по ADR §2.1:
  `tenant_id uuid NOT NULL`, `id uuid NOT NULL`, `app_id uuid NOT NULL`, `slug text NOT NULL`, `title text NOT NULL`,
  `floor text NOT NULL`, `tier text NOT NULL DEFAULT 'draft'`, `page_def jsonb NULL`, `page_code text NULL`,
  `bundle_ref text NULL`, `created_at bigint NOT NULL`, `updated_at bigint NOT NULL`.
  PK `(tenant_id, id)`. UNIQUE `(tenant_id, app_id, slug)`.
  FK `(tenant_id, app_id) REFERENCES choros.application(tenant_id, id)`.
  CHECK `floor IN ('1','2')` (named `report_page_floor_chk`).
  CHECK `tier IN ('draft','published')` (named `report_page_tier_chk`).
  CHECK payload: Floor-1 ⇒ `page_def IS NOT NULL`, Floor-2 ⇒ `page_code IS NOT NULL`
  (named `report_page_floor_payload_chk`, ADR §2.1).

- **FR-2** Миграция `0NN+1_report_page_dep.sql` создаёт таблицу `choros.report_page_dep` с колонками точно по ADR §2.2:
  `tenant_id uuid NOT NULL`, `id uuid NOT NULL`, `page_id uuid NOT NULL`,
  `registry_def_id uuid NOT NULL`, `field_key text NOT NULL`,
  `dep_kind text NOT NULL`, `stale boolean NOT NULL DEFAULT false`, `created_at bigint NOT NULL`.
  PK `(tenant_id, id)`. UNIQUE `(tenant_id, page_id, registry_def_id, field_key)`.
  FK `(tenant_id, page_id) REFERENCES choros.report_page(tenant_id, id) ON DELETE CASCADE`.
  FK `(tenant_id, registry_def_id) REFERENCES choros.registry_def(tenant_id, id)`.
  CHECK `dep_kind IN ('read','aggregate')` (named `report_page_dep_kind_chk`).

- **FR-3** Каждая из двух таблиц имеет `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` и политику default-DENY на `current_setting('choros.tenant_id', true)::uuid` (USING + WITH CHECK). Политики именованы: `report_page_tenant_isolation`, `report_page_dep_tenant_isolation`.

- **FR-4** Каждая из двух таблиц имеет `GRANT SELECT, INSERT, UPDATE, DELETE ON … TO choros_app`. `choros_app` — NOBYPASSRLS-роль (T-0013-контракт).

- **FR-5** Два имени — `report_page`, `report_page_dep` — добавляются в `ci/checks/known_tenant_tables.txt` **аддитивно** (без удаления существующих строк). Это единственное легитимное изменение этого файла в данной задаче.

- **FR-6** Два стема миграций добавляются в `ci/checks/role-criticality-migration-excludes.txt` **аддитивно** по образцу:
  `0NN_report_page  # T-0175 — reports DDL (choros.report_page)`
  `0NN+1_report_page_dep  # T-0175 — reports DDL (choros.report_page_dep)`.

- **FR-7** Таблица `report_page_dep` имеет `ON DELETE CASCADE` по FK на `report_page` (удаление страницы убирает её deps; audit_event переживает — append-only, ADR §7 NF-7).

- **FR-8** Номера слотов миграций — два последовательных свободных номера ≥ 051 (текущий максимум на ветке dev = 050_tier_delete_fix.sql). **Конкретный номер финализируется coder-ом при материализации по факту свободных слотов на dev**; порядок обязателен: `report_page` перед `report_page_dep` (FK-зависимость).

- **FR-9** Миграции **не** содержат ни одного DDL за пределами двух указанных таблиц (нет новых очередей, seed-данных, TS-кода, флоор-рендерера, MCP-инструментов — всё это T-0121b–T-0121g). `choros.mcp_tool`-seed `author_report_page` — T-0121f, не T-0175.

- **FR-10** `page_code` хранится как `text` (сырой TSX/JS). Ни `bytea`, ни large-object, ни иной бинарный тип не используются (ADR §2.1, §10, паттерн T-0119 «бинарь не в Postgres»).

---

## 3. Non-functional requirements

- **NF-1** Каждая миграция идемпотентна при повторном запуске: `CREATE TABLE IF NOT EXISTS` / DO-guard для политик и CHECK-ограничений / `ON CONFLICT DO NOTHING` для seed-строк (конвенция из `migrations/038_egress_policy.sql`).

- **NF-2** `tenant_id` — ведущая колонка PK и ВСЕХ составных индексов (T-0013-контракт, FF-LEAD). Нарушение ведёт к красному гейту `FF-LEAD`.

- **NF-3** Обе FK tenant-scoped: `(tenant_id, app_id)` → `choros.application(tenant_id, id)` и `(tenant_id, page_id)` → `choros.report_page(tenant_id, id)` и `(tenant_id, registry_def_id)` → `choros.registry_def(tenant_id, id)`. Cross-tenant FK структурно невозможен (T-0017-дисциплина).

- **NF-4** Все FK указывают на уже-живые таблицы (`application` — миг. 003; `registry_def` — миг. 004; `report_page` — предыдущий слот той же волны) — применяются без bounce. Deferred-FK не используются (ADR §2 замечание по FK-применимости).

- **NF-5** Стиль SQL-кода совместим с существующими миграциями (046–050 как образцы): подробный header-комментарий с номером задачи, `choros.` prefix на таблицах, `FORCE ROW LEVEL SECURITY` после `ENABLE`, именованная политика, `GRANT … TO choros_app` после политики.

- **NF-6** Новые объекты размещены в схеме `choros`; никаких объектов в `public`.

---

## 4. Out of scope (T-0121b–T-0121h)

- TS-код `src/core/report-page-compat.ts` (`checkReportPageDepFields`, `classifyReportPageFloor`) — T-0121b
- Registry_def schema-change API (soft-warning, destructive-deny, force-escape-hatch) — T-0121c
- `report_page` CRUD API + author/promote + `report_page_dep` registration (PDP-gated) — T-0121d
- `bundle-coherence.sh` расширение `check-report-page-deps` + `bundle_members.txt` — T-0121e
- MCP-tool seed `author_report_page` для config-агента — T-0121f
- Floor-1 server-side агрегат-рендерер + Floor-2 RLS-gated data API — T-0121g
- Статический анализ Floor-2 React → автоизвлечение field-deps (Stage-2) — T-0121h
- UI-редактор страниц Floor-1 (кнопочный) — зона 7, not-MVP в T-0121-волне
- Рантайм отчётов, deps-резолв — следующие куски ADR §9
- Шаблоны отчётов (дашборд руководителя, SLA-dashboard T-0095) — отдельные задачи

---

## 5. Acceptance criteria

### AC-1 — Таблица `report_page` существует в БД (fitness / live-impl)
`SELECT 1 FROM information_schema.tables WHERE table_schema='choros' AND table_name='report_page'` возвращает 1 строку после применения миграций.
*verifiable_as: fitness*

### AC-2 — Таблица `report_page_dep` существует в БД (fitness / live-impl)
`SELECT 1 FROM information_schema.tables WHERE table_schema='choros' AND table_name='report_page_dep'` возвращает 1 строку после применения миграций.
*verifiable_as: fitness*

### AC-3 — Колонки `report_page` совпадают с ADR §2.1 (fitness / live-impl)
`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='choros' AND table_name='report_page' ORDER BY ordinal_position` возвращает ровно 12 колонок: `tenant_id uuid NOT NULL`, `id uuid NOT NULL`, `app_id uuid NOT NULL`, `slug text NOT NULL`, `title text NOT NULL`, `floor text NOT NULL`, `tier text NOT NULL DEFAULT 'draft'`, `page_def jsonb NULL`, `page_code text NULL`, `bundle_ref text NULL`, `created_at bigint NOT NULL`, `updated_at bigint NOT NULL`. Ни одной лишней, ни одной недостающей.
*verifiable_as: fitness*

### AC-4 — Колонки `report_page_dep` совпадают с ADR §2.2 (fitness / live-impl)
`information_schema.columns` для `report_page_dep` возвращает ровно 8 колонок: `tenant_id uuid NOT NULL`, `id uuid NOT NULL`, `page_id uuid NOT NULL`, `registry_def_id uuid NOT NULL`, `field_key text NOT NULL`, `dep_kind text NOT NULL`, `stale boolean NOT NULL DEFAULT false`, `created_at bigint NOT NULL`. Ни одной лишней, ни одной недостающей.
*verifiable_as: fitness*

### AC-5 — PK `report_page` — `(tenant_id, id)`, UNIQUE `(tenant_id, app_id, slug)` (fitness / live-impl)
`pg_constraint` содержит: primary key `(tenant_id, id)` для `report_page`; unique constraint на `(tenant_id, app_id, slug)`.
*verifiable_as: fitness*

### AC-6 — PK `report_page_dep` — `(tenant_id, id)`, UNIQUE `(tenant_id, page_id, registry_def_id, field_key)` (fitness / live-impl)
`pg_constraint` содержит: primary key `(tenant_id, id)` для `report_page_dep`; unique constraint на `(tenant_id, page_id, registry_def_id, field_key)`.
*verifiable_as: fitness*

### AC-7 — FK `report_page.app_id` → `application` tenant-scoped (fitness / live-impl)
`pg_constraint` для `report_page` содержит FK `(tenant_id, app_id)` → `choros.application(tenant_id, id)`. Обе стороны FK включают `tenant_id`.
*verifiable_as: fitness*

### AC-8 — FK `report_page_dep.page_id` → `report_page` с ON DELETE CASCADE (fitness / live-impl)
`pg_constraint` для `report_page_dep` содержит FK `(tenant_id, page_id)` → `choros.report_page(tenant_id, id)` с `confdeltype='c'` (CASCADE). При удалении строки из `report_page` соответствующие строки `report_page_dep` удаляются автоматически.
*verifiable_as: fitness*

### AC-9 — FK `report_page_dep.registry_def_id` → `registry_def` tenant-scoped (fitness / live-impl)
`pg_constraint` для `report_page_dep` содержит FK `(tenant_id, registry_def_id)` → `choros.registry_def(tenant_id, id)`.
*verifiable_as: fitness*

### AC-10 — CHECK `floor IN ('1','2')` именован `report_page_floor_chk` (fitness / live-impl)
`SELECT conname FROM pg_constraint WHERE conrelid='choros.report_page'::regclass AND conname='report_page_floor_chk'` возвращает строку. Вставка строки с `floor='3'` падает с `check_violation`.
*verifiable_as: fitness*

### AC-11 — CHECK `tier IN ('draft','published')` именован `report_page_tier_chk` (fitness / live-impl)
`SELECT conname FROM pg_constraint WHERE conrelid='choros.report_page'::regclass AND conname='report_page_tier_chk'` возвращает строку. Вставка строки с `tier='archived'` падает с `check_violation`.
*verifiable_as: fitness*

### AC-12 — CHECK floor-payload (`report_page_floor_payload_chk`) работает корректно (fitness / live-impl)
`SELECT conname FROM pg_constraint WHERE conrelid='choros.report_page'::regclass AND conname='report_page_floor_payload_chk'` возвращает строку. Вставка `floor='1', page_def=NULL` падает; вставка `floor='2', page_code=NULL` падает; вставка `floor='1', page_def='{}'::jsonb` проходит.
*verifiable_as: fitness*

### AC-13 — CHECK `dep_kind IN ('read','aggregate')` именован `report_page_dep_kind_chk` (fitness / live-impl)
`SELECT conname FROM pg_constraint WHERE conrelid='choros.report_page_dep'::regclass AND conname='report_page_dep_kind_chk'` возвращает строку. Вставка с `dep_kind='write'` падает с `check_violation`.
*verifiable_as: fitness*

### AC-14 — RLS включён на обеих таблицах (fitness / live-impl)
`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class JOIN pg_namespace ON pg_class.relnamespace=pg_namespace.oid WHERE nspname='choros' AND relname IN ('report_page','report_page_dep')` возвращает 2 строки, обе с `relrowsecurity=true` и `relforcerowsecurity=true`. Проверяется существующим FF-RLS гейтом `ci/checks/db/schema.test.ts`.
*verifiable_as: fitness*

### AC-15 — Политики изоляции правильно именованы (fitness / live-impl)
`SELECT policyname FROM pg_policies WHERE schemaname='choros' AND tablename IN ('report_page','report_page_dep')` возвращает строки `report_page_tenant_isolation` и `report_page_dep_tenant_isolation`.
*verifiable_as: fitness*

### AC-16 — Политики имеют default-DENY (USING + WITH CHECK) на GUC (fitness / live-impl)
Для каждой из двух политик `qual` и `with_check` в `pg_policies` соответствуют `tenant_id = current_setting('choros.tenant_id', true)::uuid`. Без установленного GUC (NULL) — 0 строк видно, INSERT падает с `check_violation` или `insufficient_privilege`.
*verifiable_as: fitness*

### AC-17 — `choros_app` имеет DML-права на обе таблицы (fitness / live-impl)
`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='choros_app' AND table_schema='choros' AND table_name IN ('report_page','report_page_dep')` возвращает SELECT, INSERT, UPDATE, DELETE для каждой таблицы (8 строк итого).
*verifiable_as: fitness*

### AC-18 — `known_tenant_tables.txt` содержит оба имени, старые строки не удалены (fitness / static-now)
`grep -c '^report_page$\|^report_page_dep$' ci/checks/known_tenant_tables.txt` возвращает 2. Общее число строк в файле ≥ предыдущего (34 строки до этой задачи + 2 = 36 минимум, не считая пустых/комментариев).
*verifiable_as: fitness*

### AC-19 — `role-criticality-migration-excludes.txt` содержит оба стема аддитивно (fitness / static-now)
`grep -c 'T-0175' ci/checks/role-criticality-migration-excludes.txt` возвращает 2. Существующие записи (046–050) не удалены.
*verifiable_as: fitness*

### AC-20 — `tenant_id` ведущая колонка ВСЕХ составных индексов обеих таблиц (fitness / static-now + live-impl)
Grep по файлам миграций T-0175: ни один `CREATE INDEX` не начинает перечисление с колонки, отличной от `tenant_id`. Существующий гейт `FF-LEAD` в `ci/checks/db/schema.test.ts` применяется к двум новым таблицам после добавления в `known_tenant_tables.txt`.
*verifiable_as: fitness*

### AC-21 — Миграции не содержат `bytea`, `lo_`-функций, компилированных объектов (fitness / static-now)
`grep -iE '\b(bytea|lo_)\b' migrations/0NN_report_page.sql migrations/0NN+1_report_page_dep.sql` — пустой результат (ноль строк). `page_code` хранится как `text`.
*verifiable_as: fitness*

### AC-22 — Миграции не создают MCP-tool seed, API-обработчиков, рантайм-логики (fitness / static-now)
Grep по файлам миграций T-0175 не содержит DDL для `mcp_tool`, `outbox`, `queue`, `delivery`, `dispatch` таблиц. Нет INSERT в `choros.mcp_tool` в этих файлах.
*verifiable_as: fitness*

### AC-23 — Обе новые таблицы подпадают под существующий FF-T13 / FF-RLS гейт (fitness / live-impl)
`ci/checks/db/schema.test.ts` гейт `FF-RLS` (loop по `KNOWN_TENANT_TABLES`) становится зелёным для `report_page` и `report_page_dep` после применения миграций.
*verifiable_as: fitness*

### AC-24 — Порядок слотов: `report_page` < `report_page_dep` (fitness / static-now)
Номер слота `report_page` строго меньше номера слота `report_page_dep` (гарантия FK-зависимости при линейном применении миграций).
*verifiable_as: fitness*

---

## 6. Blocking questions

Нет. Все неясности закрыты:

- Структура обеих таблиц однозначно зафиксирована в ADR T-0121 §2.1–§2.2.
- Следующий свободный слот миграции — **≥ 051** (050_tier_delete_fix.sql — наивысший занятый на dev в данный момент). ADR §0 изначально резервировал 046/047, но они заняты миграциями T-0168 (notifications). Конкретный номер **финализируется coder-ом при BUILD по факту свободных слотов** — параллельные сессии могли занять дополнительные слоты. Порядок `report_page` → `report_page_dep` обязателен.
- RLS-контракт — verbatim T-0013.
- known_tenant_tables.txt — аддитивно, без удаления.
- role-criticality-migration-excludes.txt — аддитивно, без удаления.
- Декларация `bundle_members.txt` + расширение `bundle-coherence.sh` — T-0121e, не T-0175.

---

## 7. Traceability ADR → AC

| ADR §/FF | AC(s) |
|---|---|
| §2.1 `report_page` колонки | AC-1, AC-3, AC-5 |
| §2.2 `report_page_dep` колонки | AC-2, AC-4, AC-6 |
| §2.1 FK `(tenant_id, app_id)` → `application` | AC-7 |
| §2.2 FK `(tenant_id, page_id)` → `report_page` ON DELETE CASCADE | AC-8 |
| §2.2 FK `(tenant_id, registry_def_id)` → `registry_def` | AC-9 |
| §2.1 CHECK `floor IN ('1','2')` `report_page_floor_chk` | AC-10 |
| §2.1 CHECK `tier IN ('draft','published')` `report_page_tier_chk` | AC-11 |
| §2.1 CHECK `report_page_floor_payload_chk` | AC-12 |
| §2.2 CHECK `dep_kind IN ('read','aggregate')` `report_page_dep_kind_chk` | AC-13 |
| T-0013 FORCE RLS | AC-14, AC-16, AC-23 |
| Именование политик | AC-15 |
| `choros_app` DML | AC-17 |
| known_tenant_tables.txt §2 / FF-T13-PAGE | AC-18, AC-23 |
| role-criticality-migration-excludes.txt (дисциплина) | AC-19 |
| FF-LEAD (tenant_id leading) | AC-20 |
| §2.1 «бинарь не в Postgres» / §10 T-0119 | AC-21 |
| §9 T-0121a out-of-scope декомпозиция | AC-22 |
| §0 порядок слотов (report_page перед report_page_dep) | AC-24 |
