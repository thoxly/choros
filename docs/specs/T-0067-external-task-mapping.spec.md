# Spec · T-0067 — E6.2 · Маппинг External Task ↔ JobStore topic (бридж-цикл)

**Фаза:** SPEC · **Статус:** ready (без BLOCKING-вопросов) · **Дата:** 2026-06-11
**Задача:** E6.2 — сердце pull-модели: poll-бридж Flowable External Task ↔ Choros JobStore.
**Сырое ТЗ:** `playbooks/mvp-backlog.md` §E6.2
**Зависимости:**
- T-0064 (flowable-client, merged to dev b3745ae — wire-контракт заморожен в `docs/pr/T-0064.pr-handoff.json`)
- T-0062 (идемпотентность + outbox — `enqueue(idempotencyKey)` + outboxDispatcher + `deliver()/idempotentSuccess` — заморожено в `docs/pr/T-0062.pr-handoff.json`)
- T-0063 (lock-sweep/incident — outbox `worker_lock_expired`; downstream seam: deliver() для этого event_type опционально обрабатывается бриджем — заморожено в `docs/pr/T-0063.pr-handoff.json`)
- T-0007 (external worker API — `POST /external-task/fetch-and-lock`, `POST /external-task/:id/complete`, `POST /external-task/:id/fail` — готово, `src/http/externalWorker.ts`)

**Потребители downstream:**
- T-0068 (E6.3 lifecycle + audit) — seam `onDispatched` в outboxDispatcher

**Seam refs:**
- `docs/pr/T-0064.pr-handoff.json` → `downstream_seams_frozen.T-0067_external_task`
- `docs/pr/T-0062.pr-handoff.json` → `downstream_seams.T-0067`
- `docs/pr/T-0063.pr-handoff.json` → `downstream_seams.T-0067`
- `ci/checks/flowable-bridge-contract.sh` (FF-G3 активен — flowable-client.ts уже в src/core/)
- `ci/checks/flowable/external-task-smoke.sh` (образец E2E smoke, расширяется бриджем)

---

## 0. Контекст и границы

Flowable держит очередь External Tasks: когда BPMN-процесс доходит до узла `<serviceTask activiti:type="external-worker">`, движок создаёт External Task с заданным `topic`. Choros-ядро должно периодически:

1. **опросить** (fetchAndLock) Flowable по известным топикам,
2. **энкьюить** в свой JobStore полученные задачи (с `idempotency_key = external_task.id` — дубли исключены),
3. **доставить** job внешнему воркеру через уже живой `POST /external-task/fetch-and-lock`,
4. когда воркер завершает задачу (`POST /external-task/:id/complete`) — **сообщить** Flowable о завершении (`completeTask`),
5. когда воркер сигнализирует провал (`POST /external-task/:id/fail`) — **сообщить** Flowable о провале (`failTask`).

Это и есть «бридж-цикл». Механизм передачи (poll-loop, worker ID, lock duration) определяется архитектором (T-0067 DESIGN). Спека фиксирует **что** должно происходить и **машинно-проверяемые критерии**, не КАК именно реализован poll-loop.

---

## 1. Задача одним предложением

Реализовать **бридж External Task ↔ JobStore**: компонент, который (a) периодически опрашивает Flowable и энкьюит External Tasks в JobStore с `idempotency_key=external_task.id`, (b) доставляет job-ы внешним воркерам через существующий HTTP API, и (c) по завершению job-а вызывает `completeTask`/`failTask` в Flowable — замыкая полный pull-цикл.

---

## 2. Функциональные требования

**FR-1 · Poll & enqueue (Flowable → JobStore)**
Бридж периодически вызывает `FlowableClient.fetchAndLock(topic, workerId, lockDuration, maxTasks)` для каждого сконфигурированного топика. Для каждого полученного `ExternalTask` делает `pgJobStore.enqueue(topic, variables, retries, idempotencyKey=task.id)`. При повторном poll того же task (lock не истёк, но бридж рестартовал) `enqueue` возвращает существующий job без дубля (idempotency семантика T-0062).

