# T-0068 · Instance lifecycle ↔ единый аудит (человек/агент/сервис различимы) Spec

**Title:** E6.3 · Lifecycle инстанса процесса + связка с единым аудитом (человек/агент/сервис различимы)
**Status:** ready (no blocking questions — boundaries fixed below, §2/§6)
**Authored:** 2026-06-11
**Task type:** product+architecture (E6 эпик, материализован unapproved; GT-1 за фаундером)
**spec_ref:** `playbooks/mvp-backlog.md#E6.3` · `CONCEPT.md` §5 («Аудит-лог: люди + агенты + сервисы в одном потоке»), §9 (сквозной пример)
**Foundation (do NOT contradict):**
- `docs/specs/T-0016-audit-floor.spec.md` — единый append-only per-tenant hash-chained `audit_event`/`audit_head`, канонический путь записи `appendAuditEvent` (§4.4). **Дополнение, не противоречие:** T-0016 явно отложил *реализацию* писателя на «T-0053 + dependent build tasks» (§6.3). T-0068 — это dependent build task для lifecycle-событий.
- `docs/pr/T-0067.pr-handoff.json` — `onDispatched`-шов заморожен под T-0068 (`makeExternalTaskDeliver(flowableClient, jobStore, onDispatched?)`, `startBridgePollLoop`); server.ts-wiring и audit-path явно отданы T-0068 (`downstream_T_0068`, `not_in_scope`).
- `docs/pr/T-0032.pr-handoff.json` — `actor_event`-писатель (`appendActorEvent`) и SoD-гейт (`resolveFor` step 3.6/6.5) уже есть; T-0068 назван владельцем *engine-side wiring* (`deps.sod` injection + `guardCtx`). Граница уточнена в §2/§6.
- `migrations/006_audit_event.sql`, `007_audit_head.sql`, `016_employee.sql` (kind∈{human,agent}), `018_actor_event.sql`, `024_outbox.sql` — материализованная объектная модель.

---

## 1. Summary

Когда процесс-инстанс Flowable проходит свой жизненный цикл (старт инстанса →
шаги/External Task → завершение/инцидент), **каждый governance-значимый шаг
записывается ровно одной строкой в единый аудит-флор** (`audit_event`, T-0016) по
**каноническому пути записи** (`appendAuditEvent`: per-tenant hash-chain +
монотонный `seq` + атомарный head-advance). Актор каждой строки **различим как
человек / агент / сервис**: ось различения — `employee.kind` (T-0017: `human` |
`agent`; сервис = `agent` по FR-4 T-0017), спроецированная в аудит-строку. Связка
делается через замороженный T-0067 `onDispatched`-шов: доставка task_completed /
task_failed из outbox → ровно одна аудит-строка; старт инстанса (`startInstance`)
→ ровно одна аудит-строка. Идентичность инстанса (`instance_id` движка) хранится в
аудит-строке как **указатель** (опаковый ref в `payload`/`subject`), а не как дубль
состояния движка — Choros не дублирует машину состояний Flowable (CONCEPT §6:
движок = чёрный ящик уровня Postgres).

T-0068 закрывает три вещи:
1. **Канонический писатель аудит-флора** `appendAuditEvent` (T-0016 §4.4) —
   реализация, отложенная T-0016 на dependent build task. Атомарный
   `audit_event` INSERT + `audit_head` forward-advance в одной `withTenant`-транзакции.
2. **Маппер lifecycle-события → аудит-строка** с различимым актором (human/agent/
   service) и `instance_id`-указателем.
3. **Wiring** замороженных T-0067 швов (`startBridgePollLoop` + `onDispatched` +
   `startInstance`) в композиционный корень так, что путь инстанса виден в
   аудит-логе.

---

## 2. Scope boundary (зафиксировано явно)

Спорные границы разрешены здесь честно (не «попробуем»), потому что окружающий код
их обнажил. Каждая граница — проверяемое утверждение, не догадка.

### 2.1 Какие lifecycle-события в скоупе (что движок реально отдаёт через REST T-0064)

