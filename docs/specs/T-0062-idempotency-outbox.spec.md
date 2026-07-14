# T-0062 · SPEC — Идемпотентность + outbox (E1.2)

**Эпик:** E1.2 (хардненинг воркера) · **Deps:** E1.1 (T-0114 PostgresJobStore) ·
**Refs:** CONCEPT §6 (движок-как-инфраструктура, транзакционная целостность
возвращается outbox-паттерном + идемпотентными воркерами); mvp-backlog.md E1.2.
**Будущие потребители (контракты зафиксированы, не реализованы):** T-0067
(E6.2, topic-маппинг external-task↔JobStore), T-0068 (E6.3, lifecycle+audit).

Статус: **ready** (механика автономна; BLOCKING вынесены в контракт ниже).

---

## 1. Задача одним предложением

Закрыть две дыры транзакционной целостности воркерного контура: (1) дать
**идемпотентность** ключевым операциям JobStore (повторный enqueue одного
логического задания не плодит дублей; complete/fail после потери lease безопасны)
через семантику **idempotency-key**, и (2) ввести **outbox-таблицу** —
транзакционно-целостную запись «эффект на данные + сигнал процессу/внешнему миру»
в ОДНОЙ доменной транзакции, доставляемую отдельным двухфазным диспетчером (по
образцу T-0116 app_timer), чтобы потребитель T-0067/T-0068 мог завершить внешнюю
задачу и записать результат как одну логическую транзакцию.

---

## 2. Контекст: что уже есть и какие дыры остались

### 2.1 PostgresJobStore (T-0114, `src/core/postgres/pgJobStore.ts`)

Разобраны идемпотентность-дыры на текущем коде:

1. **Повторный enqueue того же логического задания → дубль.** `enqueue()` на
   каждый вызов генерирует свежий `randomUUID()` и делает безусловный INSERT. Если
   продюсер (HTTP-клиент воркера, будущий мост T-0067) ретраит enqueue после
   сетевого сбоя — в очереди оказываются ДВА job с одинаковой нагрузкой, оба будут
   обработаны. Нет логического ключа дедупликации. **Дыра.**

2. **complete после потери lease.** `complete()` корректно fail-closed:
   `LOCK_EXPIRED`/`NOT_OWNER`/`NOT_LOCKED` (ownership-gate, ADR §4.4, race-safe
   через rowCount). Сам JobStore целостен. НО: побочный бизнес-эффект, который
   воркер УЖЕ выполнил во внешней системе ДО вызова complete (записал запись,
   вызвал API), не защищён — это ответственность идемпотентности потребителя, и
   ей нужен контракт idempotency-key поверх. **Не дыра JobStore, но требует
   контракта для потребителей.**

3. **Двойная доставка (at-least-once).** `fetchAndLock` реклеймит job с истёкшим
   `lock_expiry` (state='LOCKED' AND lock_expiry<=now). Это сознательная
   at-least-once семантика (NF-1 T-0114): job может быть доставлена дважды (воркер
   завис, lease истёк, job переотдан). Эффект выполнится дважды, если воркер не
   идемпотентен. **Требует идемпотентного воркера — контракт.**

### 2.2 Flowable REST-клиент (T-0064, `src/core/flowable-client.ts`)

`withRetry` ретраит на 5xx/network/timeout с exp-backoff (maxRetries=3). Дыры
двойного эффекта:

4. **completeTask после таймаута-но-успеха.** `completeTask` обёрнут в `withRetry`.
   Сценарий: запрос дошёл до Flowable, внешняя задача завершена (204), но ответ не
   вернулся (таймаут/обрыв) → `withRetry` ретраит → второй complete на уже
   завершённую external-task → Flowable отдаёт 404 (задача снята с lock) →
   мапится в NOT_FOUND. Эффект завершения НЕ дублируется на стороне движка (он
   идемпотентен по taskId), НО вызывающий получает `NOT_FOUND` на фактически
   успешной операции — ложно-негативный исход. **Полу-дыра: маппинг исхода.**

5. **deployBpmn повторно.** `deployBpmn` тоже под `withRetry`. Повторный успешный
   deploy того же XML создаёт НОВЫЙ `deploymentId` в Flowable (deployment'ы не
   дедуплицируются по содержимому) → дубликат деплоя при ретрае. **Дыра, но вне
   воркерного контура** — деплой не транзакционная доменная операция; помечаем
   как явную не-цель T-0062 (адресуется в E6/deploy-пайплайне).

