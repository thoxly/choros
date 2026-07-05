# ADR-T0638 — Взятая defer-задача продвигает процесс (столп 4 P0)

Столп 4 (АГЕНТЫ-с-правами-как-сотрудники) + столп 3 (бесшовность). Статус: BUILD.

## 1. Что доказал разбор (кейс докооборот — агент отложил, человек доделывает)

Механика defer УЖЕ построена и завёрнута верно на уровне ACCEPTED DECISION 1
(`src/runtime/agent-dispatch/dispatch-outcome.ts`): когда агент откладывает шаг
(`defer-to-human`), его СОБСТВЕННАЯ внешняя задача в Flowable (external task на
топике `agent-step`) ЗАКРЫВАЕТСЯ немедленно — `jobStore.complete` +
`task_completed` outbox → `completeTask` в Flowable — и токен уходит ДАЛЬШЕ по
BPMN. Одновременно пишется ОДНО `agent.deferred` audit-событие — это и есть
видимая человеку карточка эскалации в инбоксе (D-061, без новой таблицы).

Но человек, взявший эту карточку и нажавший «Согласовать»/«Выполнить шаг»,
бил в `POST /api/inbox/:id/action`, которая ищет задачу ТОЛЬКО через
`findWaitingInstanceTask` → `listInstanceInboxTasks` (проекция audit-типов
`process.started`/`process.next_task`). `agent.deferred` — другой audit-тип,
которого там никогда нет → `404 "no waiting instance task with this id"`.
Инстанс висел вечно НЕ потому, что движок завис (движок УЖЕ продвинулся в
момент defer), а потому, что:

1. Реальный downstream userTask инстанса, на который токен уже пришёл, НИКОГДА
   не проецировался в инбокс отдельной строкой (ни один из четырёх
   reconcile-on-read путей — таймер/message/engine-drive-on-read — не
   срабатывает на «агент только что закрыл свою внешнюю задачу»).
2. Единственная видимая строка — сама `agent.deferred` карточка — не несла
   способа завершить ЧТО-ЛИБО в движке: клик на ней всегда бил в
   `findWaitingInstanceTask`, для которого её id структурно не существует.

Три сопутствующих дефекта одного контура:

2. **«Эскалации» не растёт.** `findInboxItems`'а defer-merge блок строил
   `InboxItem` без поля `escalated`; `inTab('esc',...)` проверяет только
   `item.escalated===true || status==='failed'` — ни то, ни другое никогда не
   было true для waiting-defer-строки.
3. **Сырой английский.** `doubt_reason` приходит буквально из кода
   (`"no published instruction for agent"`, `"llm runtime dormant — inference
   not available"`, `"autonomy threshold not met"`, `"answer marked
   ambiguous"`, критичность/бюджет-строки) и течёт НЕ ТОЛЬКО в поле
   `doubt_reason`, но и в `name` («Проверить: <raw>») — человеко-видимое поле
   списка задач.
4. **Хардкод-адресация.** `dispatch-outcome.ts` падает на
   `resolveDefaultApproverRole()` (ENV `CHOROS_DEFAULT_APPROVER_ROLE`, дефолт
   `"role-approver"`); `run-precheck.ts` и `deferred-inbox-store.ts` падают на
   литерал `"fin-ctrl"` — НИ ОДИН путь не проверяет, есть ли у этой роли
   реальные держатели в тенанте. Владелец без этой роли (как в постановке)
   не увидит задачу как «свою из пула» и не сможет её взять честно.

## 2. Решение — не изобретать новый API, переиспользовать существующий

**Ключевое наблюдение:** к моменту клика человека агентская внешняя задача УЖЕ
закрыта (ACCEPTED DECISION 1 не меняется и не должна меняться — это
корректное решение T-0378: «шаг агента ВСЕГДА закрывается»). Значит,
«завершить агентский external task» в буквальном смысле — уже поздно и не
нужно; то, что реально требуется — это **продвинуть движок дальше** тем же
путём, каким уже продвигается ОБЫЧНЫЙ approve базовой (`process.started`)
задачи: **resolve-by-instance** через `reconcileInstanceEngineDrive` с
`approvedTaskDefKey: undefined` (T-0571 §2.1) — движок сам находит ЖИВОЙ
активный userTask этого инстанса (какой бы он ни был — тот же шаг, следующий
шаг, что угодно, что реально ждёт) и завершает его.

Это ТОТ ЖЕ API, тот же типизированный 502-контракт
(`ENGINE_TASK_NOT_FOUND`/`AMBIGUOUS_ACTIVE_TASK`/`ENGINE_DRIVE_TIMEOUT`), что
уже используется на пути обычного approve (`src/http/inbox.ts`, строки ~1863+)
— НИКАКОГО нового engine-API, никакой повторной попытки завершить уже закрытый
job.

### 2.1 Маршрутизация: `POST /api/inbox/:id/action` — defer-resolve ветка