`FlowableClient` (T-0064, `src/core/flowable-client.ts`) экспортирует РОВНО:
`deployBpmn`, `startInstance`, `fetchAndLock`, `completeTask`, `failTask`. **Нет**
`cancelInstance`, **нет** instance-query/poll, **нет** `deleteInstance`. Поэтому
durably-наблюдаемые Choros-ом lifecycle-события и их аудит-маппинг:

| Lifecycle-событие | Источник наблюдения (существующий шов) | `audit_event.type` |
|---|---|---|
| **instance.started** | возврат `startInstance(...)` (server.ts вызывает) | `instance.started` |
| **task.dispatched** | `onDispatched(row)` при `eventType='task_completed'` (успешная доставка в Flowable) | `task.completed` |
| **task.failed** (incident) | `onDispatched(row)` при `eventType='task_failed'` | `task.failed` |

- **`instance.cancel` / `instance.completed` (終端 движка) — OUT OF SCOPE T-0068**:
  REST-поверхность T-0064 их не отдаёт (нет cancel-вызова, нет history/query-API).
  Их аудит требует сначала расширить `FlowableClient` (cancel + instance-query или
  Flowable history event listener) — это отдельная задача (forward-obligation §10,
  кандидат E6.4/после расширения T-0064). T-0068 НЕ выдумывает события, которых
  движок не отдаёт.
- **`worker_lock_expired`** (outbox eventType) — НЕ аудит-событие governance-уровня
  (T-0067 ADR §2.B: no-op, anti-split-brain). В аудит НЕ пишется (см. AC-9).

### 2.2 Канонический писатель аудита — СКОУП T-0068 (scope-widening, заявлен честно)

T-0016 §6.3 отложил `appendAuditEvent` на «T-0053 + dependent build tasks».
В кодовой базе writer В audit_event/audit_head **не существует** (grep по `src/`:
0 совпадений production-кода, пишущего в `audit_event`). Lifecycle-событие нельзя
записать без писателя. Поэтому **T-0068 владеет реализацией канонического
`appendAuditEvent`** (по контракту T-0016 §4.3/§4.4: канонический preimage,
SHA-256 hash-chain, per-tenant `seq` под `audit_head ... FOR UPDATE`, атомарный
head-advance, vocab_version=1) — ровно так, как T-0032 честно расширил скоуп до
`appendActorEvent`, когда у писателя не было владельца. Это НЕ новое решение сверх
карты: T-0016 предусмотрел этого dependent-владельца.

### 2.3 Граница с T-0032-wiring (`deps.sod` + `guardCtx`) — РАЗДЕЛЕНА

T-0032 handoff называет T-0068 владельцем «engine-side wiring: `deps.sod` injection
+ `guardCtx` construction». НО тот же handoff фиксирует: Postgres-DAO для `deps.sod`
(`SodSource`/`ActorEventReader`/`ActorEventWriter`) — это **T-0053**, и «until
T-0053 lands, `deps.sod` is never injected in production». Живого DAO нет.

**Решение T-0068 (зафиксировано):**
- T-0068 **строит `GuardContext`** из lifecycle-контекста (actor, onBehalfOf,
  roleAtEvent, verb, approveLevel) на approve/transition-шве — это часть
  identity-различения актора, которая нужна и для аудита.
- T-0068 **проводит шов** так, что когда T-0053-DAO появится, `deps.sod` инжектится
  в `resolveFor` без переписывания шва (опциональный параметр, как `onDispatched`).
- **Живая инъекция `deps.sod` (реального Postgres SoD-DAO) остаётся за T-0053** —
  T-0068 НЕ строит SoD Postgres-DAO. Аудит lifecycle **не зависит** от того,
  активен ли SoD-гейт: аудит-строка пишется по факту доставки события независимо от
  SoD-решения (SoD denial — это отдельная актор-событие/grant-решение, не lifecycle-аудит).

  **Почему это не BLOCKING:** «путь инстанса виден в аудите; человек/агент/сервис
  различимы» (acceptance E6.3) выполним без активного SoD-гейта. SoD-enforcement —
  ось E4/E7.1, отдельная от lifecycle-аудита E6.3. Активация SoD на живом transition
  — T-0053+T-0068-wiring, и она аддитивна (T-0032 step 3.6 fail-open-by-absence).