### 2.3 Образец двухфазного диспетчера (T-0116 app_timer)

`migrations/011_app_timer.sql` + `012_next_due_buckets.sql` +
`src/core/postgres/pgTimerStore.ts` дают готовый паттерн, который outbox
переиспользует 1:1:
- таблица с `tenant_id`-ведущим PK, FORCE RLS, default-DENY политика на GUC;
- intermediate-state (`firing`) + terminal-state (`done`/`cancelled`);
- partial-индекс `WHERE state='pending'`;
- `SECURITY DEFINER`-агрегат `next_due_buckets()` → `(tenant_id, count)` без строк
  (фаза-1 межтенантного диспетчера, не требует GUC);
- фаза-2 per-tenant: `SET LOCAL choros.tenant_id` + `FOR UPDATE SKIP LOCKED LIMIT N`;
- метрика lag в GET /health как P1-сигнал тихого отказа.

---

## 3. Скоуп

### 3.1 Идемпотентность ключевых операций

- **Idempotency-key на enqueue.** Продюсер опционально передаёт
  `idempotencyKey: string` (логический ключ задания, ≤255 символов). При наличии
  ключа повторный enqueue с тем же `(tenant_id, idempotencyKey)` НЕ создаёт новый
  job, а возвращает существующий (его id/state). Реализуется уникальным
  ограничением на `(tenant_id, idempotency_key)` + INSERT … ON CONFLICT DO NOTHING
  с последующим SELECT существующей строки. Отсутствие ключа = текущее поведение
  (всегда новый job) — обратная совместимость.
- **Семантика complete/fail неизменна** (ownership-gate уже race-safe). T-0062 НЕ
  меняет код complete/fail — фиксирует лишь контракт, что побочный эффект воркера
  обязан быть идемпотентен (через outbox или idempotency-key потребителя).
- **Контракт идемпотентного воркера** (для потребителей, не реализация): воркер,
  получивший job дважды (at-least-once реклейм), ДОЛЖЕН либо (а) выполнять эффект
  через outbox в той же транзакции, что и фиксация результата, либо (б) дедуплицировать
  по бизнес-ключу. Зафиксировать как документированный контракт E1.5/T-0067.

### 3.2 Outbox-паттерн (транзакционная целостность данные+сигнал)

- **Таблица `choros.outbox`** — запись эффекта «изменение данных + сигнал
  процессу/внешнему миру». Поля (минимум): `tenant_id`, `id`, `aggregate_kind`
  (что породило: 'job'/'record'/...), `aggregate_id`, `event_type`,
  `payload jsonb`, `state` ('pending'/'dispatching'/'dispatched'/'dead'),
  `idempotency_key` (для дедупликации доставки), `attempts`, `created_at`,
  `available_at` (backoff между ретраями доставки), `dispatched_at`,
  `last_error`. FORCE RLS + default-DENY политика на GUC `choros.tenant_id`
  (как app_timer). `tenant_id` — ведущая колонка PK и всех составных индексов.
- **Атомарность записи.** Доменная мутация (например, фиксация результата job) и
  INSERT в outbox происходят в ОДНОЙ Postgres-транзакции. Либо обе фиксируются,
  либо обе откатываются. Это и есть возврат транзакционной целостности
  «процесс+данные» из CONCEPT §6.
- **Двухфазный диспетчер доставки** (по образцу T-0116):
  - фаза-1: `SECURITY DEFINER`-агрегат `choros.outbox_pending_buckets(p_before bigint)`
    → `(tenant_id uuid, pending_count bigint)` без строк данных, без GUC;
  - фаза-2 per-tenant tx: `SET LOCAL choros.tenant_id` + CTE-select
    `FOR UPDATE SKIP LOCKED LIMIT N` строк с `state='pending' AND available_at<=now`
    → UPDATE `state='dispatching'`; после успешной доставки → `state='dispatched'`,
    `dispatched_at`; при ошибке → `state='pending'`, `attempts+1`,
    `available_at=now+backoff(attempts)`; после исчерпания ретраев → `state='dead'`.
- **Идемпотентность доставки.** Доставка at-least-once (диспетчер может упасть
  между внешним эффектом и пометкой 'dispatched'). `idempotency_key` строки
  outbox передаётся потребителю/внешней системе, чтобы повторная доставка не
  дублировала эффект. Уникальность доставки гарантирует потребитель по ключу — НЕ
  диспетчер.
