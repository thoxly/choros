# T-0062 · ADR — Идемпотентность + outbox (E1.2)

**Фаза:** DESIGN · **Вход:** `docs/specs/T-0062-idempotency-outbox.spec.md` (20 AC, ready) ·
**База:** dev `8fe7acf` · **Образец:** T-0116 app_timer (двухфазный диспетчер 1:1) ·
**Уроки:** T-0019 (composite tenant-FK; no-decrement монотонность), T-0114
(ownership-gate race-safe, at-least-once), T-0115 (cross-tenant CI-блокер).

> **ШОВ ПРОГОНА (перекрывает спеку «≥022»):** миграции — **номера с 023**
> (022 забронирована параллельной T-0034; 019-021 — T-0022, файлов нет в этом
> чекауте). Идемпотентный раннер `migrations/run.mjs` это терпит — лексикографически
> применяет только отсутствующие версии (валидировано живьём на изолированном
> Postgres 55448).

---

## 1. Решение (одним абзацем)

Закрываем две дыры транзакционной целостности воркерного контура **аддитивно**, не
трогая race-safe `complete`/`fail` (ownership-gate ADR T-0114 §4.4 корректен).
**(1) Идемпотентность enqueue:** новая nullable-колонка `choros.job.idempotency_key`
(≤255, CHECK) + **partial-unique** `(tenant_id, idempotency_key) WHERE idempotency_key
IS NOT NULL`; `enqueue` получает опциональный 4-й параметр `idempotencyKey?: string`
(обратная совместимость — единственный текущий вызыватель `src/http/externalWorker.ts`
передаёт 3 позиционных арга), при ключе делает `INSERT … ON CONFLICT (tenant_id,
idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` и при пустом `RETURNING`
довыбирает существующую строку `SELECT … WHERE tenant_id=GUC AND idempotency_key=$key`
— возвращает существующий job, не плодит дубль. Без ключа — текущее поведение
(безусловный INSERT с `randomUUID()`). **(2) Outbox:** новая tenant-таблица
`choros.outbox` (FORCE RLS + default-DENY на GUC `choros.tenant_id`, tenant_id —
ведущая колонка PK и всех составных индексов), доменная мутация + INSERT в outbox в
ОДНОЙ Postgres-транзакции (возврат целостности «процесс+данные» CONCEPT §6); доставка
**двухфазным диспетчером по образцу T-0116**: фаза-1 `SECURITY DEFINER`-агрегат
`choros.outbox_pending_buckets(p_before)` → `(tenant_id, pending_count)` без строк и
без GUC; фаза-2 per-tenant tx `SET LOCAL choros.tenant_id` + CTE `FOR UPDATE SKIP
LOCKED LIMIT N` (`state='pending' AND available_at<=now`) → `dispatching`; успех →
`dispatched`+`dispatched_at`, ошибка → `pending`+`attempts+1`+`available_at=now+backoff`,
исчерпание → `dead`. Тонкое ядро (стор + диспетчер), логика на границах — соразмерно
(рубрика ось 5): никакого брокера/Redis/Kafka (отвергнуты stack-ADR), poll-режим как
T-0116. Контракты потребителей T-0067/T-0068 зафиксированы интерфейсно, не реализованы.

---

## 2. Отвергнутые альтернативы

| Вариант | Почему нет |
|---|---|
| Дедуп enqueue по контент-хешу `(topic, variables)` вместо явного `idempotency_key` | Хрупко: нормализация JSON, ложные коллизии для легитимно-одинаковых заданий; продюсер лучше знает логический ключ ретрая. Спека пинит явный ключ. |
| `INSERT … ON CONFLICT DO UPDATE … RETURNING` (upsert) для enqueue-идемпотентности | `DO UPDATE` тронул бы существующий job (state/variables) — нарушает «повторный enqueue не меняет уже-принятое». `DO NOTHING` + добор SELECT семантически чист: вернуть существующий как есть. |
| Outbox без `state='dispatching'` (сразу pending→dispatched) | Без intermediate-состояния два диспетчера могут параллельно доставить одну строку; `dispatching` под `FOR UPDATE SKIP LOCKED` = ровно один захват (AC-12), как `firing` в T-0116. |
| FK `outbox.aggregate_id → <доменная таблица>` | `aggregate_kind` полиморфен ('job'/'record'/'external_task'/…) — единого parent нет. Денормализованная opaque-ссылка (как `object_handle`/`actor_event.object_ref`, T-0019 §3.4). **Не** composite FK — урок T-0019 применяется к ссылкам на tenant-таблицы, а здесь её нет. |
| DLQ отдельной таблицей | `state='dead'` остаётся в outbox (спека §5 out-of-scope); перекладывание/алертинг — отдельная задача. |
| LISTEN/NOTIFY как wake-up диспетчера | Poll-режим (T-0116 ADR §1); NOTIFY не доживает до подписки, не транзакционно-надёжен. Out-of-scope. |
| Брокер (Redis/Kafka/Temporal) | Отвергнуты в stack-ADR (single-Postgres substrate). |