### 2.4 Идентичность инстанса — указатель, не дубль

`instance_id` (Flowable processInstanceId) хранится в аудит-строке как опаковый ref
(`subject` и/или `payload.instanceId` + `payload.aggregateId`=jobId). Choros **не
заводит таблицу-зеркало состояния инстанса** и не реплицирует машину состояний
движка (CONCEPT §6: движок — чёрный ящик). Связь «наша объектная модель ↔ instance»
— через уже существующий `job.idempotency_key` = externalTask.id и
`outbox.aggregate_id` = jobId (T-0067 reverse-map). Новая таблица-зеркало —
явный **не-цель** (§5).

### 2.5 Server-wiring — СКОУП T-0068

T-0067 handoff: «server.ts wiring of `startBridgePollLoop` — T-0068 owns this».
T-0068 проводит `makeFlowableClient` + `startBridgePollLoop` (с `onDispatched`,
пишущим аудит) + `startInstance`-аудит в `src/server.ts` композиционный корень, за
feature-флагом окружения (без живого Flowable процесс стартует деградированно, не
падает — паттерн T-0067 AC-13/14).

---

## 3. Functional Requirements

### FR-1 — Канонический писатель аудит-флора `appendAuditEvent`
Реализовать единственный санкционированный путь записи аудит-строки (T-0016 §4.4):
внутри `withTenant`-транзакции — (a) `SELECT ... FOR UPDATE` head-строки тенанта
(per-tenant сериализация, НЕ глобальный lock); (b) `seq = head.seq+1` (или
`GENESIS_SEQ=1`), `prev_hash = head.row_hash` (или `GENESIS_PREV_HASH`=32 нулевых
байта); (c) построение канонического preimage (T-0016 §4.3, vocab_version=1:
length-prefixed поля в фиксированном порядке, JCS для jsonb, NULL≠empty),
`row_hash = SHA-256(preimage)`; (d) INSERT в `audit_event` (только INSERT) +
forward-only advance `audit_head` — в ОДНОЙ транзакции (атомарность T-0016 FR-4).

### FR-2 — Различимость актора: человек / агент / сервис
Каждая lifecycle-аудит-строка несёт различимый тип актора. Ось — `employee.kind`
(T-0017: `human` | `agent`; сервис=`agent` по FR-4 T-0017). Маппинг в аудит:
- `audit_event.actor` = идентификатор исполнителя (slug/uuid employee или
  bridge-worker id для сервис-воркеров);
- тип актора (`human`|`agent`|`service`) выводится из `employee.kind` исполнителя и
  кладётся в `audit_event.payload.actorType` (канонический, hash-covered) и/или
  `via` (T-0016 «path/channel/tool»).
- Совместимость с read-API контрактом (`src/http/audit.ts`: `type:"human"|"agent"
  |"service"`): три значения. `service` — это `agent`-employee, действующий как
  bridge/external worker (например `s-ledger`, `s-ocr`, `control-plane`) — отличается
  от `agent` (агент-рантайм) по under-роли/каналу, НЕ по новой колонке в `employee`.
  T-0068 фиксирует правило проекции kind→{human,agent,service}, не меняя схему employee.

### FR-3 — instance.started → ровно одна аудит-строка
При успешном `startInstance(processKey, vars)` пишется ровно одна `audit_event`
строка `type='instance.started'`, `subject`=processInstanceId,
`payload.instanceId`=processInstanceId, `payload.processKey`, `actor`/actorType
инициатора старта.

### FR-4 — task.completed / task.failed → ровно одна аудит-строка через onDispatched
`onDispatched(row)` (T-0067 шов, вызывается ровно-однократно после durable
`markDispatched`) для `eventType∈{task_completed, task_failed}` пишет ровно одну
`audit_event` строку (`type='task.completed'|'task.failed'`), с `instance_id`/jobId
указателем (`subject`/`payload`), actor/actorType исполнителя. Exactly-once:
повторный проход dispatcher-а по уже dispatched-строке `onDispatched` НЕ вызывает
(гарантия T-0067 outboxDispatcher: `if (advanced)`), → дубль аудит-строки невозможен.

