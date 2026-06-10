# T-0063 · SPEC — Topic/retry/backoff/lock-timeout + reclaim + incident при падении воркера (E1.3)

**Эпик:** E1.3 (хардненинг воркера) · **Deps:** E1.1 (T-0114 PostgresJobStore), E1.2 (T-0062 idempotency+outbox), T-0116 (app_timer substratum)
**Refs:** CONCEPT §5 (pull-модель, падение воркера, incident); mvp-backlog.md E1.3; docs/design/T-0114-jobstore-postgres.adr.md.
**Будущие потребители (контракты зафиксированы, не реализованы):** T-0067 (E6.2, topic-маппинг External Task↔JobStore).

Статус: **ready** (механика автономна; BLOCKING вынесены в контракт ниже — нет ни одного).

---

## 1. Инвентаризация: что УЖЕ есть (не дублировать)

Сплошное чтение кодовой базы на ветке `task/T-0063-retry-reclaim` (base dev f7dc03b) показало:

### Уже реализовано в T-0114 (`pgJobStore.ts`, миграции 010)

| Аспект | Реализация | Где |
|---|---|---|
| **Topic-фильтрация fetchAndLock** | `WHERE topic = ANY($1::text[])` — воркер передаёт массив топиков; только они выбираются | `pgJobStore.fetchAndLock()` строка 229 |
| **Backoff на fail-пути** | `fail(retries>0)` → `available_at = now + retryTimeoutMs`, `state='CREATED'`; `fetchAndLock` блокирует до `available_at <= now` | `pgJobStore.fail()` + `fetchAndLock` предикат |
| **Lazy reclaim истёкших локов** | `fetchAndLock` захватывает `state='LOCKED' AND lock_expiry <= now` (ленивый реклейм при следующем fetch) | `pgJobStore.fetchAndLock()` строка 233 |
| **Partial-индексы на CREATED/LOCKED** | `idx_job_fetchable_created` + `idx_job_fetchable_locked` | migration 010 |
| **Dead/terminal state** | `fail(retries=0)` → `state='FAILED'` (терминальный, не реклеймится) | `pgJobStore.fail()` |
| **DLQ-счётчик** | `dlqCount = FAILED AND retries=0` | `ops/catalog/queue_stats.ts` |
| **Health-метрики** | `queue.depth`, `queue.oldestAvailableLagMs` | `pgJobStore.getQueueHealth()` + server.ts |

### Уже реализовано в T-0116 (`pgTimerStore.ts`, миграции 011-012)

- Durable app_timer substratum: `enqueue/fetchAndFire/cancel/done/getTimerHealth`.
- next_due_buckets cross-tenant SECURITY DEFINER агрегат (образец для кросс-тенантного фонового прохода).

### Уже реализовано в T-0062 (`pgOutboxStore.ts`, миграции 023-025)

- Outbox table, dead-state паттерн (outbox.state='dead'), pendingLagMs+deadCount в health.
- Образец использования outbox для «incident» события без новой инфраструктуры (см. §4 ниже).

---

## 2. Дельта: что НЕ построено и входит в T-0063

### 2.1 Активный lock-timeout reclaimer (фоновый проход)

Сейчас реклейм «ленивый»: истёкшие локи освобождаются только когда следующий
воркер вызывает `fetchAndLock`. Если воркеры редки или очередь конкретного топика
пустая/неактивная — job может висеть в `LOCKED` с истёкшим lock_expiry часами.

CONCEPT §5: «Падение воркера не валит процесс: retry + таймаут лока + incident в ядре.»
Слово «таймаут лока» подразумевает, что ядро само детектирует и реагирует — не ждёт
следующего рабочего fetch.

**Дельта:** нужен фоновый reclaimer — периодический проход, который находит
`LOCKED` джобы с `lock_expiry <= now`, «реклеймирует» их (делает eligible для
следующего fetchAndLock) И генерирует запись-incident о потере лока.

Substratum для фонового прохода: app_timer (`kind='lock_reclaim_sweep'`) с
периодическим `dueAt` — образец T-0116. Либо простой setInterval в process-runner.
Механизм — зона architect (T-0063 только специфицирует ПОВЕДЕНИЕ).

### 2.2 Incident-запись при потере лока воркером

CONCEPT §5 явно перечисляет «incident в ядре» как следствие падения воркера (истёкший лок).

**Что такое «инцидент» в системе день-1** (решение без новой инфраструктуры):

- Новая таблица incident — избыточна (новая инфраструктура, новый RLS-слой).
- Запись в audit_event — аудит-лог предназначен для событий бизнес-процесса, не для
  инфраструктурных сигналов воркер-контура. Смешение нарушает семантику E2.8.
- **Запись в outbox** (aggregate_kind='job', aggregate_id=jobId, event_type='worker_lock_expired') —
  минимально, без новой инфраструктуры, естественно вписывается в существующий
  outbox-диспетчер (T-0062). Outbox уже имеет dead-state паттерн и dead_count в health.
  Потребитель (T-0067/T-0068) получит сигнал о потере воркера через тот же диспетчер.