---

## 3. Объектная модель / схема

### 3.1 `choros.job` — аддитивная колонка (миграция **023**)

```sql
ALTER TABLE choros.job ADD COLUMN idempotency_key text NULL;
ALTER TABLE choros.job ADD CONSTRAINT job_idempotency_key_len
  CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 255);
CREATE UNIQUE INDEX job_idempotency_key_uq
  ON choros.job (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;          -- AC-4; FF-LEAD: tenant_id ведущий
```

- Nullable: отсутствие ключа = текущее поведение (обратная совместимость, AC-3).
- Partial-unique → дубли по `(tenant_id, idempotency_key)` невозможны; кросс-тенантно
  ключи независимы (`tenant_id` в индексе).
- **Колонка, не таблица** → `known_tenant_tables.txt` из-за неё НЕ трогается (NF-2).

### 3.2 `choros.outbox` — новая tenant-таблица (миграция **024**)

| Поле | Тип | Прим. |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | ведущая колонка PK и индексов (NF-1, T-0013 §3.1) |
| `id` | `uuid NOT NULL` | PK `(tenant_id, id)` |
| `aggregate_kind` | `text NOT NULL` | полиморфный источник: 'job'/'record'/'external_task'/… |
| `aggregate_id` | `uuid NOT NULL` | opaque-ссылка, **не FK** (полиморфизм) |
| `event_type` | `text NOT NULL` | напр. 'task_completed' |
| `payload` | `jsonb NOT NULL` | данные сигнала |
| `state` | `text NOT NULL DEFAULT 'pending'` | CHECK ∈ {pending,dispatching,dispatched,dead} |
| `idempotency_key` | `text NOT NULL` | для дедупликации **доставки** потребителем |
| `attempts` | `integer NOT NULL DEFAULT 0` | CHECK ≥ 0 (no-decrement, T-0019) |
| `created_at` | `bigint NOT NULL` | мс epoch (inject Clock, NF-5) |
| `available_at` | `bigint NOT NULL` | backoff-окно; диспетчер берёт `<= now` |
| `dispatched_at` | `bigint NULL` | проставляется при `dispatched` |
| `last_error` | `text NULL` | диагностика последней неудачи |

```sql
PRIMARY KEY (tenant_id, id),
CONSTRAINT outbox_dispatched_at_iff
  CHECK ((state = 'dispatched') = (dispatched_at IS NOT NULL))   -- инвариант состояния
```

RLS (verbatim как `app_timer`/011): `ENABLE` + `FORCE ROW LEVEL SECURITY`; одна
default-DENY политика `USING/WITH CHECK (tenant_id = current_setting('choros.tenant_id',
true)::uuid)`; `GRANT SELECT,INSERT,UPDATE,DELETE … TO choros_app` (не DDL, NF-4).
Партиал-индекс горячего пути:

```sql
CREATE INDEX idx_outbox_pending
  ON choros.outbox (tenant_id, available_at)
  WHERE state = 'pending';        -- AC-15, NF-6; FF-LEAD: tenant_id ведущий
```

> **idempotency_key NOT NULL** (в отличие от job) — каждая outbox-строка адресует
> внешний эффект, дедуп доставки обязателен; coder генерирует ключ (напр.
> `aggregate_kind:aggregate_id:event_type` или явный) при INSERT. Уникальность
> доставки гарантирует **потребитель** по этому ключу, НЕ диспетчер (at-least-once,
> FR-6). Уникального ограничения на `outbox.idempotency_key` НЕТ — одна логическая
> доменная мутация = одна строка outbox по построению; навязывать БД-уникальность
> здесь не нужно (соразмерность).

### 3.3 `choros.outbox_pending_buckets` — SECURITY DEFINER (миграция **025**)

