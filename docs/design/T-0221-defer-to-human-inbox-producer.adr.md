# ADR · T-0221 — `defer-to-human` → реальная задача инбокса с причиной сомнения (B-2 impl)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-16
**Spec:** секция **B / B.5** плейбука `v1-demo-and-trust-surface` (воспроизведена verbatim в теле T-0220).
**Design contract (НЕ противоречить):** `docs/design/T-0220-agent-step-outcomes.adr.md` — §5.1 (двойной гейт),
§6.2 (`defer`→обычная задача инбокса), **AC-5** (defer материализует задачу инбокса с `doubt_reason`),
**AC-6** (defer НЕ вводит новый тип задачи — это обычный пул-task).
**Mechanism foundation (построено, проверено по коду):**
- `src/core/agent-precheck-motor.ts` — `classifyOutcome()` (PURE, INV-DEFAULT, приоритет fail-closed>defer>proceed;
  двойной триггер `thresholdFailed` ИЛИ `modelConfidence < CONFIDENCE_FLOOR`). **Уже есть.**
- `src/runtime/legal-precheck/run-precheck.ts` — оркестратор; читает `autonomy_threshold` (`agent_card`,
  `migrations/032`), пишет `agent.deferred` через единственный `appendAuditEvent` с `doubt_reason`. **Уже есть.**
- `src/db/audit-writer.ts` — единственный санкционированный writer аудита (`appendAuditEvent`, под caller-tx с
  `SET LOCAL choros.tenant_id`). **Уже есть.**
- `src/http/inbox.ts` — E7 display-surface **на in-memory `INBOX_SEED`** (claim/SLA/role-addressing/tabs), НЕ DB.
- RLS-эталон NF-1: `migrations/046_notification.sql`, `migrations/058_files_attachments.sql` — `tenant_id`-leading
  PK, `ENABLE+FORCE RLS`, ОДИН predicate `current_setting('choros.tenant_id', true)::uuid` (USING+WITH CHECK),
  `GRANT … TO choros_app`, имя в `ci/checks/known_tenant_tables.txt`.

> Это ADR для **impl-задачи** (B-2). Он принимает решение по data-model-крузу (нужна ли DB-таблица пула задач),
> проектирует таблицу + producer + back-link, и фиксирует fitness-функции, маппящиеся на T-0220 AC-5/AC-6.
> Каждое «где это живёт» привязано к реальному файлу выше. Гейтинг каждой FF помечен: **static-now** (бежит в
> сегодняшнем `npm run ci`: tsc/eslint/vitest + `ci/checks/*.sh`) / **live-DB** (проба Postgres в `fitness:db`).

---

## 1. Контекст: что построено и где РАЗРЫВ (verify-by-code)

T-0233 построил живой мотор и оркестратор. Исход `defer-to-human` **сегодня** материализуется ТОЛЬКО в
audit-floor: `inboxTaskRef` в `PrecheckOutcome.defer-to-human` = **id audit-события** `agent.deferred`
(`src/core/agent-precheck-motor.ts:48-52` комментарий: «ID of the `agent.deferred` audit event — the canonical
day-1 DB-backed record … audit-floor IS the seam»; `run-precheck.ts:274,329,401` — `inboxTaskRef: deferAuditId`).

Это честно покрывает «защита от потери» (append-only журнал), но **НЕ** удовлетворяет T-0220 §6.2 / AC-5
буквально: AC-5 требует, чтобы defer создал **inbox-task с непустым `doubt_reason`**, видимую **в очереди
человека**, и чтобы `agent.deferred.payload.inboxTaskId` ссылался на **id этой задачи**. Сегодня же:

- **нет DB-таблицы пула задач** — `grep -rin 'user_task|task_pool|inbox_task|pool_task' migrations/ src/` находит
  только in-memory `src/http/inbox.ts` (`INBOX_SEED`, `CLAIMED: Map`) и комментарий «A real implementation would
  write to a DB user_task_claim table» (`inbox.ts:26`). Таблицы нет;
