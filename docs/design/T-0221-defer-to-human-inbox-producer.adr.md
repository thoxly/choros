# ADR · T-0221 — `defer-to-human` → задача инбокса с причиной сомнения (B-2 impl), под ratified no-new-table

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-18 · **Supersedes:** этот же ADR от 2026-06-16
(который вводил `choros.user_task` / миграцию 073) — **отменён** founder-ratified-решением **D-061 (2026-06-17)**.
**Spec:** секция **B / B.5** плейбука `v1-demo-and-trust-surface` (воспроизведена в теле T-0220).
**Design contract (НЕ противоречить):** `docs/design/T-0220-agent-step-outcomes.adr.md` — §5.1 (двойной гейт),
§6.2 (`defer`→обычная задача инбокса), **AC-5** (defer материализует видимую человеком задачу инбокса с непустым
`doubt_reason`), **AC-6** (defer НЕ вводит новый тип задачи — это обычный пул-task).

> ## ⚠ RATIFIED GOVERNANCE CONSTRAINT — НЕ ОБСУЖДАЕТСЯ (D-061, 2026-06-17)
> **НИКАКОЙ новой таблицы БД для T-0221.** Предыдущая версия этого ADR ввела `choros.user_task` (миграция 073).
> Фаундер ратифицировал «no new table» на следующий день и **прямо назвал развилку «новая таблица vs
> переиспользование» той, что НИКОГДА не должна была дойти до него**. Это решение СВЯЗЫВАЕТ. Re-эскалация
> запрещена (D-061 чинил ровно эту утечку). Система решает **внутри** ограничения; дизайн подгоняется под него,
> а не воюет с ним. Никакого founder-gate, никакого founder-вопроса в этом ADR быть НЕ может.

**Mechanism foundation (построено, проверено по коду 2026-06-18):**
- `src/core/agent-precheck-motor.ts` — `classifyOutcome()` (PURE, INV-DEFAULT, приоритет fail-closed>defer>proceed;
  двойной триггер `thresholdFailed` ИЛИ `modelConfidence < CONFIDENCE_FLOOR`). **Уже есть, НЕ трогаем.**
- `src/runtime/legal-precheck/run-precheck.ts` — оркестратор; ТРИ defer-ветки (missing-instruction :260,
  dormant :316, tentative-defer :387) уже пишут `agent.deferred` через единственный `appendAuditEvent` с
  `doubt_reason` под caller-tx. **Уже есть.**
- `src/db/audit-writer.ts` — единственный санкционированный writer аудита (`appendAuditEvent`, под caller-tx с
  `SET LOCAL choros.tenant_id`; append-only по триггеру 007, FORCE RLS). **Уже есть.**
- `src/db/audit-grant-trail.ts` — **прецедент read-проекции аудита**: читает `audit_event` строки
  `WHERE type IN (...)` под tenant-RLS и проектирует их на wire-shape для UI (grant-trail). НЕ создаёт таблиц,
  `known_tenant_tables.txt` не трогает. **Это шаблон, по которому строится defer-read-DAO (§5.4).**
- `src/http/inbox.ts` — E7 display-surface **на in-memory `INBOX_SEED`** (claim/SLA/role-addressing/tabs), НЕ DB;
  комментарий :26 «A real implementation would write to a DB user_task_claim table».
- `migrations/006_audit_event.sql` — `type text NOT NULL` **БЕЗ CHECK** (open-vocab); `payload jsonb NOT NULL`
  hash-покрыт; ENABLE+FORCE RLS, ОДИН predicate; append-only enforced (GRANT без UPDATE/DELETE + триггеры).

> Это ADR для **impl-задачи** (B-2) под HARD-ограничением «no new table». Он пересматривает выбор предыдущей
> версии (новая таблица) — **ограничение изменило взвешивание отвергнутых ранее альтернатив** — и фиксирует
> честный объём: что carries defer-состояние на СУЩЕСТВУЮЩЕМ носителе, и что осознанно сдвигается в E7.
> Гейтинг каждой FF помечен: **static-now** (бежит в сегодняшнем `npm run ci`: tsc/eslint/vitest + `ci/checks/*.sh`)
> / **live-DB** (проба Postgres в `fitness:db`, порт 55432).

---

## 1. Контекст: что построено, что carries defer сегодня, и где ИСТИННЫЙ разрыв