- **Health-метрика `queue.workerIncidents`** — счётчик `outbox` строк с
  event_type='worker_lock_expired' (поверх существующего getOutboxHealth или отдельный запрос).

Это минимальная реализация CONCEPT §5 «incident в ядре» без новой инфраструктуры.

### 2.3 Что НЕ входит в T-0063

- Topic-фильтрация fetchAndLock — **уже есть** (T-0114).
- Backoff на fail-пути — **уже есть** (T-0114).
- Lazy reclaim — **уже есть** (T-0114, как часть fetchAndLock).
- Dead/FAILED semantics для job — **уже есть** (T-0114).
- Идемпотентность — **уже есть** (T-0062).
- Новые топик-таблицы или topic-registry — **не-цель** (topic сейчас plain text, T-0067 решит маппинг).

---

## 3. Функциональные требования

**FR-1. Фоновый reclaimer (активный lock-timeout release).**
Ядро периодически (не реже чем раз в `sweepIntervalMs`) находит jobs в состоянии
`LOCKED` с `lock_expiry <= now` и переводит их в состояние, где они снова eligible
для `fetchAndLock` (возвращает в `CREATED` с `available_at=now`, если остались ретраи;
либо в `FAILED` если `retries=0`), уменьшая `retries` на 1 на каждый sweep-reclaim.

**FR-2. Incident-запись в outbox при sweep-reclaim.**
На каждый реклеймированный job reclaimer atomically записывает в outbox строку:
- `aggregate_kind = 'job'`
- `aggregate_id = jobId`
- `event_type = 'worker_lock_expired'`
- `payload = { topic, lockOwner, lockExpiry, retriesLeft }` (retriesLeft = retries ПОСЛЕ декремента)
- Запись outbox + обновление job в ОДНОЙ транзакции (целостность как T-0062).

**FR-3. Мигратор с корректным шовным номером.**
Если T-0063 требует новых DDL — использовать номер миграции ≥ 029
(027/028 заняты T-0032 в полёте). Если DDL не нужна (reclaimer работает только
с существующими job+outbox таблицами) — новых миграций нет.

**FR-4. Health-метрика workerIncidents в GET /health.**
`GET /health` возвращает дополнительное поле `queue.workerIncidents: number` —
суммарное количество outbox-строк с `event_type='worker_lock_expired'` в состоянии
`pending` или `dead` (ненулевое значение сигнализирует о недавних падениях воркеров).
Аддитивно к существующим полям health (backward-compatible).

**FR-5. Idempotency-ключ для outbox incident строки.**
`idempotency_key = 'lock_expired:' || jobId || ':' || lockExpiry` — гарантирует
что повторный sweep не создаёт дубль incident для того же лок-события.

**FR-6. Retries-декремент при sweep-reclaim согласован с fail-путём.**
Sweep-reclaim считается как один «неудачный попытка» — `retries` уменьшается на 1.
При `retries=0` job переходит в `FAILED` (как при явном `fail(retries=0)`).
При `retries>0` job возвращается в `CREATED` с `available_at = now` (immediate retry,
без дополнительного backoff — воркер упал, не job).

---

## 4. Нефункциональные требования

**NF-1. Без новых таблиц.**
Reclaimer использует только существующие `choros.job` + `choros.outbox`. Новая таблица
(incident, worker_stat и т.п.) = новая инфраструктура → вне скопа T-0063.

**NF-2. Транзакционная атомарность (образец T-0062).**
`UPDATE choros.job` (sweep) + `INSERT INTO choros.outbox` (incident) — в ОДНОЙ транзакции.
Нет partial state: либо оба эффекта, либо ни одного.

**NF-3. Concurrent-safe sweep.**
Несколько экземпляров reclaimer (горизонтальное масштабирование) не должны
одновременно реклеймировать один и тот же job. Механизм: `FOR UPDATE SKIP LOCKED`
или аналогичный (зона architect).

**NF-4. RLS-совместимость.**
reclaimer работает как `choros_app` (NOBYPASSRLS) + GUC `choros.tenant_id` per-tenant,
по образцу `pgOutboxStore.claimBatch` двухфазного диспетчера. Либо как migrator
(BYPASSRLS) — решает architect. Tenant-isolation не ослабляется.

**NF-5. Clock injection.**
Reclaimer принимает `Clock` (как pgJobStore/pgTimerStore) для детерминированных тестов.

**NF-6. Нет нового брокера.**
Poll-режим, Postgres-only. Образец: `runOutboxOnce` (T-0062) или timer fetchAndFire
(T-0116). Никакого Redis/Kafka.

---

## 5. Явные не-цели (out of scope)

- Topic-registry / topic namespace — T-0067 (E6.2).
- Отдельная таблица incidents или worker_stat — выходит за NF-1.
- Push-уведомления (webhook, SSE) при incident — T-0068 (E6.3).
- Настраиваемый backoff при sweep-reclaim (дополнительный retryTimeoutMs) — T-0067+.
- Auth воркер-эндпоинтов (токен Keycloak) — T-0064 (E1.4).
- Документация external-worker API — T-0065 (E1.5).
- Retry-политика на уровне HTTP-адаптера Flowable — T-0064.

