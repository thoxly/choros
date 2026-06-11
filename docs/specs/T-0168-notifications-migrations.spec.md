# Spec · T-0168 — Notifications E-N.1: миграции notification / email_channel_config / notification_preference

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0168 (product=choros, type=standard_code, prio 52)
**ADR consumed:** `docs/design/T-0120-notifications.adr.md` (status: ready) §2 (object model §4.1–4.3) и §5 E-N.1 (декомпозиция)
**Foundations:** T-0013 (RLS-контракт), T-0119 (миграционная дисциплина слотов)

---

## 1. Summary

Три SQL-миграции создают tenant-таблицы `notification`, `email_channel_config`, `notification_preference` по схеме ADR T-0120 §4.1–4.3 с полным T-0013-контрактом (ENABLE+FORCE RLS, default-DENY, `choros_app` DML, NOBYPASSRLS), badge-частичным индексом и keyset-индексом для `notification`; три имени добавляются в `ci/checks/known_tenant_tables.txt` аддитивно.

---

## 2. Functional requirements

- **FR-1** Миграция `0NN_notification.sql` создаёт таблицу `choros.notification` с колонками точно по ADR §4.1: `tenant_id uuid NOT NULL`, `id uuid NOT NULL`, `recipient_id uuid NOT NULL`, `event_kind text NOT NULL`, `title text NOT NULL`, `body text NOT NULL`, `object_ref text NULL`, `is_read boolean NOT NULL DEFAULT false`, `created_at bigint NOT NULL`, `expires_at bigint NULL`. PK `(tenant_id, id)`. FK `(tenant_id, recipient_id) REFERENCES choros.employee(tenant_id, id)`.

- **FR-2** Миграция `0NN+1_email_channel_config.sql` создаёт таблицу `choros.email_channel_config` с колонками по ADR §4.2: `tenant_id uuid NOT NULL` (PK — одна строка на тенант), `smtp_host text NOT NULL`, `smtp_port integer NOT NULL`, `smtp_tls boolean NOT NULL DEFAULT true`, `from_address text NOT NULL`, `from_name text NULL`, `smtp_handle text NOT NULL`, `is_enabled boolean NOT NULL DEFAULT false`, `updated_by text NOT NULL`, `updated_at bigint NOT NULL`. PK `(tenant_id)`.

- **FR-3** Миграция `0NN+2_notification_preference.sql` создаёт таблицу `choros.notification_preference` с колонками по ADR §4.3: `tenant_id uuid NOT NULL`, `event_kind text NOT NULL`, `recipient_scope text NOT NULL`, `channels text[] NOT NULL`, `updated_by text NOT NULL`, `updated_at bigint NOT NULL`. PK `(tenant_id, event_kind, recipient_scope)`.

- **FR-4** Каждая из трёх таблиц имеет `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` и политику default-DENY на `current_setting('choros.tenant_id', true)::uuid` (USING + WITH CHECK). Политики именованы: `notification_tenant_isolation`, `email_channel_config_tenant_isolation`, `notification_preference_tenant_isolation`.

- **FR-5** Каждая из трёх таблиц имеет `GRANT SELECT, INSERT, UPDATE, DELETE ON … TO choros_app`. `choros_app` — NOBYPASSRLS-роль (T-0013-контракт).

- **FR-6** Для `choros.notification` создаётся badge-частичный индекс: `CREATE INDEX idx_notification_unread ON choros.notification (tenant_id, recipient_id) WHERE is_read = false`. Имя индекса содержит `notification` и `unread` (согласовано с ADR §2.7 и FF-UNREAD-INDEXED).

- **FR-7** Для `choros.notification` создаётся keyset-индекс листинга: `CREATE INDEX idx_notification_listing ON choros.notification (tenant_id, recipient_id, created_at, id)` (поддерживает `GET /api/notifications` keyset-пагинацию по `(created_at, id)`).

