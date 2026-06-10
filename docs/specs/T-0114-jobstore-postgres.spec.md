# T-0114 · Перенос jobStore на Postgres

**Title:** Подложка-1: `job`/`inbox_task` — Map → Postgres, `available_at`, partial-индексы, health-depth, ops-операции
**Status:** ready (блокирующих вопросов нет)
**Authored:** 2026-06-10
**Authoritative source:** `docs/design/stack-and-fleet-ops.md` §1 п.1, §2 (ratified ADR, GT-1, 2026-06-10)

---

## 1. Summary

Заменить in-memory `Map`-реализацию `JobStore` на Postgres-стор с сохранением
контракта `fetchAndLock / complete / fail / lease` 1:1. Добавить колонку
`available_at` (bigint, unix epoch ms), включить retry-backoff через неё,
закрыть `retryTimeoutMs recorded-only` — с этой задачей поле начинает реально
соблюдаться. Добавить partial-индексы `WHERE state` для устранения O(n)-скана
по очереди. Расширить `GET /health` метриками глубины очереди и oldest-available
lag. Добавить ops-операции `run_vacuum` и `queue_stats` в каталог органов
fleet-ops (ADR §2).

---

## 2. Предусловие и граница шва с T-0053

T-0114 **зависит от T-0053** (сестринская задача, параллельная ветка
`task/T-0053-*`). T-0053 предоставляет:

- `docker-compose.yml` с `postgres:16`
- zero-dep раннер миграций: каталог `migrations/`, файлы `NNN_<name>.sql`,
  лексикографический порядок, таблица `schema_migrations`
- Postgres-сервис в CI
- зависимость `pg` в `package.json`

T-0114 **не трогает** docker-compose.yml, раннер миграций и package.json.
Подключение к Postgres — env `DATABASE_URL`.

BUILD-фаза T-0114 запускается после мержа T-0053 в `dev` (или на ветке T-0053).
Это предусловие обязательно фиксировать в CI — тест не запускается без
`DATABASE_URL` / работающего Postgres.

---

## 3. Граница таблиц

T-0114 владеет миграциями начиная с `010_` (на случай если T-0053 займёт
`001_–009_`). T-0114 создаёт таблицу `job` (и при необходимости `inbox_task`
если они разделены) с partial-индексами. Детали схемы — зона architect/coder,
данная spec определяет поведенческие инварианты.

> Примечание: `inbox_task` упомянута в названии задачи. Судя по существующему
> коду (`src/core/jobStore.ts`), `inbox_task` — это алиас для job-очереди
> инбокса, а не отдельная сущность в текущей кодовой базе. Coder/architect
> решает автономно: одна таблица `job` с колонкой `type` ИЛИ две таблицы. В
> любом случае все ниже сформулированные АС применяются к реализующей таблице.

---

## 4. Функциональные требования

### FR-1  Postgres-стор за существующим интерфейсом `JobStore`

- Все методы `enqueue`, `getById`, `listByTopic`, `listByState`,
  `listByTopicAndState`, `fetchAndLock`, `complete`, `fail` сохраняют поведенческий
  контракт 1:1 (см. §6, AC-1 – AC-13 ниже).
- `fetchAndLock` реализуется через `FOR UPDATE SKIP LOCKED` (ADR §1) — не через
  advisory locks или ручную атомарность.
- Ownership-gate `complete` и `fail` (NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER)
  соблюдается на уровне Postgres — одна атомарная транзакция без race conditions.
- Инжекция часов (`Clock`) сохраняется как seam для детерминированных тестов.

### FR-2  Колонка `available_at` и retry-backoff

- Таблица `job` содержит колонку `available_at bigint NOT NULL` (unix epoch ms).
- При `enqueue` `available_at = createdAt` (доступна немедленно).
- При `fail` с `retries > 0` и `retryTimeoutMs > 0`:
  `available_at = clock.now() + retryTimeoutMs` — job недоступна для
  `fetchAndLock` до наступления этого момента.
- При `fail` с `retryTimeoutMs = 0`: `available_at = clock.now()` (доступна сразу).
- `fetchAndLock` кандидаты: `state = 'CREATED' AND available_at <= clock.now()` ИЛИ
  `state = 'LOCKED' AND lock_expiry <= clock.now()` — условие `available_at`
  добавляется к первому предикату.