- `agent.deferred.payload` несёт `doubt_reason`/`signal`/`reasoning_trace_ref`, но **НЕ** `inboxTaskId`, потому что
  материализованной задачи, на которую можно сослаться, не существует — `inboxTaskRef` = id самого же audit-события
  (self-reference, stand-in);
- мотор-исход generaлизован только под **узкий** `legal_precheck`-путь, не как общий step-outcome producer.

T-0220 §9.2 и T-0233-контракт оба отвергли «новую таблицу» как **rejected alternative**, аргументируя «ничего
нового сверх envelope». **Этот ADR пересматривает это решение** — не ради красоты, а потому что **AC-5
недостижим без реального места, куда кладётся задача**, а E7-Инбокс (epic T-0049) day-1 = только in-memory seed.
Разрешение этого противоречия — §3.

---

## 2. Решение (один абзац)

Day-1 честный `defer-to-human`, видимый человеком и удовлетворяющий AC-5, **ТРЕБУЕТ** DB-backed таблицу пула
задач — `audit-floor` доказывает «не потеряли», но НЕ даёт **очередь, из которой человек берёт работу** (claim из
пула с SLA — это write-state, который in-memory `Map` теряет при рестарте и который не tenant-isolated в БД).
Вводим ОДНУ новую tenant-таблицу **`choros.user_task`** (минимальное ядро пула: role-addressing + SLA + claim +
`exec_type` + `doubt_reason`), строго по NF-1 RLS-контракту (`tenant_id`-leading PK, ENABLE+FORCE RLS, ОДИН
predicate, `GRANT … choros_app`, запись в `known_tenant_tables.txt`). Producer
`src/core/defer-task-producer.ts` (PURE-планировщик + тонкий DAO-writer) при исходе `defer` кладёт **обычную**
пул-задачу той же формы, что `src/http/inbox.ts` (role/sla/exec_type), с непустым `doubt_reason`, и **в той же
caller-tx** пишет `agent.deferred` через тот же `appendAuditEvent`, **back-linking** реальный `user_task.id` в
`payload.inboxTaskId` (заменяя сегодняшний audit-id-stand-in). Producer вызывается из оркестратора defer-веток
(`run-precheck.ts`) — generalization за пределы `legal_precheck` НЕ делаем в этой задаче (§5, scope-guard).
`src/http/inbox.ts` промотируется с in-memory seed на чтение `user_task` за DB-backed read-DAO **аддитивно**
(seed остаётся fallback при `!hasDb()`), wire-контракт инбокса не меняется. Это `IN_ENVELOPE_BUILD_NOW` с
оговоркой (§6): таблица минимальна, авторитет НЕ трогается (claim-eligibility = role-membership, как сейчас; PDP
T-0021 не дублируется), миграция аддитивна.

---

## 3. Крузовое решение: нужна ли DB-таблица? — ДА. Обоснование и взвешенные альтернативы

### 3.1 Почему audit-floor НЕ достаточно (против сегодняшнего stand-in)
`audit_event` — **append-only журнал отклонений** (что пошло не так), индексированный по hash-цепочке. Он:
- не имеет изменяемого `claim`-состояния (claimedBy/claimedAt) — а claim из пула это **mutable write-state**;
- не имеет SLA-дедлайна/`status` жизненного цикла задачи (waiting→claimed→done) — это бизнес-объект, не аудит;
- семантически НЕ «очередь работы»: класть рабочие задачи в governance-журнал = смешать аудит с операционным
  состоянием (нарушает T-0016 append-only-инвариант, если задача меняет статус → UPDATE на audit = запрещён).

`inboxTaskRef = audit-id` сегодня — это **honest stand-in под dormant-агента** (живой defer ещё не гонится в
демо), но он структурно НЕ может быть тем, на что ссылается AC-5 «inbox-task создан». Это и есть разрыв.

