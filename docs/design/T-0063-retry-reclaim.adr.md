# T-0063 · ADR — Активный lock-reclaim + incident-outbox (E1.3)

**Фаза:** DESIGN · **Вход:** `docs/specs/T-0063-retry-reclaim.spec.md` (14 AC, ready) ·
**База:** dev `f7dc03b` · **Образцы:** T-0114 (pgJobStore/SKIP LOCKED), T-0062 (enqueueInTx), T-0116 (poll-цикл) ·
**Уроки:** T-0115 (cross-tenant CI-гейт), T-0062 (атомарность данные+сигнал).

---

## 1. Решение (одним абзацем)

Закрываем пробел E1.3 **аддитивно**, не изменяя ownership-gate `fetchAndLock`/`fail`/`complete`.
**(1) Активный sweep:** новый метод `PostgresJobStore.sweepExpiredLocks(sweepDurationMs: number): Promise<SweepResult>`
выполняет атомарный CTE-проход по `choros.job WHERE state='LOCKED' AND lock_expiry <= now`:
для каждого найденного job — декрементирует `retries`, переводит в `CREATED` (retries>0,
`available_at=now`, немедленный retry) или в `FAILED` (retries=0), **и в той же транзакции**
вызывает `outboxStore.enqueueInTx(client, incident)` — outbox-строка `event_type='worker_lock_expired'`.
Транзакционная атомарность достигается явным `client` (pg.PoolClient), открытым sweep-методом:
`BEGIN → SET LOCAL choros.tenant_id → CTE UPDATE+RETURNING → enqueueInTx (INSERT outbox) → COMMIT`.
**(2) Idempotency-ключ incident-строки:** `'lock_expired:' || jobId || ':' || lockExpiry` —
ON CONFLICT DO NOTHING на `outbox.idempotency_key` гарантирует, что повторный sweep того же
лок-события не создаёт дубль. **(3) Concurrent-safe sweep:** `FOR UPDATE SKIP LOCKED` в CTE —
два параллельных sweeper-а не реклеймируют один job дважды (образец fetchAndLock T-0114).
**(4) RLS: sweep работает как `choros_app` через `SET LOCAL choros.tenant_id` per-tenant**
(двухфазный паттерн T-0062 claimBatch); кросс-тенантный обнаружитель — SECURITY DEFINER
функция `choros.job_locked_expired_buckets(p_before bigint)` (образец outbox_pending_buckets).
**(5) Фоновый цикл:** `runSweepOnce` — функция-аналог `runOutboxOnce` (T-0062);
вызывается poll-петлёй `src/core/lockReclaimer.ts` с инъектируемым `setIntervalFn`
и инъектируемыми `Clock` — детерминированные тесты без реального таймера.
**(6) Health:** `getQueueHealth()` расширяется полем `workerIncidents: number` —
счётчик outbox-строк `event_type='worker_lock_expired'` в состоянии `pending` или `dead`.
**(7) Нет новых таблиц, нет новых миграций** — sweep использует только существующие
`choros.job` + `choros.outbox`. DDL — только одна новая SECURITY DEFINER-функция в
миграции `029_lock_sweep_buckets.sql` (027/028 заняты T-0032).
Тонкое ядро (стор + reclaimer), логика на границах (образец T-0062/T-0116, рубрика ось 5).

---

## 2. Отвергнутые альтернативы

