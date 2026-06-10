# T-0068 · ADR — Instance lifecycle → единый аудит (канонический writer `appendAuditEvent` + lifecycle-маппер + bridge-wiring)

**Status:** ready
**Task type:** product+architecture (E6.3; материализован unapproved, GT-1 за фаундером)
**Spec:** `docs/specs/T-0068-instance-lifecycle.spec.md` (17 AC, ready)
**Foundation (не противоречить):** T-0016 (§4.3 preimage / §4.4 append-контракт / §4.6 append-only), T-0067 (`onDispatched`/`startBridgePollLoop`/`makeExternalTaskDeliver` швы), T-0032 (`appendActorEvent` writer + SoD-wiring граница), T-0031 (`AuditEventInput` seam-тип на dev), migrations 006/007/016/018/024.

---

## 1. Контекст и сила решения

T-0016 спроектировал единый append-only hash-chained аудит-флор (`audit_event`/`audit_head`)
и **отложил** реализацию канонического writer-а `appendAuditEvent` на «T-0053 + dependent
build tasks» (§6.3). В production-коде writer-а в `audit_event` **нет** (grep: 0 совпадений).
T-0068 — первый dependent build task, которому writer необходим: lifecycle-событие нельзя
записать без него. Следовательно T-0068 **владеет** реализацией writer-а — ровно как T-0032
честно расширил скоуп до `appendActorEvent`, когда у того не было владельца.

На dev уже живёт T-0031 (`src/core/audit-grant-encoder.ts`): он производит `AuditEventInput`
для grant-trail (`encodeGrantAuditEvent`/`encodeAssignmentAuditEvent`), а его тесты **мокали**
`appendAuditEvent`. Значит writer T-0068 — **единый канонический сток** и для grant-trail, и
для lifecycle-событий. Это диктует первое решение: **writer ОБЯЗАН принять `AuditEventInput`-форму
T-0031 как свой входной контракт** — не вводить параллельный тип.

Рычаг: аудит-флор — конституционный механизм Choros (CONCEPT §5: люди+агенты+сервисы в одном
потоке; §6: движок=чёрный ящик). Канонический preimage и hash-chain — это контракт совместимости
с будущим верификатором (T-0053). Ошибка в порядке полей/кодировке preimage = тихий tamper-false-positive
по всей цепи. Поэтому preimage пере-пиннится здесь как единственный источник правды для coder.

---

## 2. Решение (одним абзацем)

T-0068 реализует **канонический writer `appendAuditEvent(tx, input: AuditEventInput)`** в новом
модуле `src/db/audit-writer.ts` (Postgres-tx путь) поверх **чистого** модуля
`src/core/audit-preimage.ts` (детерминированный length-prefixed preimage + SHA-256, vocab=1,
zero-dep `node:crypto`), принимающего `AuditEventInput`-форму T-0031. Writer — это **порт**
(`AuditWriter` интерфейс): production-имплементация пишет в Postgres внутри транзакции вызывающего
(`withTenant`-tx: per-tenant `audit_head ... FOR UPDATE` → `seq=head.seq+1`/genesis →
canonical preimage → `row_hash` → atomic `audit_event` INSERT + `audit_head` forward-advance),
а `InMemoryAuditWriter` (тот же интерфейс, чейн в памяти) обслуживает static-now unit-тесты —
ровно как T-0032 разделил `InMemoryActorEventStore` ↔ Postgres-DAO. **lifecycle-маппер**
`src/core/lifecycle-audit.ts` (чистый, по образцу `audit-grant-encoder.ts`) проецирует
lifecycle-событие → `AuditEventInput` с различимым `actorType∈{human,agent,service}` (ось
`employee.kind`) в hash-covered `payload`. **`auditOnDispatched(writerPort, employeeKindLookup)`**
— фабрика `OnDispatched`-callback: для `eventType∈{task_completed,task_failed}` энкодит и
аппендит ровно одну строку (`task.completed`/`task.failed`), для `worker_lock_expired`/неизвестных
— no-op. Exactly-once опирается на T-0067 `if(advanced)` (callback зовётся только после durable
`markDispatched`). **server-wiring** в новом `src/server/lifecycle-bridge.ts` (композиционный
шов, вызываемый из `index.ts` main-блока за env-флагом `FLOWABLE_BASE_URL`): без Flowable-конфига
loop стартует деградированно (no-throw, паттерн T-0067 AC-13/14). **`GuardContext`-шов** проводится
аддитивно: `buildLifecycleGuardCtx` строит `GuardContext` из lifecycle-контекста, а `resolveFor`
уже принимает опциональные `guardCtx`/`deps.sod` — T-0068 НЕ меняет сигнатуру и НЕ строит
Postgres SoD-DAO (остаётся T-0053). **Новых таблиц нет** (006/007 уже существуют, уже в
known_tenant_tables) → нет новых миграций (AC-16/17 вакуумно зелёные).

