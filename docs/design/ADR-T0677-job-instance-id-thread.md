# ADR-T0677 — job.instance_id/process_def_id протянуты в рантайм (столп 4 P0, upstream-фикс T-0638)

Столп 4 (АГЕНТЫ-с-правами-как-сотрудники) + столп 3 (бесшовность). Статус: BUILD.

## 1. Что вскрыл LIVE_PROOF T-0638

T-0638 (defer-resolve — человек завершает отложенную агентом задачу) построил
корректный механизм: `payload.instance_id` из `agent.deferred` audit-события →
`deferred-inbox-store.ts` читает его в `DeferredInboxRow.instanceId` →
`POST /api/inbox/:id/action` вызывает `reconcileInstanceEngineDrive`
(resolve-by-instance) на этот instanceId. Мокнутый unit-тест был зелёным,
потому что мок вручную конструирует `ctx` с корректным `instanceId`.

Живой прогон на реальном стенде (агент отложил → человек взял карточку →
нажал «Согласовать») дал **404 DEFER_NOT_ROUTABLE**. Инстанс (99573238) остался
висеть, хотя движок уже продвинул токен в момент defer (ACCEPTED DECISION 1,
`dispatch-outcome.ts`, не меняется этой задачей).

Корень оказался НЕ в T-0638, а СТАРШЕ — в миграции 111 (T-0534, tel-intake
DMN-triage seam): `choros.job.process_def_id`/`instance_id` пишутся при
enqueue, но никогда не читались обратно ни одним из четырёх слоёв кода между
БД и `agent-step-context.ts`.

## 2. Цепочка протяжки (enqueue → БД → fetchAndLock → rowToJob → readJobVars)

### 2.1 enqueue пишет корректно (не тронуто этой задачей — уже работало)

`src/core/externalTaskBridge.ts::runBridgeOnce` читает `ExternalTask` —
Flowable's `GET /runtime/external-jobs/acquire` wire shape
(`src/core/flowable-client.ts`, `processInstanceId`/`processDefinitionKey`
поля — **engine-метаданные конкретного акта запуска процесса**, НЕ BPMN
business-переменная) — и передаёт их **позиционно** в
`pgJobStore.enqueue(topic, variables, retries, idempotencyKey, processDefId,
instanceId, executor?)`:

```ts
await jobStore.enqueue(
  topic, task.variables, retries, task.id,
  task.processDefinitionKey || undefined,
  task.processInstanceId || undefined,
);
```

`enqueue()` уже писало эти значения корректно в `choros.job.process_def_id` /
`instance_id` (миграция 111). Live-proof подтвердил: колонки в БД заполнены.
Этот шаг звена НЕ является дефектом и не менялся.

### 2.2 ДЕФЕКТ — `pgJobStore.ts`: fetchAndLock/enqueue/getById/list* никогда не
### выбирали эти колонки обратно

`src/core/postgres/pgJobStore.ts` — `JobRow` (внутренний DB row shape) не имел
полей `process_def_id`/`instance_id`; `rowToJob()` их не мапил; и, что решает
исход, **`fetchAndLock()`'s `RETURNING` список** (единственный метод, которым
рантайм реально забирает job для исполнения) их не перечислял:

```sql
RETURNING j.id, j.topic, j.variables, j.state, j.retries,
          j.lock_owner, j.lock_expiry, j.created_at, j.available_at
-- process_def_id, instance_id ОТСУТСТВОВАЛИ
```

Фикс: `JobRow` получил `process_def_id?: string | null` /
`instance_id?: string | null`; `rowToJob()` мапит их на
`Job.processDefId`/`Job.instanceId` с `?? null` нормализацией; ВСЕ
SELECT/RETURNING списки файла (enqueue — обе ветки, getById, listByTopic,
listByState, listByTopicAndState, fetchAndLock) теперь явно перечисляют обе
колонки.