```sql
CREATE OR REPLACE FUNCTION choros.outbox_pending_buckets(p_before bigint)
RETURNS TABLE(tenant_id uuid, pending_count bigint)         -- ровно 2 колонки, AC-10
LANGUAGE sql SECURITY DEFINER
SET search_path = choros, pg_catalog STABLE
AS $$
  SELECT tenant_id, COUNT(*)::bigint AS pending_count
  FROM choros.outbox
  WHERE state = 'pending' AND available_at <= p_before
  GROUP BY tenant_id;
$$;
REVOKE ALL ON FUNCTION choros.outbox_pending_buckets(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION choros.outbox_pending_buckets(bigint) TO choros_app;
```

Образец 012/`next_due_buckets` 1:1 (SECURITY DEFINER + `SET search_path` + REVOKE
PUBLIC + EXECUTE-only). Без GUC, без строк данных — фаза-1 межтенантного диспетчера.

---

## 4. Контракты (источник правды для coder/tester)

### 4.1 `PostgresJobStore.enqueue` — расширение сигнатуры

```ts
// БЫЛО: enqueue(topic, variables, retries): Promise<Job>
// СТАЛО (4-й опциональный параметр — обратно совместимо):
async enqueue(
  topic: string,
  variables: Record<string, unknown>,
  retries: number,
  idempotencyKey?: string            // ≤255; при наличии — дедуп по (tenant_id, key)
): Promise<Job>
```

Псевдокод (raw pg, без ORM, NF-3):
```
если idempotencyKey === undefined:
  INSERT … (… idempotency_key=NULL) RETURNING …      // текущее поведение, AC-3
иначе:
  r = INSERT … (… idempotency_key=$key)
        ON CONFLICT (tenant_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL           // ОБЯЗАТЕЛЬНО предикат partial-индекса
        DO NOTHING RETURNING …
  если r пуст:                                        // конфликт → строка уже есть
    r = SELECT … FROM choros.job
          WHERE tenant_id = current_setting('choros.tenant_id',false)::uuid
            AND idempotency_key = $key                // RLS+явный tenant — defense-in-depth
  вернуть rowToJob(r[0])                              // AC-1/AC-2
```

> **Контракт совместимости (rule #7):** `JobStore` (= `InMemoryJobStore`,
> `src/core/jobStore.ts`) — публичная поверхность, её импортируют замороженные
> unit-тесты (`jobStore.test.ts` и др.) и HTTP-хендлеры через alias. 4-й параметр
> **опционален** → ни один вызыватель не ломается; `externalWorker.ts:78` (3 арга)
> компилируется без изменений. **Для паритета** coder добавляет `idempotencyKey?`
> и в `InMemoryJobStore.enqueue` (Map-дедуп по `${tenantId}:${key}`), иначе тип
> `JobStore` разойдётся с `PostgresJobStore`. HTTP-роут `POST /jobs` опционально
> читает `idempotencyKey` из тела (валидация: string ≤255 если передан) — аддитивно,
> существующие клиенты не ломаются.

### 4.2 Outbox-стор (новый `src/core/postgres/pgOutboxStore.ts`)

Программный интерфейс (REST/CRUD — out-of-scope, §5 спеки):
```ts
class PostgresOutboxStore {
  constructor(pool: pg.Pool, clock?: Clock)            // inject Clock, NF-5
  // Фаза доменной транзакции: вызывается ВНУТРИ tx потребителя (тот же client),
  // НЕ открывает свою — атомарность данные+сигнал (AC-8, FR-3):
  enqueueInTx(client: pg.PoolClient, row: OutboxInsert): Promise<OutboxRow>
  // Фаза-1: агрегат без GUC (вызывает SECURITY DEFINER fn):
  pendingBuckets(before: number): Promise<Array<{tenantId: string; pendingCount: number}>>
  // Фаза-2: per-tenant tx, SET LOCAL + FOR UPDATE SKIP LOCKED → 'dispatching':
  claimBatch(tenantId: string, limit: number): Promise<OutboxRow[]>
  markDispatched(tenantId: string, id: string): Promise<boolean>   // 'dispatching'→'dispatched'
  markRetry(tenantId: string, id: string, backoffMs: number, error: string,
            maxAttempts: number): Promise<'pending'|'dead'>        // attempts+1; dead при исчерпании
  getOutboxHealth(): Promise<{ pendingLagMs: number|null; deadCount: number }>  // без GUC, AC-16
}
```