**FR-2 · Topic-маппинг (конвенция идентичности)**
Flowable `topic` = JobStore `topic`. Конвенция: 1:1 по строковому значению. Промежуточной таблицы маппинга нет — топик передаётся сквозь без трансформации. Если Flowable-топик нужно переименовать для JobStore — это конфигурация бриджа (override-map), не отдельная таблица БД.

**FR-3 · Передача переменных (в безопасных типах)**
Переменные `ExternalTask.variables` (уже распарсенные `fromFlowableVars` в flowable-client) передаются как `variables` в `enqueue`. Каждое значение перед постановкой в очередь проходит через `assertVariableValue` — FF-G3 Layer C (T-0028). Провал guard-а → job не создаётся, бридж записывает инцидент и продолжает следующий task.

**FR-4 · Complete-путь (JobStore → Flowable)**
Когда внешний воркер вызывает `POST /external-task/:id/complete` и JobStore успешно переводит job в COMPLETED — бридж вызывает `FlowableClient.completeTask(externalTaskId, workerId, payload)`. Ответ NOT_FOUND от Flowable → `idempotentSuccess: true` (external task уже завершён; outboxDispatcher трактует как dispatched, не dead). Любой другой сбой → `ok: false, error: ...` → outboxDispatcher запускает backoff/retry цикл.

**FR-5 · Fail-путь (JobStore → Flowable)**
Когда внешний воркер вызывает `POST /external-task/:id/fail` и JobStore успешно регистрирует провал — бридж вызывает `FlowableClient.failTask(externalTaskId, workerId, errorMessage, retries, retryTimeout)`. NOT_FOUND → `idempotentSuccess: true`. Другой сбой → retry.

**FR-6 · Связь job ↔ external task ID**
Для выполнения FR-4/FR-5 необходимо знать Flowable `externalTaskId` по `jobId`. Эта связь устанавливается при enqueue (FR-1) и должна сохраняться до вызова complete/fail. Механизм хранения (переменные job, отдельная таблица, поле в job) — зона DESIGN. Спека фиксирует: связь должна быть восстанавливаемой при любом рестарте бриджа без потери данных.

**FR-7 · Deliver-функция для outboxDispatcher**
Бридж реализует `Deliver: (row: OutboxRow) => Promise<DispatchResult>` (контракт T-0062). `deliver` вызывает соответствующий FlowableClient-метод в зависимости от `row.eventType` (`task_completed` → completeTask, `task_failed` → failTask). Неизвестный `eventType` → `{ ok: true }` (no-op, бридж не ломается).

**FR-8 · Обработка worker_lock_expired incidents (T-0063 seam)**
Outbox может содержать строки `event_type='worker_lock_expired'` (от lock-sweep T-0063). Бридж определяет поведение: вызвать `failTask` в Flowable с `retries=0` (terminal fail, signalling the engine the task was abandoned) или no-op (если Flowable сам управляет ретраями). Выбор фиксирует DESIGN. Спека: бридж **не падает** при получении этого event_type — deliver возвращает валидный DispatchResult.

**FR-9 · Идемпотентность fetch-цикла**
При параллельном запуске двух бридж-инстансов (например, после перезапуска без graceful shutdown): `pgJobStore.enqueue` с тем же `idempotency_key` гарантирует один job (T-0062). `fetchAndLock` в Flowable лочит задачу на `lockDuration` — второй бридж-инстанс не получит её до истечения. Итого: двойной enqueue безопасен, двойной complete/fail безопасен через `idempotentSuccess`.

**FR-10 · Poll-loop паттерн**
Бридж использует тот же poll-loop паттерн, что `outboxDispatcher` (T-0062) и `lockReclaimer` (T-0063): фоновый цикл на `setInterval` с инъектируемыми часами и `setIntervalFn` для детерминированных тестов. `stop()` для graceful shutdown. Первый проход — после первого интервала (не блокирует старт сервера).

---

## 3. Нефункциональные требования