---

## 6. Контракты для будущих задач (зафиксированы, не реализованы)

- **T-0067 (E6.2):** получает `worker_lock_expired` из outbox через диспетчер T-0062.
  Payload должен содержать `{ topic, lockOwner, lockExpiry, retriesLeft }`.
- **T-0068 (E6.3):** audit-запись о потере воркера — поверх incident outbox-строки.
- **T-0065 (E1.5):** документация должна описать sweep reclaimer как часть lifecycle.

---

## 7. Швы прогона

- Новые миграции: **начиная с 029** (027/028 заняты T-0032).
- Если reclaimer не требует DDL (работает только с job+outbox) — новых файлов миграций нет.
- `known_tenant_tables.txt`: **не меняется** (новых таблиц нет).
- `pgJobStore.integration.test.ts`: **аддитивно** — новые describe-блоки для sweep-reclaim, не трогаем существующие.
- `cross_tenant.test.ts`: не меняется (нет новых таблиц).

---

## 8. Критерии приёмки

| AC | Текст | Verifiable as |
|---|---|---|
| AC-1 | `pgJobStore.sweepExpiredLocks(sweepDurationMs)` находит job с `state='LOCKED' AND lock_expiry <= now`, переводит его в `CREATED` (retries>0) или `FAILED` (retries=0), и atomically записывает outbox-строку `event_type='worker_lock_expired'` в той же транзакции | test |
| AC-2 | Job с `retries=2` после sweep: `state='CREATED'`, `retries=1`, `available_at=now` (не сдвинут на backoff) | test |
| AC-3 | Job с `retries=0` после sweep: `state='FAILED'`, `retries=0`; outbox-строка записана | test |
| AC-4 | Outbox incident строка содержит: `aggregate_kind='job'`, `aggregate_id=<jobId>`, `event_type='worker_lock_expired'`, `payload.lockOwner=<woker_id>`, `payload.retriesLeft` | test |
| AC-5 | Idempotency-ключ `'lock_expired:' || jobId || ':' || lockExpiry` — повторный sweep того же job не создаёт второй outbox-строки (конфликт игнорируется через ON CONFLICT DO NOTHING) | test |
| AC-6 | Sweep не затрагивает job с `state='LOCKED' AND lock_expiry > now` (активный лок) | test |
| AC-7 | Sweep не затрагивает job с `state='CREATED'` или `state='COMPLETED'` или `state='FAILED'` | test |
| AC-8 | Двойной одновременный sweep двух конкурирующих reclaimer-ов реклеймирует каждый конкретный job ровно один раз (не создаёт двойную outbox-строку при наличии idempotency-key или при FOR UPDATE SKIP LOCKED) | test |
| AC-9 | `GET /health` возвращает `queue.workerIncidents: <number>` — аддитивно, не ломает существующие поля `queue.depth`, `queue.oldestAvailableLagMs`, `timer.timerLagMs`, `outbox.pendingLagMs`, `outbox.deadCount` | test |
| AC-10 | `queue.workerIncidents = 0` при пустой очереди; `queue.workerIncidents = N` после N sweep-reclaim'ов | test |
| AC-11 | Sweep работает только внутри своего тенанта — job тенанта B не реклеймируется при sweep тенанта A (RLS-инвариант) | fitness |
| AC-12 | Интеграционный тест: seed 1 LOCKED job с `lock_expiry = now - 1ms`, после `sweepExpiredLocks(now)` — job в `CREATED`, 1 outbox-строка `worker_lock_expired`; seed 1 LOCKED job с `lock_expiry = now + 1000ms` — sweep не трогает | fitness |
| AC-13 | `pgJobStore.integration.test.ts` (существующие AC-1..AC-18) зелёные после добавления sweep (аддитивность) | fitness |
| AC-14 | Миграции, если есть (≥029), идемпотентны (IF NOT EXISTS / ON CONFLICT DO NOTHING) | fitness |

---

## 9. Blocking-вопросы

*Нет.* Все аспекты задачи однозначно разрешаются существующей кодовой базой и CONCEPT §5.
Принятые решения:
- «Инцидент» = outbox строка (не новая таблица, не audit_event) — обоснование в §2.2.
- Retries-декремент при sweep (не сброс к 0, не пропуск) — следует семантике `fail()`.
- Immediate retry (available_at=now) при sweep — воркер упал, не job; дополнительный backoff
  не нужен и не запрошен в ТЗ (mvp-backlog E1.3 не упоминает backoff для sweep).

---

## 10. Зависимости

| Задача | Статус | Что нужно |
|---|---|---|
| T-0114 | done | pgJobStore, available_at, fetchAndLock lazy reclaim |
| T-0062 | done | outbox table + dispatcher + idempotency_key |
| T-0116 | done | app_timer substratum (при необходимости для scheduling sweep) |
| T-0032 | in-flight | занимает миграции 027/028 → sweep использует ≥029 |