### FR-5 — worker_lock_expired НЕ пишется в аудит
`onDispatched` для `eventType='worker_lock_expired'` (и неизвестных типов) НЕ
порождает аудит-строку (T-0067 ADR §2.B: это no-op/anti-split-brain, не governance-
событие).

### FR-6 — instance_id как указатель, не дубль
Аудит-строка хранит `instance_id` (и jobId/externalTaskId через T-0067 reverse-map)
как опаковый ref в `subject`/`payload`. T-0068 НЕ создаёт таблицу-зеркало состояния
инстанса и НЕ реплицирует состояние движка (§2.4).

### FR-7 — GuardContext-конструкция на approve/transition-шве (T-0032 wiring, аддитивно)
T-0068 строит `GuardContext` (actor, onBehalfOf, roleAtEvent, verb, approveLevel) из
lifecycle-контекста и проводит шов `resolveFor(..., deps.sod?, guardCtx?)` так, что
T-0053-DAO `deps.sod` инжектится без переписывания. БЕЗ `deps.sod` поведение
идентично pre-T-0032 (fail-open-by-absence). Живой Postgres SoD-DAO — НЕ скоуп
T-0068 (§2.3).

### FR-8 — Server-wiring lifecycle-аудита
`src/server.ts` (или композиционный модуль) проводит: `makeFlowableClient` →
`startBridgePollLoop({..., onDispatched=auditOnDispatched})` + lifecycle-аудит на
`startInstance`. За env-флагом; без Flowable-конфига сервер стартует, аудит-путь
деградирован (no-throw, паттерн T-0067 AC-13/14).

### FR-9 — Новые таблицы (если будут) — tenant-tables
Если T-0068 заведёт новую таблицу (например, lifecycle-проекция/маппинг) — она
обязана быть T-0013 tenant-table (tenant_id leading PK, FORCE RLS, default-DENY),
добавлена в `ci/checks/known_tenant_tables.txt` + `cross_tenant.test.ts` case. (NB:
по §2.4 цель — НЕ заводить таблицу-зеркало; `audit_event`/`audit_head` уже
существуют и уже в known_tenant_tables.)

---

## 4. Non-Functional Requirements

- **NF-1** — Zero new npm dependencies (zero-runtime-dep дисциплина репозитория;
  SHA-256 из `node:crypto`).
- **NF-2** — Per-tenant сериализация аудит-append: НИКАКОГО глобального SEQUENCE/
  advisory-lock (T-0016 NF-2). Только `audit_head ... FOR UPDATE` per tenant.
- **NF-3** — Атомарность: `audit_event` INSERT + `audit_head` advance в одной
  транзакции; ROLLBACK откатывает оба (T-0016 FR-4 / AC-15).
- **NF-4** — Exactly-once аудит на lifecycle-событие: opираемся на durable
  `markDispatched`+`if(advanced)` (T-0067), не на in-app дедуп.
- **NF-5** — Деградация без Flowable: отсутствие движка/конфига НЕ роняет сервер
  (loop стартует, ошибки poll глотаются — T-0067 AC-13/14).
- **NF-6** — Аудит-append append-only структурно (T-0016 FR-1): writer использует
  только INSERT на `audit_event`; никаких UPDATE/DELETE. Триггеры миграции
  006/007 уже барят мутацию.
- **NF-7** — Канонический preimage детерминирован и vocab-pinned (T-0016 FR-6/NF-5):
  изменение поля/порядка/кодировки/H = bump vocab_version, golden-digest CI-гейт.
- **NF-8** — Идемпотентность миграций: новые миграции (если будут) — нумерация **с
  031** (030 занята T-0030 в полёте), применяются дважды без ошибки.

---

## 5. Out of Scope (явные не-цели)

1. **`instance.cancel` / `instance.completed`-аудит** — REST T-0064 не отдаёт cancel/
   history; требует расширения `FlowableClient` (forward §10).
2. **Таблица-зеркало состояния инстанса** — Choros не дублирует машину состояний
   движка (§2.4 / CONCEPT §6).
3. **Verifier (`verifyAuditChain`) реализация + CI-probe** — контракт в T-0016 §4.5/
   FR-5; T-0068 строит writer, не верификатор (T-0053 / dependent, §10). T-0068
   ОБЯЗАН лишь не нарушить verifier-инвариант (preimage детерминирован, chain dense).