`OutboxInsert = { aggregateKind, aggregateId, eventType, payload, idempotencyKey }`
(tenant_id берётся из GUC `current_setting('choros.tenant_id',false)::uuid` — как
`pgTimerStore.enqueue`, R-4). `claimBatch`/`fetchAndFire`-паттерн: UUID-валидация
`tenantId` перед `SET LOCAL` (R-3 T-0116), BEGIN/SET LOCAL/CTE/COMMIT, ROLLBACK на
ошибку. Сортировка результата по `created_at`/`available_at` ASC (UPDATE FROM не
гарантирует порядок — урок pgJobStore).

> **No-decrement / монотонность состояния (урок T-0019):** переходы состояния идут
> ТОЛЬКО вперёд. `claimBatch` берёт лишь `state='pending'`; `markDispatched`
> обновляет лишь `state='dispatching'` (rowCount-гейт — иначе строку уже забрали);
> `markRetry` возвращает в `pending` ТОЛЬКО из `dispatching`. `attempts` лишь
> инкрементируется (CHECK ≥ 0). Запрещён откат `dispatched`→`pending` или
> декремент `attempts` — это тихо потеряло бы доставку/зациклило ретраи.

### 4.3 Двухфазный диспетчер (новый `src/core/outboxDispatcher.ts`)

```ts
interface DispatchResult { ok: boolean; idempotentSuccess?: boolean }
type Deliver = (row: OutboxRow) => Promise<DispatchResult>
type OnDispatched = (row: OutboxRow) => Promise<void>   // seam T-0068, инжектируется

async function runOutboxOnce(store, deliver, opts: {
  batchLimit: number; maxAttempts: number;
  backoff: (attempts: number) => number;      // эксп-backoff, как withRetry T-0064
  onDispatched?: OnDispatched;                // по умолчанию no-op (T-0068 заполнит)
}): Promise<{ dispatched: number; failed: number; dead: number }>
```

Цикл: `buckets = store.pendingBuckets(now)`; для каждого tenant —
`rows = store.claimBatch(tenant, limit)`; для каждой строки `res = await deliver(row)`;
успех (`res.ok` ИЛИ `res.idempotentSuccess`) → `markDispatched` + `onDispatched`;
иначе `markRetry(... backoff(attempts), maxAttempts)`.

> **Контракт T-0067 (зафиксирован, не реализован, AC-17):** для
> `event_type='task_completed'` функция `deliver` вызовет
> `flowableClient.completeTask`; исход `NOT_FOUND` (движок идемпотентен по taskId —
> дыра №4 спеки §2.2) трактуется как `{ ok:false, idempotentSuccess:true }` →
> строка → `dispatched`, **НЕ** `dead`. Это контракт интерфейса `Deliver` для
> T-0067, здесь только seam.
>
> **Контракт T-0068 (зафиксирован, не реализован, AC-18):** `onDispatched`-хук —
> seam для записи в `audit_event`/`actor_event` (T-0019) при доставке. T-0062
> оставляет инъекцию; реальная запись — зона T-0068.
>
> **Контракт идемпотентного воркера (AC-18, документирован):** воркер, получивший
> job дважды (at-least-once реклейм `fetchAndLock`, NF-1 T-0114), ОБЯЗАН либо (а)
> выполнять внешний эффект через outbox в той же транзакции, что фиксация
> результата, либо (б) дедуплицировать по бизнес-ключу. Зона исполнения — E1.5/T-0067.

### 4.4 GET /health (расширение `src/server.ts`)

Аддитивно к существующему `{ status, queue, timer }` добавляется блок
`outbox: { pendingLagMs: number|null, deadCount: number }`. Независимый try/catch
(как timer-блок, ADR T-0116 §3.7): ошибка Postgres → `status='degraded'`, не 500
(AC-16). `getOutboxHealth` исполняется без GUC (migrator-пул, агрегирует все тенанты,
как `getTimerHealth`). Обратная совместимость: существующие поля не меняются.

---

## 5. Fitness-функции (CI-границы)

