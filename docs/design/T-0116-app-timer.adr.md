# ADR · T-0116 — Подложка-3: durable-планировщик прикладных таймеров

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-10
**Spec:** `docs/specs/T-0116-app-timer.spec.md` (status: ready, AC-1..AC-14)
**Stack ADR (не противоречить):** `docs/design/stack-and-fleet-ops.md` §1 п.3 (ratified GT-1 2026-06-10)
**Опора T-0114:** `docs/design/T-0114-jobstore-postgres.adr.md` — паттерн store, SKIP LOCKED, health, ops-catalog
**Опора T-0115:** `ci/checks/db/cross_tenant.test.ts` — KNOWN_TENANT_TABLES, RLS CI-гейт

---

## 1. Decision

Реализовать durable-планировщик прикладных таймеров как **`PostgresTimerStore`** за
чётким интерфейсом (`enqueue`, `fetchAndFire`, `cancel`, `done`), по образцу
`PostgresJobStore` из T-0114: raw `pg`-драйвер, parameterised SQL, zero-dep, инъектируемые
часы (`Clock`). Двухфазный tenant-scoped dispatcher реализован в одной функции
`fetchAndFire` (фаза-1 вызывает SECURITY DEFINER агрегат, фаза-2 исполняется в caller-е с
`SET LOCAL`).

Механизм хранения: одна таблица `choros.app_timer` в миграции `011_app_timer.sql`
(T-0116 владеет номерами `011_+`). Isolaton: `ENABLE/FORCE ROW LEVEL SECURITY` по
`current_setting('choros.tenant_id', true)::uuid`, политика аналогична `choros.job`.

Scheduler-discovery: SECURITY DEFINER-функция `choros.next_due_buckets(p_due_before bigint)`
возвращает только агрегат `(tenant_id uuid, timer_count bigint)` — без строк данных.
Caller (dispatcher) итерирует по bucket-ам и для каждого тенанта вызывает
`fetchAndFire(tenantId, dueBeforeMs, limitN)`, которая открывает транзакцию с
`SET LOCAL choros.tenant_id = $tenantId`, захватывает ≤ N pending-таймеров
`FOR UPDATE SKIP LOCKED`, переводит их в `state = 'firing'` и возвращает строки caller-у.

Health: `PostgresTimerStore.getTimerHealth()` → `{ timerLagMs: number | null }`.
`GET /health` расширяется полем `timer.timerLagMs`, backward-compatible. При ошибке
Postgres → `status: "degraded"`, `timer.timerLagMs: null` (аналогично queue-health).

Ops-catalog: `ops/catalog/timer_stats.ts` — идемпотентный SELECT по `choros.app_timer`,
stdout JSON, exit 0, autonomy tier T0 (аналог `queue_stats`).

Cross-tenant CI: добавить `app_timer` в `ci/checks/known_tenant_tables.txt` — все
AC T-0115 подхватывают новую таблицу без изменений самого теста.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **LISTEN/NOTIFY как wake-up** | Spec явно запрещает: Out of Scope п.2; dispatcher работает в poll-режиме. Добавляет stateful push-соединения на тенанта, усложняет отказоустойчивость без пользы на целевой нагрузке (silo, единицы rps). |
| **Единственная фаза без SECURITY DEFINER** | Вынуждает `choros_app` делать full-scan `app_timer` без тенант-фильтра для обнаружения просроченных тенантов — нарушает RLS-изоляцию (политика требует установленного GUC). SECURITY DEFINER-агрегат минимально расширяет поверхность. |
| **Отдельная «dispatcher»-таблица/очередь поверх app_timer** | Дублирует субстрат; стек ADR §1 п.3 явно называет `due_at` + partial index как механизм прикладных таймеров на Postgres. |
| **Redis / внешний брокер** | Out of Scope spec §5; не до S2 по stack ADR. |
| **Один общий store-метод вместо fetchAndFire + next_due_buckets** | Нельзя: фаза-1 работает без GUC (SECURITY DEFINER), фаза-2 требует GUC. Смешение в одном методе скрывало бы разницу контекстов. |
| **Multi-consumer fan-out одного таймера** | Out of Scope spec §5; усложняет семантику без текущей потребности. |

---

## 3. Object model