- **FR-8** Три имени — `notification`, `email_channel_config`, `notification_preference` — добавляются в `ci/checks/known_tenant_tables.txt` **аддитивно** (без удаления существующих строк). Это единственное легитимное изменение фикстуры в этой задаче.

- **FR-9** Миграции не создают новых таблиц типа queue/delivery/dispatch (нет второго outbox — FF-NB-OUTBOX из ADR §6). Доставка идёт через существующую `choros.outbox`.

- **FR-10** Номера слотов миграций — три последовательных свободных номера ≥ 046 (следующий после 045_form_binding.sql, который является наивысшим занятым на текущей ветке). Выбирает coder при материализации; схема нумерации — три файла `046_notification.sql`, `047_email_channel_config.sql`, `048_notification_preference.sql` (или иные свободные слоты ≥ 046 без коллизий).

---

## 3. Non-functional requirements

- **NF-1** Каждая миграция идемпотентна при повторном запуске: `CREATE TABLE IF NOT EXISTS` / DO-guard для политик / `ON CONFLICT DO NOTHING` для seed-строк (конвенция из `migrations/038_egress_policy.sql`). Runner `migrations/run.mjs` записывает версию в `choros.schema_migrations` и пропускает уже применённые.

- **NF-2** `tenant_id` — ведущая колонка PK и ВСЕХ составных индексов (T-0013-контракт, FF-LEAD). Нарушение ведёт к красному гейту `FF-LEAD`.

- **NF-3** Три таблицы не содержат FK за пределы своего тенанта; FK `(tenant_id, recipient_id) → employee(tenant_id, id)` tenant-scoped на обеих сторонах (T-0017-дисциплина).

- **NF-4** Стиль SQL-кода совместим с существующими миграциями (043–045 как образцы): подробный header-комментарий с номером задачи, `choros.` prefix на таблицах, `FORCE ROW LEVEL SECURITY` после `ENABLE`, именованная политика, `GRANT … TO choros_app` после политики.

- **NF-5** Новые объекты размещены в схеме `choros`; никаких объектов в `public`.

---

## 4. Out of scope (E-N.2+)

- TS-код routing / fanout / `publishNotificationEvent` — E-N.2
- `ChannelDriver`-реестр, `makeNotificationDeliver` — E-N.2
- Email-драйвер, `SmtpSecretResolverPort`, SMTP-адаптер — E-N.3
- `notification_preference`-CRUD-хендлеры, defaults-seed при genesis tenant — E-N.4
- `renderTemplate`, `notification-templates.ts` — E-N.5
- REST API `/api/notifications`, `/api/email-channel-config`, `/api/notification-preferences` — E-N.6
- Аудит-события `notif.email_config.*`, `notif.preference.changed` — E-N.7
- Sweeper авто-ретенции (фоновый процесс) — Stage-2
- Tenant-configurable шаблоны (`notification_template` таблица) — Stage-2
- Push-уведомления (мобильный) — not-MVP
- Bounce-webhook обработка — Stage-2
- Full notification center UI — Stage-2

---

## 5. Acceptance criteria

### AC-1 — Таблица `notification` существует в БД (fitness / live-impl)
После применения миграций `SELECT 1 FROM information_schema.tables WHERE table_schema='choros' AND table_name='notification'` возвращает 1 строку.
*verifiable_as: fitness*

### AC-2 — Таблица `email_channel_config` существует в БД (fitness / live-impl)
После применения миграций `SELECT 1 FROM information_schema.tables WHERE table_schema='choros' AND table_name='email_channel_config'` возвращает 1 строку.
*verifiable_as: fitness*

### AC-3 — Таблица `notification_preference` существует в БД (fitness / live-impl)
После применения миграций `SELECT 1 FROM information_schema.tables WHERE table_schema='choros' AND table_name='notification_preference'` возвращает 1 строку.
*verifiable_as: fitness*

