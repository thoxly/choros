# ADR-T0609 — Честные ресурсы формы «Дать роли право» + переменные/история инстанса

**Status:** ready
**Phase:** DESIGN
**Task:** T-0609 [P1]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0609-rights-real-resources.spec.md` + `docs/specs/T-0609.spec.contract.json` (AC-1..AC-17)
**База:** dev @ `51fbc32` (ветка `task/T-0609-rights-real-resources`, содержит T-0605)
**Ревизия:** после независимого ревью (839a53e, BLOCKING F-1) §1.1–§1.3 переработаны:
грант из формы должен РЕЗОЛВИТЬСЯ PDP — форма эмитит resource-hierarchy scope для
реальных ресурсов (путь A ревью); первая редакция §1.3 рамила разрыв как «выбор формата
resource_type» — снято как вводящее в заблуждение (enforcement решает scope-иерархия,
не формат строки).

---

## 1. Решение — ресурсы формы «Дать роли право»

**Новый read-only эндпоинт `GET /api/rights/resources`, новый файл
`src/http/rights-resources.ts`.** НЕ трогает `src/http/grants.ts` (заморожен байт-в-байт,
`ci/checks/rights-ui-frozen-write.sh`, T-0572 FF-T0572-FROZEN).

### 1.1. Серверная часть

```ts
// src/http/rights-resources.ts (НОВЫЙ файл) — каждая запись:
// {
//   uri:  `registry:<app_slug>` | `registry:<app_slug>.<reg_slug>`,  // display-метка (→ resource_type)
//   name: display_name (для реестра — `<app> · <reg>`),
//   id:   реальный UUID application/registry_def,                     // ← enforcement: scope.nodeId
//   node_level: 'application' | 'registry',                           // ← enforcement: scope.nodeLevel
// }
// Тенант-скоуп: extractActor → resolveActorTenant → listApplications/
// listRegistryDefs (ПЕРЕИСПОЛЬЗОВАНЫ из applications.ts / registry-defs.ts,
// RLS через их собственный withTenantTx). Регистрация — server.ts, DB-режим.
```

**`uri` формат: `registry:<application_slug>[.<registry_slug>]`** — человекочитаемая
display-метка, уходящая в `resource_type` (grant-trail/обзор показывают её как есть;
слаг читаем там, где UUID был бы шумом). **`id` + `node_level` — enforcement-идентичность
(фикс F-1)**: PDP-предикат (`resolveFor`/`isRecordReadable`) матчит грант ТОЛЬКО по
scope-содержанию в resource-иерархии и НЕ читает `resource_type` — поэтому конкретный
ресурс адресуется в `scope = {kind:'node', hierarchy:'resource', nodeId:<id>,
nodeLevel:<node_level>}`, ровно как канонический READ-PDP грант (миграция 117); composite
resource-ancestry oracle (`src/db/resource-ancestry.ts` rules 1/3) покрывает
record→registry→application цепочку без нового кода.

Функция регистрируется В `server.ts` рядом с `registerApplicationRoutes`/
`registerRegistryDefRoutes` (когда `grantsPool` присутствует — DB-режим), НЕ заменяет и не
перехватывает `registerDictionariesRoute` (тот путь, `GET /api/rights/dictionaries`,
остаётся байт-в-байт как есть — заморожен).

### 1.2. Клиентская часть

`web/src/screens/rights/screen-rights.jsx` добавляет `fetchRealResources()` (тот же паттерн,
что `fetchDictionaries()`/`fetchEmployees()` — best-effort, `[]` на ошибку) и передаёт
`GrantRightForm` ОБЪЕДИНЁННЫЙ массив: реальные ресурсы тенанта первыми, затем
`dictionaries.resources` (демо) — демо-записи ТЕГИРУЮТСЯ `demoSeed` на merge-точке
(UX-2: различимость реального и демо). `GrantRightForm` (F-1 фикс):

- **Реальный ресурс** (запись несёт `id` + `node_level`): форма эмитит
  `scope = {kind:'node', hierarchy:'resource', nodeId:<id>, nodeLevel:<node_level>}` —
  org-`ScopePicker` НЕ рендерится (охват гранта ЕСТЬ узел ресурса; сужение по
  подразделению для resource-гранта в одноэлементной scope-модели невыразимо), вместо
  него честная строка «Охват: ресурс целиком — право действует на все записи …».
  Тост — прежний «Право выдано.» (теперь честный: грант РЕЗОЛВИТСЯ).
- **Демо-ресурс** (`demoSeed`, без `id`): прежний org-scope путь БЕЗ изменений, но
  (а) пункт селектора помечен «· демо», (б) при выборе — честная подсказка
  «право появится в обзоре ролей, но не ограничивает доступ к данным тенанта»,
  (в) success-тост КВАЛИФИЦИРОВАН («Право выдано (демо-ресурс: попадёт в обзор ролей,
  но не ограничивает доступ к данным).») — ложного успеха для инертного гранта нет
  (UX-1 blocking закрыт вариантом «пометить», как разрешено ревью/направлением).

### 1.3. Enforcement-путь: почему scope, а не resource_type (ревизия после ревью F-1)

Первая редакция этого раздела рамила вопрос как «выбор формата resource_type» и называла
org-scope паттерн «равно легитимной конвенцией резолюции ресурса». **Это было вводящим в
заблуждение и снято.** Факты (доказаны живым probe ревью + пином RESOLVE-4 в
`ci/checks/db/rights-resource-grant-resolve.db.test.ts`):

- Covering-предикат PDP (`grant-resolver.ts:589-607`) фильтрует гранты по
  tenant+operation+isEffective+`isNarrowerOrEqual(handleScope, g.scope, ancestry)`.
  **`resource_type` в allow/deny НЕ участвует** (`refToResourceType` — только
  buildMaskContext, T-0033 маскировка).
- Runtime-запрос всегда несёт `handleScope {hierarchy:'resource', nodeId:<UUID>}`
  (`refToScope`); `isNarrowerOrEqual` короткозамыкает на несовпадении иерархий
  (`grant-lattice.ts:280`). **Org-scope грант структурно неспособен покрыть
  resource-запрос** — независимо от значения `resource_type`.
- Значит «наполнить resource_type реальными именами» БЕЗ смены scope-иерархии оставляло
  экран декоративным на enforcement-пути — ровно blocking-находка F-1.

Решение: для РЕАЛЬНЫХ ресурсов форма переходит на канонический enforcement-паттерн
(T-0570/миграция 117): конкретный ресурс в `scope` (resource-hierarchy, реальный UUID),
`resource_type` — display-метка. Это НЕ «второй формат»: это ЕДИНСТВЕННЫЙ формат, который
PDP вообще резолвит. Демо/пресет-стек (`DICT_PRESETS` — заморожен, оси критичности
`axesFromGrants`/`RES_BY_URI`, SoD-отображение) продолжает жить org-scope путём —
он питает ТОЛЬКО отображение и помечен честно в UI; его миграция — follow-up O2.

Живое доказательство enforcement-пути — `ci/checks/db/rights-resource-grant-resolve.db.test.ts`
(live PG, production-компоненты: реальный `POST /api/grants` → `makeDbGrantSource`/
`getGrantsForSubject` → `resolveFor` + `makeResourceAncestryOracle`):
- RESOLVE-1: грант телом формы (resource-hierarchy scope, nodeId=реальный registry UUID)
  → `resolveFor` РАЗРЕШАЕТ read записи этого реестра (`denied:false`).
- RESOLVE-2: запись чужого реестра/приложения → `no_grant`.
- RESOLVE-3: субъект другого тенанта → `cross_tenant` (fail-closed до чтения грантов).
- RESOLVE-4 (F-1 pin): грант ДО-фиксной формы (org-scope) → `no_grant` — регресс к
  org-scope эмиссии для реальных ресурсов красит suite.

## 2. Решение — переменные и история инстанса процесса

### 2.1. `FlowableClient` — два новых read-only метода

Добавляются в `src/core/flowable-client.ts` (НЕ заморожен), тем же паттерном, что
`getFirstActiveUserTask`/`isInstanceEnded` (`withRetry`, `httpStatusToCode`, `auth` header):

```ts
export interface HistoricVariable { readonly name: string; readonly value: unknown; }
export type GetHistoricVariablesResult =
  | { ok: true; variables: HistoricVariable[] }
  | { ok: false; code: FlowableErrorCode };