### 3.2 Почему НЕ «оставить in-memory `INBOX_SEED`» (against status-quo)
In-memory `Map`/seed: (1) теряется при рестарте — defer-задача исчезает, «не потеряли» нарушено; (2) НЕ
tenant-isolated в БД (152-ФЗ RLS-инвариант не покрыт); (3) не виден из другого процесса/пода. Для **демо-показа**
(ТЭЛ-эталон) это можно было бы стерпеть, но AC-5 говорит **live-DB (inbox write)** — это требует реальной строки
в Postgres, которую видит запрос человека. Seed остаётся ТОЛЬКО как `!hasDb()`-fallback (как `org.ts`).

### 3.3 Почему МИНИМАЛЬНАЯ таблица `user_task`, а не полный E7-движок
Соразмерность (рубрика ось 5): не строим планировщик/эскалации/нотификации заново — они уже есть
(`notification-router.ts`, escalated-tab). Таблица несёт ровно поля, которые сегодня держит `InboxItem` как
operational state (`role`,`sla`,`status`,`exec_type`,`claimed_by/at`,`escalated`) ПЛЮС `doubt_reason` для defer.
Это «E7-Инбокс day-1 ядро», на которое потом сядут эскалации/дедлайны/нотификации (additive ALTER).

### 3.4 Взвешенные альтернативы (rejected)
| Опция | Почему НЕТ |
|---|---|
| **A. Оставить audit-id stand-in (статус-кво T-0233)** | Не удовлетворяет AC-5 «inbox-task создан, виден человеком»; audit не несёт claim/SLA mutable-state. Это и есть разрыв, ради закрытия которого заведён T-0221. |
| **B. In-memory `INBOX_SEED` + producer пишет в `Map`** | Теряется при рестарте (нарушает «не потеряли»), НЕ tenant-isolated в БД (152-ФЗ), не виден кросс-процессно; AC-5 требует live-DB write. |
| **C. Класть defer-задачу как строку в `audit_event` с расширенным payload** | Смешивает governance-аудит с operational claim-state; claim = UPDATE → ломает append-only NF-6. §3.1. |
| **D. Полный E7-движок (планировщик/эскалации/нотификации с нуля)** | Переусложнение (ось 5); эскалации/нотификации уже построены. Минимальное ядро + additive-ALTER — соразмерно. |
| **E. Generic step-outcome producer для ЛЮБОГО навыка сразу** | Over-reach scope T-0221; узость рантайма (FF-COMP-6 допускает чтение agent_instruction только `legal_precheck`-путём). Producer **тип-обобщён** (принимает outcome+context), но **вызывается** пока только из defer-веток legal-precheck (§5). |
| **F. Переиспользовать `choros.job` / `choros.actor_event` как пул задач** | `job` = технический job-store (jobStore.ts), не human-task; `actor_event` verb-set закрыт (T-0019) и это SoD-факты, не очередь. Семантически чужие носители. |

> Это пересмотр T-0220 §9.2 rejected#2 / T-0233-rejected «новая таблица». **Триггер пересмотра:** §9.2 утверждал
> «`audit_event`+inbox(E7) покрывают всё day-1» — но inbox(E7) day-1 оказался **in-memory seed без DB-носителя**,
> т.е. посылки §9.2 не выполнились в коде. Это не дрейф, а закрытие честного разрыва между дизайном и реализацией.

---

## 4. Объектная модель — таблица `choros.user_task` (миграция `073_user_task.sql`)

Строго по NF-1-эталону (`058_files_attachments.sql` / `046_notification.sql`). **ОДИН** RLS-predicate.