- **Метрика в GET /health.** Поле `outbox.pendingLagMs: number | null` (lag
  старейшей недоставленной pending-строки) + `outbox.deadCount: number` как
  P1-сигнал тихого отказа доставки. При ошибке Postgres → `degraded`, не краш.

### 3.3 Связка с Flowable-мостом (контракты потребителей — ЗАФИКСИРОВАТЬ, НЕ РЕАЛИЗОВАТЬ)

- **T-0067 (topic-маппинг external-task↔JobStore):** при завершении внешней задачи
  потребитель пишет результат в доменную таблицу И строку outbox
  (`aggregate_kind='external_task'`, `event_type='task_completed'`,
  `payload`={taskId, variables}) в одной транзакции. Диспетчер позже вызывает
  `flowableClient.completeTask` — повторный вызов после таймаута-но-успеха
  безопасен по taskId (см. дыра №4: движок идемпотентен, NOT_FOUND трактуется как
  уже-доставлено → строка помечается 'dispatched', не 'dead'). **Контракт:**
  outbox-диспетчер для `event_type='task_completed'` трактует исход
  Flowable-клиента `NOT_FOUND` как идемпотентный успех доставки.
- **T-0068 (lifecycle+audit):** запись в `audit_event` (T-0019 actor-ledger) при
  доставке outbox-события — в скоупе T-0068, не T-0062. T-0062 лишь оставляет
  seam: диспетчер вызывает инжектируемый `onDispatched`-хук.

---

## 4. Нефункциональные требования

- **NF-1.** `tenant_id` — ведущая колонка PK и ВСЕХ составных индексов outbox
  (T-0013 §3.1). FORCE RLS + default-DENY; без GUC INSERT падает, SELECT/UPDATE → 0
  строк (fail-closed, инвариант 152-ФЗ tenant-изоляции новых таблиц).
- **NF-2.** `ci/checks/known_tenant_tables.txt` пополняется строкой `outbox`
  **аддитивно** — межтенантный CI-тест (T-0115) подхватывает без изменений самого
  теста. Идемпотентность-ключ на job НЕ создаёт новой таблицы (колонка на job),
  поэтому реестр не трогается из-за неё.
- **NF-3.** Raw `pg`-queries, parameterised, без ORM (ADR NF-4). Никаких новых
  runtime-зависимостей (`pg` уже есть от T-0053).
- **NF-4.** `choros_app` имеет SELECT/INSERT/UPDATE/DELETE на outbox и EXECUTE на
  `outbox_pending_buckets()`, но не DDL (owner = `choros_migrator`).
- **NF-5.** Inject Clock (как pgJobStore/pgTimerStore) для тестируемости backoff и
  available_at.
- **NF-6.** Партиал-индекс `WHERE state='pending'` покрывает путь диспетчера; нет
  Seq Scan по всей таблице на горячем пути.
- **NF-7.** ШОВ ПРОГОНА: миграции — НОМЕРА С 022 (019-021 заняты T-0022 в полёте).
  `pgJobStore.integration.test.ts` — только аддитивный блок в конец, если трогается.

---

## 5. Явные не-цели (out of scope)

- Идемпотентность `deployBpmn` (дыра №5) — деплой не доменная транзакция; адресуется
  в E6/deploy-пайплайне, не здесь.
- Реализация потребителей T-0067/T-0068 (контракты зафиксированы, код — их задачи).
- LISTEN/NOTIFY как wake-up диспетчера (poll-режим, как T-0116 ADR §1).
- Redis / внешний брокер / Kafka (отвергнуты в stack-ADR).
- DLQ как отдельная таблица — `state='dead'` остаётся в outbox; перекладывание/
  алертинг — отдельная задача.
- Реальная запись в `audit_event` при доставке (T-0068).
- REST API/CRUD поверх outbox — только программный интерфейс стора + диспетчер.
- Multi-consumer fan-out одного outbox-события — одна строка = одна доставка.
- Изменение кода complete/fail JobStore (ownership-gate уже корректен).

---

## 6. Критерии приёмки (машинно-проверяемые)