T-0233 построил живой мотор и оркестратор. Исход `defer-to-human` **сегодня** материализуется в audit-floor:
`run-precheck.ts` пишет строку `audit_event` `type='agent.deferred'` с `payload.doubt_reason`/`signal`/
`reasoning_trace_ref` через единственный `appendAuditEvent`, под caller-tx с активным RLS. `inboxTaskRef` в
`PrecheckOutcome.defer-to-human` = **id этого audit-события** (`run-precheck.ts:274,329,401`).

**Ключевой факт (verify-by-code):** `choros.audit_event` — это **существующая, tenant-изолированная (FORCE RLS,
ОДИН predicate), переживающая рестарт, append-only** таблица. Строка `agent.deferred` в ней **НЕ теряется**,
**НЕ видна чужому тенанту**, и **видна из другого процесса/пода** (это БД, не in-memory `Map`). То есть гарантия
**«defer не потерян + tenant-isolated + durable»** УЖЕ достигается существующим носителем, без новой таблицы.

Чего audit-floor структурно **не** даёт — это **изменяемое claim/SLA-lifecycle-состояние** (claimed_by/claimed_at
как UPDATE, переход waiting→claimed→done): аудит append-only по жёсткому триггеру 007, UPDATE на нём запрещён для
ВСЕХ ролей. Поэтому **claimable mutable-SLA очередь** на audit-floor невыразима — и это единственная часть AC-5,
которая требует mutable persistent state.

**Истинный разрыв (точно):** не «defer теряется» (он не теряется), а:
(a) `agent.deferred.payload` НЕ несёт `inbox_task_id` ссылки — `inboxTaskRef` = id самого же audit-события
(self-reference): AC-5-формулировка «agent.deferred ссылается на id задачи» сегодня неточна;
(b) defer-событие **не спроецировано в человеко-видимую очередь** `/api/inbox` — мотор пишет в audit, но инбокс
читает только `INBOX_SEED`, так что человек defer-задачу в своём списке **не видит** (хотя строка в БД есть);
(c) `inboxTaskRef` JSDoc уже честно называет audit-id «canonical day-1 DB-backed record … audit-floor IS the
seam» — то есть предыдущая no-new-table-интерпретация (audit-floor как носитель) была **исходным** дизайном
T-0233, и именно его восстанавливает D-061.

Разрешение (a)+(b) **не требует** новой таблицы: проекция audit→inbox-view — это read-DAO по образцу
`audit-grant-trail.ts`. Mutable claim — отдельная мощность, осознанно сдвигаемая в E7 (§3.3, §6).

---

## 2. Решение (один абзац)