4. **Постоянный Postgres SoD-DAO (`deps.sod`)** — T-0053 (§2.3).
5. **head-snapshot-to-object-storage job** — T-0016 §6.5 (T-0053/infra).
6. **UI инбокса/аудита** — read-API уже отдаёт seed-fixture (`src/http/audit.ts`);
   замена seed на live-выборку из `audit_event` — кандидат E7.3/последующая задача,
   НЕ T-0068 (T-0068 пишет в флор; чтение из флора в UI — отдельный шов).
7. **Агентский рантайм / реальные агенты** — Stage 2 (CONCEPT §9, E10.1 заглушка).
8. **152-ФЗ юридическая валидация** — юрист, не код (T-0016 §6.11).

---

## 6. Acceptance Criteria

Все AC машинно-проверяемы. **static-now** = в `npm run ci` сегодня (tsc/lint/vitest +
`ci/checks/*` линты; zero-runtime-dep). **live-DB** = проба против isolated Postgres
(job `fitness:db` / compose), авторится сейчас, гейтится при наличии БД. Паттерн
T-0013/T-0016/T-0032.

### Канонический writer (FR-1, NF-2/3/6/7)

**AC-1** — `appendAuditEvent` пишет первую строку тенанта с genesis-якорем
```
live-DB: appendAuditEvent(tx, {type:'instance.started', actor:'e-larina', ...}) для
  пустого тенанта → строка с seq=1, prev_hash=GENESIS_PREV_HASH (32 нулевых байта),
  row_hash=SHA256(preimage). audit_head.(seq,row_hash)=(1, row_hash).
```
`verifiable_as: test`

**AC-2** — Цепочка: prev_hash[n] = row_hash[n-1], seq плотный +1
```
live-DB: 3 последовательных appendAuditEvent в одном тенанте → seq=1,2,3 (плотно);
  для каждого n>1 prev_hash равен row_hash строки seq=n-1; audit_head=(3, row_hash_3).
```
`verifiable_as: test`

**AC-3** — Канонический preimage детерминирован и совпадает с pinned digest (vocab=1)
```
static-now (unit): canonicalPreimage(fixture-row) детерминирован (тот же вход → те же
  байты), length-unambiguous (NULL≠empty; переставленные ключи jsonb → идентичный
  preimage через JCS), и SHA256(preimage)==pinned golden digest. Изменение поля/
  порядка/кодировки флипает golden → CI красный (форсит bump vocab_version).
```
`verifiable_as: fitness`

**AC-4** — Append per-tenant сериализован, без глобального lock
```
static-now: ci/checks/audit_no_global_seq.sh (или существующий аналог) — писатель
  использует 'audit_head ... FOR UPDATE' per tenant, НЕ глобальный SEQUENCE/advisory.
live-DB (concurrency): N конкурентных appendAuditEvent в тенанте-A → N плотных
  различных seq (нет дубля/пропуска); append в A и B не блокируют друг друга.
```
`verifiable_as: test`

**AC-5** — Атомарность append+head: ROLLBACK откатывает обе записи
```
live-DB: внутри транзакции appendAuditEvent затем ROLLBACK → ни audit_event-строки,
  ни head-advance не видно. После COMMIT — обе видны и согласованы (head.seq указывает
  на существующую audit_event-строку).
```
`verifiable_as: test`

**AC-6** — Writer не нарушает append-only (только INSERT)
```
static-now: ci/checks/audit_append_only.sh (T-0016 AC-4) остаётся зелёным — writer не
  добавляет GRANT UPDATE/DELETE и не делает UPDATE/DELETE на audit_event. Триггеры
  006/007 не тронуты.
```
`verifiable_as: fitness`

### Lifecycle → аудит (FR-3/4/5)

**AC-7** — instance.started → ровно одна аудит-строка
```
live-DB (или unit с in-memory writer-port): успешный startInstance('invoice', vars) →
  ровно одна audit_event строка type='instance.started', subject=processInstanceId,
  payload.instanceId=processInstanceId.
```
`verifiable_as: test`