| ID | Критерий | verifiable_as |
|---|---|---|
| AC-1 | `enqueue(topic, vars, retries, idempotencyKey)` с НОВЫМ ключом создаёт job и возвращает его; строка имеет `idempotency_key` = ключ. | test |
| AC-2 | Повторный `enqueue` с тем же `(tenant_id, idempotencyKey)` НЕ создаёт второй job: `SELECT COUNT(*) FROM choros.job WHERE idempotency_key=$key` = 1; возвращается id первого job. | test |
| AC-3 | `enqueue` БЕЗ `idempotencyKey` (undefined) сохраняет текущее поведение: два вызова → два разных job (обратная совместимость). | test |
| AC-4 | Уникальное ограничение на `(tenant_id, idempotency_key)` существует в схеме (partial unique index WHERE idempotency_key IS NOT NULL). | fitness |
| AC-5 | Таблица `choros.outbox`: INSERT от `choros_app` без GUC `choros.tenant_id` → Postgres бросает ошибку (fail-closed). | test |
| AC-6 | `SELECT FROM choros.outbox` от `choros_app` в контексте TENANT_A (SET LOCAL) → строки TENANT_B не видны (0 строк при явном WHERE tenant_id=TENANT_B). | test |
| AC-7 | `ci/checks/known_tenant_tables.txt` содержит строку `outbox`; межтенантный CI-тест (T-0115) проходит без изменений самого теста. | fitness |
| AC-8 | Доменная мутация + INSERT в outbox в одной транзакции атомарны: при искусственном откате транзакции ПОСЛЕ обоих INSERT в БД нет ни доменной строки, ни outbox-строки. | test |
| AC-9 | `choros.outbox_pending_buckets(p_before)` от `choros_app` БЕЗ GUC возвращает агрегат `(tenant_id, pending_count)` без ошибки (SECURITY DEFINER). | test |
| AC-10 | Результат `outbox_pending_buckets()` содержит ровно 2 колонки `(tenant_id, pending_count)` — ни payload, ни id, ни иные поля строки не возвращаются. | test |
| AC-11 | Диспетчер фаза-2 в контексте TENANT_A берёт только `state='pending' AND available_at<=now` строки этого тенанта; строка TENANT_B остаётся `pending`. | test |
| AC-12 | Два параллельных вызова диспетчера на одну outbox-строку: сумма захваченных = 1 (FOR UPDATE SKIP LOCKED). | test |
| AC-13 | Успешная доставка переводит строку `state='dispatching'`→`'dispatched'`, проставляет `dispatched_at`; неуспешная → `state='pending'`, `attempts+1`, `available_at=now+backoff`. | test |
| AC-14 | После исчерпания максимума `attempts` строка переводится в `state='dead'` и не выбирается диспетчером повторно. | test |
| AC-15 | Партиал-индекс `WHERE state='pending'` на `(tenant_id, available_at)` существует; EXPLAIN запроса фазы-2 при 1000 `dispatched` + 10 `pending` строках не показывает Seq Scan по всей таблице. | test |
| AC-16 | GET /health содержит `outbox.pendingLagMs: number|null` (lag старейшей pending-строки) и `outbox.deadCount: number`; при недоступной БД → `status: degraded`, не 500. | test |
| AC-17 | Контракт T-0067 зафиксирован в спеке/доке: outbox-диспетчер для `event_type='task_completed'` трактует исход Flowable-клиента `NOT_FOUND` как идемпотентный успех доставки (строка → `dispatched`, не `dead`). | manual |
| AC-18 | Контракт идемпотентного воркера задокументирован: at-least-once реклейм требует либо outbox-в-той-же-транзакции, либо дедупликацию по бизнес-ключу (ссылка на E1.5/T-0067). | manual |
| AC-19 | Миграции добавлены с номерами ≥022 (019-021 не заняты T-0062); раннер `migrations/run.mjs` применяет их идемпотентно (повторный прогон без ошибок). | test |
| AC-20 | `tsc --noEmit`, eslint и весь существующий `npm run fitness` зелёные после задачи (аддитивность, ничего не сломано). | fitness |

---

## 7. BLOCKING-вопросы

Нет BLOCKING-вопросов, меняющих объём/поведение продукта. Механика (схема outbox,
backoff-кривая, имена колонок, max-attempts) автономна — зона architect/coder, не
требует решения фаундера. Контракты потребителей (T-0067/T-0068) зафиксированы как
интерфейсные обязательства, не реализованы. Статус: **ready**.