```sql
-- 073 · user_task (T-0221 / E7-Инбокс, epic T-0049) — DB-backed человеческая задача пула.
-- Промотирует src/http/inbox.ts с in-memory INBOX_SEED на реальную tenant-таблицу.
-- defer-to-human (T-0220 §6.2 / AC-5) кладёт сюда ОБЫЧНУЮ пул-задачу с doubt_reason.
-- НЕ новый authority-surface: claim-eligibility = role-membership (как сегодня в inbox.ts);
-- PDP (T-0021) не дублируется — это операционная очередь, не grant-решение.
CREATE TABLE IF NOT EXISTS choros.user_task (
  tenant_id     uuid    NOT NULL,
  id            uuid    NOT NULL,
  -- Role-addressing инвариант (T-0093): задача адресована РОЛИ, не человеку.
  role          text    NOT NULL,
  name          text    NOT NULL,          -- «Проверить: <doubtReason>» для defer
  step          text    NOT NULL DEFAULT '',
  status        text    NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('running','waiting','failed','done','paused')),
  exec_type     text    NULL
    CHECK (exec_type IN ('agent','human','service')),
  exec_name     text    NULL,
  pool          boolean NOT NULL DEFAULT true,   -- claimable из пула
  escalated     boolean NOT NULL DEFAULT false,  -- драйвит «Эскалации»-tab (fail-closed §6.1)
  -- defer-специфика: ЧТО ИМЕННО НЕЯСНО (B.2). NULL для обычных задач, NOT-NULL для defer.
  doubt_reason  text    NULL,
  -- источник исхода: 'defer'|'fail-closed' для агентских; NULL для обычных.
  origin_outcome text   NULL
    CHECK (origin_outcome IN ('defer','fail-closed')),
  -- SLA: минуты-бюджет + дедлайн в epoch-ms (как inbox.ts.deadline, server-truth T-0095).
  sla_minutes   integer NULL,
  due_at        bigint  NULL,
  -- claim-state (T-0094/T-0138): кто/когда взял из пула. NULL = не взято.
  claimed_by    text    NULL,
  claimed_at    bigint  NULL,
  created_by    text    NOT NULL,          -- 'agent:<employeeId>' для defer-producer
  created_at    bigint  NOT NULL,
  updated_at    bigint  NOT NULL,
  PRIMARY KEY (tenant_id, id)
  -- НЕТ FK на employee/record: role — текстовый ключ позиции (как inbox.ts.role,
  -- не employee-id), а defer может относиться к любому объекту; back-link на объект
  -- держит agent.deferred.payload, не строка задачи (избегаем chicken-and-egg и
  -- cross-table связности, как file.current_version в 058).
);

CREATE INDEX IF NOT EXISTS user_task_pool_by_role
  ON choros.user_task (tenant_id, role) WHERE pool = true AND claimed_by IS NULL;

ALTER TABLE choros.user_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.user_task FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='choros' AND tablename='user_task'
      AND policyname='user_task_tenant_isolation'
  ) THEN
    CREATE POLICY user_task_tenant_isolation ON choros.user_task
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.user_task TO choros_app;
```

**`agent.deferred.payload` — back-link (изменение относительно T-0233):** добавить поле
`inboxTaskId: string` (= `user_task.id` реально вставленной строки). Сегодняшний `inboxTaskRef = deferAuditId`
заменяется на id задачи. Остальные поля (`doubt_reason`,`signal`,`reasoning_trace_ref`) сохраняются.
`PrecheckOutcome.defer-to-human.inboxTaskRef` начинает нести **id задачи**, не audit-id (контракт типа сохранён —
строка; меняется семантика значения, что фиксируется в JSDoc и тесте AC-5).

---

## 5. Контракты — producer + read-DAO + порядок записи (один tx)

### 5.1 PURE-планировщик (static-now-тестируемый, как `classifyOutcome`)
```ts
// src/core/defer-task-producer.ts (PURE: no pg/http/env — план, не запись)
export interface DeferTaskPlan {
  readonly role: string;          // кому адресовать (из контекста шага/процесса)
  readonly name: string;          // «Проверить: <doubtReason>» (truncated)
  readonly doubtReason: string;   // непустой (INV: AC-5)
  readonly execType: "agent";     // источник = агент
  readonly execName?: string;
  readonly slaMinutes?: number;   // из процесса/дефолт
  readonly originOutcome: "defer";
}
/** Чистая трансформация defer-исхода+контекста в план задачи. Тотальна; doubtReason всегда непуст. */
export function planDeferTask(
  outcome: Extract<PrecheckOutcome, { kind: "defer-to-human" }>,
  ctx: { readonly role: string; readonly slaMinutes?: number; readonly execName?: string },
): DeferTaskPlan;
```