- `void retryTimeoutMs` в текущем коде снимается — поле активно используется.

### FR-3  Partial-индексы WHERE state

- На таблице `job` созданы partial-индексы, ограниченные строками с
  `state IN ('CREATED', 'LOCKED')` (или аналогичными состояниями ожидания).
- `fetchAndLock`-запрос использует partial-индекс (проверяется через EXPLAIN —
  Seq Scan по всей таблице недопустим при >0 строк в нецелевом состоянии).

### FR-4  In-memory реализация как тестовый дублёр

- Существующие unit-тесты (`jobStore.test.ts`, `fetchLock.test.ts`,
  `completeFail.test.ts`) продолжают проходить без Postgres — они используют
  in-memory реализацию или мок.
- Postgres-стор тестируется в интеграционных тестах, требующих `DATABASE_URL`.
- Решение о сохранении in-memory класса как TestDouble vs. мок-объекта —
  автономно для coder (impl-деталь).

### FR-5  Health-эндпоинт с метриками очереди

- `GET /health` возвращает `200 OK` с JSON, содержащим как минимум:
  - `status: "ok"` (обратная совместимость с AC-1 health.test.ts)
  - `queue.depth: number` — количество строк с `state IN ('CREATED', 'LOCKED')`
    и `available_at <= now()` (реально готовых к обработке)
  - `queue.oldestAvailableLagMs: number | null` — разница между `now()` и
    минимальным `available_at` среди доступных строк; `null` если очередь пуста
- Существующие тесты health.test.ts (`AC-1..AC-4`) продолжают работать без Postgres
  (health при недоступной БД может возвращать `status: "degraded"` но не 5xx — см.
  NF-3).

### FR-6  Ops-операция `run_vacuum` в каталоге органов

- Каталог органов (путь: `ops/catalog/` или аналогичный — coder выбирает,
  ADR §2 называет «каталог ops-операций») содержит операцию `run_vacuum`.
- `run_vacuum`: выполняет `VACUUM ANALYZE job` (или эквивалент) на целевой БД.
- Операция идемпотентна: повторный вызов не приводит к ошибке.
- Операция принимает `DATABASE_URL` как аргумент или из env.
- Выходной формат: машиночитаемый JSON `{ ok: true, tableVacuumed: "job" }` или
  `{ ok: false, error: "..." }`.
- Тир автономии T0 (ADR §2): авто, лог.

### FR-7  Ops-операция `queue_stats` в каталоге органов

- Каталог органов содержит операцию `queue_stats`.
- `queue_stats`: возвращает метрики очереди:
  - `depth`: строки с `state IN ('CREATED', 'LOCKED') AND available_at <= now()`
  - `lockedCount`: строки с `state = 'LOCKED'`
  - `failedCount`: строки с `state = 'FAILED'`
  - `completedCount`: строки с `state = 'COMPLETED'`
  - `oldestAvailableLagMs`: аналогично FR-5
  - `dlqCount` (DLQ — строки с `state = 'FAILED' AND retries = 0`): число строк
    в dead letter queue
- Вывод JSON, идемпотентно, принимает `DATABASE_URL`.
- Тир автономии T0 (ADR §2).

---

## 5. Нефункциональные требования

### NF-1  At-least-once семантика

`fetchAndLock` с `FOR UPDATE SKIP LOCKED` гарантирует, что каждую строку
одновременно обрабатывает не более одного воркера (at-most-once lock); lease
(lock_expiry) обеспечивает повторную доступность при падении воркера
(at-least-once выполнение).

### NF-2  Нет O(n)-скана по полной таблице

При наличии partial-индексов и нескольких тысяч строк в состоянии COMPLETED/FAILED
план `fetchAndLock` НЕ должен включать Sequential Scan по всей таблице
(проверяется через EXPLAIN ANALYZE).

### NF-3  Health деградирует, не падает

При недоступной БД `GET /health` возвращает `200` или `503` с JSON
`{ status: "degraded", error: "..." }` — никогда не падает с unhandled
rejection / 500. (Конкретный HTTP-код — impl-решение coder.)

### NF-4  Zero-dep в доменной логике

