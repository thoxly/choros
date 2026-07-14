# T-0614 — Спека: деТЭЛизация `projectionToInstance` (имя/прогресс/исполнители инстанса)

**Status:** ready
**Phase:** SPEC
**Task:** T-0614 [P1, деТЭЛизация]
**Date:** 2026-07-03
**База:** dev @ `6fe5d7b` (ветка `task/T-0614-instance-name-detel`)

---

## 1. Контекст (живой факт, вскрыт фаундером 2026-07-03)

`projectionToInstance` (`src/http/processes.ts:201-231`) — маппер `InstanceProjection` →
`ProcessInstance` (wire-шейп `GET /api/processes` / `GET /api/processes/:id` в DB-режиме).
Три поля на нём были ЗАШИТЫ кейс-литералами линейного ТЭЛ, независимо от реального
процесса:

- `name: "Канонический линейный ТЭЛ"` (`:218`) — присваивалось КАЖДОМУ инстансу, любого
  процесса. Живой факт: и purchaseApproval, и acceptance-demo инстансы показывались в
  списке `/processes` под одним и тем же именем «Канонический линейный ТЭЛ», хотя
  `process_definition.name` для этих процессов честно содержит «Согласование закупки» /
  «Приёмка демо».
- `progress = p.status==="done" ? {done:3,total:3} : {done:2,total:3}` (`:211`) — зашиты 3
  узла ИМЕННО линейного ТЭЛ (`tel-linear.bpmn20.xml`), независимо от реального количества
  шагов процесса.
- `execs: ["human", "agent"]` (`:226`) — зашитый список типов исполнителей, не связанный с
  тем, кто реально стартовал/вёл инстанс.

Это токсичный ТЭЛ-осадок доктрины D-064 (столп «универсальный конструктор, не вертикаль
под один кейс») — три места, где универсальный движковый read-путь (`InstanceProjection`,
audit-backed, ADR T-0278 §2.3) вырождается обратно в кейс-хардкод на последнем шаге
(display-мэппинге).

## 2. Разведка (карта фактов, file:line)

### 2.1. `name` — где уже есть честный паттерн

- `src/core/process-catalog-view.ts:82-86` (`fallbackDefinitionName`) уже решает РОВНО
  эту задачу для каталога процессов (`GET /api/process-catalog`): имя из
  `choros.process_definition.name` (модельные определения) с фолбэком
  `fallbackDefinitionName(processKey)` для движковых-only ключей (сегодня — только
  `"telLinear"` возвращает честную метку «Канонический линейный ТЭЛ»; остальные ключи —
  сырой `process_key`). `buildCatalogDefinitions` (`:96-131`) мержит modeler-строки
  (`choros.process_definition`, migrations/074) и engine-observed ключи БЕЗ фабрикации.
- `src/http/process-catalog.ts:190-198` (`listProcessDefRows`) — рабочий SQL-паттерн:
  `SELECT DISTINCT ON (process_key) process_key, name, version, status, deployment_id,
  updated_at FROM choros.process_definition WHERE tenant_id=$1 ORDER BY process_key,
  version DESC` — латест-версия на process_key, tenant-scoped RLS.
- `src/http/processes.ts` НЕ может импортировать `pg`/`src/db/*` напрямую — файл
  промаркирован display-plane-pure (комментарий `:10-15`, FF-DISPLAY-4/FF-7-3,
  `ci/checks/pack-serve-no-write.sh` + `ci/checks/start-route-isolation.sh`): GET-путь
  читает движковое состояние ТОЛЬКО через `process-projection.ts` (который несёт `pg`,
  `:26-28` import). Значит имя определения ДОЛЖНО прийти в `InstanceProjection` —
  протянуто тем же projection-модулем, не отдельным прямым запросом из `processes.ts`.
- `src/http/process-projection.ts` УЖЕ несёт `pg` (`:33` import) и уже открывает
  tenant-scoped `pg.PoolClient` внутри `readEvents`/`withTenant` (`:797-810`) для чтения
  `choros.audit_event` — тот же клиент/транзакция может честно прочитать
  `choros.process_definition` без нового пула.

### 2.2. `progress` — что реально известно проекции

- Проекция (`listInstanceProjections`, `:813-891`) — чисто append-only audit-фолд (ADR
  §2.3, ЗАМОРОЖЕННЫЙ контракт: "НЕ live-Flowable запрос... НЕ новая таблица"). Она не
  хранит и не может дёшево получить общее число BPMN-узлов процесса (для этого
  потребовался бы live-запрос к движку/парсинг BPMN-XML — архитектурно другая работа,
  явно отвергнутая ADR §2.3 как disproportionate).