### 5.2 Тонкий DAO-writer (live-DB; под caller-tx, как audit-writer)
```ts
// src/db/user-task-store.ts — единственный write-path в choros.user_task (FF аналог audit-writer FF-11)
export interface UserTaskWriter {
  /** INSERT под caller-tx (SET LOCAL choros.tenant_id уже выставлен). Возвращает id вставленной строки. */
  insertUserTask(tx: PgClientLike, row: NewUserTaskRow): Promise<{ id: string }>;
}
export interface NewUserTaskRow {
  id: string; role: string; name: string; status: "waiting"; pool: true;
  execType: "agent"; execName?: string; doubtReason: string; originOutcome: "defer";
  slaMinutes?: number; dueAt?: number; createdBy: string; createdAt: number; updatedAt: number;
}
// + InMemoryUserTaskWriter (static-now) — same shape, для unit без БД (как InMemoryAuditWriter).
```

### 5.3 Порядок записи в оркестраторе (run-precheck.ts defer-ветки)
**Инвариант атомарности:** задача и `agent.deferred` пишутся **в одной caller-tx** (caller ROLLBACK откатывает
обе — как audit-writer §4.2). Порядок:
1. `planDeferTask(outcome, ctx)` → план.
2. `taskId = randomUUID()`; `userTaskWriter.insertUserTask(tx, {...plan, id: taskId, ...})`.
3. `appendAuditEvent(tx, deferredAuditEvent(... inboxTaskId: taskId ...))` — back-link.
4. вернуть `{ kind:"defer-to-human", inboxTaskRef: taskId, ... }`.

Сегодняшние **три** defer-ветки в `run-precheck.ts` (missing-instruction :260, dormant :316, tentative-defer
:387) обновляются на этот порядок. `role`/`slaMinutes` приходят из `args` оркестратора (новые поля
`PrecheckArgs.deferRole`, `PrecheckArgs.deferSlaMinutes?` — откуда адресовать defer; day-1 — из процесса/демо).

### 5.4 Read-DAO для инбокса (промоция `src/http/inbox.ts`, АДДИТИВНО)
```ts
// src/db/user-task-store.ts (read side)
export async function listUserTasksForTenant(pool, tenantId, opts): Promise<UserTaskRow[]>;
```
`src/http/inbox.ts.findInboxItems()`: при `hasDb()` читает `user_task` через read-DAO и мапит в существующий
`InboxItem`-wire; при `!hasDb()` — текущий `INBOX_SEED` (fallback, как `resolveTenant`). **Wire-контракт
`/api/inbox` НЕ меняется** (те же поля/tabs/counts) — FE не трогается. `doubt_reason` пробрасывается в `InboxItem`
как опциональное поле для рендера «нужна проверка: …» (additive, не ломает существующих потребителей).

> **Контракт совместимости (правило 7):** `_resetClaimStateForTests()` (`inbox.ts:413`) и in-memory `CLAIMED`
> сохраняются как `!hasDb()`-path — НЕ удаляем экспорт; существующие e2e (`inbox-claim.e2e.test.ts`) гоняются
> на seed-fallback и остаются зелёными. Claim-write DB-path (UPDATE `claimed_by/at`) — **в scope как DAO**, но
> сама claim-эндпоинт-промоция HTTP может остаться seed-only day-1, если e2e так проще (build-brief §8 отметит).

### 5.5 Generalization — НЕ в этой задаче (scope-guard)
Producer и `planDeferTask` приняты **тип-обобщённо** (вход = defer-outcome + context), но **точка вызова** day-1 —
только defer-ветки `run-precheck.ts` (`legal_precheck`). Маршрутизация general step-outcomes через
`classifyOutcome` за пределы legal-precheck = **отдельная будущая задача** (нарушила бы узость FF-COMP-6 рантайма
и scope T-0221). ADR фиксирует seam (producer не знает про legal_precheck), но не расширяет точку вызова.

---

## 6. Scope-boundary / founder-вопрос — РЕКОМЕНДАЦИЯ: `IN_ENVELOPE_BUILD_NOW`

**Рекомендация: `IN_ENVELOPE_BUILD_NOW`.** Обоснование, честно у границы data-model/authority:

