# T-0116 · Подложка-3: durable-планировщик прикладных таймеров

**Title:** Подложка-3: таблица `app_timer` + двухфазный tenant-scoped dispatcher + timer-lag в health
**Status:** ready (блокирующих вопросов нет)
**Authored:** 2026-06-10
**Authoritative source:** `docs/design/stack-and-fleet-ops.md` §1 п.3, §2 (ratified ADR, GT-1, 2026-06-10)

---

## 1. Summary

Реализовать durable-планировщик прикладных таймеров на Postgres: таблица
`choros.app_timer` с partial-индексом по `(tenant_id, due_at) WHERE state='pending'`,
двухфазный tenant-scoped dispatcher (фаза-1: SECURITY DEFINER-функция возвращает
агрегат `(tenant_id, count)` без данных строк; фаза-2: per-tenant транзакция с
`SET LOCAL` + `FOR UPDATE SKIP LOCKED LIMIT N`), метрика `timer.lag` (P1-сигнал
тихого отказа таймеров) в `GET /health`. Таблица обязана быть под FORCE RLS и войти
в `KNOWN_TENANT_TABLES` — cross-tenant CI-тест её подхватывает автоматически.

---

## 2. Контекст и зависимости

Подложка-3 строится поверх:
- **T-0114** (Подложка-1): `choros.job`, partial-индексы, паттерн `FOR UPDATE SKIP LOCKED`.
- **T-0115** (Подложка-2): FORCE RLS + `choros_app`-роль, CI-гейт cross-tenant (`KNOWN_TENANT_TABLES`).

T-0116 **не дублирует** DDL ролей, схем и политик RLS из T-0053/T-0115.
Все новые миграции размещаются с номерами `011_+` (T-0116 владеет ими; `001–010` уже заняты).

Таймеры обслуживают (не ограничено этим списком):
- SLA-таймеры инбокса (уведомить/эскалировать при просроченном задании),
- lease-renew (автопродление аренды ресурсов),
- retry-таймеры (отложенный повтор failed-операций, отдельно от job-backoff).

---

## 3. Функциональные требования

### FR-1  Таблица `app_timer`

Таблица `choros.app_timer` хранит durable-таймеры. Обязательные атрибуты строки:
- `tenant_id uuid NOT NULL` — ведущий ключ (T-0013-инвариант).
- `id uuid NOT NULL` — уникальный идентификатор таймера.
- `due_at bigint NOT NULL` — момент срабатывания (unix epoch ms).
- `state text NOT NULL` — допустимые значения: `'pending'`, `'firing'`, `'done'`, `'cancelled'`.
- `kind text NOT NULL` — тип таймера (например, `'inbox_sla'`, `'lease_renew'`, `'retry'`).
- `payload jsonb NOT NULL` — прикладная нагрузка (контент непрозрачен для dispatcher).

Детали дополнительных колонок (например, `created_at`, `fired_at`, `cancel_reason`)
и точный DDL — зона architect/coder; данный spec фиксирует поведенческие инварианты.

### FR-2  Partial-индекс

Таблица должна иметь partial-индекс по `(tenant_id, due_at) WHERE state = 'pending'`
для эффективной выборки pending-таймеров с заданным сроком.

### FR-3  FORCE RLS + политика изоляции тенантов