### 3.1 Таблица `choros.app_timer` (migration 011_app_timer.sql)

| Колонка | Тип | Ограничения | Примечания |
|---|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL` | Ведущий ключ (T-0013 §3.1); PK(tenant_id, id) |
| `id` | `uuid` | `NOT NULL` | Уникальный идентификатор таймера |
| `due_at` | `bigint` | `NOT NULL` | Unix epoch ms; момент срабатывания |
| `state` | `text` | `NOT NULL CHECK (state IN ('pending','firing','done','cancelled'))` | Жизненный цикл |
| `kind` | `text` | `NOT NULL` | Тип таймера (`inbox_sla`, `lease_renew`, `retry`, …); непрозрачен для dispatcher |
| `payload` | `jsonb` | `NOT NULL` | Прикладная нагрузка; непрозрачна для dispatcher |
| `created_at` | `bigint` | `NOT NULL` | Unix epoch ms (Clock.now() при enqueue) |
| `fired_at` | `bigint` | `NULL` | Установлен dispatcher при переходе → `firing` |
| `cancel_reason` | `text` | `NULL` | Устанавливается при `cancel()` |

PK: `(tenant_id, id)`.

### 3.2 Partial-индекс

```sql
CREATE INDEX idx_app_timer_pending
  ON choros.app_timer (tenant_id, due_at)
  WHERE state = 'pending';
```

Имя содержит `app_timer` и `pending` (AC-12). `tenant_id` — ведущая колонка (NF-2).

### 3.3 RLS-политика (migration 011_app_timer.sql)

```sql
ALTER TABLE choros.app_timer ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.app_timer FORCE ROW LEVEL SECURITY;