Зависимость `pg` (предоставлена T-0053) — единственная новая runtime-зависимость.
Ops-операции используют `pg` или node stdlib. Не добавлять ORM.

### NF-5  Инжекция часов сохраняется

Postgres-стор принимает `Clock` для тестовой предсказуемости lockExpiry и
available_at. Тесты, использующие `makeFixedClock` / `makeCounterClock`,
продолжают работать против TestDouble без реального Postgres.

---

## 6. Out of Scope

1. `tenant_id` + RLS на таблице `job` — задача T-0013 / T-0053. T-0114 не добавляет
   RLS и не добавляет `tenant_id` в схему `job`.
2. `docker-compose.yml`, раннер миграций, зависимость `pg` — задача T-0053.
3. DLQ-роутинг и обработка dead letter queue — ADR упоминает DLQ как концепт,
   но обработка (перекладывание в отдельную таблицу, уведомление) — отдельная задача.
4. Flowable external-task мост — задача T-0115+ (ADR §1 п.5).
5. Мозг fleet-ops (Sentinel/Diagnost/Operator) — отдельный контур, вне этого репо.
6. HTTP-эндпоинты для ops-операций — ops-операции запускаются как CLI/скрипты
   из каталога, не через HTTP API продукта.
7. Метрики timer-lag Flowable — GC/heap метрики вне скопа T-0114.
8. Pooled-mode / tenant isolation на очереди — T-0053 / последующие задачи.

---

## 7. Критерии приёмки

### Группа A: контракт fetchAndLock (совместимость 1:1)

**AC-1** — fetchAndLock возвращает заблокированные jobs с корректными полями
```
Integration test (требует Postgres):
  enqueue job с известными topic/variables/retries при stubbed clock=1000.
  fetchAndLock("w1", [topic], 1, 30000).
  Вернувшийся job: state=LOCKED, lockOwner="w1",
  lockExpiry=31000, createdAt=1000, available_at>=createdAt.
  Все поля совпадают с контрактом Job из types.ts.
```
`verifiable_as: test`

**AC-2** — fetchAndLock FIFO, ограничен maxJobs
```
Integration test:
  enqueue 3 jobs с разными createdAt (clock.now() инкрементируется).
  fetchAndLock("w", [topic], 2, 5000).
  Возвращает ровно 2 job в порядке возрастания createdAt.
  Третья job остаётся в CREATED.
```
`verifiable_as: test`

**AC-3** — fetchAndLock не возвращает job, недоступную по available_at
```
Integration test:
  enqueue job, затем fail с retries=1, retryTimeoutMs=60000 (clock=T).
  fetchAndLock при clock=T+59999 — возвращает [].
  fetchAndLock при clock=T+60000 — возвращает job.
```
`verifiable_as: test`

**AC-4** — fetchAndLock переиспользует job с истёкшим lock_expiry
```
Integration test:
  enqueue, fetchAndLock("w1", lockDurationMs=0, clock=500).
  clock=600 >= lockExpiry=500.
  fetchAndLock("w2", lockDurationMs=100, clock=600).
  Возвращает ту же job, lockOwner="w2", lockExpiry=700.
```
`verifiable_as: test`

**AC-5** — fetchAndLock атомарен: два конкурентных вызова не берут одну job
```
Integration test:
  enqueue 1 job.
  Два параллельных fetchAndLock (разные workerId, maxJobs=1).
  Сумма результатов = 1 (один взял, второй получил []).
  Реализован через SKIP LOCKED — проверяется.
```
`verifiable_as: test`

### Группа B: контракт complete / fail (совместимость 1:1)

**AC-6** — complete happy path: состояние → COMPLETED, lock cleared
```
Integration test:
  enqueue → fetchAndLock → complete("w1", jobId).
  getById: state=COMPLETED, lockOwner=undefined, lockExpiry=undefined.
  complete возвращает { ok: true }.
```
`verifiable_as: test`

**AC-7** — complete gate: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER
```
Integration test: проверяет все четыре кода в правильном приоритете
(аналогично completeFail.test.ts, работает против Postgres-стора).
```
`verifiable_as: test`