`app_timer` включается в тот же RLS-режим, что и все остальные тенант-таблицы:
`ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, permissive-политика на
`current_setting('choros.tenant_id', true)::uuid`, `choros_app` — NOBYPASSRLS.
Без установленного GUC `choros.tenant_id` — **fail-closed**: 0 строк видно,
INSERT падает с ошибкой Postgres.

### FR-4  SECURITY DEFINER-функция (фаза-1 dispatcher)

Функция `choros.next_due_buckets(p_due_before bigint)` возвращает **только агрегат**
`(tenant_id uuid, timer_count bigint)` — количество pending-таймеров с `due_at < p_due_before`
для каждого тенанта. Она **не возвращает** никаких строк таймеров, ни `id`, ни `payload`.
Функция работает как SECURITY DEFINER (видит все тенанты) и не требует GUC `choros.tenant_id`.
Результат используется dispatcher'ом исключительно для выбора тенантов с просроченными
таймерами — без доступа к данным.

### FR-5  Двухфазный dispatcher (фаза-2)

Для каждого тенанта из результата фазы-1 dispatcher открывает отдельную транзакцию,
в которой:
1. `SET LOCAL choros.tenant_id = '<tenant_id>'` — переключение контекста.
2. `SELECT ... FROM choros.app_timer WHERE state='pending' AND due_at < $now ORDER BY due_at ASC FOR UPDATE SKIP LOCKED LIMIT N` — захват N ближайших таймеров.
3. Обновляет `state = 'firing'` для захваченных строк.
4. Возвращает строки caller'у (прикладная обработка — вне транзакции dispatcher'а).

Механизм обработки после захвата (обработчики kind-ов) — вне границы данной задачи.

### FR-6  Метрика `timer.lag` в `GET /health`

`GET /health` расширяется полем `timer.timerLagMs: number | null` — время (мс) от
`due_at` старейшего `pending`-таймера, у которого `due_at <= now`, до `now`.
`null` — когда нет просроченных pending-таймеров (норма).
Положительное значение > порогового — P1-сигнал тихого отказа dispatcher'а.

---

## 4. Нефункциональные требования

### NF-1  Одна функция-стор, контракт аналогичен `pgJobStore`

`PostgresTimerStore` (или аналогичное название) реализует операции таймера за чётким
интерфейсом: `enqueue`, `fetchAndFire` (фаза-2), `cancel`, `done`. Zero-dep stdlib:
raw pg-queries, parameterised, без ORM (ADR NF-4).

### NF-2  Tenant-leading индексы

`tenant_id` — первая колонка во всех составных индексах `app_timer` (T-0013 §3.1).

### NF-3  KNOWN_TENANT_TABLES обновляется

`ci/checks/known_tenant_tables.txt` пополняется строкой `app_timer`. Это делает
cross-tenant CI-тест (T-0115) автоматически покрывающим новую таблицу без изменения
самого теста.

### NF-4  Timer-lag в health при падении соединения

Если запрос health-метрики таймеров бросает исключение — `GET /health` возвращает
`status: "degraded"`, `timer.timerLagMs: null` (по аналогии с `queue.depth`).

### NF-5  SECURITY DEFINER-функция не доступна `choros_app` напрямую для DDL

`choros_app` имеет право вызвать `next_due_buckets()` (EXECUTE), но не ALTER/DROP
функцию. DDL на функцию — только у `choros_migrator`.

---

## 5. Явные не-цели (Out of Scope)

- **Прикладные обработчики таймеров** (inbox-эскалация, lease-renew-логика, retry-логика) —
  вне T-0116; данная задача строит только инфраструктуру диспетчеризации.
- **Flowable-таймеры** (BPMN boundary-timers) — за ними `ACT_*`; не пересекаемся.
- **LISTEN/NOTIFY** как механизм wake-up dispatcher'а — ADR §1 это явно отвергает;
  диспетчер работает в poll-режиме.
- **Redis / внешний брокер** — не до S2.
- **multi-consumer fan-out** одного таймера нескольким обработчикам — вне T-0116.
- **API-эндпоинты управления таймерами** (REST CRUD over `app_timer`) — вне T-0116;
  строим только внутреннюю инфраструктуру.

---

## 6. Критерии приёмки

### RLS и изоляция тенантов

**AC-1** (test)
`INSERT INTO choros.app_timer` от `choros_app` без установленного GUC `choros.tenant_id`
→ Postgres бросает ошибку (fail-closed, аналог AC-6 T-0115).

**AC-2** (test)
`SELECT ... FROM choros.app_timer` от `choros_app` в контексте TENANT_A (SET LOCAL)
→ строки с `tenant_id = TENANT_B` не возвращаются (0 строк при явном `WHERE tenant_id=TENANT_B`).

**AC-3** (fitness)
`ci/checks/known_tenant_tables.txt` содержит строку `app_timer`.
Cross-tenant CI-тест (T-0115, `KNOWN_TENANT_TABLES`) проходит без изменений самого теста —
все AC-1..AC-9 T-0115 применяются к `app_timer` автоматически.

### SECURITY DEFINER / двухфазный dispatcher

**AC-4** (test)
Вызов `choros.next_due_buckets(p_due_before)` от `choros_app` без GUC `choros.tenant_id`
→ возвращает корректный агрегат `(tenant_id, timer_count)` (функция SECURITY DEFINER,
GUC не нужен).

**AC-5** (test)
Результат `next_due_buckets()` содержит только поля `tenant_id` и `timer_count`
— **не содержит** `id`, `payload`, `kind`, `due_at` или любых других полей строки таймера.
Проверяется структура возвращаемого набора: ровно 2 колонки.

**AC-6** (test)
Фаза-2: dispatcher, вызывающий `fetchAndFire` в контексте TENANT_A (SET LOCAL),
получает только `pending`-таймеры с `due_at <= now` этого тенанта.
Одновременная строка TENANT_B не захватывается и остаётся в `state='pending'`.

**AC-7** (test)
Фаза-2: `fetchAndFire` с `LIMIT N` → возвращает ≤ N строк.
Оставшиеся pending-таймеры (> N) не переходят в `state='firing'`.

**AC-8** (test)
`FOR UPDATE SKIP LOCKED` семантика: второй параллельный вызов `fetchAndFire`
для того же тенанта не захватывает строки, уже залоченные первым вызовом
(rowCount второго вызова + rowCount первого вызова ≤ суммарного числа ready-строк).

### Timer-lag в health

**AC-9** (test)
`GET /health` при наличии хотя бы одного `pending`-таймера с `due_at <= now`
возвращает `timer.timerLagMs` ≥ 0 (тип number, не null).

**AC-10** (test)
`GET /health` при отсутствии просроченных `pending`-таймеров возвращает
`timer.timerLagMs: null`.

**AC-11** (test)
`GET /health` при ошибке Postgres в запросе timer-метрики возвращает
`status: "degraded"`, `timer.timerLagMs: null` (деградация не крашит эндпоинт).

**AC-12** (fitness)
Новый partial-индекс `(tenant_id, due_at) WHERE state = 'pending'` существует
в `pg_indexes` после применения миграции. Имя индекса содержит `app_timer` и `pending`.

### Схема и миграции

**AC-13** (test)
После применения миграций `011_+` (T-0116) таблица `choros.app_timer` существует
с колонками `tenant_id`, `id`, `due_at`, `state`, `kind`, `payload`
(минимальный обязательный набор; architect может добавлять колонки).

**AC-14** (test)
`app_timer` имеет `FORCE ROW LEVEL SECURITY` (проверяется через `pg_tables.rowsecurity = true`
и `pg_class.relforcerowsecurity = true`).

---

## 7. Вопросы и неясности

Блокирующих вопросов нет. Все архитектурные решения (naming, дополнительные колонки,
точная сигнатура store-класса, механизм poll-интервала) — автономная зона architect/coder.