| Вариант | Почему нет |
|---|---|
| Полностью атомарный CTE без отдельного `enqueueInTx` (UPDATE job + INSERT outbox в одном SQL-statement) | Нельзя: `enqueueInTx` принимает `pg.PoolClient` и генерирует `randomUUID()`/`clock.now()` в TS-коде, не в SQL. Вынос логики в чистый SQL потребовал бы дублирования store-слоя. Паттерн «одна транзакция, два statement-а на одном client» (как T-0062 claimBatch) семантически идентичен. |
| Sweep через app_timer (`kind='lock_reclaim_sweep'`) с durable dueAt | Избыточно: sweep нужен только живому процессу, не пережившим рестарт state. setInterval + инъектируемые часы достаточны (NF-5); дуракл-таймер добавил бы DDL-зависимость от T-0116 без пользы. Spec §2.1 сам называет «простой setInterval» как альтернативу. |
| Sweep как BYPASSRLS с одним cross-tenant UPDATE | Ослабляет RLS-инвариант (NF-4): любой будущий баг в предикате мог бы затронуть чужой тенант. Двухфазный паттерн (SECURITY DEFINER bucket discovery + per-tenant SET LOCAL) идентичен outbox-диспетчеру — проверенный механизм. |
| Incident в `audit_event` вместо outbox | Нарушает семантику аудита (бизнес-события vs инфраструктурные сигналы, spec §2.2). Outbox уже существует, имеет dead-state паттерн и health-метрики. |
| Новая таблица `worker_incident` | Нарушает NF-1 (no new tables). Outbox покрывает потребность без новой инфраструктуры. |
| Immediate full-retry без декремента retries | Не следует семантике `fail()`: каждая потеря лока = неудачная попытка. Без декремента бесконечные краши воркера зациклят job навсегда. |
| Backoff при sweep-reclaim (available_at = now + retryTimeoutMs) | Spec §3 FR-6 явно: «воркер упал, не job» — immediate retry (available_at=now). Дополнительный backoff не запрошен в mvp-backlog E1.3. |

---

## 3. Объектная модель / схема

### 3.1 `choros.job` — без изменений

Sweep работает с существующими колонками: `state`, `retries`, `lock_owner`, `lock_expiry`,
`available_at`. Новых колонок нет. Миграции для `job` не нужны.

### 3.2 `choros.outbox` — без изменений

Incident-строка использует существующую схему:

| Поле | Значение sweep-строки |
|---|---|
| `aggregate_kind` | `'job'` |
| `aggregate_id` | `jobId` (UUID) |
| `event_type` | `'worker_lock_expired'` |
| `payload` | `{ topic: string, lockOwner: string, lockExpiry: number, retriesLeft: number }` |
| `idempotency_key` | `'lock_expired:' + jobId + ':' + String(lockExpiry)` |
| `state` | `'pending'` (initial) |
| `attempts` | `0` |

> `retriesLeft` = retries ПОСЛЕ декремента (= retries в job-строке после UPDATE).
> `lockOwner` берётся из строки ДО UPDATE (snapshot из CTE RETURNING before или из
> SELECT перед UPDATE — см. §4.1 контракт).

### 3.3 Новая SECURITY DEFINER-функция (миграция **029**)

```sql
-- 029_lock_sweep_buckets.sql
CREATE OR REPLACE FUNCTION choros.job_locked_expired_buckets(p_before bigint)
RETURNS TABLE(tenant_id uuid, expired_count bigint)
LANGUAGE sql SECURITY DEFINER
SET search_path = choros, pg_catalog STABLE
AS $$
  SELECT tenant_id, COUNT(*)::bigint AS expired_count
  FROM choros.job
  WHERE state = 'LOCKED' AND lock_expiry <= p_before
  GROUP BY tenant_id;
$$;
REVOKE ALL ON FUNCTION choros.job_locked_expired_buckets(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION choros.job_locked_expired_buckets(bigint) TO choros_app;
```

Образец `choros.outbox_pending_buckets` (025) 1:1 — без GUC, без строк данных,
только агрегат. Индекс: `idx_job_fetchable_locked` (`state='LOCKED'`, migration 010)
уже существует — функция использует его.

### 3.4 SweepResult (новый TS-тип)

```ts
// src/core/jobStoreTypes.ts — аддитивно
export interface SweepResult {
  reclaimed: number;   // job-ов переведено в CREATED
  failed: number;      // job-ов переведено в FAILED (retries=0)
  incidents: number;   // outbox-строк вставлено (=reclaimed+failed; <N если ON CONFLICT)
}
```

### 3.5 LockReclaimerOptions (новый TS-тип)

```ts
// src/core/lockReclaimer.ts
export interface LockReclaimerOptions {
  sweepIntervalMs: number;       // частота прохода; инъектируется, дефолт 30_000
  setIntervalFn?: typeof setInterval;  // для детерминированных тестов
  onSweep?: (result: SweepResult) => void;  // observability-хук; дефолт no-op
}
```

---

## 4. Контракты (источник правды для coder/tester)