Когда `findWaitingInstanceTask(pool, tenantId, taskId)` возвращает `null`,
ДОБАВЛЯЕТСЯ второй look-up: `listDeferredInboxTasks(pool, tenantId)` ищет
строку с `id === taskId`.

- Не найдена → честный `404 NOT_FOUND` (не изменилось для «вообще неизвестного
  id»).
- Найдена, но `instanceId === null` (легаси-событие без `payload.instance_id`
  — например, путь `run-precheck.ts`/`demo-run.ts`, не являющийся живым
  production-путём) → честный `404 DEFER_NOT_ROUTABLE` с человеческим
  сообщением («эта отложенная задача не привязана к процессу — продвинуть её
  нельзя»). НЕ тихий no-op 200, НЕ попытка вызвать движок с id, который заведомо
  отсутствует.
- Найдена, `instanceId` есть → **defer-резолюция**:
  1. Та же authz-дисциплина, что и у обычного approve (deny-by-default): актор
     должен держать роль задачи ИЛИ иметь Tier-2-заместительство
     (`resolveTier2SubstitutionClaim`, переиспользуется байт-в-байт); та же
     деактивация-проверка.
  2. Записывается ОДНО audit-событие `agent.defer_resolved` (открытый
     словарь типов — как `agent.deferred`/`agent.proceeded`/`agent.blocked`
     уже существуют; НЕ новая таблица, `defer-no-new-table.sh` НЕ трогается).
     Payload: `{inbox_task_id, resolved_by, instance_id, proc_key, outcome}`.
  3. `reconcileInstanceEngineDrive(pool, tenantId, flowableClient, {instanceId,
     procKey, completeEngineTask: true, approvedTaskDefKey: undefined,
     actor, driveDeadlineMs})` — resolve-by-instance, тот же путь, что и
     approve базовой задачи.
  4. Ответ — тот же конверт `{instanceId, status, action, outcome, engine}` /
     `502 {error:{code,stage,engineCode,instanceId}}`, что и обычный approve —
     фронту (`screen-inbox.jsx`) не нужно знать, что это была defer-задача.

### 2.2 F1 — DAO несёт реальный instanceId/procKey

`src/db/deferred-inbox-store.ts`'s `DeferredInboxRow` расширяется
`instanceId: string | null` и `procKey: string | null`, читаемыми из
`payload.instance_id`/`payload.proc_key` (уже пишутся `dispatch-outcome.ts`'s
`deferredAuditEvent`, но раньше DAO их игнорировал). Поле `inst` (человеческая
строка, уже отображаемая в UI) НЕ меняется — оно и раньше не было настоящим
instanceId (было `subject` = `agent:<actorId>`), новые поля существуют РЯДОМ
специально для машинной маршрутизации, аддитивно.

### 2.3 F7 — defer = эскалация (дефект №2)

`findInboxItems`'а defer-merge блок теперь ставит `escalated: true` на КАЖДЫЙ
построенный defer `InboxItem`. Defer — эскалация по определению (агент
отказался решать автономно); `inTab('esc', ...)` уже проверяет
`item.escalated === true` — правка чисто в производителе строки, ноль правок в
самой логике вкладки.

### 2.4 F3 — human-readable doubt_reason (дефект №3)