**NF-1 · Zero new npm dependencies.** Бридж использует только stdlib Node + существующие модули проекта (`flowable-client`, `pgJobStore`, `outboxDispatcher`, `object-handle`).

**NF-2 · Аддитивность.** Бридж не меняет сигнатуры существующих модулей. `externalWorker.ts` (HTTP-слой) не изменяется — воркер продолжает работать с JobStore напрямую как сейчас.

**NF-3 · FF-G3 compliance.** Бридж-файлы обязаны содержать `assertVariableValue` и `resolveFor` (структурные ссылки). Fitness `flowable-bridge-contract.sh` продолжает проходить.

**NF-4 · Инъектируемые зависимости.** FlowableClient, pgJobStore, pgOutboxStore и часы — инъектируются в factory/constructor. Бридж тестируется с mock-клиентом без живого Flowable.

**NF-5 · Tenant isolation.** Каждый enqueue и все операции JobStore/OutboxStore — с установленным GUC `choros.tenant_id`. Бридж оперирует в контексте одного tenant (или итерирует по tenant-бакетам, как lockReclaimer). Cross-tenant CI-блокер (T-0115 `cross_tenant.test.ts`) должен оставаться зелёным.

**NF-6 · Миграции с номером ≥030.** Если бриджу нужны новые таблицы — номера начинаются с 030. Новые таблицы добавляются в `ci/checks/known_tenant_tables.txt` + `cross_tenant` case.

---

## 4. Явно вне скопа (out of scope)

- **T-0068:** lifecycle инстанса + полная запись в audit_event/actor_event (seam `onDispatched` зарезервирован — T-0067 не заполняет его).
- **E8.2:** деплой BPMN из модельера.
- **E1.4:** auth эндпоинтов воркера (Keycloak токен).
- **Агентский рантайм (Stage 2):** Agent Task ≠ External Task в рамках этой задачи.
- **User Task / inbox (E7):** только External Task.
- **Масштабирование / шардирование** нескольких бридж-инстансов: single-instance достаточно для MVP.

---

## 5. Критерии приёмки

### Блок A — poll & enqueue

| ID | Критерий | Тип |
|---|---|---|
| AC-1 | `runBridgeOnce(flowableClient, jobStore, topics, ...)` с mock-FlowableClient, возвращающим 2 ExternalTask по топику `"invoice-process"`, создаёт ровно 2 job-а в JobStore с `topic="invoice-process"` | test |
| AC-2 | Повторный вызов `runBridgeOnce` с теми же ExternalTask ID (mock возвращает те же tasks) создаёт 0 новых job (idempotency_key conflict → возвращает существующий, не дубль). JobStore содержит по-прежнему 2 job-а | test |
| AC-3 | Если `assertVariableValue` отклоняет переменную в ExternalTask (mock возвращает задачу с `variables: { rec: { __kind: "RecordRef", ... } }`), job **не создаётся** для этого task; остальные tasks в том же batch обрабатываются | test |
| AC-4 | `job.topic` совпадает с `externalTask.topic` (конвенция 1:1); `job.variables` соответствует `externalTask.variables` (без трансформации полей) | test |
| AC-5 | Связь `jobId ↔ externalTaskId` сохраняется (восстанавливается) после рестарта бриджа (проверяется: enqueue → получить jobId → simulate restart → resolve externalTaskId по jobId → совпадает) | test |

### Блок B — complete-путь

| ID | Критерий | Тип |
|---|---|---|
| AC-6 | Когда JobStore.complete() возвращает `{ ok: true }`, бридж вызывает `FlowableClient.completeTask(externalTaskId, workerId, payload)` ровно 1 раз; аргументы соответствуют job-данным | test |
| AC-7 | `completeTask` возвращает `{ ok: false, code: 'NOT_FOUND' }` → outboxDispatcher получает `{ ok: false, idempotentSuccess: true }` → строка переходит в `dispatched`, не в `dead` | test |
| AC-8 | `completeTask` возвращает `{ ok: false, code: 'ENGINE_UNAVAILABLE' }` → outboxDispatcher получает `{ ok: false }` → строка остаётся в pending/backoff цикле; после `maxAttempts` → `dead` | test |
| AC-9 | Если `FlowableClient.completeTask` вызывается с переменными, прошедшими через `assertVariableValue`, и с `resolveFor`-ссылкой — fitness `flowable-bridge-contract.sh` проходит (FF-G3 зелёный) | fitness |