| ID | Правило | CI-проверка |
|---|---|---|
| **FF-1** | Partial-unique `job_idempotency_key_uq` на `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL` существует. | `ci/checks/db/schema.test.ts`: запрос `pg_index`/`pg_indexes` подтверждает имя + `indpred IS NOT NULL` + ведущая колонка `tenant_id`. (AC-4) |
| **FF-2** | `outbox` присутствует в `ci/checks/known_tenant_tables.txt` (аддитивно). | `grep -qx outbox ci/checks/known_tenant_tables.txt` (новый shell-чек `ci/checks/outbox-registry.sh` ИЛИ строка в существующем) + `schema.test.ts` FF-2 (таблица существует). (AC-7) |
| **FF-3** | `choros.outbox` имеет ENABLE+FORCE RLS и default-DENY политику. | `ci/checks/db/schema.test.ts` FF-RLS (уже итерирует `KNOWN_TENANT_TABLES` → подхватит `outbox` без правок самого теста). (AC-5, AC-6) |
| **FF-4** | tenant_id — ведущая колонка ВСЕХ составных индексов и FK новых объектов. | `ci/checks/db/tenant_id_leading.sql` → 0 строк (валидировано живьём: 0). FF-LEAD в `schema.test.ts`. (NF-1) |
| **FF-5** | Партиал-индекс `idx_outbox_pending` на `(tenant_id, available_at) WHERE state='pending'`; EXPLAIN фазы-2 при 1000 dispatched + 10 pending → Index Scan, не Seq Scan. | `ci/checks/db/pgOutboxStore.integration.test.ts`: `EXPLAIN` содержит `idx_outbox_pending`, не `Seq Scan on outbox`. (AC-15) |
| **FF-6** | `outbox_pending_buckets()` возвращает ровно 2 колонки `(tenant_id, pending_count)`, работает без GUC. | integration: `SELECT * FROM choros.outbox_pending_buckets($before)` от choros_app без GUC → `Object.keys(row)` = `['tenant_id','pending_count']`. (AC-9, AC-10) |
| **FF-7** | Никакого ORM/новых runtime-deps: только `pg` (parameterised). | `ci/checks/pg-single-dep.sh` (существует) + `eslint` (no raw string concat в SQL, кроме UUID-validated SET LOCAL). (NF-3) |
| **FF-8** | Монотонность состояния outbox: нет SQL-перехода `dispatched→pending`/`dead→*`, нет декремента `attempts`; CHECK `(state='dispatched')=(dispatched_at IS NOT NULL)`. | `ci/checks/db/schema.test.ts`: CHECK `outbox_dispatched_at_iff` существует (валидировано живьём: отвергает dispatched без dispatched_at). + integration AC-13/AC-14. (T-0019 урок) |
| **FF-9** | `complete`/`fail` JobStore НЕ изменены (ownership-gate frozen). | `git diff --stat` на `pgJobStore.ts`: метод `enqueue` тронут, тела `complete`/`fail` — нет (review-чек). (спека §3.1) |
| **FF-10** | Миграции — номера ≥ 023; раннер применяет идемпотентно (повторный прогон 0 ошибок). | `ci/checks/db` bring-up: `node migrations/run.mjs` дважды → второй прогон «nothing to apply». (AC-19) — валидировано живьём на 55448. |
| **FF-11** | `tsc --noEmit`, `eslint`, весь `npm run fitness` зелёные (аддитивность). | `npm run ci`. (AC-20) |

> **FF-2 нюанс (см. §6 фрикшен):** добавление `outbox` в `known_tenant_tables.txt`
> требует **сопутствующего аддитивного** `case 'outbox':` в
> `ci/checks/db/cross_tenant.test.ts` (`seedRowForTable` имеет `default: throw`).
> Это аддитивная правка (новый seeder), НЕ изменение ассертов теста.

---

## 6. Фрикшен: AC-7 vs реальный T-0115-тест (rule #7 — контракт совместимости)

**Находка (живьём против кода):** спека AC-7 и контракт NF-2 утверждают, что
`outbox` в `known_tenant_tables.txt` подхватывается межтенантным CI-тестом T-0115
**«без изменений самого теста»**. Это **неверно против реального кода**:
`ci/checks/db/cross_tenant.test.ts` сидит каждую таблицу через
`seedRowForTable(c, tableName, tenant)` — `switch` по имени с
`default: throw new Error('unknown table')` (строки 280-361). Добавление `outbox` в
реестр **сломает** `beforeAll` этого теста («unknown table outbox»), т.е. красный
ниже по потоку.