### 4.1 `PostgresJobStore.sweepExpiredLocks` — новый метод

```ts
// Добавляется в src/core/postgres/pgJobStore.ts
async sweepExpiredLocks(
  sweepDurationMs: number,   // значение clock.now() передаётся снаружи (уже есть в Clock)
  outboxStore: PostgresOutboxStore,
  tenantId: string           // UUID; вызывается per-tenant из runSweepOnce
): Promise<SweepResult>
```

**Алгоритм (псевдокод):**

```
client = await pool.connect()
BEGIN
SET LOCAL choros.tenant_id = tenantId   // R-3: UUID-validated перед интерполяцией
now = clock.now()

// Атомарный CTE: захватить истёкшие LOCKED-джобы, обновить состояние
rows = await client.query(`
  WITH expired AS (
    SELECT id, topic, retries, lock_owner, lock_expiry
    FROM choros.job
    WHERE state = 'LOCKED' AND lock_expiry <= $1
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE choros.job j
    SET
      state        = CASE WHEN (SELECT retries FROM expired WHERE id=j.id) > 0
                          THEN 'CREATED' ELSE 'FAILED' END,
      retries      = GREATEST((SELECT retries FROM expired WHERE id=j.id) - 1, 0),
      lock_owner   = NULL,
      lock_expiry  = NULL,
      available_at = $1          -- немедленный retry (FR-6: no backoff)
    FROM expired
    WHERE j.id = expired.id
    RETURNING j.id, j.topic, j.retries AS retries_after,
              (SELECT lock_owner FROM expired WHERE id=j.id) AS lock_owner_before,
              (SELECT lock_expiry FROM expired WHERE id=j.id) AS lock_expiry_before,
              j.state AS new_state
  )
  SELECT * FROM updated
`, [now])

// Для каждой строки: INSERT incident в outbox (ON CONFLICT DO NOTHING = idempotency)
for each row in rows:
  idempotencyKey = 'lock_expired:' + row.id + ':' + String(row.lock_expiry_before)
  await outboxStore.enqueueInTx(client, {
    aggregateKind: 'job',
    aggregateId: row.id,
    eventType: 'worker_lock_expired',
    payload: {
      topic: row.topic,
      lockOwner: row.lock_owner_before,
      lockExpiry: Number(row.lock_expiry_before),
      retriesLeft: row.retries_after
    },
    idempotencyKey
  })
  // ON CONFLICT DO NOTHING встроен в enqueueInTx через existing outbox idempotency:
  // outbox уже имеет UNIQUE(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  // → повторный sweep → INSERT 0, не ошибка (AC-5, AC-8)

COMMIT
return { reclaimed, failed, incidents }
```

> **Гонка sweep vs fetchAndLock-reclaim:** `fetchAndLock` при ленивом рекл. тоже захватывает
> `state='LOCKED' AND lock_expiry<=now` (migration 010, строка 233 pgJobStore.ts).
> Победитель — тот, кто первым взял `FOR UPDATE SKIP LOCKED`: проигравший пропускает
> строку. Семантика корректна: если fetchAndLock реклеймировал job (переводит его сразу в
> LOCKED для нового воркера), sweep его не видит (уже не LOCKED-истёкший), incident не пишется.
> Если sweep реклеймировал первым (→CREATED + incident), следующий fetchAndLock возьмёт
> строку штатно. Нет двойного incident, нет потерянного события.

> **Контракт outbox idempotency (ON CONFLICT DO NOTHING):** coder ОБЯЗАН убедиться, что
> `enqueueInTx` при конфликте по `(tenant_id, idempotency_key)` возвращает существующую
> строку или не бросает — стандартное поведение `ON CONFLICT DO NOTHING RETURNING`.
> Текущий `pgOutboxStore.enqueueInTx` (T-0062) бросает если `RETURNING` пуст, т.к.
> `rows[0]` будет undefined. Coder ОБЯЗАН **аддитивно** добавить в `enqueueInTx` обработку
> пустого RETURNING (ON CONFLICT case): при пустом RETURNING — SELECT-back существующей строки
> (как `pgJobStore.enqueue` с idempotencyKey). Это аддитивное расширение, не ломает
> существующих вызывателей.