---

## 3. Отвергнутые альтернативы

| Альтернатива | Почему нет |
|---|---|
| **Параллельный input-тип writer-а (свой `AuditRowInput`)** вместо `AuditEventInput` T-0031 | Развилка стока: grant-trail (T-0031/T-0030) и lifecycle потекли бы через разные формы → два preimage-пути, риск рассинхрона vocab. Запинено: единый канонический путь. `AuditEventInput` (T-0031) уже точно отражает писательские колонки `audit_event` (chain-колонки отсутствуют — их считает writer). Переиспользуем как контракт. |
| **Writer пишет в собственной транзакции (открывает BEGIN внутри)** | Ломает атомарность с бизнес-эффектом вызывающего (T-0016 FR-4: append+head+бизнес-факт в ОДНОЙ tx, ROLLBACK откатывает всё). Writer обязан работать в tx вызывающего (`enqueueInTx`-паттерн T-0062: принимает `client`/`tx`, не `pool`). |
| **Глобальный SEQUENCE / `bigserial` / константный advisory-lock для `seq`** | T-0016 NF-2 / AC-4: per-tenant сериализация только через `audit_head ... FOR UPDATE`. Глобальный lock связал бы throughput всех тенантов в одну точку и сделал бы seq tenant-global. Запрещено fitness-линтом. |
| **Таблица-зеркало состояния инстанса (`process_instance`)** | CONCEPT §6: движок = чёрный ящик уровня Postgres, Choros не дублирует машину состояний Flowable. `instance_id` — опаковый указатель в `subject`/`payload`, связь через существующий `job.idempotency_key`=externalTask.id (T-0067 reverse-map). Новая таблица = лишняя миграция + known_tenant_tables + нет пользы (§2.4 спеки). |
| **Новая колонка `actor_kind` в `employee`** | FR-2/§7: ось различения уже есть (`employee.kind∈{human,agent}`). `service` — это `agent`-employee, действующий по каналу external-worker (`via`), не новая схема. Проекция `kind→{human,agent,service}` — правило в коде, не DDL. Изменение `employee`-схемы было бы скоуп-крипом и сломало бы T-0017-инварианты. |
| **`actorType` в неканоническом (не-hash-covered) поле (отдельная колонка вне preimage)** | AC-12: подмена типа актора должна детектироваться как tamper. `actorType` обязан входить в `payload` (который покрыт preimage) → recompute `row_hash` ловит подмену. Колонка вне preimage была бы tamper-невидима. |
| **Реализовать `verifyAuditChain` здесь же** | §5.3/forward-obligation: T-0068 строит writer, не верификатор (T-0053). T-0068 обязан лишь не нарушить verifier-инвариант (preimage детерминирован, chain dense) — это покрыто golden-digest fitness (AC-3). |
| **Живая инъекция Postgres SoD-DAO (`deps.sod`)** | §2.3: Postgres SoD-DAO = T-0053 («until T-0053 lands, deps.sod is never injected in production»). lifecycle-аудит НЕ зависит от активности SoD-гейта (аудит пишется по факту доставки независимо от SoD-решения). T-0068 оставляет шов готовым (опциональный параметр), не строит DAO. |
| **`instance.completed`/`instance.cancel` аудит** | §5.1: REST T-0064 (`FlowableClient`) их не отдаёт (нет cancel/history/query). Выдумывать события, которых движок не отдаёт — нечестно. Forward-obligation E6.4 / расширение T-0064. |

---

## 4. Объектная модель и контракты (источник правды для coder/tester)

### 4.1 `AuditEventInput` (импортируется из T-0031, НЕ переопределяется)

Writer принимает форму T-0031 `src/core/audit-grant-encoder.ts` (chain-колонки отсутствуют —
их считает writer):