### Блок C — fail-путь

| ID | Критерий | Тип |
|---|---|---|
| AC-10 | Когда JobStore.fail() возвращает `{ ok: true }`, бридж вызывает `FlowableClient.failTask(externalTaskId, workerId, errorMessage, retries, retryTimeout)` ровно 1 раз | test |
| AC-11 | `failTask` возвращает `NOT_FOUND` → `idempotentSuccess: true` → строка в `dispatched` | test |
| AC-12 | Для `event_type='worker_lock_expired'` (T-0063 incident) бридж возвращает валидный `DispatchResult` (не бросает исключение, не зависает); строка отмечается dispatched или переходит в retry — но не вызывает unhandled rejection | test |

### Блок D — poll-loop

| ID | Критерий | Тип |
|---|---|---|
| AC-13 | `startBridgePollLoop(...)` с `setIntervalFn` (инъектируемый) — первый проход происходит через один интервал, не немедленно (сервер стартует без блокировки) | test |
| AC-14 | `stop()` прекращает дальнейшие вызовы FlowableClient; нет `unhandledRejection` после stop | test |
| AC-15 | При провале `FlowableClient.fetchAndLock` (`ENGINE_UNAVAILABLE`) — poll-loop продолжает работу; следующий интервал — нормальный вызов | test |

### Блок E — live E2E (полный цикл через реальный Flowable)

| ID | Критерий | Тип |
|---|---|---|
| AC-16 | `ci/checks/flowable/bridge-e2e-smoke.sh` (новый, образец `external-task-smoke.sh`): deploy `choros-smoke.bpmn20.xml` → start instance → bridge-poll (единичный runBridgeOnce через CLI-runner) → job появляется в JobStore → `POST /external-task/:id/complete` → bridge deliver → completeTask в Flowable → экземпляр завершён; весь цикл exit 0 | fitness |
| AC-17 | В позитивном E2E smoke: `job.idempotency_key = externalTask.id` (константа 1:1); повторный poll того же инстанса до complete → 0 новых job | fitness |
| AC-18 | В E2E smoke: полная пара complete-путь с payload `{ approved: true }` проходит FF-G3 (assertVariableValue + resolveFor в bridge-файле; flowable-bridge-contract.sh exit 0) | fitness |

### Блок F — изоляция и регрессия

| ID | Критерий | Тип |
|---|---|---|
| AC-19 | `npm run fitness:db` (изолированный Postgres) — cross_tenant.test.ts остаётся зелёным; если добавлена новая таблица, она присутствует в `known_tenant_tables.txt` | fitness |
| AC-20 | `tsc --noEmit` exit 0; `eslint src/` exit 0; `vitest run` — все существующие тесты зелёные (0 регрессий) | fitness |
| AC-21 | Миграции ≥030 (если есть): `node migrations/run.mjs` дважды — второй прогон `nothing to apply` (идемпотентность миграций) | fitness |

---

## 6. BLOCKING-вопросы

Нет. Все механизмы (FlowableClient, pgJobStore, outboxDispatcher, lockReclaimer, FF-G3) зафиксированы предшествующими задачами. Единственный выбор дизайна — способ хранения связи `jobId ↔ externalTaskId` (FR-6) и поведение бриджа при `worker_lock_expired` (FR-8) — отдан DESIGN-фазе (T-0067 DESIGN) как автономное решение без эскалации фаундеру.

---

## 7. Шов для T-0068

Бридж передаёт `onDispatched?: (row: OutboxRow) => Promise<void>` в `runOutboxOnce`. T-0067 оставляет `onDispatched` как `undefined` (no-op в outboxDispatcher). T-0068 заполняет этот seam для записи в audit_event/actor_event.