### 2.3 ДЕФЕКТ #2 (production-специфичный) — `PostgresAgentJobFetcher` — своя
### копия CTE с той же дырой

`src/server/agent-dispatch-loop.ts::PostgresAgentJobFetcher.fetchAndLockAgentJobs`
— **это РЕАЛЬНЫЙ путь, которым живой агентский диспетчер (`main.ts`'s
`startAgentDispatchLoop`) забирает jobs**, НЕ через
`PostgresJobStore.fetchAndLock`. Причина существования отдельной копии:
production runtime pool подключается как `choros_migrator` (BYPASSRLS), и
`fetchAndLockAgentJobs` реализует cross-tenant discovery (Phase-1: distinct
tenant_id) + per-tenant lock (Phase-2: explicit `tenant_id = $6` предикат,
т.к. `SET LOCAL choros.tenant_id` инертен под BYPASSRLS) — логика, которой у
`PostgresJobStore.fetchAndLock` просто нет (он полагается на RLS одного
тенанта). Эта ручная CTE имела **свой собственный** `RETURNING`-список без
`process_def_id`/`instance_id` — независимый от фикса в §2.2, потому что это
буквально другой SQL-текст в другом файле.

Фикс: тот же паттерн — RETURNING получает `j.process_def_id, j.instance_id`;
TS-тип строки результата получает `process_def_id`/`instance_id: string |
null`; маппинг `jobRows.map(...)` в `Job` получает `processDefId`/`instanceId`
из строки (`?? null`), тем же принципом, каким уже стампуется `__tenantId` из
`r.tenant_id` (авторитетный источник — значение строки, не переменная цикла).

### 2.4 ДЕФЕКТ #3 (симптом-точка) — `readJobVars()` читал ТОЛЬКО variables

`src/runtime/agent-dispatch/agent-step-context.ts::readJobVars(job: Job)` —
единственная функция, которая превращает `Job` в
`{instanceId, procKey, agentEmployeeId, roleId, externalTaskId, fields}` для
сборки `AgentStepContext`:

```ts
instanceId: str("instanceId") || str("processInstanceId") || str("inst"),
```

Всё выражение читает **только** `job.variables` — а `variables` это BPMN
business-переменные шага (то, что несёт `task.variables` из Flowable
external-task, п.2.1), НЕ engine-метаданные. Ни один код в репозитории не
стемпит `variables.instanceId`/`processInstanceId` для живого агентского
job'а (`externalTaskBridge.ts`'s `resolveInstanceId`/`resolveAuthoredProcessKey`
хелперы читают ТЕ ЖЕ ключи, но это отдельный, чисто эвристический best-effort
путь для audit-корреляции внутри триаж-сима, не производитель для
`agent-step` топика). Следствие: `str("instanceId")` возвращает `""` для
КАЖДОГО живого agentTask — именно это увидел live-proof.

Фикс: `readJobVars()` теперь **предпочитает** `job.instanceId`/
`job.processDefId` (авторитетные DB-колонки, протянутые §2.2/§2.3) и падает в
`variables`-lookup только как fallback (легаси jobs, enqueued до миграции 111,
или jobs чей enqueue-путь не передал process scope):

```ts
instanceId:
  (typeof job.instanceId === "string" && job.instanceId.trim() !== ""
    ? job.instanceId.trim() : "") ||
  str("instanceId") || str("processInstanceId") || str("inst"),
```

### 2.5 Downstream (не тронуто — уже верно, теперь получает нужное значение)

`assembleAgentStepContext` кладёт `v.instanceId`/`procKey` в
`AgentStepContext.instanceId`/`procKey` (не менялось) →
`dispatch-outcome.ts::deferredAuditEvent` кладёт `ctx.instanceId` в
`payload.instance_id` (не менялось) → `deferred-inbox-store.ts` читает
`payload.instance_id`, трактуя пустую строку как `null` (не менялось, это и
есть механизм T-0638) → раньше пустая строка ⇒ `null` ⇒ 404
`DEFER_NOT_ROUTABLE`; теперь реальный instanceId ⇒ `reconcileInstanceEngineDrive`
находит и завершает живой userTask инстанса.