1. **Direction уже дана.** Фаундер назвал «инбокс» частью ТЭЛ-MVP-эталона приёмки
   (`choros-product-direction-tel`: «НИЧЕГО не режем: процессы+инбокс+формы+авторинг»), и E7-Инбокс = epic
   **T-0049** (одобрен, `choros-foundation-epics-approved`). DB-backed инбокс — прямая реализация уже
   одобренного направления, не новое продуктовое решение.
2. **Это impl-латитуда, не direction-call.** Прецедент `founder-autonomy-impl`: «DB/compose/indexing/engine —
   автономно, никогда не эскалировать»; data-model форма tenant-таблицы = именно это. NF-1 RLS-эталон существует
   (058/046) — таблица строится по застывшему контракту, без новых инвариантов изоляции.
3. **Authority НЕ трогается.** Ключевой тест границы: вводит ли таблица новый authority-surface? **НЕТ.**
   claim-eligibility = role-membership (как уже в `inbox.ts`), PDP (T-0021) не дублируется, grant-lattice не
   меняется, frozen-объекты не трогаются. `user_task` — операционная очередь, не grant-решение. (Если бы defer
   создавал grant или менял видимость — был бы founder-gate; здесь нет.)
4. **Аддитивность.** Новая миграция (slot 073), новая запись в `known_tenant_tables.txt`, новый producer/DAO —
   всё additive; ни одной существующей таблицы/чека/frozen-объекта не ломаем. Нет нового внешнего ресурса/сервера.

**Единственная оговорка (НЕ блокер):** этот ADR **пересматривает** rejected#2 из T-0220 §9.2 и T-0233-контракта
(«не вводить новую таблицу»). Пересмотр обоснован разрывом дизайн↔код (§3.4 note): посылка §9.2 («inbox E7
покрывает day-1») в коде не выполнилась (inbox = in-memory seed). Это **закрытие честного разрыва ради
выполнимости AC-5**, а не дрейф. Оркестратор может зафиксировать это как ratified-reversal в memory; founder-gate
НЕ требуется (нет нового authority/инфра/необратимого/секрета/бюджета — границы фаундера по D-060).

> Если оркестратор/ревью сочтёт пересмотр rejected-альтернативы достаточно весомым для записи — это **record**,
> не **gate**: строить можно сейчас. Формальный founder-вопрос (если всё же поднять): *«T-0220 day-1 отверг
> DB-таблицу пула задач, положившись на E7-инбокс; но E7-инбокс в коде = in-memory seed без DB-носителя, поэтому
> AC-5 (defer→видимая человеком задача с doubt_reason) недостижим. Вводим минимальную tenant-таблицу user_task
> (без нового authority-surface, claim=role-membership как сейчас). Подтвердить, что это impl-латитуда?»*

---

## 7. Fitness-функции (маппинг на T-0220 AC-5/AC-6 + новые инварианты)