export interface HistoricActivity {
  readonly activityId: string;
  readonly activityName: string;
  readonly activityType: string; // startEvent|userTask|exclusiveGateway|parallelGateway|endEvent|...
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly assignee: string | null;
}
export type GetHistoricActivitiesResult =
  | { ok: true; activities: HistoricActivity[] }
  | { ok: false; code: FlowableErrorCode };
```

- `getHistoricVariableInstances(instanceId)`:
  `GET {baseUrl}/history/historic-variable-instances?processInstanceId={id}` →
  `{ data: [{variableName, value, ...}] }` → маппинг `{name: variableName, value}`.
- `getHistoricActivityInstances(instanceId)`:
  `GET {baseUrl}/history/historic-activity-instances?processInstanceId={id}&sort=startTime` →
  `{ data: [{activityId, activityName, activityType, startTime, endTime, assignee}] }` →
  маппинг 1:1 в `HistoricActivity` (сортировка проксируется движком через `sort=startTime`,
  клиент не сортирует повторно).

Оба — `{ ok:false, code }` на ЛЮБУЮ ошибку (никогда throw), как весь остальной клиент.

### 2.2. `GET /api/processes/:id` — расширение ответа

`src/http/processes.ts`, ветка `hasDb() && startDeps` (единственная ветка, где
`startDeps.flowable` доступен): после нахождения `match` (существующий код,
`processes.ts:392-397`) — ДОПОЛНИТЕЛЬНО, best-effort, ДО отправки ответа:

```ts
const [varsResult, actsResult] = await Promise.all([
  startDeps.flowable.getHistoricVariableInstances(instanceId),
  startDeps.flowable.getHistoricActivityInstances(instanceId),
]);
const variables = varsResult.ok ? varsResult.variables : [];
const history = actsResult.ok
  ? actsResult.activities.map(a => ({
      step: a.activityName || a.activityId,
      kind: a.activityType,
      startedAt: a.startTime,
      endedAt: a.endTime,
      completedBy: a.assignee,
    }))
  : [];