Новая ЧИСТАЯ функция `humanizeDoubtReason` (`src/core/defer-inbox-producer.ts`)
— таблица точных соответствий: закрытый список ИЗВЕСТНЫХ структурных литералов,
авторски написанных в движке (`run-agent-step.ts`/`run-precheck.ts`/
`classifyOutcome`'s `??`-дефолты) → человеко-читаемая русская фраза. ЛЮБАЯ
другая строка (LLM-сгенерированный текст агента, динамическое «model
confidence 0.42 below floor 0.70») проходит НЕ ТРОНУТОЙ — это анти-кейс
дисциплина: словарь ИНЖЕНЕРНЫХ констант, а не переписывание кейс-контента, и
диагностика для незнакомой причины не теряется (тот же принцип, что уже
применён к `ACTION_ERROR_MESSAGE`/`CLAIM_ERROR_MESSAGE` в
`screen-inbox.jsx`).

`planDeferTask` вызывает `humanizeDoubtReason` ПЕРЕД тем, как строить
`name`/сохранять `doubtReason` — единая точка перевода для ОБОИХ потребителей
(`run-precheck.ts` и `dispatch-outcome.ts`, оба зовут `planDeferTask`).
`deferred-inbox-store.ts` ТАКЖЕ гуманизирует на чтении (защитно — покрывает
строки, записанные ДО этой задачи, чьи `payload.doubt_reason`/`defer_name`
навсегда останутся сырыми в БД) и ВСЕГДА пересобирает `name` из уже
гуманизированного `doubtReason`, а не доверяет сохранённому `defer_name`
(который является производным полем — доверие ему после фикса заново
просачивало бы сырой английский из старых строк).

### 2.5 F6 — честная адресация (дефект №4)

Вместо того чтобы менять сам литерал-фолбэк на запись (что просто заменило бы
один хардкод другим), фикс идёт на ЧТЕНИЕ: `findInboxItems`'а defer-merge блок
переиспользует УЖЕ существующий батч-резолвер `resolveExecutorFallbackBatch`
(T-0380 D4) — ТОТ ЖЕ механизм, что уже честно адресует обычные instance-задачи
с незаполненной ролью. Для НЕклеймленных defer-строк: если у `row.role` нет
подтверждённых держателей в тенанте — ставится `routed_to_fallback:
"role_unfilled"` (то же поле, что уже использует UI/нотификации для instance-
задач), и держатель резолвится на `findTenantOwnerSlug` (владелец тенанта) —
та же честная лестница, что уже задокументирована для F6/F7 T-0380. Роль С
держателями — ничего не меняется (ни `item.role`, ни адресация).

Запись (`dispatch-outcome.ts`'s `deferRole: ctx.roleId !== "" ? ctx.roleId :
resolveDefaultApproverRole()`) НЕ трогается — `ctx.roleId` (роль, которую агент
реально держит для шага) остаётся первичным источником, конфиг-примитив-
фолбэк — только когда она пуста. Это НЕ регресс: честная адресация теперь
гарантирована на чтении НЕЗАВИСИМО от того, какой литерал попал в
`defer_role` на запись.

## 3. Инварианты (не меняются)

- **D-061 / defer-no-new-table.sh**: `agent.defer_resolved` — открытый
  словарь audit-типов, НЕ новая таблица/колонка. `known_tenant_tables.txt`
  не трогается.
- **ACCEPTED DECISION 1** (T-0378): агентский шаг ВСЕГДА закрывается на
  defer — НЕ меняется. Человек НЕ пытается повторно завершить уже закрытый
  external task; он продвигает то, что движок УЖЕ открыл следующим.
- **PDP/authz**: defer-резолюция проверяет ТУ ЖЕ approve-грант-дисциплину
  (myRoles/Tier-2-substitution), что и обычный approve — не новый путь без
  грантов.
- **Анти-кейс (D-064)**: 0 новых литералов ролей/тенант-слагов в `src/`.
  `detel-literal-baseline.sh`/`anti-case-lock.sh` ("role-approver": baseline 3,
  фактически 2/3 до этой задачи, эта задача НЕ добавляет новых вхождений)
  остаются зелёными без изменения baseline.

## 4. Альтернативы, отклонённые

- **Попытка «завершить агентский external task повторно»** — отклонено: к
  моменту клика человека job УЖЕ закрыт (`jobStore.complete`), а внешняя
  задача Flowable уже удалена движком; повторный `completeTask` на
  несуществующий/чужой `externalTaskId` дал бы `404`/гонку с воркером, а не
  решение проблемы (проблема НЕ в агентском шаге, а в том, что downstream
  шаг не виден/не завершаем).
- **Хранить `externalTaskId` агента и пытаться его «переоткрыть»** — отклонено:
  противоречило бы ACCEPTED DECISION 1 (шаг агента должен оставаться
  закрытым; переоткрытие означало бы, что агент «ещё выполняет» шаг, которого
  для него больше нет) и потребовало бы нового состояния/таблицы.
- **Хардкодить новый явный fallback-литерал вместо `resolveExecutorFallbackBatch`
  переиспользования** — отклонено: заменило бы один хардкод другим, не решая
  корень (проверка держателей роли), и нарушило бы анти-кейс дисциплину
  (`anti-case-lock.sh` `role-approver` уже на потолке baseline=3).

## 5. Изменённые файлы

- `src/core/defer-inbox-producer.ts` — `humanizeDoubtReason` + вызов в
  `planDeferTask`.
- `src/db/deferred-inbox-store.ts` — `instanceId`/`procKey` в
  `DeferredInboxRow`; гуманизация на чтении; `name` всегда пересобирается.
- `src/http/inbox.ts` — defer-resolve ветка в `POST /api/inbox/:id/action`;
  `escalated: true` + honest-addressing fallback (`resolveExecutorFallbackBatch`)
  в `findInboxItems`'а defer-merge блоке.
- `web/src/screens/screen-inbox.jsx` — `ACTION_ERROR_MESSAGE.DEFER_NOT_ROUTABLE`.
- Тесты: `src/core/__tests__/defer-inbox-producer.test.ts` (humanization),
  `src/__tests__/inbox-defer-resolve.test.ts` (defer-resolve HTTP branch,
  unit/fake-pool), `ci/checks/db/inbox-defer-escalation.db.test.ts` (live-DB:
  escalated tab + honest fallback), `src/runtime/legal-precheck/__tests__/run-precheck.test.ts`
  (updated golden assertion for humanized doubt_reason).