| FF | Правило (инвариант) | ci_check | Гейтинг |
|---|---|---|---|
| **FF-1 (AC-5)** | defer-исход создаёт строку `user_task` с **непустым** `doubt_reason` | live-DB: прогнать defer-ветку под tenant-tx → `SELECT … FROM user_task WHERE id=$inboxTaskRef` вернул 1 строку, `doubt_reason <> ''`, `origin_outcome='defer'` | live-DB |
| **FF-2 (AC-5)** | `agent.deferred.payload.inboxTaskId` == id созданной задачи (back-link, не audit-id) | live-DB + static-now: payload-поле = `user_task.id`; golden на in-memory writer проверяет равенство | live-DB + static-now |
| **FF-3 (AC-6)** | defer кладёт задачу **той же формы**, что `inbox.ts` (role/sla/pool/exec_type); НЕТ второй task-таблицы | static-now lint (`ci/checks/defer-task-no-new-table.sh`): `migrations/` содержит ровно ОДНУ новую task-таблицу `user_task`; `NewUserTaskRow` несёт `role`/`pool`/`execType` | static-now |
| **FF-4 (NF-1 RLS)** | `user_task` имеет ENABLE+FORCE RLS + ровно ОДИН isolation-predicate `current_setting('choros.tenant_id',true)::uuid` (USING+WITH CHECK) | live-DB: `force_rls.sql`-стиль проба (как 058); static-now grep: migration содержит ENABLE/FORCE/policy и НЕ содержит второго predicate | live-DB + static-now |
| **FF-5 (NF-1)** | `user_task` ∈ `known_tenant_tables.txt` (cross-tenant-fitness покрывает) | static-now: `grep -qx user_task ci/checks/known_tenant_tables.txt`; `cross_tenant.test.ts` (live) видит изоляцию | static-now + live-DB |
| **FF-6** | Producer пишет user_task И agent.deferred в ОДНОЙ tx (атомарность) | static-now: lint — обе записи под одним `tx`-аргументом в defer-ветках `run-precheck.ts`; live-DB: ROLLBACK откатывает ОБЕ | static-now + live-DB |
| **FF-7** | Единственный write-path в `user_task` = `user-task-store` (FF аналог audit FF-11) | static-now grep: нет `INSERT INTO choros.user_task` вне `src/db/user-task-store.ts` | static-now |
| **FF-8 (INV сохранён)** | `classifyOutcome`/INV-DEFAULT не изменены (T-0220 AC-1..AC-4,AC-13 остаются зелёными) | static-now: существующие golden мотора (`run-precheck.test.ts`) зелёные; diff не трогает `agent-precheck-motor.ts` логику классификации | static-now |
| **FF-9** | reasoning НЕ утекает в `user_task` (D-139): `doubt_reason` ≠ raw reasoning; нет reasoning-колонки | static-now lint: `user_task` migration не содержит `reasoning`-колонки; producer не пишет `outcome`-внутренний reasoning | static-now |
| **FF-10 (AC-5 visible)** | defer-задача видна в `/api/inbox` человека нужной роли (из пула) | live-DB e2e: вставить defer-task под TENANT, `GET /api/inbox?tab=pool` под актором этой роли → задача в `items` | live-DB |
| **FF-11 (back-compat)** | `!hasDb()`-fallback сохраняет seed-поведение; `inbox-claim.e2e.test.ts` зелёный; `/api/inbox` wire не изменён | static-now: существующие inbox e2e зелёные; нет breaking-изменений wire-полей | static-now |
| **FF-12 (no actor_event)** | События по-прежнему НЕ идут в `actor_event` (closed verb-set, T-0220 AC-10) | static-now: `actor_event_vocab_pinned` зелёный; нет нового actor_event-глагола | static-now |

---

## 8. Build-brief (что coder реализует, file-level)

1. **`migrations/073_user_task.sql`** — таблица из §4 (NF-1 RLS-эталон 058/046). Slot 073 (072 = highest на dev).
2. **`ci/checks/known_tenant_tables.txt`** — добавить строку `user_task`.
3. **`src/core/defer-task-producer.ts`** — PURE `planDeferTask()` + типы `DeferTaskPlan` (§5.1). Юнит-golden.
4. **`src/db/user-task-store.ts`** — `UserTaskWriter` (insert, под caller-tx) + `InMemoryUserTaskWriter` +
   read-DAO `listUserTasksForTenant()` (§5.2/§5.4). Единственный write-path (FF-7).
5. **`src/core/agent-precheck-motor.ts`** — JSDoc у `inboxTaskRef`: уточнить «= user_task.id (T-0221), не audit-id».
   Логику `classifyOutcome` НЕ менять (FF-8).
6. **`src/runtime/legal-precheck/run-precheck.ts`** — в трёх defer-ветках (≈:260,:316,:387): вызвать
   `planDeferTask` → `insertUserTask` → `appendAuditEvent` с `inboxTaskId=taskId` в одной tx (§5.3). Добавить
   `deferRole`/`deferSlaMinutes?` в `PrecheckArgs` + `userTaskWriter` в `PrecheckDeps`. `deferredAuditEvent`
   payload получает `inboxTaskId`.