CREATE POLICY app_timer_tenant_isolation ON choros.app_timer
  USING      (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.app_timer TO choros_app;
```

Fail-closed: без GUC `current_setting('choros.tenant_id', true)` → NULL → предикат
никогда не true → 0 строк видно, INSERT падает (AC-1, AC-14).

### 3.4 SECURITY DEFINER-функция `choros.next_due_buckets` (migration 012_next_due_buckets.sql)

```sql
CREATE OR REPLACE FUNCTION choros.next_due_buckets(p_due_before bigint)
RETURNS TABLE(tenant_id uuid, timer_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = choros, pg_catalog
STABLE
AS $$
  SELECT tenant_id, COUNT(*)::bigint AS timer_count
  FROM choros.app_timer
  WHERE state = 'pending' AND due_at < p_due_before
  GROUP BY tenant_id;
$$;

-- Owner: choros_migrator (inherits from CURRENT_USER at migration time)
REVOKE ALL ON FUNCTION choros.next_due_buckets(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION choros.next_due_buckets(bigint) TO choros_app;
```

Функция видит все тенанты (SECURITY DEFINER bypasses RLS), но возвращает **только**
`(tenant_id, timer_count)` — никаких строк таймеров (AC-5). `choros_app` имеет
EXECUTE, но не DDL (NF-5 → только `choros_migrator` может ALTER/DROP).

### 3.5 `AppTimer` TS-тип (`src/core/timerTypes.ts`)

```typescript
export type TimerState = 'pending' | 'firing' | 'done' | 'cancelled';

export interface AppTimer {
  readonly tenantId: string;       // UUID
  readonly id: string;             // UUID
  readonly dueAt: number;          // unix epoch ms
  readonly state: TimerState;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;      // unix epoch ms
  readonly firedAt: number | undefined;
  readonly cancelReason: string | undefined;
}
```

### 3.6 `PostgresTimerStore` (`src/core/postgres/pgTimerStore.ts`)

Инъектируемые зависимости: `pg.Pool`, `Clock` (опционально, default `systemClock`).

| Метод | Сигнатура | Семантика |
|---|---|---|
| `enqueue` | `(tenantId, kind, payload, dueAt) => Promise<AppTimer>` | INSERT `state='pending'`; caller уже установил GUC или передаёт tenantId явно для INSERT (SECURITY DEFINER не нужен здесь). |
| `fetchAndFire` | `(tenantId, dueBeforeMs, limit) => Promise<AppTimer[]>` | BEGIN; SET LOCAL choros.tenant_id = tenantId; SELECT FOR UPDATE SKIP LOCKED WHERE state='pending' AND due_at < dueBeforeMs ORDER BY due_at ASC LIMIT N; UPDATE state='firing', fired_at=now; COMMIT; return rows. |
| `cancel` | `(tenantId, timerId, reason?) => Promise<boolean>` | UPDATE state='cancelled', cancel_reason=reason WHERE id=$id AND state='pending'; returns rowCount > 0. |
| `done` | `(tenantId, timerId) => Promise<boolean>` | UPDATE state='done' WHERE id=$id AND state='firing'; returns rowCount > 0. |
| `getTimerHealth` | `() => Promise<{ timerLagMs: number \| null }>` | SELECT MIN(due_at) FROM app_timer WHERE state='pending' AND due_at <= now(); вычисляет lag. Не устанавливает GUC (migrator URL или суперпользователь). Выбрасывает при ошибке соединения. |

**Важно:** `enqueue`, `fetchAndFire`, `cancel`, `done` — конечные операции тенант-владельца; caller устанавливает GUC до вызова (RLS обеспечивает изоляцию). `getTimerHealth` — health-операция без тенантного контекста (запрашивается от migrator/superuser или через SECURITY DEFINER аналогично `next_due_buckets`).

### 3.7 Health response (расширение `GET /health`)

```typescript
// Расширение существующего ответа (backward-compatible)
{
  status: "ok" | "degraded",
  queue: { depth: number, oldestAvailableLagMs: number | null },
  timer: { timerLagMs: number | null }   // NEW — T-0116
}
```

При ошибке Postgres в timer-запросе: `status: "degraded"`, `timer.timerLagMs: null`.
Существующий `queue`-блок независим: его ошибка тоже → `degraded`, оба блока
вычисляются в параллельных try/catch.

### 3.8 Ops-operation `ops/catalog/timer_stats.ts`

Паттерн идентичен `ops/catalog/queue_stats.ts`:

```
Output shape:
{
  pendingCount: number,          // state='pending'
  firingCount: number,           // state='firing'
  doneCount: number,             // state='done'
  cancelledCount: number,        // state='cancelled'
  overdueCount: number,          // state='pending' AND due_at < now
  timerLagMs: number | null      // MAX(now - due_at) WHERE state='pending' AND due_at < now
}
```

CLI: `DATABASE_URL=<migrator-url> node ops/dist/timer_stats.js`. Autonomy tier T0.
Идемпотентен (pure SELECT). Выходит 0 всегда. Использует migrator URL (нет GUC,
нет RLS-фильтра) → видит все тенанты.

---

## 4. Contracts

### 4.1 DDL-контракт миграций

- `migrations/011_app_timer.sql` — CREATE TABLE + FORCE RLS + политика + GRANT + partial index
- `migrations/012_next_due_buckets.sql` — SECURITY DEFINER-функция + REVOKE PUBLIC + GRANT EXECUTE choros_app
- Имена индексов: `idx_app_timer_pending` (содержит `app_timer` и `pending`, AC-12)
- `ci/checks/known_tenant_tables.txt` += `app_timer` (AC-3)

### 4.2 SQL-контракт `fetchAndFire`

```sql
-- Внутри BEGIN/COMMIT; $1=tenantId, $2=dueBeforeMs, $3=limit, $4=now
SET LOCAL choros.tenant_id = $1;

WITH candidates AS (
  SELECT id FROM choros.app_timer
  WHERE state = 'pending'
    AND due_at < $2
  ORDER BY due_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
UPDATE choros.app_timer t
SET
  state    = 'firing',
  fired_at = $4
FROM candidates
WHERE t.id = candidates.id
RETURNING t.tenant_id, t.id, t.due_at, t.state, t.kind,
          t.payload, t.created_at, t.fired_at, t.cancel_reason;
```

RLS автоматически ограничивает выборку тенантом из GUC — таймеры других тенантов
не видны (AC-2, AC-6).

### 4.3 SQL-контракт `getTimerHealth`

```sql
-- Выполняется без GUC (migrator connection или SECURITY DEFINER wrapper)
SELECT MIN(due_at) AS oldest_overdue_at
FROM choros.app_timer
WHERE state = 'pending' AND due_at <= $1;  -- $1 = now
-- timerLagMs = oldest_overdue_at IS NOT NULL ? (now - oldest_overdue_at) : null
```

### 4.4 Контракт dispatcher-а (как на него садятся потребители)

Dispatcher — это не класс T-0116, а паттерн использования `PostgresTimerStore`:

```typescript
// Псевдокод — не реализация (zone: coder потребителей T-0117+)
async function dispatchTimers(store: PostgresTimerStore, dueBeforeMs: number): Promise<void> {
  // Фаза-1: SECURITY DEFINER, без GUC, видит все тенанты
  const buckets = await pool.query('SELECT * FROM choros.next_due_buckets($1)', [dueBeforeMs]);

  // Фаза-2: per-tenant, через store.fetchAndFire (SET LOCAL внутри)
  for (const { tenant_id, timer_count } of buckets.rows) {
    const timers = await store.fetchAndFire(tenant_id, dueBeforeMs, BATCH_SIZE);
    // Прикладная обработка — ВНЕ транзакции fetchAndFire
    for (const timer of timers) {
      await handleTimer(timer);          // zone: потребитель (T-0117+)
      await store.done(tenant_id, timer.id);
    }
  }
}
```

`next_due_buckets` вызывается на соединении **без** установленного GUC (иначе RLS
заблокирует — функция SECURITY DEFINER этого не требует, но подключение всё равно
не должно иметь GUC на уровне сессии).

### 4.5 Публичные экспорты (совместимость импортёров)

```typescript
// src/core/timerTypes.ts  — NEW (не ломает ничего)
export type { AppTimer, TimerState }

// src/core/postgres/pgTimerStore.ts  — NEW
export class PostgresTimerStore { ... }
export type { TimerHealthResult }

// ops/catalog/timer_stats.ts  — NEW
export async function getTimerStats(dbUrl: string): Promise<TimerStatsResult>
```

Новые файлы, нет существующих импортёров → нет breaking changes (compat-check FE-W23-0008).

---

## 5. Fitness functions

| ID | Правило | CI-проверка |
|---|---|---|
| **FF-T1** | `app_timer` в `KNOWN_TENANT_TABLES` → cross-tenant тест подхватывает без изменений | `grep 'app_timer' ci/checks/known_tenant_tables.txt` выдаёт строку. Выполняется в `ci/checks/db/cross_tenant.test.ts` (static + db job). |
| **FF-T2** | Partial-индекс `idx_app_timer_pending` существует после миграций | `SELECT 1 FROM pg_indexes WHERE tablename='app_timer' AND indexname LIKE '%app_timer%pending%'` возвращает строку. `ci/checks/db/schema.test.ts` db-job. |
| **FF-T3** | `app_timer` имеет FORCE RLS (`pg_class.relforcerowsecurity = true`) | `SELECT relforcerowsecurity FROM pg_class WHERE relname='app_timer'` = `true`. `ci/checks/db/force_rls.sql` + `schema.test.ts`. |
| **FF-T4** | `tenant_id` — ведущая колонка во всех индексах `app_timer` | `SELECT * FROM pg_indexes WHERE tablename='app_timer'` — все составные индексы начинаются с `tenant_id`. `ci/checks/db/tenant_id_leading.sql` (существующая проверка T-0115). |
| **FF-T5** | `next_due_buckets()` возвращает ровно 2 колонки (`tenant_id`, `timer_count`), никаких полей строк | `SELECT column_name FROM information_schema.columns WHERE ...` или introspection в тесте: `Object.keys(row).length === 2 && 'tenant_id' in row && 'timer_count' in row`. `ci/checks/db/two_tenant.test.ts` db-job. |
| **FF-T6** | `fetchAndFire` использует `FOR UPDATE SKIP LOCKED` | `grep -n 'FOR UPDATE' src/core/postgres/pgTimerStore.ts` содержит `SKIP LOCKED`. Static. |
| **FF-T7** | Health backward-compatible: `GET /health` без DATABASE_URL → 200, `status: "ok"`, Content-Type json | `npm test -- health.test.ts` проходит без DATABASE_URL (проверяет расширенную схему с `timer.timerLagMs`). Static. |
| **FF-T8** | `timer_stats` выходит 0 и эмитит валидный JSON при bad URL и при real URL | `DATABASE_URL=bad node ops/dist/timer_stats.js` exits 0, `{ok:false,error:…}`. `DATABASE_URL=$real node ops/dist/timer_stats.js` exits 0, `{ok:true,pendingCount:…}`. `ci/checks/ops-ops.test.ts`. |
| **FF-T9** | Нет ORM в `src/` и `ops/` | `grep -rn 'prisma\|typeorm\|drizzle\|sequelize\|knex\|mikro-orm' src/ ops/` → 0 hits. Static. |
| **FF-T10** | `choros_app` не может ALTER/DROP `next_due_buckets()` | Integration (db-job): `choros_app` выполняет `ALTER FUNCTION choros.next_due_buckets(bigint) ...` → ошибка `permission denied`. `ci/checks/db/two_tenant.test.ts`. |

---

## 6. Traceability

| AC | Covered by |
|---|---|
| AC-1 | §3.3 FORCE RLS + fail-closed политика; FF-T3; тест: INSERT без GUC → Postgres ошибка |
| AC-2 | §4.2 SET LOCAL + RLS автофильтр; FF-T4; тест: SELECT в контексте TENANT_A, WHERE tenant_id=TENANT_B → 0 строк |
| AC-3 | §4.1 known_tenant_tables.txt += app_timer; FF-T1; cross_tenant.test.ts подхватывает без изменений |
| AC-4 | §3.4 SECURITY DEFINER + §4.4 dispatcher-контракт; FF-T5; тест: вызов без GUC → результат без ошибки |
| AC-5 | §3.4 SELECT возвращает только (tenant_id, timer_count); FF-T5; тест: Object.keys(row).length === 2 |
| AC-6 | §4.2 fetchAndFire SET LOCAL + RLS; тест: fetchAndFire TENANT_A не захватывает строки TENANT_B |
| AC-7 | §4.2 LIMIT N в SQL; тест: rowCount ≤ N; оставшиеся state='pending' |
| AC-8 | §4.2 FOR UPDATE SKIP LOCKED; FF-T6; тест: параллельные fetchAndFire, rowCount1 + rowCount2 ≤ total |
| AC-9 | §3.7 timerLagMs ≥ 0 при наличии просроченных; тест: health с перезревшим таймером |
| AC-10 | §4.3 oldest_overdue_at IS NULL → null; тест: health без просроченных таймеров |
| AC-11 | §3.7 try/catch в health → degraded; FF-T7; тест: broken pool → degraded, timerLagMs:null |
| AC-12 | §3.2 partial index + §4.1 имя; FF-T2; тест: pg_indexes после миграции |
| AC-13 | §3.1 DDL колонки; §4.1 migration 011; тест: \d app_timer после миграций |
| AC-14 | §3.3 FORCE ROW LEVEL SECURITY; FF-T3; тест: pg_class.relforcerowsecurity = true |

---

## 7. Runtime target

Postgres 16 в docker-compose silo на сервере фаундера (`/srv/choros`). Деплой —
фаундер-гейт. Соединение via `DATABASE_URL` (env). Приложение подключается как
`choros_app` (NOBYPASSRLS, non-owner). Миграции — `choros_migrator`. T-0116
владеет номерами `011_` и `012_`. Инфра (compose, migrations runner, pg package,
001–010 migrations) — T-0053/T-0114 (уже влиты).

---

## 8. Notes

- `fetchAndFire` возвращает строки caller-у **после** COMMIT. Прикладная обработка
  (`handleTimer`) — вне транзакции dispatcher-а. Caller обязан вызвать `done()` после
  успешной обработки или реализовать собственную идемпотентность (зона потребителей,
  не T-0116).
- `firing`-строки, которые не дошли до `done()` (сбой обработчика), остаются в
  state=`firing` бессрочно. Recovery-логика (timeout → reset → `pending`) — зона
  следующих задач (lease-renew паттерн); T-0116 только строит инфраструктуру.
- `enqueue` использует `current_setting('choros.tenant_id', false)::uuid` — caller
  устанавливает GUC до вызова (аналог `pgJobStore.enqueue`).
- `getTimerHealth` запрашивается на migrator-соединении (нет RLS) — агрегирует лаг
  по всем тенантам. Если нужна изоляция в health — это future work.