### AC-4 — RLS включён на всех трёх таблицах (fitness / live-impl)
Запрос к `pg_class` подтверждает `relrowsecurity = true` и `relforcerowsecurity = true` для `notification`, `email_channel_config`, `notification_preference` в схеме `choros`. Проверяется существующим FF-RLS гейтом `ci/checks/db/schema.test.ts`.
*verifiable_as: fitness*

### AC-5 — Политики изоляции правильно именованы (fitness / live-impl)
`SELECT policyname FROM pg_policies WHERE schemaname='choros' AND tablename IN ('notification','email_channel_config','notification_preference')` возвращает строки `notification_tenant_isolation`, `email_channel_config_tenant_isolation`, `notification_preference_tenant_isolation`.
*verifiable_as: fitness*

### AC-6 — Политики имеют default-DENY (USING + WITH CHECK) на GUC (fitness / live-impl)
Для каждой из трёх политик `qual` и `with_check` в `pg_policies` соответствуют `tenant_id = current_setting('choros.tenant_id', true)::uuid`. Без GUC (NULL) — 0 строк видно, INSERT падает.
*verifiable_as: fitness*

### AC-7 — `choros_app` имеет DML-права на все три таблицы (fitness / live-impl)
`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='choros_app' AND table_schema='choros' AND table_name=<each>` возвращает SELECT, INSERT, UPDATE, DELETE для каждой таблицы.
*verifiable_as: fitness*

### AC-8 — PK `notification` — `(tenant_id, id)`, FK `(tenant_id, recipient_id)` → `employee` (fitness / live-impl)
`pg_constraint` содержит: primary key `(tenant_id, id)` для `notification`; foreign key `(tenant_id, recipient_id)` → `choros.employee(tenant_id, id)`. Обе колонки FK tenant-scoped.
*verifiable_as: fitness*

### AC-9 — PK `email_channel_config` — `(tenant_id)` (одна строка на тенант) (fitness / live-impl)
`pg_constraint` содержит primary key с единственной колонкой `tenant_id` для `email_channel_config`.
*verifiable_as: fitness*

### AC-10 — PK `notification_preference` — `(tenant_id, event_kind, recipient_scope)` (fitness / live-impl)
`pg_constraint` содержит composite primary key `(tenant_id, event_kind, recipient_scope)` для `notification_preference`.
*verifiable_as: fitness*

### AC-11 — Badge-частичный индекс существует и покрывает только `is_read = false` (fitness / live-impl)
`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='choros' AND tablename='notification' AND indexname='idx_notification_unread'` возвращает строку; `indexdef` содержит `WHERE (is_read = false)`.
*verifiable_as: fitness*

### AC-12 — Keyset-индекс `idx_notification_listing` существует (fitness / live-impl)
`SELECT indexname FROM pg_indexes WHERE schemaname='choros' AND tablename='notification' AND indexname='idx_notification_listing'` возвращает строку; `indexdef` содержит колонки `(tenant_id, recipient_id, created_at, id)`.
*verifiable_as: fitness*

### AC-13 — `tenant_id` ведущая колонка ВСЕХ составных индексов трёх таблиц (fitness / static-now + live-impl)
Существующий гейт `FF-LEAD` в `ci/checks/db/schema.test.ts` применяется к трём новым таблицам после добавления в `known_tenant_tables.txt`. Grep по миграционным файлам: ни один `CREATE INDEX` не начинает перечисление с колонки, отличной от `tenant_id`.
*verifiable_as: fitness*

### AC-14 — `known_tenant_tables.txt` содержит все три имени, старые строки не удалены (fitness / static-now)
`grep -c 'notification$\|email_channel_config\|notification_preference' ci/checks/known_tenant_tables.txt` возвращает 3. Общее число строк в файле ≥ предыдущего (31 строка до этой задачи + 3 = 34 минимум).
*verifiable_as: fitness*

### AC-15 — Миграции не создают новых queue/delivery/dispatch-таблиц (fitness / static-now)
Grep по файлам миграций T-0168: `grep -iE 'CREATE TABLE.*(queue|delivery|dispatch)' migrations/04[6-9]_*.sql` — пустой результат.
*verifiable_as: fitness*