Под ratified no-new-table **носителем defer-состояния остаётся существующая `choros.audit_event`** (строка
`type='agent.deferred'`), которая уже даёт durable + tenant-isolated + «не потеряно». T-0221 закрывает разрыв
**видимости человеком**, НЕ вводя таблицу: (1) `agent.deferred.payload` обогащается полем
`inbox_task_id` = `audit_event.id` той же строки (стабильный детерминированный self-id, минтится ДО append'а),
чтобы AC-5 back-link имел точный referent, а `PrecheckOutcome.defer-to-human.inboxTaskRef` нёс этот же id
(контракт типа — строка — сохранён); (2) добавляется **read-DAO** `listDeferredInboxTasks()` в новый
`src/db/deferred-inbox-store.ts` по образцу `audit-grant-trail.ts` — читает `audit_event WHERE
type='agent.deferred'` под tenant-RLS, проецирует на существующий **`InboxItem`-wire** (role/name/sla/exec_type/
`doubt_reason`); (3) `src/http/inbox.ts.findInboxItems()` при `hasDb()` **МЕРЖИТ** эти defer-проекции в свой
список **АДДИТИВНО** к `INBOX_SEED` (seed остаётся day-1 демо-данными), так что defer-задача появляется в
`/api/inbox` как **обычный пул-item** нужной роли с непустым `doubt_reason` — это и есть «видимая человеком
задача» (AC-5) той же формы, что любая пул-задача (AC-6). PURE-планировщик `src/core/defer-task-producer.ts`
(`planDeferTask`) строит `name`/`role`/`sla` из defer-исхода+контекста (static-now-тестируемо, как
`classifyOutcome`). **Адресация defer-ветки** (`deferRole`/`deferSlaMinutes?`) добавляется в `PrecheckArgs`, чтобы
проекция знала роль/SLA. **Claim mutable-state** (claimed_by/claimed_at как durable UPDATE, переход
waiting→claimed→done с SLA-таймерами) **на audit-floor невыразим** (append-only) — он **осознанно сдвигается в
E7** (T-0049), где появится правильный mutable носитель (это решает E7-ADR, не этот). Day-1 claim defer-задачи —
поверх существующего in-memory `CLAIMED` (`inbox.ts`, process-lifetime, как у seed-задач): для линейного ТЭЛ-демо
(один процесс) этого достаточно. Это `IN_ENVELOPE_BUILD_NOW`: ноль миграций, ноль новых таблиц, ноль
изменений `known_tenant_tables.txt`, ноль founder-gate; добавляется только payload-поле (open-vocab,
не DDL), read-DAO, тонкий мерж в инбокс и PURE-планировщик.

---

## 3. Крузовое решение: какой носитель carries defer? — СУЩЕСТВУЮЩИЙ audit-floor. Обоснование

### 3.1 Что audit-floor УЖЕ обеспечивает для AC-5 (re-judged под no-new-table)
| Свойство AC-5 | Носитель | Достигнуто day-1? |
|---|---|---|
| **не потеряно** (durable) | `audit_event` append-only, в Postgres | **ДА** — строка коммитится в caller-tx; рестарт переживает |
| **tenant-isolated** (152-ФЗ/NF-1) | `audit_event` FORCE RLS, ОДИН predicate `choros.tenant_id` | **ДА** — изоляция наследуется, без новой RLS-поверхности |
| **непустой `doubt_reason`** | `payload.doubt_reason` (мотор уже пишет) | **ДА** — INV planDeferTask: doubtReason всегда непуст |
| **видна человеком в очереди** | проекция audit→`/api/inbox` (read-DAO §5.4) | **ДА (новое в T-0221)** — мерж defer-проекций в инбокс |
| **back-link agent.deferred→задача** | `payload.inbox_task_id = audit_event.id` (self-id) | **ДА (новое в T-0221)** — точный referent |
| **claimable mutable очередь + SLA-таймеры** | требует mutable persistent state (UPDATE) | **НЕТ → E7** (audit append-only; §3.3) |

Вывод: **пять из шести** граней AC-5 достигаются на существующем носителе. Шестая (mutable claim) — единственная,
требующая mutable persistent state, и она честно сдвигается в E7.

### 3.2 Почему audit-floor — ПРАВИЛЬНЫЙ носитель, а не костыль (под ограничением)
Прецедент `audit-grant-trail.ts` уже доказывает: проекция `audit_event WHERE type IN (...)` в человеко-видимый
UI-список — это **штатный, не-хакерский паттерн** в этом коде (grant-trail так и работает). `agent.deferred` —
это governance-аудит (что агент засомневался), его место — `audit_event` (open-vocab), как и зафиксировал T-0220
§5.2. Делать из него человеко-видимую задачу = читать его проекцией, **ровно как grant-trail**. Никакого
смешения операционного и аудит-состояния НЕ происходит, **пока мы не пишем mutable claim в audit** (мы не пишем —
claim уходит в E7/seed-`CLAIMED`).

### 3.3 Почему claimable mutable-очередь — это E7, а не T-0221 (consequence ограничения, не дефект)
Полная AC-5 в строгой форме (claimable, с durable claimed_by/claimed_at и SLA-дедлайнами, переживающими рестарт)
**требует mutable persistent state**. Под ratified no-new-table его негде разместить durable:
- audit-floor — append-only (UPDATE запрещён триггером 007 → claim невыразим);
- ни одна существующая таблица семантически не подходит как human-task-pool (см. §3.4 строки E/F);
- `INBOX_SEED`/`CLAIMED` — in-memory (теряются при рестарте).

Следовательно **honest resolution = SCOPE-решение** (явно санкционированное брифом задачи §3): day-1 ship
audit-floor-backed гарантию **«не потеряно / видимо человеком с doubt_reason»**; **claimable mutable-SLA очередь
defer-задач → E7 (T-0049)**, где правильный mutable носитель проектируется как часть epic'а. Это **прямое
следствие ратифицированного ограничения**, НЕ повод заводить таблицу и НЕ повод re-эскалировать. Линейный
ТЭЛ-демо (приёмочный эталон MVP) — один процесс, claim поверх process-lifetime `CLAIMED` достаточен для показа;
durable claim не на критическом пути демо.

### 3.4 Взвешенные альтернативы (re-judged под ratified no-new-table)
| Опция | Вердикт под ограничением |
|---|---|
| **A. Новая таблица `choros.user_task` (предыдущая версия ADR / миграция 073)** | **ОТВЕРГНУТА ratified-решением D-061.** Founder прямо запретил новую таблицу и назвал развилку утечкой. Сверх ratified-запрета — **slot 073 уже занят** `073_vendor_crm_seed.sql` (highest на dev), т.е. план был ещё и технически устаревшим. Не обсуждается. |
| **B. audit-floor как носитель + проекция в инбокс (ВЫБРАНО)** | Durable+tenant-isolated+doubt_reason УЖЕ есть; видимость добавляется read-проекцией (прецедент `audit-grant-trail.ts`); ноль таблиц. Mutable claim → E7. **Честно и в рамках ограничения.** |
| **C. Промотировать defer на СУЩЕСТВУЮЩУЮ `choros.notification`** | `notification` несёт recipient_id (FK→employee), is_read, TTL — это **per-человек уведомление**, не **per-роль pool-task** с claim/SLA/doubt_reason. Семантически чужой носитель (адресация по человеку, не роли — ломает role-addressing T-0093). Притягивание defer туда исказило бы notification-модель. **Нет.** |
| **D. Промотировать на `choros.job`** | `job` = технический work-queue (topic/variables/lock_owner/state CHECK CREATED/LOCKED/COMPLETED/FAILED), консумится `jobStore`/external-worker'ами. Это **машинная** очередь job'ов, не **человеческая** задача инбокса (нет role/sla/doubt_reason/claimed_by-семантики человека). Перегрузка `job` человеческими задачами смешала бы две разные машины. **Нет.** |
| **E. Промотировать на `choros.actor_event`** | verb-set закрыт и vocab-pinned (T-0019), это SoD-факты, не очередь работы. **Нет** (уже отвергнуто T-0220 §5.4). |
| **F. In-memory `INBOX_SEED`/`CLAIMED` как носитель defer day-1** | Теряется при рестарте → «не потеряно» нарушено; не tenant-isolated в БД. Но как **claim-слой** (поверх durable audit-проекции) — приемлем day-1 для одно-процессного демо (§3.3). Как **носитель самой defer-записи** — нет (durable должен быть audit). |
| **G. Класть mutable claim прямо в `audit_event` (расширенный payload + UPDATE)** | UPDATE на audit запрещён триггером 007 (append-only NF-6). Структурно невозможно. **Нет.** |
| **H. Generic step-outcome producer для любого навыка сразу** | Over-reach scope (узость FF-COMP-6 рантайма). Producer тип-обобщён, но вызывается только из defer-веток legal-precheck (§5.5). **Нет (scope).** |

> **Триггер пересмотра (явно):** предыдущая версия ADR оценила «AC-5 недостижим без реального места, куда кладётся
> задача». Это **неверно в сильной форме**: durable place УЖЕ есть — `audit_event`. Под ratified-ограничением
> правильное взвешивание: durable+visible достигается без таблицы (B), а единственная по-настоящему
> table-требующая грань (mutable claim) **сдвигается в E7**, а не тащит за собой запрещённую таблицу.

---

## 4. Объектная модель — НИ ОДНОЙ новой таблицы. Существующие носители

**Носитель defer-записи:** `choros.audit_event`, строка `type='agent.deferred'` (миграция 006, без изменений DDL).

**Единственное изменение носителя — аддитивное поле в `payload` (open-vocab, НЕ DDL):**
`agent.deferred.payload` получает поле **`inbox_task_id: string`** = `audit_event.id` той же строки. id минтится
ДО append'а (`const taskId = randomUUID(); deferredAuditEvent(..., id: taskId, payload:{ inbox_task_id: taskId }
)`), так что back-link точен и self-consistent. `PrecheckOutcome.defer-to-human.inboxTaskRef` несёт этот же id
(уже несёт audit-id — семантика «id задачи == id defer-события» теперь явная, не stand-in). Прочие payload-поля
(`doubt_reason`,`signal`,`reasoning_trace_ref`) сохранены. **`audit_event.type` остаётся open-vocab — никакого
CHECK/колонки/таблицы (T-0220 AC-8).**

**Проекция defer-записи в инбокс-вид (read-only, новый DAO, без таблиц)** — мапит `audit_event`-строку на
существующий `InboxItem`-wire:

| `InboxItem` поле | Источник из `agent.deferred`-строки | Примечание |
|---|---|---|
| `id` | `audit_event.id` (== `payload.inbox_task_id`) | стабильный, для claim/dedup |
| `status` | `'waiting'` (константа day-1) | defer ждёт человека |
| `name` | `«Проверить: <doubt_reason>»` (planDeferTask, truncated) | человеко-читаемо |
| `step` | `scope.skill` (`'legal_precheck'`) | контекст шага |
| `inst` | `subject` (`agent:<id>`) или process-ref из scope | привязка к кейсу |
| `role` | `payload.defer_role` (новое, из `PrecheckArgs.deferRole`) | role-addressing T-0093 |
| `execType` | `'agent'` | источник = агент |
| `execName` | `actor` (employeeId агента) | кто засомневался |
| `pool` | `true` | claimable из пула (claim-слой §6) |
| `sla` | `payload.defer_sla_minutes`→`{min,left}` (новое) | из процесса/дефолт |
| `doubt_reason` | `payload.doubt_reason` | **additive optional** поле `InboxItem`, рендер «нужна проверка: …» |
| `tenant` (internal) | RLS-tenant строки | стрипается на wire (как seed) |

`role`/`defer_sla_minutes` приходят из новых необязательных полей `PrecheckArgs` (`deferRole`,
`deferSlaMinutes?`) и кладутся в `payload` defer-события. День-1 default `role` = адресат процесса/демо.

---

## 5. Контракты — PURE-планировщик + payload back-link + read-DAO

### 5.1 PURE-планировщик (static-now-тестируемый, как `classifyOutcome`)
```ts
// src/core/defer-task-producer.ts (PURE: no pg/http/env — план задачи, не запись)
export interface DeferTaskPlan {
  readonly role: string;          // кому адресовать (из PrecheckArgs.deferRole)
  readonly name: string;          // «Проверить: <doubtReason>» (truncated)
  readonly doubtReason: string;   // непустой (INV: AC-5) — тотально
  readonly execType: "agent";
  readonly execName: string;      // employeeId агента
  readonly slaMinutes?: number;
  readonly originOutcome: "defer";
}
/** Чистая трансформация defer-исхода+контекста в план. Тотальна; doubtReason всегда непуст. */
export function planDeferTask(
  outcome: Extract<PrecheckOutcome, { kind: "defer-to-human" }>,
  ctx: { readonly role: string; readonly agentEmployeeId: string; readonly slaMinutes?: number },
): DeferTaskPlan;
```
Юнит-golden: пустой/`"pending"` doubtReason → нормализуется в непустую строку; `name` детерминирован.

### 5.2 payload back-link в оркестраторе (НЕ новый writer — тот же `appendAuditEvent`)
`deferredAuditEvent(...)` расширяется: принимает `plan`, кладёт в `payload`
`{ doubt_reason, signal, reasoning_trace_ref, inbox_task_id: id, defer_role: plan.role,
defer_sla_minutes: plan.slaMinutes ?? null }`, где `id` — заранее минтнутый `audit_event.id`. Все ТРИ defer-ветки
(`run-precheck.ts` :260,:316,:387) обновляются единообразно. **Порядок (одна caller-tx, без новой записи в БД):**
1. `plan = planDeferTask(tentative, { role: args.deferRole, agentEmployeeId, slaMinutes: args.deferSlaMinutes })`.
2. `taskId = randomUUID()`.
3. `appendAuditEvent(tx, deferredAuditEvent(plan, taskId, ...))` — единственный sink, как сегодня.
4. `return { kind:"defer-to-human", inboxTaskRef: taskId, signal, doubtReason: plan.doubtReason }`.

Никакого второго writer'а, никакого второго INSERT-target'а: **писать остаётся ТОЛЬКО `appendAuditEvent`**
(сохраняет single-audit-sink инвариант run-precheck'а).

### 5.3 Read-DAO (новый файл, БЕЗ таблиц — образец `audit-grant-trail.ts`)
```ts
// src/db/deferred-inbox-store.ts — read-only проекция agent.deferred → InboxItem-wire.
// НЕ создаёт таблиц; НЕ трогает known_tenant_tables.txt; читает только audit_event.
export interface DeferredInboxRow {
  id: string; role: string; name: string; doubtReason: string;
  execName: string; slaMinutes: number | null; occurredAt: number; step: string; inst: string;
}
/** Читает audit_event WHERE type='agent.deferred' под tenant-RLS (внутри withTenant), мапит на wire. */
export async function listDeferredInboxTasks(
  pool: pg.Pool, tenantId: string, opts?: { limit?: number },
): Promise<DeferredInboxRow[]>;
```
Запрос — точная калька `queryGrantTrail`: `WHERE tenant_id=$1 AND type='agent.deferred'`, explicit tenant_id
(BYPASSRLS-safety, как T-0184), `ORDER BY occurred_at DESC LIMIT`, поля из `payload->>...`.

### 5.4 Мерж в инбокс (`src/http/inbox.ts.findInboxItems`, АДДИТИВНО)
При `hasDb()`: `const defers = await listDeferredInboxTasks(getOrgPool(), tenantId)` → мапятся в `InboxItem`
(§4-таблица, `pool:true`, `status:'waiting'`, `doubt_reason` проброшен) → **конкатенируются** с `INBOX_SEED`-
проекцией (seed = day-1 демо-данные, остаётся). При `!hasDb()` — только seed (как сейчас). **Wire-контракт
`/api/inbox` НЕ меняется** (те же поля/tabs/counts); `doubt_reason` — additive optional поле `InboxItem`. Tabs
(`pool`/`mine`/`esc`/`all`), counts, role-eligibility считаются над объединённым списком существующей логикой
без изменений. Claim defer-задачи идёт через существующий `POST /api/inbox/:id/claim` поверх in-memory `CLAIMED`
(§6) — той же ручкой, что seed-задачи; никакого нового эндпоинта.

> **Контракт совместимости (правило 7):** `_resetClaimStateForTests()`, `CLAIMED`, `INBOX_SEED` и их экспорты
> **сохраняются**; существующие e2e (`inbox-claim.e2e.test.ts`, 10 it-кейсов) гоняются на seed без БД и остаются
> зелёными (мерж defer-проекций активен только при `hasDb()`). `/api/inbox` поля не ломаются.

### 5.5 Generalization — НЕ в этой задаче (scope-guard)
`planDeferTask`/producer приняты тип-обобщённо (вход = defer-outcome + context), но **точка вызова** day-1 —
только defer-ветки `run-precheck.ts` (`legal_precheck`). Маршрутизация general step-outcomes за пределы
legal-precheck нарушила бы узость FF-COMP-6 рантайма и scope T-0221 — **отдельная будущая задача**.

---

## 6. Scope-boundary — `IN_ENVELOPE_BUILD_NOW`, БЕЗ founder-gate, БЕЗ founder-вопроса

**Это чистая impl-латитуда под ratified-ограничением. НИ founder-gate, НИ founder-вопроса здесь быть не может**
(D-061 закрыл утечку «table vs reuse» к фаундеру; решение принято — no new table — и реализуется).

1. **Ноль новой структуры БД.** Ни миграции, ни таблицы, ни колонки, ни записи в `known_tenant_tables.txt`,
   ни нового RLS-predicate. Только payload-поле (open-vocab, не DDL), read-DAO, мерж, PURE-планировщик. Нет
   нового внешнего ресурса/сервера/секрета/бюджета — все границы фаундера (D-060) не задеты.
2. **Authority НЕ трогается.** claim-eligibility = role-membership (как уже в `inbox.ts`), PDP (T-0021) не
   дублируется, grant-lattice/frozen-объекты не меняются. defer-проекция — операционная очередь чтения, не grant.
3. **Аддитивность.** Existing audit-floor дополняется одним payload-полем; инбокс мержит проекцию аддитивно;
   `!hasDb()` поведение и все существующие чеки/тесты не ломаются.

**SCOPE-граница, заявленная прямо (не founder-вопрос, а инженерный факт):** durable claimable mutable-SLA очередь
defer-задач **переезжает в E7 (T-0049)** — под ratified no-new-table mutable persistent claim негде разместить
durable, и это правильный объём для epic'а инбокса, а не для defer-producer'а. Day-1 поставляется
audit-floor-backed гарантия «не потеряно / видимо человеком с doubt_reason». Линейный ТЭЛ-демо этим
удовлетворяется.

---

## 7. Fitness-функции (маппинг на T-0220 AC-5/AC-6 + инварианты ограничения)

| FF | Правило (инвариант) | ci_check | Гейтинг |
|---|---|---|---|
| **FF-1 (NO NEW TABLE — несущий)** | T-0221-diff НЕ добавляет миграций и НЕ создаёт таблиц; `known_tenant_tables.txt` без новых строк | static-now `ci/checks/defer-no-new-table.sh`: нет новых `migrations/0*_*.sql` в diff с `CREATE TABLE`; `git diff` не трогает `known_tenant_tables.txt`; нет строки `user_task` нигде | static-now |
| **FF-2 (AC-5 durable+isolated)** | defer пишет ровно одну `audit_event` `type='agent.deferred'` с непустым `payload.doubt_reason` под tenant-RLS | live-DB: прогнать defer-ветку под tenant-tx → `SELECT … WHERE type='agent.deferred' AND id=$inboxTaskRef` вернул 1, `payload->>'doubt_reason' <> ''` | live-DB |
| **FF-3 (AC-5 back-link)** | `agent.deferred.payload.inbox_task_id == audit_event.id` той же строки (== `inboxTaskRef`) | static-now (in-memory writer golden: payload.inbox_task_id === input.id) + live-DB | static-now + live-DB |
| **FF-4 (AC-5 visible)** | defer-задача видна в `/api/inbox` человека нужной роли (из пула) при `hasDb()` | live-DB e2e: записать defer под TENANT → `GET /api/inbox?tab=pool` под актором роли → задача в `items` с `doubt_reason` | live-DB |
| **FF-5 (AC-6 ordinary task)** | defer-проекция имеет ту же `InboxItem`-форму (role/sla/pool/exec_type); НЕТ второго task-носителя/таблицы | static-now lint: `DeferredInboxRow`→`InboxItem` маппер несёт `role`/`pool`/`execType`; `ci/checks/defer-no-new-table.sh` подтверждает single-носитель | static-now |
| **FF-6 (single audit-sink сохранён)** | defer пишется ТОЛЬКО через `appendAuditEvent`; нет второго writer'а/INSERT-target'а | static-now grep: в `run-precheck.ts` defer-ветках только `appendAuditEvent`; нет `INSERT INTO` вне audit-writer | static-now |
| **FF-7 (read-DAO только читает audit)** | `deferred-inbox-store.ts` НЕ пишет и читает ТОЛЬКО `audit_event` | static-now grep: файл без `INSERT/UPDATE/DELETE`, без иных таблиц кроме `audit_event` (образец `audit-grant-trail.ts`) | static-now |
| **FF-8 (INV-DEFAULT сохранён)** | `classifyOutcome`/мотор не изменены (T-0220 AC-1..AC-4,AC-13 зелёные) | static-now: `run-precheck.test.ts`/мотор-golden зелёные; diff не трогает `classifyOutcome` логику | static-now |
| **FF-9 (reasoning не утекает, D-139)** | `doubt_reason` ≠ raw reasoning; проекция в `InboxItem` не несёт reasoning-текст | static-now lint: маппер не читает `reasoning_trace_ref` в видимое поле; `name`/`doubt_reason` из `doubt_reason` only | static-now |
| **FF-10 (audit open-vocab, no DDL)** | новое `payload.inbox_task_id`/`defer_role` — payload-поля, НЕ CHECK/колонка/таблица | static-now: `migrations/` без нового `type`-CHECK; событие через `type`-строку (`audit-writer.ts`) | static-now |
| **FF-11 (back-compat)** | `!hasDb()` сохраняет seed-поведение; `inbox-claim.e2e.test.ts` зелёный; `/api/inbox` wire не изменён | static-now: существующие inbox e2e зелёные; нет breaking wire-полей | static-now |
| **FF-12 (no actor_event)** | События НЕ идут в `actor_event` (closed verb-set, T-0220 AC-10) | static-now: `actor_event_vocab_pinned` зелёный; нет нового глагола | static-now |
| **FF-13 (RLS наследуется, не вводится)** | T-0221 НЕ добавляет RLS-поверхности — defer изоляция = существующий `audit_event` predicate | static-now: нет нового `CREATE POLICY` в diff; live-DB cross_tenant над `audit_event` уже зелёный | static-now + live-DB |

---

## 8. Build-brief (что coder реализует, file-level)

1. **`src/core/defer-task-producer.ts`** — PURE `planDeferTask()` + типы `DeferTaskPlan` (§5.1). Юнит-golden.
   **PURE: no pg/http/env.**
2. **`src/runtime/legal-precheck/run-precheck.ts`** — в ТРЁХ defer-ветках (:260,:316,:387): минтить `taskId`,
   `planDeferTask`, `deferredAuditEvent(plan, taskId)` с payload `inbox_task_id`/`defer_role`/`defer_sla_minutes`;
   `inboxTaskRef = taskId`. Добавить `deferRole`/`deferSlaMinutes?` в `args`-сигнатуру. **Единственный sink остаётся
   `appendAuditEvent`** (FF-6). `classifyOutcome` НЕ трогать (FF-8).
3. **`src/db/deferred-inbox-store.ts`** (НОВЫЙ, read-only) — `listDeferredInboxTasks()` по образцу
   `audit-grant-trail.ts`: читает `audit_event WHERE type='agent.deferred'` под tenant-RLS, мапит на
   `DeferredInboxRow`. БЕЗ INSERT/UPDATE/DELETE, БЕЗ иных таблиц (FF-7). **НЕ трогать `known_tenant_tables.txt`.**
4. **`src/http/inbox.ts`** — `findInboxItems()`: при `hasDb()` мержить `listDeferredInboxTasks(...)`-проекции в
   список аддитивно к `INBOX_SEED`; `!hasDb()` → только seed. `doubt_reason` — additive optional поле `InboxItem`.
   Сохранить `_resetClaimStateForTests`/`CLAIMED`/`INBOX_SEED` (правило 7, FF-11). Wire не менять.
5. **`src/core/agent-precheck-motor.ts`** — JSDoc у `inboxTaskRef`: уточнить «= audit_event.id строки
   agent.deferred (== payload.inbox_task_id); носитель — audit-floor, НЕ новая таблица (D-061)». Логику не менять.
6. **`ci/checks/defer-no-new-table.sh`** (НОВЫЙ static-lint, FF-1/FF-5/FF-7): diff не добавляет
   `CREATE TABLE`-миграций; нет строки `user_task` нигде; read-DAO без write-SQL; `known_tenant_tables.txt`
   не изменён.
7. **Тесты:** `src/core/__tests__/defer-task-producer.test.ts` (static golden, §5.1); обновить
   `run-precheck.test.ts` defer-кейсы на новый payload (`inbox_task_id`==id, `defer_role`); live:
   `ci/checks/db/deferred-inbox.test.ts` (FF-2/FF-3/FF-4 — defer пишется, проекция видна в `/api/inbox`).
   Свежий tenant-UUID (память `choros-db-test-shared-db`), НЕ TENANT_A/_B.
8. **НЕ делать:** миграцию, таблицу, изменение `known_tenant_tables.txt`, новый CREATE POLICY, durable claim
   (→ E7). Никакой re-эскалации (D-061).

---

## 9. Traceability (AC T-0220 → дизайн T-0221 под no-new-table)

| T-0220 AC | Покрыто здесь |
|---|---|
| **AC-5** (defer → видимая человеком задача с doubt_reason) | §3.1 (5/6 граней на audit-floor), §4 (проекция), §5.2-5.4, FF-2/FF-3/FF-4. **Mutable-claim-грань → E7 (§3.3, явный scope).** |
| **AC-6** (defer = обычный пул-task, не новый тип) | §4 (та же `InboxItem`-форма), §5.4 (мерж как пул-item), FF-5 |
| AC-1..AC-4, AC-13 (мотор/INV-DEFAULT) | §5.5/FF-8 — `classifyOutcome` не трогаем |
| AC-8 (no CHECK/колонка/таблица на audit) | §4 — open-vocab `type`; добавляется только payload-поле, FF-10 |
| AC-10 (не actor_event) | FF-12 |
| AC-11 (reasoning-trace) | §4 — `reasoning_trace_ref` в payload сохранён; FF-9 (не утекает в видимое) |

---

## 10. Runtime / deploy target

**Runtime:** существующий choros dev-стек (single-Postgres substrate + node:http), `/srv/choros`,
deploy founder-gated. **Новое:** payload-поле (open-vocab), PURE-планировщик, read-only DAO, тонкий мерж в инбокс,
один static-чек. **НЕТ** миграции / таблицы / RLS-поверхности / `known_tenant_tables.txt`-изменения / нового
внешнего ресурса / founder-gate. Локальная проверка: live DB порт **55432**
(`DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros`). Никакого
`fitness:db:setup-template` для миграций НЕ требуется (миграций нет).

---

## 11. Residual risk

1. **Mutable claim defer-задачи не durable day-1** (process-lifetime `CLAIMED`). Митигация: durable claim —
   осознанный scope E7 (§3.3); линейный ТЭЛ-демо одно-процессный, durable claim не на критическом пути.
   Прозрачно зафиксировано как E7-зависимость.
2. **Проекция audit→inbox при большом журнале** — `listDeferredInboxTasks` с `LIMIT`/`ORDER BY occurred_at DESC`
   (как grant-trail). Митигация: day-1 объём defer'ов мал; keyset/индекс — Stage-2, если понадобится.
3. **`defer_role` без FK** — текстовый ключ позиции (как `inbox.ts.role`). Митигация: соответствует
   существующему inbox-инварианту; FK = Stage-2.
4. **Дубль claim-семантики** (seed `CLAIMED` для seed-задач И defer-проекций) — обе через одну ручку
   `/api/inbox/:id/claim`, in-memory; взаимно-согласованы (один `CLAIMED`-Map). Durable → E7.
5. **Generalization-seam не вызывается** за пределами legal-precheck — намеренно (§5.5); producer тип-обобщён,
   реально используется (defer-ветки), не dead code.
6. **db shared-template gotcha** — live-тест минтит свежий tenant-UUID (память `choros-db-test-shared-db`),
   зафиксировано в build-brief §7.