```ts
export type AuditEventInput = {
  id: string;                 // stable UUID; caller/encoder-minted
  type: string;               // 'instance.started' | 'task.completed' | 'task.failed' | 'grant.create' | …
  actor: string;              // slug employee | worker-id (bridge/service)
  subject: string | null;     // affected ref; для lifecycle = processInstanceId
  scope: unknown | null;      // ScopeElement | null; JCS — забота preimage
  via: string | null;         // канал: 'engine' | 'external-worker' | 'user-task'
  proposed_by: string | null;
  confirmed_by: string | null;
  payload: unknown;           // plain JSON; ДЛЯ lifecycle несёт actorType (hash-covered)
  occurred_at: number;        // epoch-ms (bigint как TS number, safe < 2^53)
};
```

> Контракт совместимости (FE-W23-0008): `AuditEventInput` экспортируется из
> `src/core/audit-grant-encoder.ts` и потребляется T-0031-тестами (мок `appendAuditEvent`),
> а скоро — T-0030 (`writeGrantAuditEvent`). T-0068 **НЕ меняет** этот тип и НЕ перемещает
> модуль. Writer импортирует тип отсюда. Если coder сочтёт нужным вынести `AuditEventInput`
> в общий seam-модуль — обязан сохранить re-export из `audit-grant-encoder.ts` (импортёры:
> T-0031 тесты, T-0030 grants.ts при мерже).

### 4.2 `AuditWriter` порт (новый, `src/db/audit-writer.ts`)

```ts
export interface AppendedAuditEvent { seq: number; rowHash: Buffer; }

// tx — клиент в открытой транзакции вызывающего, уже под withTenant (choros.tenant_id GUC set).
// Writer НЕ открывает/коммитит транзакцию (enqueueInTx-паттерн T-0062).
export interface AuditWriter {
  appendAuditEvent(tx: PgClientLike, input: AuditEventInput): Promise<AppendedAuditEvent>;
}

export function makePgAuditWriter(): AuditWriter;          // production (Postgres)
export class InMemoryAuditWriter implements AuditWriter {  // static-now тесты (чейн в памяти)
  // per-tenant in-memory head; те же seq/prev_hash/row_hash-инварианты, тот же preimage.
  rows(tenantId: string): ReadonlyArray<AuditRowSnapshot>;  // для assertions
}
```

`PgClientLike` = минимальный интерфейс `{ query(sql, params?): Promise<{ rows: any[] }> }`
(совместим с `pg.PoolClient`; не тянет тип всего пула — зона coder).

**Алгоритм `appendAuditEvent` (Postgres, T-0016 §4.4):**

1. `SELECT seq, row_hash, vocab_version FROM choros.audit_head WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid FOR UPDATE` — per-tenant lock (НЕ глобальный).
2. Если head нет: `seq=GENESIS_SEQ=1`, `prev_hash=GENESIS_PREV_HASH` (32 нулевых байта). Иначе `seq=head.seq+1`, `prev_hash=head.row_hash`.
3. `preimage = canonicalPreimage({ tenant_id, seq, id, type, actor, subject, scope, via, proposed_by, confirmed_by, payload, occurred_at, prev_hash, vocab_version: 1 })`; `row_hash = sha256(preimage)`.
4. **В ОДНОЙ tx:** `INSERT INTO choros.audit_event (...) VALUES (...)` (только INSERT) + advance head:
   - первый раз: `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version) VALUES (...)`;
   - далее: `UPDATE choros.audit_head SET seq=$seq, row_hash=$rowHash, updated_at=$now, vocab_version=1 WHERE tenant_id=...` (trigger 007 форсит `NEW.seq=OLD.seq+1`).
5. Вернуть `{ seq, rowHash }`. ROLLBACK вызывающего откатывает обе записи (NF-3/AC-5).

> Замечание о genesis-инициализации head: миграции 006/007 не сидят head-строку. Первый append
> тенанта `INSERT`-ит head (seq=1). Это согласуется с trigger 007 (advance-trigger на UPDATE; первый
> INSERT его не трогает) и grant choros_app (SELECT,INSERT,UPDATE на audit_head). **Concurrency-нюанс
> (для coder, AC-4):** два конкурентных первых-append одного тенанта оба не находят head и оба пытаются
> INSERT — второй упрётся в PK `(tenant_id)` (serialization). Writer ловит unique-violation на head-INSERT
> и **повторяет шаг 1** (теперь head существует → FOR UPDATE сериализует). Это даёт N плотных seq без
> дубля/пропуска. Альтернатива — `INSERT ... ON CONFLICT (tenant_id) DO NOTHING` seed-строки head с
> `seq=GENESIS_SEQ-1=0` в начале, затем всегда FOR UPDATE+UPDATE-advance; coder выбирает, инвариант —
> «N конкурентных append → N плотных различных seq» (AC-4 live-DB).