**AC-8** — onDispatched(task_completed/task_failed) → ровно одна аудит-строка с
instance-указателем
```
static-now (unit): auditOnDispatched(row{eventType:'task_completed', tenantId, aggregateId,
  payload}) вызывает appendAuditEvent ровно один раз с type='task.completed',
  subject/payload содержит instance/job-указатель (aggregateId). Аналогично
  'task_failed' → type='task.failed'.
```
`verifiable_as: test`

**AC-9** — worker_lock_expired НЕ пишет аудит
```
static-now (unit): auditOnDispatched(row{eventType:'worker_lock_expired'}) НЕ вызывает
  appendAuditEvent (0 строк). То же для неизвестного eventType.
```
`verifiable_as: test`

**AC-10** — Exactly-once: повторная доставка не дублирует аудит-строку
```
static-now (unit): прогон outboxDispatcher дважды по одной строке — onDispatched
  вызывается только когда markDispatched.advanced===true (T-0067), → appendAuditEvent
  вызван ровно один раз; второй проход (already dispatched) аудит не пишет.
```
`verifiable_as: test`

### Различимость актора (FR-2)

**AC-11** — human / agent / service различимы в аудит-строке
```
static-now (unit): для исполнителя employee.kind='human' аудит-строка несёт
  payload.actorType='human'; для kind='agent' (агент-рантайм) → 'agent'; для
  bridge/external-worker-актора (сервис, напр. 's-ledger'/'control-plane') → 'service'.
  Три значения различимы и hash-covered (входят в preimage payload).
```
`verifiable_as: test`

**AC-12** — actorType покрыт hash-цепью (tamper-detectable)
```
static-now (unit): изменение payload.actorType в фикстуре меняет recomputed row_hash
  (T-0016 AC-19 паттерн) — подмена типа актора детектируется как tamper.
```
`verifiable_as: test`

**AC-13** — read-API контракт совместим (type∈{human,agent,service})
```
static-now: проекция kind→actorType даёт значения из множества, совпадающего с
  AuditEvent.type в src/http/audit.ts ('human'|'agent'|'service') — без изменения
  схемы employee (kind остаётся {human,agent}).
```
`verifiable_as: fitness`

### Wiring (FR-7/8, NF-5)

**AC-14** — Server-wiring: bridge+аудит проведены, без Flowable сервер стартует
```
static-now (unit/test): композиционный корень регистрирует startBridgePollLoop с
  onDispatched=auditOnDispatched и lifecycle-аудит на startInstance. Без
  FLOWABLE-env сервер стартует (loop стартует, ошибки poll глотаются — T-0067
  AC-13/14), не бросает на старте.
```
`verifiable_as: test`

**AC-15** — GuardContext-шов аддитивен: без deps.sod поведение pre-T-0032
```
static-now (unit): resolveFor на approve/transition с построенным guardCtx, но БЕЗ
  deps.sod → решение идентично pre-T-0032 (нет sod_violation; только grant-решение).
  Шов готов принять deps.sod (опциональный параметр) без изменения сигнатуры.
```
`verifiable_as: test`

### Tenant-инварианты (NF-8, FR-9)

**AC-16** — Новые миграции (если есть) нумеруются с 031 и идемпотентны
```
live-DB: если T-0068 добавляет миграцию — её номер ≥ 031 (030 занята T-0030);
  migrations run x2 идемпотентны (no error на втором прогоне). Если новых таблиц нет —
  AC выполнен вакуумно (0 новых миграций; писатель использует существующие 006/007).
```
`verifiable_as: test`

**AC-17** — Любая новая таблица — tenant-table в known_tenant_tables + cross_tenant
```
static-now + live-DB: если T-0068 заводит таблицу — она в ci/checks/known_tenant_tables.txt
  и имеет case в cross_tenant.test.ts (FORCE RLS, tenant_id leading, isolation:
  TENANT_A row невидим (0) для TENANT_B). Нет новой таблицы → AC вакуумно зелёный.
```
`verifiable_as: fitness`

---

## 7. Identity / actor model (для architect/coder)