**AC-8** — fail с retries>0: состояние → CREATED, available_at = now() + retryTimeoutMs
```
Integration test (clock=1000):
  enqueue → fetchAndLock → fail("w", jobId, retries=2, retryTimeoutMs=5000).
  getById: state=CREATED, retries=2.
  available_at = 6000 (1000 + 5000).
  fetchAndLock при clock=5999 — не берёт.
  fetchAndLock при clock=6000 — берёт.
```
`verifiable_as: test`

**AC-9** — fail с retries=0: состояние → FAILED
```
Integration test:
  enqueue → fetchAndLock → fail("w", jobId, retries=0, retryTimeoutMs=0).
  getById: state=FAILED, retries=0.
  fetchAndLock не возвращает FAILED job.
```
`verifiable_as: test`

**AC-10** — fail gate: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER
```
Integration test: аналогично AC-7 для fail.
```
`verifiable_as: test`

### Группа C: unit-тесты in-memory продолжают проходить

**AC-11** — Все тесты jobStore.test.ts, fetchLock.test.ts, completeFail.test.ts
проходят без Postgres (in-memory дублёр / mock)
```
CI: npm test — тесты из перечисленных файлов зелёные без DATABASE_URL.
```
`verifiable_as: test`

### Группа D: partial-индексы, нет O(n)-скана

**AC-12** — fetchAndLock не производит Sequential Scan при наличии строк вне
ожидаемых состояний
```
Integration fitness:
  Загрузить таблицу job: 1000 строк state=COMPLETED, 10 строк state=CREATED.
  EXPLAIN (ANALYZE) запроса fetchAndLock.
  Plan НЕ должен содержать "Seq Scan on job" без Index condition.
  Partial-index должен быть виден в плане.
```
`verifiable_as: fitness`

### Группа E: health-эндпоинт

**AC-13** — GET /health возвращает queue.depth и queue.oldestAvailableLagMs
```
Integration test (с Postgres):
  enqueue 3 jobs с available_at в прошлом.
  GET /health → 200, body.queue.depth = 3,
  body.queue.oldestAvailableLagMs >= 0.
```
`verifiable_as: test`

**AC-14** — GET /health при пустой очереди: queue.depth=0, oldestAvailableLagMs=null
```
Integration test: пустая БД.
  GET /health → 200, body.queue.depth=0, body.queue.oldestAvailableLagMs=null.
```
`verifiable_as: test`

**AC-15** — Существующие health.test.ts AC-1..AC-4 продолжают проходить
(обратная совместимость: status ok, Content-Type json)
```
CI: npm test — health.test.ts зелёный без Postgres.
```
`verifiable_as: test`

### Группа F: ops-операции

**AC-16** — run_vacuum выполняет VACUUM ANALYZE job и возвращает { ok: true }
```
Integration test (с Postgres):
  Запустить ops/catalog/run_vacuum (или его программный аналог).
  Вернуть { ok: true, tableVacuumed: "job" }.
  Повторный вызов — тот же результат (идемпотентен).
```
`verifiable_as: test`

**AC-17** — queue_stats возвращает корректные метрики для известного состояния
```
Integration test:
  seed: 5 CREATED available, 2 LOCKED, 1 FAILED retries=0 (DLQ), 3 COMPLETED.
  queue_stats → {
    depth: 5, lockedCount: 2, failedCount: 1,
    completedCount: 3, dlqCount: 1,
    oldestAvailableLagMs: >= 0
  }.
```
`verifiable_as: test`

**AC-18** — run_vacuum и queue_stats при недоступной БД возвращают { ok: false, error: "..." }
```
Integration test: неверный DATABASE_URL.
  Оба возвращают { ok: false, error: <non-empty string> }, не кидают unhandled exception.
```
`verifiable_as: test`

---

## 8. Блокирующие вопросы

Нет. Все impl-детали (точная схема таблицы, разбивка на одну/две таблицы для
job/inbox_task, расположение каталога ops, формат ошибок health при degraded,
TestDouble vs. mock для unit-тестов) — автономны для architect/coder.

---

## 9. Нет-цели (напоминание)

- Не менять docker-compose.yml, раннер миграций, package.json (T-0053).
- Не добавлять tenant_id / RLS на таблицу job (T-0013/T-0053).
- Не реализовывать DLQ-обработку (только считать строки с FAILED+retries=0).
- Не строить HTTP-эндпоинты для ops-операций (только CLI/программный вызов).
- Не трогать ветку main или dev напрямую.