## 3. In-memory JobStore — не сломан, не требует изменений

`src/core/inMemoryJobStore.ts` — Job-объекты строятся объектным литералом с
явным перечислением полей (не spread). Добавление ДВУХ **optional** полей на
`Job` (`processDefId?`, `instanceId?`) не требует, чтобы этот литерал их
указывал — TS считает отсутствие optional-поля валидным. `InMemoryJobStore`'s
собственный `enqueue()` имеет 3-параметровую сигнатуру
(`topic, variables, retries, idempotencyKey?`) — она НЕ принимает
processDefId/instanceId вообще (это Postgres-only T-0534 механика,
`PostgresJobStore.enqueue` — 7-параметровая версия с этими двумя доп.
аргументами). Job'ы, порождённые in-memory-путём (юнит-тесты/dev-fallback без
Postgres), просто не несут этих полей — `readJobVars()` для них падает в
`variables`-fallback, как и раньше (никакого поведенческого изменения для
in-memory-путей).

Тестовый хелпер `makeJob()`
(`src/runtime/agent-dispatch/__tests__/agent-dispatch-loop.test.ts`) кладёт
`instanceId` **внутрь** `variables` — это уже существующий тестовый паттерн,
эксплуатирующий как раз `variables`-fallback путь; он остаётся зелёным без
изменений (не «истинная» форма живого job, но допустимая fallback-форма).

## 4. Почему не поменяли process-start.ts (альтернатива, отклонена)

Альтернативный фикс — стемпить `choros_instanceId`/`choros_processKey` как
реальные Flowable process-переменные при `startInstance` — был отклонён:
(а) он потребовал бы менять BPMN-переменные КАЖДОГО процесса, тогда как
`process_def_id`/`instance_id` уже существуют как выделенные DB-колонки
специально для этой цели (T-0534's design intent — migration 111's docstring:
«Captures the Flowable processDefinitionKey and processInstanceId at
fetchAndLock time... so triage seam can scope rule-table lookups... rather
than relying on process variables»); (б) `enqueue()` УЖЕ писал правильные
значения — недостающим звеном было ЧТЕНИЕ, не запись; протягивать существующие
колонки — меньший, более локальный и более безопасный диф, чем трогать
BPMN-переменные каждого authored-процесса.

## 5. Обратная совместимость

- Legacy job (enqueued до T-0534/migration 111, или чей enqueue-путь не
  передал process scope) → `process_def_id`/`instance_id` NULL в БД →
  `Job.processDefId`/`instanceId === null` (не undefined-краш) →
  `readJobVars()` падает в `variables`-fallback или итоговое `""` (безопасный
  degrade к defer, документированная существующая семантика).
- `PostgresAgentJobFetcher` (реальный путь) и `PostgresJobStore.fetchAndLock`
  (используется тестами/альтернативными вызывающими) оба протянуты —
  паритет между двумя копиями CTE.
- Ни одной миграции не добавлено — колонки существуют с 111.

## 6. Проверено (см. pr-handoff.json `gate_results` для точных чисел)

DB/unit-тесты на обе реализации fetchAndLock (PostgresJobStore и
PostgresAgentJobFetcher), unit-тест на readJobVars/assembleAgentStepContext
(мутационно-красный — воспроизводит ровно `ctx.instanceId===""` до фикса,
подтверждённый git-stash прогоном), обратная совместимость (NULL-колонки, job
без instanceId), cross-tenant scoping (process_def_id/instance_id не текут
между тенантами). `tsc --noEmit`, `eslint src`, `vitest run` (весь unit-набор),
`npm run fitness:db` соло, `anti-case-lock.sh`, `flowable-bridge-contract.sh`,
`agent-bridge-contract.sh` — все зелёные.