**Решение (rule #7 — импортёры реестра как контракт совместимости):** coder ОБЯЗАН
добавить **аддитивно** в `cross_tenant.test.ts`:
1. seed-функцию `seedOutboxRow(c, tenantId)` (минимальная валидная строка: state
   default 'pending', idempotency_key уникален, created_at/available_at=0);
2. `case 'outbox': await seedOutboxRow(c, tenantId); break;` в `seedRowForTable`.

Это **аддитивно** (новый seeder + новая ветка switch), ассерты AC-1/AC-2 T-0115
(`for tableName of KNOWN_TENANT_TABLES`) и логика теста не трогаются — инвариант
152-ФЗ доказывается для `outbox` тем же кодом. **Уточнение формулировки AC-7:**
«T-0115 проходит без изменений *ассертов/инвариантов* теста; сидер-ветка для новой
таблицы — обязательная аддитивная часть контракта реестра». Это не продуктовая
развилка (механика), эскалация не требуется — фиксирую как фрикшен-заметку для
tester/reviewer, чтобы «зелёный T-0115» был явной частью DoD.

**Доп. заметка по `actor_event_seq` баг рядом:** в `seedRowForTable` ветка
`case 'actor_event_seq':` (строка 354) **без `break`** проваливается в
`data_classification` — существующий пре-T-0062 дефект, НЕ в скоупе; не трогаю,
помечаю для отдельного триажа.

---

## 7. Трассировка AC → дизайн

| AC | Покрыто |
|---|---|
| AC-1 | §4.1 enqueue с ключом → INSERT … RETURNING; §3.1 |
| AC-2 | §4.1 ON CONFLICT DO NOTHING + добор SELECT (живьём: total=1) |
| AC-3 | §4.1 undefined-ветка = текущее поведение; §3.1 nullable |
| AC-4 | §3.1 `job_idempotency_key_uq`; FF-1 |
| AC-5 | §3.2 FORCE RLS + default-DENY (живьём: INSERT без GUC падает); FF-3 |
| AC-6 | §3.2 политика на GUC (живьём: B видит 0 строк A); FF-3 |
| AC-7 | §3.2/§5 FF-2 + §6 (аддитивный seeder в cross_tenant.test.ts) |
| AC-8 | §4.2 `enqueueInTx` в tx потребителя — атомарность данные+сигнал; FR-3 |
| AC-9 | §3.3 SECURITY DEFINER без GUC (живьём: 0 строк, без ошибки); FF-6 |
| AC-10 | §3.3 `RETURNS TABLE(tenant_id, pending_count)` ровно 2 колонки; FF-6 |
| AC-11 | §4.2 `claimBatch` per-tenant `SET LOCAL` + RLS |
| AC-12 | §4.2 `FOR UPDATE SKIP LOCKED` → `dispatching` (образец T-0116 AC-8) |
| AC-13 | §4.2 markDispatched/markRetry; §3.2 backoff/attempts |
| AC-14 | §4.2 markRetry → `dead` при исчерпании maxAttempts; FF-8 |
| AC-15 | §3.2 `idx_outbox_pending`; FF-5 (живьём: Index Scan, не Seq Scan) |
| AC-16 | §4.4 GET /health `outbox.{pendingLagMs,deadCount}`, degraded не 500 |
| AC-17 | §4.3 контракт T-0067 NOT_FOUND=идемпотентный успех (seam) |
| AC-18 | §4.3 контракт идемпотентного воркера + onDispatched seam T-0068 |
| AC-19 | §3/ШОВ номера ≥023; раннер идемпотентен (живьём: 2-й прогон no-op); FF-10 |
| AC-20 | §5 FF-11 `npm run ci` зелёный (аддитивность) |

---

## 8. Runtime / deploy-таргет

**Без изменений против T-0114/T-0116:** контейнер (single-Postgres substrate,
stack-ADR). Outbox-диспетчер — фоновый poll-цикл в том же процессе сервиса (как
app_timer-диспетчер); никакого внешнего ресурса/брокера. **Провижн не требуется** —
GT-4 не задействован. DDL валидирован живьём на изолированном Postgres 16 (порт
55448, снесён после прогона; 55432/T-0115 не тронут).

---

## 9. Эскалация

Нет. Механика автономна (зона architect/coder): схема outbox, backoff-кривая, имена
колонок, max-attempts — не продуктовые развилки (спека §7: 0 BLOCKING). Контракты
T-0067/T-0068 интерфейсны. Единственный фрикшен (§6) — реконсиляция формулировки
AC-7 против реального теста — решён в дизайне без продуктовой петли.