Ось различимости «человек/агент/сервис» НЕ требует новой колонки:
- `employee.kind ∈ {human, agent}` (016_employee.sql) — каноническая ось. Сервис-
  воркеры (`s-ledger`, `s-ocr`) уже seed-нуты как `kind='agent'` (T-0017 FR-4).
- Проекция в аудит `actorType ∈ {human, agent, service}`:
  - `human` ⟸ employee.kind='human';
  - `agent` ⟸ employee.kind='agent', действующий как агент-рантайм (under-роль/канал
    «agent»);
  - `service` ⟸ актор является bridge/external-worker (канал=external worker API):
    `s-*` сервис-воркеры и системные акторы (`control-plane`). Различие agent↔service
    — по каналу/via, не по employee-схеме.
- `audit_event.actor` (text) = идентификатор (slug employee или worker-id).
- `audit_event.via` (text) = канал (e.g. `external-worker`, `user-task`, `engine`).
- `payload.actorType` — канонический, hash-covered тип (FR-2, AC-11/12).
- Для approve/transition: `actor_event` (T-0019/T-0032) уже несёт actor/on_behalf_of/
  role_at_event; lifecycle-аудит в `audit_event` — параллельный поток (T-0016: NOT
  the same as actor_event; нет FK между ними). T-0068 НЕ сливает их.

---

## 8. Blocking questions

Нет. Все спорные границы разрешены в §2 как проверяемые scope-решения (что движок
отдаёт §2.1; владение writer §2.2; SoD-граница §2.3; instance=указатель §2.4),
опираясь на реальный код и замороженные швы T-0067/T-0032 — не на догадки. Ни одна
не меняет product-acceptance E6.3 («путь инстанса виден в аудите; человек/агент/
сервис различимы»), которое выполнимо в зафиксированном скоупе.

---

## 9. Scope-widening (заявлено честно — паттерн T-0032)

T-0068 расширяет скоуп до владения **каноническим writer `appendAuditEvent`**
(T-0016 §4.4), т.к. (a) lifecycle-событие нельзя записать без писателя; (b) writer не
имел владельца — T-0016 §6.3 отложил его на «T-0053 + dependent build tasks», и
T-0068 — первый dependent build task, которому он нужен. Аналогично T-0032 владел
`appendActorEvent`. Writer + canonical preimage + chain — present, tested, по
контракту T-0016 (не пере-проектируем инварианты T-0016).

---

## 10. Forward-obligations (downstream)

| Задача | Обязательство |
|---|---|
| **T-0053** | Postgres SoD-DAO (`SodSource`/`ActorEventReader`/`ActorEventWriter`) для живой инъекции `deps.sod`; `verifyAuditChain` реализация + CI-probe; head-snapshot job. T-0068 оставляет шов готовым. |
| **расширение T-0064 / E6.4** | `cancelInstance` + instance-query/history-listener в `FlowableClient`, затем аудит `instance.cancel`/`instance.completed` (вне T-0068, §5.1). |
| **E7.3 / UI** | замена seed-fixture в `src/http/audit.ts` на live-выборку из `audit_event` (T-0068 пишет флор; чтение в UI — отдельный шов, §5.6). |
| **T-0032-активация** | при наличии T-0053-DAO — фактическая инъекция `deps.sod` в проведённый T-0068 шов (аддитивно). |

---

## 11. References
- `CONCEPT.md` §5 (единый аудит люди+агенты+сервисы), §6 (движок=чёрный ящик,
  outbox), §9 (сквозной пример).
- `playbooks/mvp-backlog.md#E6.3`.
- `docs/specs/T-0016-audit-floor.spec.md` (§4.3 preimage, §4.4 append-контракт, §6
  deferral).
- `docs/pr/T-0067.pr-handoff.json` (onDispatched/startBridgePollLoop швы).
- `docs/pr/T-0032.pr-handoff.json` (actor_event writer + SoD wiring граница).
- `migrations/006_audit_event.sql`, `007_audit_head.sql`, `016_employee.sql`,
  `018_actor_event.sql`, `024_outbox.sql`.
- `src/core/flowable-client.ts`, `src/core/externalTaskBridge.ts`,
  `src/core/outboxDispatcher.ts`, `src/http/audit.ts`, `src/server.ts`.