7. **`src/http/inbox.ts`** — `findInboxItems()`: при `hasDb()` читать `user_task` (read-DAO), мапить в `InboxItem`;
   `!hasDb()` → текущий seed. Wire не менять; `doubt_reason` — additive optional поле. Сохранить
   `_resetClaimStateForTests`/`CLAIMED` для seed-path (правило 7).
8. **`ci/checks/defer-task-no-new-table.sh`** — static-lint FF-3/FF-7/FF-9 (ровно одна новая task-таблица; нет
   INSERT вне store; нет reasoning-колонки).
9. **Тесты:** `ci/checks/db/user-task.test.ts` (live: FF-1/FF-2/FF-4/FF-10), `src/core/__tests__/defer-task-producer.test.ts`
   (static golden), обновить `run-precheck.test.ts` defer-кейсы на новый back-link. `cross_tenant.test.ts`
   автоматически подхватит `user_task` из `known_tenant_tables.txt`.
10. **Post-merge:** `npm run fitness:db:setup-template` после смены миграций (память s24); claim-write DB-promotion
    HTTP — опционально day-1 (build-brief может оставить claim на seed-fallback, если e2e так проще; DAO готов).

---

## 9. Traceability (AC T-0220 → дизайн T-0221)

| T-0220 AC | Покрыто здесь |
|---|---|
| **AC-5** (defer → inbox-task с doubt_reason) | §3 (крузовое ДА), §4 (`user_task`), §5.3 (порядок), FF-1/FF-2/FF-10 |
| **AC-6** (defer = обычный пул-task, не новый тип) | §3.3 (минимальное ядро), §5.4 (та же InboxItem-форма), FF-3 |
| AC-1..AC-4, AC-13 (мотор/INV-DEFAULT) | §5.5/FF-8 — не трогаем `classifyOutcome`; остаются зелёными |
| AC-8 (no CHECK/колонка на audit) | §4 — `agent.deferred` всё ещё open-vocab `type`; добавляется только payload-поле, не DDL |
| AC-10 (не actor_event) | FF-12 |
| AC-11 (reasoning-trace) | §4 — `reasoning_trace_ref` в payload сохранён; FF-9 (не утекает в user_task) |

---

## 10. Runtime / deploy target

**Runtime:** существующий choros dev-стек (single-Postgres substrate + node:http), `/srv/choros`,
deploy founder-gated. **Новое:** ОДНА аддитивная миграция (`073_user_task.sql`), новый producer/DAO, новый
static-чек, обновление `known_tenant_tables.txt`. **НЕТ** нового внешнего ресурса / сервера / DB-provisioning /
секрета. **НЕТ founder-gate инфры.** Локальная проверка: `fitness:db:setup-template` после миграции (порт live DB
= **55432**, `DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros`).

---

## 11. Residual risk

1. **Reversal rejected-альтернативы** (§6 оговорка) — пересматриваем «no new table» из T-0220 §9.2/T-0233.
   Митигация: обоснован разрывом дизайн↔код; не authority; оркестратор может зафиксировать record.
2. **Дубль-семантика claim-state** day-1: claim живёт И в seed-`CLAIMED` (`!hasDb()`), И в `user_task.claimed_by`
   (`hasDb()`). Митигация: пути взаимоисключающие по `hasDb()`; не смешиваются в одном прогоне. Полная
   DB-промоция claim-HTTP — следующий шаг (DAO готов).
3. **`role` без FK** — текстовый ключ позиции (как `inbox.ts.role`), не валидируется против `position`-таблицы.
   Митигация: соответствует существующему inbox-инварианту (role = строковый ключ); FK = Stage-2 ужесточение.
4. **Generalization-seam не вызывается** за пределами legal-precheck — намеренно (§5.5). Риск: «мёртвый» general
   producer. Митигация: producer тип-обобщён, но используется реально (legal-precheck defer); не dead code.
5. **db shared-template gotcha** (память `choros-db-test-shared-db`): новый live-тест ДОЛЖЕН минтить свежий
   tenant-UUID (не TENANT_A/_B), иначе кросс-файловая контаминация. Зафиксировано в build-brief §9.