const historyAvailable = actsResult.ok;
res.end(JSON.stringify({ ...projectionToInstance(match), variables, history, historyAvailable }));
```

**Гейт НЕ меняется**: это остаётся ВНУТРИ существующей `if (actorSlug) { try {
tenantId = resolveActorTenant(...); ... } catch { /* 404 */ } }` ветки — variables/history
получает ТОЛЬКО тот, кто уже прошёл tenant-membership проверку для просмотра самого
инстанса (§2.5 спеки). Ни PDP, ни capability-гейт не добавляется и не убирается — точное
соответствие директиве задачи «не расширяй видимость сверх текущей».

Движок недоступен (`{ok:false}` от одного или обоих вызовов) → соответствующий массив
пустой + `historyAvailable:false` — ответ ВСЁ РАВНО 200 (честная деградация, не 500;
существующие поля status/node/progress и т.д. не зависят от движка и отдаются как раньше).

### 2.3. Frontend — `screen-process-instance.jsx` + `process-instance.logic.js`

- Новая секция «Переменные процесса» — таблица имя/значение, рендерится когда
  `instance.variables?.length > 0`; иначе не показывается (не «пусто», а честно отсутствует
  — переменные не в каждом процессе обязательны).
- Секция «История переходов» переключается: если `instance.historyAvailable === true` —
  рендерит `instance.history` (шаг/тип/начало/конец/кто закрыл) вместо best-effort
  audit-фильтрации; если `false` — прежнее поведение (audit-фильтр + честная заметка при
  пустом результате) СОХРАНЯЕТСЯ БЕЗ ИЗМЕНЕНИЙ (regression safety для не-Flowable/no-DB
  путей, где `historyAvailable` вообще отсутствует в ответе — `undefined !== true` даёт тот
  же старый путь).
- `process-instance.logic.js` получает чистые функции `formatHistoryStep(activity)` и
  `hasVariables(instance)` — тестируемые в node-vitest без DOM, тем же паттерном, что
  существующие `currentNodes`/`progressLabel`.

## 3. Отвергнутые альтернативы

1. **Правка `src/http/grants.ts` (`DICT_RESOURCES`) напрямую, добавив DB-чтение внутрь
   `registerDictionariesRoute`.** Отвергнуто — файл заморожен байт-в-байт
   (`ci/checks/rights-ui-frozen-write.sh`), любая правка красит CI. Даже если бы не был
   заморожен: смешивать «сид-словарь дня-1» с «живой DB-запрос» в ОДНОМ хендлере без
   пула (`registerDictionariesRoute(router)` регистрируется БЕЗ `pool` вообще,
   `server.ts:587`) — более инвазивная правка сигнатуры, чем отдельный новый эндпоинт.

2. **[ПЕРЕСМОТРЕНО после ревью F-1] Оставить эмиссию формы на org-scope, ограничившись
   наполнением `resource_type` реальными именами.** Первая редакция ADR так и решила —
   ревью доказало живым probe, что такой грант ИНЕРТЕН на PDP (org-scope структурно не
   покрывает resource-запрос, §1.3) — т.е. экран остаётся декоративным, ровно blocking-режим
   отказа. Отвергнуто; принят путь A ревью: реальные ресурсы эмитят resource-hierarchy
   scope (реализовано, §1.1–§1.3). Что ПО-ПРЕЖНЕМУ отвергнуто в этой задаче — миграция
   ДЕМО/пресет-стека (`DICT_PRESETS` — 14 замороженных пресетов, `axesFromGrants`/
   критичность-оси, SoD-отображение) на resource-hierarchy: он питает только отображение,
   честно помечен в UI («· демо» + квалифицированный тост) и уходит в follow-up O2.
   Вариант B ревью (только задокументировать/пометить, БЕЗ починки резолва реальных
   ресурсов) отвергнут: доступность реального ресурса «для грантов» и означает
   резолвимость выданного гранта.

3. **Слить `ScopePicker`'ово оргдерево с реальной `/api/org` оргструктурой в этой же
   задаче.** Отвергнуто — структурно другая модель (`department/position/employee` vs
   лестница охвата гранта `nodeLevel`), нужно сначала решить продуктовую семантику «узел
   охвата» = что именно (department id? Произвольный тег?) — отдельное архитектурное
   решение. Follow-up O1, как и прямо разрешено формулировкой задачи.

4. **Проксировать переменные/историю через `GET /api/audit` (owner-only гейт) вместо
   `GET /api/processes/:id`.** Отвергнуто — `/api/audit` гейтится строже
   (`holdsAuditRead = isGenesisOwner`), чем текущая страница инстанса (tenant-membership
   only). Проксирование сузило бы видимость СУЩЕСТВУЮЩИХ полей страницы (`status`/`node`/
   `progress`) до owner-only — прямое нарушение «не расширяй/не сужай видимость сверх
   текущей» (было бы регрессией для не-owner тенант-мемберов, которые сегодня открывают
   страницу инстанса). variables/history остаются В ТОМ ЖЕ хендлере под тем же гейтом.

5. **Не пытаться получить историю из Flowable вообще — просто улучшить текстовую заметку
   («используйте /audit для истории»).** Отвергнуто — не решает живой факт приёмки:
   диагностика P0-ветвления требовала SQL именно потому, что ни один UI-путь (включая
   `/audit`, owner-only и не про конкретный инстанс структурно) не показывает
   activity-историю движка. Задача прямо требует минимума «переменные + пройденные шаги».

## 4. Follow-up (зафиксировано, не в этой задаче)

- **O1** — узлы охвата `ScopePicker` (`DICT_ORG_TREE`) остаются демо-деревом, НЕ реальной
  оргструктурой тенанта (`choros.department`, `GET /api/org`). Нужна отдельная задача:
  решить продуктовую семантику «узел охвата гранта» (department id? Отдельная
  классификация?) прежде чем сводить источники.
- **O2** — миграция ДЕМО/пресет-стека (`DICT_PRESETS` — 14 замороженных пресетов,
  критичность-оси `axesFromGrants`/`RES_BY_URI`, SoD-отображение) на resource-hierarchy.
  РЕАЛЬНЫЕ ресурсы формы уже переключены (фикс F-1, §1.3); до этого рефактора демо-гранты
  остаются org-scope (питают только отображение, помечены «· демо» в UI, тост
  квалифицирован — ложного успеха нет).
- **O3** — типизированный редактор переменных (со схемой типов) вместо плоского списка
  имя/значение.

## 5. Fitness-функции и трассируемость

См. `docs/adr/T-0609.adr.contract.json` (FF-1..FF-9, traceability AC↔FF).

## 6. Эскалация

Нет. Оба решения — READ-only расширения (новый GET-эндпоинт, два новых read-метода
FlowableClient) плюс правка ЭМИССИИ существующей формы (scope-shape тела POST /api/grants
— write-путь сам не тронут, замороженные файлы не тронуты). Форма теперь производит
гранты, резолвимые ЕДИНСТВЕННЫМ существующим PDP-предикатом — никакой новый
authority-путь не вводится (наоборот: устраняется класс структурно-инертных грантов).
Видимость страницы инстанса не расширена сверх текущего гейта. Узлы охвата (O1) и
миграция демо/пресет-стека (O2) — сознательно вынесены в follow-up.