### AC-16 — Три новые таблицы подпадают под существующий FF-T13 / FF-RLS гейт (fitness / live-impl)
`ci/checks/db/schema.test.ts` гейт `FF-RLS` (loop по `KNOWN_TENANT_TABLES`) становится зелёным для `notification`, `email_channel_config`, `notification_preference` после применения миграций.
*verifiable_as: fitness*

### AC-17 — Частичный индекс используется при запросе badge-счётчика (fitness / live-impl)
`EXPLAIN (FORMAT JSON) SELECT COUNT(*) FROM choros.notification WHERE tenant_id = $1 AND recipient_id = $2 AND is_read = false` содержит `idx_notification_unread` в плане (index scan / index-only scan). Нет seq-scan и нет materialized view.
*verifiable_as: fitness*

### AC-18 — Колонки `notification` совпадают с ADR §4.1 (fitness / live-impl)
`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='choros' AND table_name='notification'` возвращает ровно: `tenant_id uuid NOT NULL`, `id uuid NOT NULL`, `recipient_id uuid NOT NULL`, `event_kind text NOT NULL`, `title text NOT NULL`, `body text NOT NULL`, `object_ref text NULL`, `is_read boolean NOT NULL DEFAULT false`, `created_at bigint NOT NULL`, `expires_at bigint NULL`.
*verifiable_as: fitness*

### AC-19 — Колонки `email_channel_config` совпадают с ADR §4.2 (fitness / live-impl)
`information_schema.columns` для `email_channel_config` возвращает: `tenant_id uuid NOT NULL`, `smtp_host text NOT NULL`, `smtp_port integer NOT NULL`, `smtp_tls boolean NOT NULL DEFAULT true`, `from_address text NOT NULL`, `from_name text NULL`, `smtp_handle text NOT NULL`, `is_enabled boolean NOT NULL DEFAULT false`, `updated_by text NOT NULL`, `updated_at bigint NOT NULL`.
*verifiable_as: fitness*

### AC-20 — Колонки `notification_preference` совпадают с ADR §4.3 (fitness / live-impl)
`information_schema.columns` для `notification_preference` возвращает: `tenant_id uuid NOT NULL`, `event_kind text NOT NULL`, `recipient_scope text NOT NULL`, `channels ARRAY NOT NULL`, `updated_by text NOT NULL`, `updated_at bigint NOT NULL`.
*verifiable_as: fitness*

---

## 6. Blocking questions

Нет. Все неясности закрыты:

- Структура трёх таблиц однозначно зафиксирована в ADR T-0120 §4.1–4.3.
- Следующий свободный слот миграции — **046** (045_form_binding.sql — наивысший занятый на ветке).
- RLS-контракт — verbatim T-0013.
- known_tenant_tables.txt — аддитивно, без удаления.
- Частичный индекс badge — `WHERE is_read = false` прямо прописан в ADR §2.7.
- Sweeper и templates — явно в out-of-scope (Stage-2).

---

## 7. Traceability ADR → AC

| ADR §/FF | AC(s) |
|---|---|
| §4.1 `notification` колонки | AC-1, AC-8, AC-18 |
| §4.2 `email_channel_config` колонки | AC-2, AC-9, AC-19 |
| §4.3 `notification_preference` колонки | AC-3, AC-10, AC-20 |
| T-0013 FORCE RLS | AC-4, AC-6, AC-16 |
| Именование политик | AC-5 |
| `choros_app` DML | AC-7 |
| Badge partial index §2.7 / FF-UNREAD-INDEXED | AC-11, AC-17 |
| Keyset index §4.1 | AC-12 |
| FF-LEAD (tenant_id leading) | AC-13 |
| known_tenant_tables.txt §4 / FF-T13 | AC-14, AC-16 |
| FF-NB-OUTBOX (нет второго outbox) | AC-15 |