### 4.2 `runSweepOnce` — новая функция (`src/core/lockReclaimer.ts`)

```ts
export interface RunSweepResult {
  tenants: number;
  reclaimed: number;
  failed: number;
  incidents: number;
}

async function runSweepOnce(
  jobStore: PostgresJobStore,
  outboxStore: PostgresOutboxStore,
  bucketsFn: (before: number) => Promise<Array<{tenantId: string; expiredCount: number}>>
): Promise<RunSweepResult>
```

Цикл: `buckets = await bucketsFn(now)` (→ `jobStore.getLockedExpiredBuckets(now)` обёртка над SECURITY DEFINER); для каждого tenantId → `jobStore.sweepExpiredLocks(now, outboxStore, tenantId)`; агрегирует totals.

> `getLockedExpiredBuckets(before: number)` — публичный метод `PostgresJobStore`, вызывающий
> `choros.job_locked_expired_buckets($1)` (migration 029). Выполняется без GUC (migrator-пул
> или пул без SET tenant_id) — образец `pendingBuckets` pgOutboxStore.

### 4.3 `startLockReclaimerLoop` — фоновый планировщик

```ts
// src/core/lockReclaimer.ts
export function startLockReclaimerLoop(
  jobStore: PostgresJobStore,
  outboxStore: PostgresOutboxStore,
  opts?: LockReclaimerOptions
): { stop: () => void }
```

Реализация: `setIntervalFn(() => runSweepOnce(...), sweepIntervalMs)` — первый прогон через `sweepIntervalMs` после старта (не немедленно — не блокирует запуск сервера).
Возвращает `{ stop }` для graceful shutdown (clearInterval).

### 4.4 `PostgresJobStore.getQueueHealth` — расширение (аддитивное)

```ts
// БЫЛО:
getQueueHealth(): Promise<{ depth: number; oldestAvailableLagMs: number | null }>

// СТАЛО (backward-compatible, аддитивно):
getQueueHealth(): Promise<{
  depth: number;
  oldestAvailableLagMs: number | null;
  workerIncidents: number;  // NEW: count of outbox rows WHERE event_type='worker_lock_expired'
                            //      AND state IN ('pending','dead')
}>
```

Реализация: дополнительный SELECT к `choros.outbox`:

```sql
SELECT COUNT(*) FROM choros.outbox
WHERE event_type = 'worker_lock_expired'
  AND state IN ('pending', 'dead')
```

Выполняется без GUC (migrator-пул — агрегирует все тенанты, как `getOutboxHealth`).

> **Важно:** `getQueueHealth` на сейчас принимает пул из конструктора `PostgresJobStore`.
> Для cross-table запроса нужен доступ к `choros.outbox`. Два варианта:
> (a) `getQueueHealth` принимает опциональный `outboxStore?: PostgresOutboxStore`
>     и вызывает `outboxStore?.getWorkerIncidentCount()`;
> (b) `getQueueHealth` принимает тот же пул (уже есть), делает raw SELECT к outbox.
> Решение: вариант **(b)** — raw SELECT в том же пуле (проще, без циклической зависимости),
> обёрнуто в независимый try/catch (ошибка → `workerIncidents: 0`, не 500). Функция
> `getQueueHealth` уже делает собственный SELECT — дополнительный запрос аддитивен.

### 4.5 GET /health — расширение `src/server.ts`

Аддитивно к `{ status, queue: { depth, oldestAvailableLagMs }, timer, outbox }`:

```json
{
  "queue": {
    "depth": 0,
    "oldestAvailableLagMs": null,
    "workerIncidents": 0
  }
}
```

`workerIncidents` берётся из `getQueueHealth()`. Backward-compatible (новое поле — не ломает существующих клиентов). Независимый try/catch: ошибка Postgres → `workerIncidents: 0`, `status='degraded'`.

Обновить строку в `buildRouter` — добавить `workerIncidents: health.workerIncidents` в body.