### 4.3 Canonical preimage (vocab_version = 1) — пере-пиннено как источник правды

Модуль `src/core/audit-preimage.ts`, чистый, zero-dep (`node:crypto`). `canonicalPreimage(row): Buffer`.

**Field set & order (точно, в этом порядке):** `tenant_id`, `seq`, `id`, `type`, `actor`, `subject`,
`scope`, `via`, `proposed_by`, `confirmed_by`, `payload`, `occurred_at`, `prev_hash`, `vocab_version`.
(`row_hash` — выход, не часть своего preimage.)

**Encoding (каждое поле length-prefixed, длина = 4-байтовый big-endian uint32 числа байт значения,
затем сами байты; конкатенация в порядке выше):**

- `uuid` (`tenant_id`, `id`): 16 raw байт (canonical big-endian, парсинг из dashed-формы). Длина-префикс = 16.
- `bigint` (`seq`, `occurred_at`): 8 байт big-endian (signed two's-complement / для неотрицательных = unsigned). Длина-префикс = 8.
- `smallint` (`vocab_version`): 2 байта big-endian. Длина-префикс = 2.
- `text` (`type`, `actor`, `subject`, `via`, `proposed_by`, `confirmed_by`): UTF-8 байты, length-prefixed. **NULL** кодируется length-префиксом-сентинелом `0xFFFFFFFF` (и ноль байт значения) — отличим от empty string (length=0, ноль байт). NULL≠"".
- `jsonb` (`scope`, `payload`): RFC 8785 / JCS-канонизация (лексикографический порядок ключей рекурсивно, без незначимого whitespace, канонический числовой вид), затем UTF-8 байты, length-prefixed. **NULL** (для `scope`) — тот же сентинел `0xFFFFFFFF`.
- `bytea` (`prev_hash`): raw байты, length-prefixed (всегда 32 для chain).

**Hash:** `row_hash = SHA-256(preimage)` (32 байта). `GENESIS_PREV_HASH` = `Buffer.alloc(32, 0)`;
`GENESIS_SEQ = 1`. Все три (preimage-правила, H=SHA-256, genesis-константы) — часть `vocab_version=1`.

**JCS-профиль (пиннится здесь, coder реализует zero-dep):** ключи объектов сортируются по UTF-16
code-unit (лексикографически по строке ключа); строки — JSON-escape по RFC 8785; числа — кратчайший
roundtrip-вид (целые без `.0`, без экспоненты где возможно по 8785); булевы/null — литералы; массивы —
порядок сохранён; без пробелов. Choros lifecycle `payload`/`scope` содержат только string/number/bool/null/
вложенные object/array (no Date, no bigint в JSON) — coder обязан отклонить иные типы как ошибку энкодинга.

**Vocab-pin:** любое изменение field-set/порядка/кодировки/H/genesis ⇒ bump `vocab_version` ⇒
golden-digest флипает ⇒ CI красный (AC-3 / FF-3). Golden-digest зафиксирован как unit-фикстура
(см. FF-3): фиксированная строка-row → известный hex-digest.

### 4.4 `LifecycleEvent` → `AuditEventInput` маппер (`src/core/lifecycle-audit.ts`, чистый)

По образцу `audit-grant-encoder.ts` (чистый, IO-free, no pg/http/fetch import).

```ts
export type ActorType = "human" | "agent" | "service";

export type LifecycleAuditInput =
  | { kind: "instance.started"; instanceId: string; processKey: string;
      actor: string; actorType: ActorType; via?: string | null }
  | { kind: "task.completed";  instanceId: string | null; jobId: string;
      actor: string; actorType: ActorType; via?: string | null; detail?: Record<string, unknown> }
  | { kind: "task.failed";     instanceId: string | null; jobId: string;
      actor: string; actorType: ActorType; via?: string | null; errorMessage?: string };

// nowMs/idOverride — как в encodeGrantAuditEvent (Date.now() на call-site; idOverride для тестов).
export function encodeLifecycleAuditEvent(e: LifecycleAuditInput, nowMs: number, idOverride?: string): AuditEventInput;
```

**Маппинг:** `type=e.kind`; `subject=instanceId` (для started — processInstanceId; для task.* —
instanceId-если-известен, иначе null); `actor=e.actor`; `via=e.via ?? канал-по-умолчанию`
(`'engine'` для started, `'external-worker'` для task.*); `payload` несёт **`actorType`** (hash-covered),
`instanceId`, `aggregateId`/`jobId` (T-0067 reverse-map ref), `processKey`/`errorMessage` по типу.
`scope=null`, `proposed_by/confirmed_by=null` (lifecycle — не grant/approve-поток).

### 4.5 Actor-type projection (FR-2 / §7), правило `employee.kind → actorType`

```ts
// Чистая проекция. Ось — employee.kind (016, {human,agent}). 'service' = канал, не kind.
export function projectActorType(kind: "human" | "agent", channel: "engine" | "external-worker" | "user-task" | "service"): ActorType {
  if (kind === "human") return "human";
  // kind === "agent": agent-runtime → 'agent'; bridge/external-worker/системный → 'service'.
  return channel === "external-worker" || channel === "service" ? "service" : "agent";
}
```

- `human` ⟸ `kind='human'`.
- `agent` ⟸ `kind='agent'` под каналом agent-runtime/user-task.
- `service` ⟸ `kind='agent'` под каналом external-worker (`s-ledger`/`s-ocr`/`control-plane`).
- Множество значений `{human,agent,service}` ровно совпадает с `AuditEvent.type` в `src/http/audit.ts` (FF-13/AC-13). **Схема `employee` не меняется** (kind остаётся `{human,agent}`).

`employeeKindLookup` (для `auditOnDispatched`): порт `(tenantId, actorId) => Promise<"human"|"agent">`
(в production — выборка `employee.kind` по slug/uuid; static-now — фейк-мапа в тесте). Канал
известен из контекста шва (external-worker для bridge → `service` для `kind='agent'`).

### 4.6 `auditOnDispatched` фабрика (мост T-0067 шва, `src/core/lifecycle-audit.ts` или `src/server/lifecycle-bridge.ts`)

```ts
// Возвращает OnDispatched (T-0067: (row: OutboxRow) => Promise<void>), зовётся ТОЛЬКО после
// durable markDispatched (if(advanced) — outboxDispatcher.ts:91). Exactly-once → дубля нет.
export function makeAuditOnDispatched(deps: {
  writer: AuditWriter;
  withTenantTx: <T>(tenantId: string, fn: (tx: PgClientLike) => Promise<T>) => Promise<T>;
  resolveActor: (row: OutboxRow) => Promise<{ actor: string; actorType: ActorType }>;
  now?: () => number;
}): OnDispatched;
```

Поведение: `switch(row.eventType)` — `task_completed`→`task.completed`, `task_failed`→`task.failed`
(энкод через `encodeLifecycleAuditEvent`, `instanceId` через T-0067 reverse-map из `row.aggregateId`,
затем `withTenantTx(row.tenantId, tx => writer.appendAuditEvent(tx, input))` — ровно один append);
`worker_lock_expired` и `default` → **return (no-op, 0 append)**. `resolveActor` извлекает
actor/actorType (через `employeeKindLookup` + канал external-worker).

### 4.7 `GuardContext`-шов (FR-7, аддитивно, БЕЗ Postgres SoD-DAO)

`resolveFor(deps, handle, subject, op, invokeCtx?, guardCtx?)` (grant-resolver.ts:451) **уже**
принимает опциональные `guardCtx` и `deps.sod` — T-0068 **НЕ меняет сигнатуру**. T-0068 добавляет
чистую `buildLifecycleGuardCtx(ctx): GuardContext` (actor, onBehalfOf, roleAtEvent, verb='transition'|'approve',
approveLevel?) для approve/transition-шва. Без `deps.sod` поведение = pre-T-0032 (fail-open-by-absence;
grant-only решение). Живой Postgres SoD-DAO — НЕ скоуп (§2.3, T-0053).

### 4.8 Server-wiring (FR-8, `src/server/lifecycle-bridge.ts` + hook в `index.ts`)

```ts
export interface LifecycleBridgeHandle { stop: () => void; }
// Читает env (FLOWABLE_BASE_URL и пр.). Если конфига нет — возвращает no-op handle (degraded,
// no-throw). Если есть — makeFlowableClient + startBridgePollLoop({..., onDispatched: makeAuditOnDispatched(...)}).
export function startLifecycleBridge(deps: {...}, env?: NodeJS.ProcessEnv): LifecycleBridgeHandle;
```

Вызывается из `index.ts` main-блока (`thisFile === mainFile`), РЯДОМ с `createServer().listen()`,
НЕ внутри `createServer` (чтобы тесты, импортирующие server, не стартовали loop — паттерн lockReclaimer).
Без `FLOWABLE_BASE_URL` сервер стартует, bridge деградирован (loop не крутится / poll-ошибки глотаются —
T-0067 AC-13/14). `startInstance`-аудит: тонкая обёртка на call-site старта инстанса (где сервер зовёт
`flowableClient.startInstance`) — при `ok:true` энкодит `instance.started` (instanceId=`result.instanceId`)
и аппендит в tenant-tx. (NB: REST-эндпоинт старта инстанса — отдельный шов; T-0068 проводит аудит-обёртку,
сам HTTP-route — там, где он есть/появится; для AC-7 достаточно unit с in-memory writer + прямой вызов обёртки.)

### 4.9 Миграции / таблицы

**Новых таблиц нет.** Writer использует существующие 006/007 (уже в `known_tenant_tables.txt`).
**Новых миграций нет** → AC-16 вакуумно зелёный (если coder всё же заведёт миграцию — номер ≥ 031,
030 занята T-0030, идемпотентна x2). AC-17 вакуумно зелёный (нет новой таблицы). Триггеры 006/007 НЕ
трогаются (NF-6/AC-6). Grant choros_app (SELECT,INSERT на audit_event; SELECT,INSERT,UPDATE на audit_head)
покрывает writer (INSERT event + INSERT/UPDATE head) — изменений DDL не требуется.

---

## 5. Границы слоёв (что fitness защищает)

- `src/core/audit-preimage.ts`, `src/core/lifecycle-audit.ts` — **чистые** (no pg/http/https/net/fetch/child_process import); IO-free; по образцу `audit-grant-encoder.ts`.
- `src/db/audit-writer.ts` — **единственный** модуль, делающий SQL на `audit_event`/`audit_head` (кроме миграций). Writer = единственный санкционированный путь записи (T-0016 §4.4).
- `AuditEventInput` импортируется из `src/core/audit-grant-encoder.ts` (T-0031) — не дублируется.
- Background-loop wiring — только в `index.ts` main-блоке / `src/server/lifecycle-bridge.ts`, НЕ в `createServer` (тесты не должны стартовать loop).

---

## 6. Fitness-функции (машинно-проверяемые границы для CI)

> Все `ci/checks/*.sh` после написания добавляются coder-ом в `package.json` script `fitness`
> (как сделано для `audit_append_only.sh` и т.п.). Без регистрации в `fitness` линт не поедет в CI.

| ID | Правило (нарушаемая граница) | CI-проверка |
|---|---|---|
| **FF-1** (AC-1/2/5) | Writer пишет genesis-якорь (seq=1, prev=32×0x00) и плотную +1 цепь (prev_hash[n]=row_hash[n-1]); append+head атомарны (ROLLBACK откатывает обе). | `vitest run` (live-DB: `ci/checks/db/audit-writer.chain.test.ts`) — isolated Postgres; gated `fitness:db`. |
| **FF-2** (AC-4 static) | Writer НЕ использует глобальный SEQUENCE/`bigserial`/`nextval`/константный `pg_advisory_lock` для audit seq; использует `audit_head ... FOR UPDATE` per tenant. | новый `ci/checks/audit_no_global_seq.sh` (образец `actor_event_no_global_seq.sh`): grep по `src/db/audit-writer.ts` — присутствует `FOR UPDATE` на audit_head, отсутствуют `pg_advisory.*\([0-9]`, `nextval`, `CREATE SEQUENCE.*audit`. |
| **FF-2b** (AC-4 live) | N конкурентных append в тенант-A → N плотных различных seq (нет дубля/пропуска); append в A и B не блокируют друг друга. | `vitest run` live-DB concurrency-тест (`fitness:db`). |
| **FF-3** (AC-3) | `canonicalPreimage` детерминирован, length-unambiguous (NULL≠""; переставленные ключи jsonb → идентичный preimage через JCS), `SHA256(preimage)==pinned golden hex digest (vocab=1)`. Изменение поля/порядка/кодировки флипает golden → красный. | `vitest run` unit (`src/__tests__/audit-preimage.test.ts`): golden-digest assertion + permuted-keys-equal + null-vs-empty-differs. (TS golden, образец T-0032 vocab-pin на тест-уровне.) |
| **FF-4** (AC-6) | `audit_append_only.sh` (T-0016) остаётся зелёным: writer не добавляет GRANT UPDATE/DELETE и не делает UPDATE/DELETE на audit_event; триггеры 006/007 не тронуты. | существующий `ci/checks/audit_append_only.sh` (без изменений) + новый grep-линт: `src/db/audit-writer.ts` не содержит `UPDATE choros.audit_event`/`DELETE FROM choros.audit_event`. |
| **FF-5** (AC-8/9/10) | `auditOnDispatched(task_completed/task_failed)` → ровно 1 append с instance/job-указателем; `worker_lock_expired`/unknown → 0 append; повторный dispatcher-проход (already dispatched) → 0 доп. append (exactly-once via T-0067 `if(advanced)`). | `vitest run` unit (`src/__tests__/lifecycle-audit.test.ts`) с `InMemoryAuditWriter` + spy на append-count + прогон `outboxDispatcher` дважды. |
| **FF-6** (AC-7) | Успешный `startInstance` → ровно 1 append `type='instance.started'`, subject=processInstanceId, payload.instanceId=processInstanceId. | `vitest run` unit (in-memory writer + обёртка). |
| **FF-7** (AC-11/12) | human/agent/service различимы в `payload.actorType`; изменение `payload.actorType` в фикстуре меняет recomputed `row_hash` (hash-covered, tamper-detectable). | `vitest run` unit: проекция `kind→actorType` (3 значения) + recompute-hash-differs при подмене actorType. |
| **FF-8** (AC-13) | Проекция `kind→actorType` даёт значения ровно из множества `AuditEvent.type` (`'human'\|'agent'\|'service'`) в `src/http/audit.ts`; схема employee не меняется (kind остаётся `{human,agent}`). | новый `ci/checks/audit_actor_type_set.sh`: grep — union типов `projectActorType` ⊆ {human,agent,service}; `src/http/audit.ts` содержит ту же тройку; миграция 016 CHECK остаётся `('human','agent')`. |
| **FF-9** (AC-14, NF-5) | Композиционный корень регистрирует `startBridgePollLoop` с `onDispatched=auditOnDispatched` и lifecycle-аудит на startInstance; без `FLOWABLE_BASE_URL` сервер стартует (loop no-throw, poll-ошибки глотаются), `createServer`/импорт server НЕ стартует loop. | `vitest run` unit (`src/__tests__/lifecycle-bridge.test.ts`): `startLifecycleBridge({}, {})` без env → no-throw, `stop()` идемпотентен; grep-линт: `createServer` body не зовёт `startBridgePollLoop`. |
| **FF-10** (AC-15) | `resolveFor` с `guardCtx` но без `deps.sod` → решение идентично pre-T-0032 (нет `sod_violation`); сигнатура `resolveFor` не изменена. | `vitest run` unit (resolveFor с guardCtx, без sod → grant-only) + grep-линт: сигнатура `resolveFor(deps, handle, subject, op, invokeCtx?, guardCtx?)` не тронута. |
| **FF-11** (слой) | `audit-preimage.ts` и `lifecycle-audit.ts` чистые (no `from "pg"`/http/https/net/child_process/fetch); writer — единственный модуль с SQL на audit_event/audit_head (вне миграций). | новый `ci/checks/audit_writer_isolation.sh` (образец `grant-resolver-isolation.sh`): grep по импортам core-модулей + grep `audit_event`/`audit_head` SQL только в `src/db/audit-writer.ts` и `migrations/`. |
| **FF-12** (AC-16/17, контракт совместимости) | Нет новых таблиц/миграций (вакуумно); если появятся — миграция ≥031 идемпотентна, таблица в `known_tenant_tables.txt` + cross_tenant case. `AuditEventInput` остаётся экспортирован из `audit-grant-encoder.ts` (импортёры T-0031/T-0030). | существующий `ci/checks/cross-tenant-fitness.sh` + grep-линт: `export type AuditEventInput` присутствует в `src/core/audit-grant-encoder.ts`. |

---

## 7. Трассировка AC → дизайн

| AC | Покрыто |
|---|---|
| AC-1 (genesis-якорь) | §4.2 алгоритм шаг 2/4; FF-1 (live-DB). |
| AC-2 (плотная цепь) | §4.2 шаг 2-4; FF-1. |
| AC-3 (preimage детерминирован + golden) | §4.3 (пере-пиннен preimage+JCS+vocab); FF-3. |
| AC-4 (per-tenant сериализация) | §4.2 шаг 1 + concurrency-нюанс; FF-2 (static) + FF-2b (live). |
| AC-5 (атомарность ROLLBACK) | §4.2 шаг 4 (одна tx вызывающего); FF-1. |
| AC-6 (append-only) | §4.9 (триггеры/grant не тронуты); FF-4. |
| AC-7 (instance.started → 1 строка) | §4.4/§4.8 обёртка startInstance; FF-6. |
| AC-8 (task.completed/failed → 1 строка) | §4.6 `auditOnDispatched`; FF-5. |
| AC-9 (worker_lock_expired → 0) | §4.6 no-op branch; FF-5. |
| AC-10 (exactly-once) | §4.6 опора на T-0067 `if(advanced)`; FF-5 (двойной прогон). |
| AC-11 (human/agent/service) | §4.5 `projectActorType`; FF-7. |
| AC-12 (actorType hash-covered) | §4.4 (actorType в payload) + §4.3 (payload в preimage); FF-7. |
| AC-13 (read-API совместимость) | §4.5 (множество = `audit.ts` type); FF-8. |
| AC-14 (server-wiring degraded) | §4.8 `startLifecycleBridge`; FF-9. |
| AC-15 (GuardContext аддитивен) | §4.7 (сигнатура не тронута, fail-open без sod); FF-10. |
| AC-16 (миграции ≥031 / вакуум) | §4.9 (нет новых миграций); FF-12. |
| AC-17 (новая таблица tenant-table / вакуум) | §4.9 (нет новой таблицы); FF-12. |

---

## 8. Runtime / deploy-таргет

**Контейнер/сервер (как весь Choros, T-0053 single-Postgres substrate).** Writer и lifecycle-аудит
исполняются в Node-процессе Choros рядом с движком Flowable и Postgres. Static-now (unit + grep-линты)
гейтят в `npm run ci` сегодня без БД; live-DB пробы (FF-1/FF-2b) — против isolated Postgres (`fitness:db`),
гейтятся при наличии БД (паттерн T-0013/T-0016/T-0032). **Внешний ресурс не требуется** (таблицы 006/007
уже есть; новых нет). Provision/deploy — существующий гейт фаундера (GT-4), не меняется T-0068.

---

## 9. Forward-obligations (downstream)

| Задача | Обязательство |
|---|---|
| **T-0053** | Postgres SoD-DAO для живой `deps.sod`-инъекции в проведённый T-0068 шов; `verifyAuditChain` реализация + CI-probe (читает chain, пере-вычисляет preimage по vocab — T-0068 оставляет preimage детерминированным/dense); head-snapshot job. |
| **расширение T-0064 / E6.4** | `cancelInstance` + instance-query/history-listener → аудит `instance.cancel`/`instance.completed` (вне T-0068, §5.1). |
| **E7.3 / UI** | замена seed-fixture в `src/http/audit.ts` на live-выборку из `audit_event` (T-0068 пишет флор; чтение в UI — отдельный шов). |
| **T-0030 (мержится)** | при мерже `grants.ts` `writeGrantAuditEvent` должен звать T-0068 `appendAuditEvent` (единый сток) — контракт `AuditEventInput` совместим (§4.1); coder T-0068 не трогает grants.ts, но writer готов его принять. |

---

## 10. Заметки для coder

- **НЕ переопределяй `AuditEventInput`** — импортируй из `src/core/audit-grant-encoder.ts`. Сохрани его export (контракт T-0031/T-0030).
- Writer работает в tx вызывающего (`PgClientLike`), НЕ открывает BEGIN/COMMIT сам.
- `InMemoryAuditWriter` обязан считать тот же preimage/row_hash, что Postgres-путь (один `canonicalPreimage`-модуль) — иначе static-now тесты разойдутся с live-DB.
- Golden-digest (FF-3): зафиксируй фикстуру-row + hex-digest как константу в тесте; любой дрейф энкодинга = красный → форсит bump vocab_version.
- Зарегистрируй новые `ci/checks/*.sh` в `package.json` → `fitness` (иначе не поедут в CI).
- Канал external-worker → `actorType='service'` для `kind='agent'`; agent-runtime → `'agent'`. Не заводи колонку в employee.
- Concurrency genesis-head (§4.2): реализуй ИЛИ retry-on-unique ИЛИ seed-head `ON CONFLICT DO NOTHING (seq=0)`; инвариант — N плотных seq (AC-4).