- Что проекция УЖЕ честно знает на каждый инстанс (без похода к движку):
  - `baseApproved` (`approvedTaskIds.has(row.id)`, `:869`) — пройден ли базовый
    approve-шаг;
  - количество APPROVED `process.next_task` строк для инстанса (пост-гейтвей шаги,
    уже завершённые — сегодня фолд считает только PENDING next_task через
    `pendingNextTaskInstanceIds`/`concurrentNextStepsByInst`, `:825-845`; APPROVED
    next_task строки этого инстанса сегодня НЕ агрегируются нигде, но легко посчитать
    из уже прочитанных `nextTaskRows` + `approvedTaskIds`);
  - `concurrentSteps.length` (`:867-876`) — число ТЕКУЩИХ параллельных ожидающих шагов.
- Значит честная МИНИМАЛЬНАЯ метрика прогресса, выводимая БЕЗ фабрикации и БЕЗ похода к
  движку: `done` = число уже пройденных шагов ЭТОГО инстанса (базовый approve, если он
  был + approved next_task строки); `total` = `done` + число ТЕКУЩИХ ожидающих шагов
  (`concurrentSteps.length`) для waiting-инстанса, либо `total = done` для done-инстанса
  (нет более шагов, которые проекция могла бы честно предсказать вперёд). Это НЕ полный
  BPMN-прогресс (не знает будущих непройденных узлов дальше по графу) — явный follow-up
  (§6 O1) на живой BPMN-интроспекцию/движковый счётчик total-user-task-count.

### 2.3. `execs` — что реально известно об исполнителях

- `InstanceProjection`/`StartedRow` несёт `actor: string` (`:310`, `row.actor`,
  `process-projection.ts:731-739` SELECT) — актёр, СТАРТОВАВШИЙ инстанс
  (`args.actor` в `appendProcessStarted`, `:305-354`). Это ЕДИНСТВЕННЫЙ конкретный,
  привязанный к записи actor-идентификатор в проекции сегодня (approve/next_task пишут
  СВОЕГО actor'а в `audit_event.actor`, но не пробрасывают его в `InstanceProjection`
  как отдельное поле на инстанс — расширение этого пришлось бы делать для КАЖДОГО шага
  отдельно, вне периметра этой задачи).
- Канонический паттерн резолва human/agent для актёра — `src/http/inbox.ts:1370-1379`
  (`actorKind`): `findEmployeeById(pool, tenantId, actorId)` →
  `emp?.type === "agent" ? "agent" : "human"`, non-fatal degrade к `"human"` на ошибку
  резолва (актёр не найден / DB-ошибка) — тот же паттерн уместен здесь.
- `src/db/org.ts:191-224` (`findEmployeeById`) — `employee.kind` в БД (`choros.employee`)
  реально принимает ТОЛЬКО `"human" | "agent"` (нет колонки/значения `"service"` нигде в
  org-модели; `migrations/093_agent_taxonomy_employee_nullable.sql:60` вводит
  `agent_type IN ('workforce','system','assistant')` — под-классификация ВНУТРИ
  `"agent"`, не отдельный `"service"`-kind). Значит `"service"` в
  `ProcessInstance.execs` union НИКОГДА не выводим честно из текущей org-модели —
  фабриковать его было бы новым кейс-хардкодом. Follow-up (§6 O2): если/когда
  service-исполнители (движковые service-task, таймеры, интеграции) появятся в
  org-модели или в самой проекции, `execs` сможет честно включать `"service"`.
- `appendTaskApproved`/`appendInstanceEnded` (`:481-484`, `:550`) сами ЖЁСТКО
  прописывают `projectActorType("human", "user-task")` для events approve/end
  (комментарий признаёт: «approve path is always a human user-task») — это
  архитектурное упрощение ВНЕ периметра этой задачи (не кейс-литерал в смысле D-064:
  это структурное свойство самого write-пути «инбокс = человеческое approve», а не
  случайный литерал имени/числа). Не трогаем.

## 3. Решение (одной фразой на каждую дыру)

1. **`name`**: `InstanceProjection` получает НОВОЕ обязательное поле `definitionName:
   string`. `listInstanceProjections` резолвит его из `choros.process_definition.name`
   (латест-версия по `process_key`, tenant-scoped, тот же паттерн что
   `listProcessDefRows`) одним batched SELECT по всем `process_key`, встреченным в
   тек���щей выборке; когда строки определения нет (движковый-only ключ, например
   `telLinear` без modeler-записи) — фолбэк `fallbackDefinitionName(procKey)`
   (переиспользован из `src/core/process-catalog-view.ts`, не задублирован).
   `projectionToInstance` (`processes.ts`) читает `p.definitionName` вместо литерала —
   файл остаётся display-plane-pure (данные приходят ЧЕРЕЗ `InstanceProjection`, импорт
   `pg`/`src/db/*` в `processes.ts` не добавляется).
2. **`progress`**: `InstanceProjection` получает `stepsDone: number` и
   `stepsKnownTotal: number`, вычисленные из уже прочитанного audit-фолда (§2.2) —
   ЧЕСТНОЕ число пройденных/известных-на-сейчас шагов ЭТОГО инстанса, не 3
   зашитых узла линейного ТЭЛ. `projectionToInstance` строит
   `progress = {done: p.stepsDone, total: p.stepsKnownTotal}`. Явно НЕ полный
   BPMN-total (см. §6 follow-up) — минимально-честный шаг вместо фабрикации точности.