> **Контракт совместимости (rule #7):** `health.test.ts` проверяет только `status`, `timer.timerLagMs`, `content-type` — ни один из этих ассертов не ломается от нового поля. Тест не фиксирует полный JSON-объект, только точечные `.toHaveProperty`. Frozen тест зелёный без изменений.

---

## 5. Fitness-функции (CI-границы)

| ID | Правило | CI-проверка |
|---|---|---|
| **FF-1** | `sweepExpiredLocks` переводит job `state='LOCKED' AND lock_expiry<=now` в `CREATED` (retries>0) или `FAILED` (retries=0) атомарно с outbox-строкой `worker_lock_expired`. | `pgJobStore.integration.test.ts`: describe 'sweepExpiredLocks' — после вызова: job.state = CREATED/FAILED, SELECT outbox WHERE event_type='worker_lock_expired' = 1 строка. (AC-1) |
| **FF-2** | Retries-семантика sweep совместима с fail-путём: retries--; FAILED при retries=0; available_at=now (без backoff). | Integration: job retries=2 → sweep → retries=1, state=CREATED, available_at≈now (AC-2); job retries=0 → sweep → state=FAILED (AC-3). |
| **FF-3** | Outbox incident содержит все обязательные поля payload: `topic`, `lockOwner`, `lockExpiry`, `retriesLeft`. | Integration: SELECT payload FROM outbox WHERE event_type='worker_lock_expired' → все 4 ключа присутствуют (AC-4). |
| **FF-4** | Idempotency-ключ `'lock_expired:'+jobId+':'+lockExpiry` — повторный sweep не создаёт второй outbox-строки. | Integration: two calls `sweepExpiredLocks(now)` → SELECT COUNT(*) FROM outbox WHERE event_type='worker_lock_expired' AND aggregate_id=$jobId = 1 (не 2) (AC-5). |
| **FF-5** | Sweep не затрагивает активный лок (`lock_expiry > now`) и job не в `LOCKED` (CREATED/COMPLETED/FAILED). | Integration: seed LOCKED job с lock_expiry=now+1000 → sweep → state=LOCKED (не тронут) (AC-6, AC-7). |
| **FF-6** | Concurrent sweep двух экземпляров реклеймирует каждый job ровно один раз (FOR UPDATE SKIP LOCKED). | Integration: параллельные Promise.all → outbox WHERE event_type='worker_lock_expired' AND aggregate_id=$jobId = ровно 1 строка (AC-8). |
| **FF-7** | `GET /health` возвращает `queue.workerIncidents: number` аддитивно, без поломки существующих полей. | `health.test.ts` + новый describe 'workerIncidents': parsed.queue.workerIncidents ≥ 0; существующие AC-1..AC-4 зелёные (AC-9). |
| **FF-8** | `queue.workerIncidents = 0` при пустой очереди (нет incidents); = N после N sweep-reclaim. | Integration: workerIncidents = 0 изначально; после N sweep = N (AC-10). |
| **FF-9** | RLS-инвариант sweep: job тенанта B не реклеймируется при sweep тенанта A. | `pgJobStore.integration.test.ts` sweep-раздел: seed jobs тенанта A и B; sweep(tenantA) → jobs B не тронуты (state=LOCKED). (AC-11) |
| **FF-10** | Интеграционный smoke: seed 1 LOCKED job с lock_expiry=now−1ms → sweepExpiredLocks(now) → state=CREATED, 1 outbox-строка; seed 1 LOCKED job с lock_expiry=now+1000ms → sweep не трогает. | `pgJobStore.integration.test.ts` (AC-12). |
| **FF-11** | Существующие AC-1..AC-18 pgJobStore.integration.test.ts зелёные после добавления sweep (аддитивность). | `npm run ci` (AC-13). |
| **FF-12** | Миграция 029_lock_sweep_buckets.sql идемпотентна (`CREATE OR REPLACE FUNCTION`, `REVOKE/GRANT` идемпотентны). | `node migrations/run.mjs` дважды → второй прогон 0 ошибок (AC-14). |
| **FF-13** | `sweepExpiredLocks` и `startLockReclaimerLoop` НЕ импортируют ничего из `http/` — нет циклической зависимости core→http. | `eslint` / `tsc --noEmit` + `ci/checks/no-http-import-in-core.sh`: `grep -r "from.*http/" src/core/` → 0 строк. |
| **FF-14** | Clock injection в sweep: `sweepExpiredLocks` использует `this.clock.now()`, не `Date.now()` напрямую. | `grep -n "Date\.now()" src/core/postgres/pgJobStore.ts` → 0 совпадений в методе sweepExpiredLocks. |

---

## 6. Фрикшен: ON CONFLICT DO NOTHING в enqueueInTx (rule #7 — совместимость)

**Находка:** `pgOutboxStore.enqueueInTx` (T-0062, строка 121-143) делает:
```ts
const { rows } = await client.query<OutboxDbRow>(`INSERT … RETURNING ${RETURNING_COLS}`, […])
return rowToOutbox(rows[0])   // ← бросит при пустом rows если ON CONFLICT DO NOTHING
```
Для sweep idempotency нам нужно `ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`. При конфликте `rows` будет пустым — `rows[0]` = `undefined` → `rowToOutbox(undefined)` → тихий runtime-баг или TypeError.

**Решение (аддитивная правка `pgOutboxStore.enqueueInTx`):**
```ts
if (rows.length > 0) return rowToOutbox(rows[0])
// ON CONFLICT case: SELECT-back (образец pgJobStore.enqueue idempotency T-0062)
const sel = await client.query<OutboxDbRow>(
  `SELECT ${RETURNING_COLS} FROM choros.outbox
   WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid
     AND idempotency_key = $1`,
  [row.idempotencyKey]
)
return rowToOutbox(sel.rows[0])
```
Это аддитивно (новая ветка кода), существующих вызывателей не ломает (они не передают
idempotency_key с конфликтом по design). Coder обязан исполнить.

---

## 7. Трассировка AC → дизайн

| AC | Покрыто |
|---|---|
| AC-1 | §4.1 CTE UPDATE + enqueueInTx атомарно; FF-1 |
| AC-2 | §4.1 retries>0 → CREATED, available_at=now; FF-2 |
| AC-3 | §4.1 retries=0 → FAILED; FF-2 |
| AC-4 | §3.2 payload = {topic, lockOwner, lockExpiry, retriesLeft}; FF-3 |
| AC-5 | §4.1 idempotency_key + ON CONFLICT DO NOTHING (§6 фрикшен enqueueInTx fix); FF-4 |
| AC-6 | §4.1 WHERE lock_expiry <= now (активный лок не выбирается); FF-5 |
| AC-7 | §4.1 WHERE state='LOCKED' (CREATED/COMPLETED/FAILED не выбираются); FF-5 |
| AC-8 | §4.1 FOR UPDATE SKIP LOCKED + idempotency_key ON CONFLICT; FF-6 |
| AC-9 | §4.4/§4.5 queue.workerIncidents в GET /health (backward-compatible); FF-7 |
| AC-10 | §4.4 SELECT COUNT(*) FROM outbox WHERE event_type='worker_lock_expired' AND state IN ('pending','dead'); FF-8 |
| AC-11 | §4.1 SET LOCAL choros.tenant_id per-tenant sweep (двухфазный паттерн T-0062); FF-9 |
| AC-12 | §4.1 lock_expiry<=now included; lock_expiry>now excluded; FF-10 |
| AC-13 | §5 FF-11 аддитивность (новые describe-блоки, не трогаем существующие) |
| AC-14 | §3.3 CREATE OR REPLACE FUNCTION (идемпотентно); FF-12 |

---

## 8. Runtime / deploy-таргет

**Без изменений:** контейнер (single-Postgres substrate, stack-ADR). Lock reclaimer — фоновый
poll-цикл в том же процессе сервиса (как outbox-диспетчер T-0062). Никакого внешнего ресурса.
**Провижн не требуется** — GT-4 не задействован. DDL-only миграция 029 (SECURITY DEFINER
функция) — применяется штатным `node migrations/run.mjs`.

---

## 9. Эскалация

Нет. Все аспекты задачи однозначно разрешаются существующей кодовой базой и CONCEPT §5.
Единственный нетривиальный момент — ON CONFLICT fix в `enqueueInTx` (§6) — это технический
фрикшен, не продуктовая развилка. Фоновый цикл (setInterval vs app_timer) выбран
соразмерно задаче (рубрика ось 5). Контракты T-0067/T-0068 зафиксированы интерфейсно.