3. **`execs`**: `InstanceProjection` получает `starterActorKind: "human" | "agent"`,
   резолвленный через `findEmployeeById` (тем же паттерном что `inbox.ts:1372-1379`,
   non-fatal degrade к `"human"` при отсутствии/ошибке). `projectionToInstance` строит
   `execs: [p.starterActorKind]` — один честно известный исполнитель (тот, кто
   стартовал инстанс), не зашитая пара `["human","agent"]`. `"service"` не
   фабрикуется (§2.3 — нет источника правды).

## 4. Функциональные требования

- **F1.** `listInstanceProjections` batched-резолвит `definitionName` для каждого
  `procKey` из `choros.process_definition` (латест версия, tenant-scoped RLS); при
  отсутствии строки — `fallbackDefinitionName(procKey)`. Разные `procKey` в одном
  ответе получают РАЗНЫЕ честные имена (regression-доказательство: два инстанса разных
  процессов НЕ показывают одинаковый литерал «Канонический линейный ТЭЛ»).
- **F2.** `projectionToInstance` (`processes.ts`) присваивает `name: p.definitionName`
  — литерал `"Канонический линейный ТЭЛ"` удалён из этого файла (может остаться как
  ИМЕНОВАННЫЙ фолбэк-конфиг-примитив в `process-catalog-view.ts`, где он уже легитимно
  живёт как `fallbackDefinitionName`, — не задваивается вторым хардкодом здесь).
- **F3.** `listInstanceProjections` вычисляет `stepsDone`/`stepsKnownTotal` из
  уже прочитанного audit-фолда (baseApproved + approved next_task count;
  `concurrentSteps.length` для known-total). `projectionToInstance` строит
  `progress` из этих полей — литерал `{done:2,total:3}`/`{done:3,total:3}` удалён.
- **F4.** `listInstanceProjections` резолвит `starterActorKind` через
  `findEmployeeById(pool, tenantId, row.actor)` (non-fatal, degrade `"human"`).
  `projectionToInstance` строит `execs: [p.starterActorKind]` — литерал
  `["human","agent"]` удалён.
- **F5.** Регресс: существующие consumers `InstanceProjection` (`reconcileInstanceTimers`,
  `reconcileInstanceEngineDrive`, `reconcileInboxEngineDriveOnRead`,
  `makeEngineMessageSubscriptionSource`) продолжают работать без изменений — новые поля
  ADDITIVE, не меняют существующие поля/сигнатуры функций, которые их НЕ читают.

## 5. Нефункциональные требования

- **N1.** D-064: никаких новых кейс-литералов («телleft»/ТЭЛ-имя/`purchaseApproval`/
  зашитых чисел узлов) в `src/`. `bash ci/checks/anti-case-lock.sh` +
  `detel-literal-baseline.sh` + `detel-base-task-from-engine.sh` остаются зелёными;
  агрегат ТЭЛ-литералов в `processes.ts` уменьшается (было 3 захардкоженных места:
  name/progress/execs → 0 после фикса; фолбэк-имя остаётся ЕДИНСТВЕННЫМ разрешённым
  местом, `process-catalog-view.ts`, уже существовал до этой задачи).
- **N2.** display-plane-purity `processes.ts` не нарушается: файл НЕ импортирует
  `pg`/`src/db/*` напрямую после фикса (все новые данные идут через
  `InstanceProjection`, экспортированный `process-projection.ts`).
- **N3.** Честная деградация: резолв имени определения / actor-kind при ошибке БД
  (или отсутствии строки) НЕ 500-ит и НЕ ломает существующий waiting/done-статус —
  падает на именованный фолбэк (`fallbackDefinitionName` / `"human"`).
- **N4.** Не фабриковать точность, которой нет: `progress.total` — честно
  «известно на сейчас», не полный BPMN-граф. Зафиксировано как follow-up, не выдаётся
  за законченное решение.

## 6. Вне рамок (out of scope, follow-up)

- **O1.** Точный `progress.total` = полное число user-task узлов BPMN-определения
  (требует движковой интроспекции/парсинга BPMN XML определения — большая работа,
  ADR §2.3 явно отвергла live-Flowable запрос на каждый read как disproportionate).
  Текущий шаг даёт честный "known so far" счётчик вместо фабрикации; полный total —
  отдельная задача (см. ADR §4).
- **O2.** `execs` с `"service"` — сегодня не выводим честно (org-модель не имеет
  service-kind сотрудника). Как только появится источник правды (движковый
  service-task исполнитель / отдельная сущность), `execs` может быть расширен.
- **O3.** `execs` по КАЖДОМУ шагу инстанса отдельно (не только стартовавший actor) —
  потребовало бы протянуть actor через approve/next_task события В
  `InstanceProjection` как массив по шагам — отдельная задача.

## 7. Acceptance criteria

См. `docs/specs/T-0614.spec.contract.json` (AC-1..AC-10).
