# ADR-T0609 — Честные ресурсы формы «Дать роли право» + переменные/история инстанса

**Status:** ready
**Phase:** DESIGN
**Task:** T-0609 [P1]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0609-rights-real-resources.spec.md` + `docs/specs/T-0609.spec.contract.json` (AC-1..AC-14)
**База:** dev @ `51fbc32` (ветка `task/T-0609-rights-real-resources`, содержит T-0605)

---

## 1. Решение — ресурсы формы «Дать роли право»

**Новый read-only эндпоинт `GET /api/rights/resources`, новый файл
`src/http/rights-resources.ts`.** НЕ трогает `src/http/grants.ts` (заморожен байт-в-байт,
`ci/checks/rights-ui-frozen-write.sh`, T-0572 FF-T0572-FROZEN).

### 1.1. Серверная часть

```ts
// src/http/rights-resources.ts (НОВЫЙ файл)
export function registerRightsResourcesRoute(
  router: Router,
  pool: pg.Pool,
  resolveActorTenant: (actorSlug: string) => Promise<string>,
): void {
  router.register("GET", "/api/rights/resources", withAuth(async (req, res) => {
    const actorId = await extractActorFromReq(req, pool); // тот же паттерн, что registry-defs.ts
    const tenantId = await resolveActorTenant(actorId);
    const apps = await listApplications(pool, tenantId);      // ПЕРЕИСПОЛЬЗУЕТ src/http/applications.ts
    const regs = await listRegistryDefs(pool, tenantId, null); // ПЕРЕИСПОЛЬЗУЕТ src/http/registry-defs.ts
    const appById = new Map(apps.map(a => [a.id, a]));
    const resources = [
      ...apps.map(a => ({
        uri: `registry:${a.slug}`,
        name: a.display_name,
      })),
      ...regs.map(r => {
        const app = appById.get(r.application_id);
        const appSlug = app ? app.slug : r.application_id;
        return {
          uri: `registry:${appSlug}.${r.slug}`,
          name: app ? `${app.display_name} · ${r.display_name}` : r.display_name,
        };
      }),
    ];
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ resources }));
  }));
}
```

**`uri` формат: `registry:<application_slug>` (уровень приложения) и
`registry:<application_slug>.<registry_slug>` (уровень конкретного реестра).** Это ТОТ ЖЕ
класс значения (свободная именующая строка), что уже несёт `resource_type` во ВСЕЙ
существующей форме — `mcp://ledger.invoices` не более и не менее «формат», чем
`registry:zakupki.zayavki`; обе — непрозрачные строки-имена без DB-constraint и без
рантайм-парсинга схемы (подтверждено: `grep` не находит НИ ОДНОГО места, парсящего
`resource_type` как URL/scheme — `mcp://` нигде не разбирается структурно, это чисто
display/naming-конвенция). Слаг, а не UUID, — потому что слаг стабилен для человека,
читающего audit-trail/пресет (`grant-trail.ts` и подобные показывают `resource_type` как
есть), а UUID был бы нечитаем в тех же местах, где сегодня читаемо `mcp://ledger.invoices`.

Функция регистрируется В `server.ts` рядом с `registerApplicationRoutes`/
`registerRegistryDefRoutes` (когда `grantsPool` присутствует — DB-режим), НЕ заменяет и не
перехватывает `registerDictionariesRoute` (тот путь, `GET /api/rights/dictionaries`,
остаётся байт-в-байт как есть — заморожен).

### 1.2. Клиентская часть

`web/src/screens/rights/screen-rights.jsx` добавляет `fetchRealResources()` (тот же паттерн,
что `fetchDictionaries()`/`fetchEmployees()` — best-effort, `[]` на ошибку) и передаёт
`GrantRightForm` ОБЪЕДИНЁННЫЙ массив: реальные ресурсы тенанта первыми, затем
`dictionaries.resources` (демо) — без дедупликации по имени (реальный тенант обычно не
пересекается с демо-именами; в демо-тенанте реальных пока нет, список = чистый демо, как
сегодня — нет функционального изменения для демо-тенанта). `GrantRightForm` НЕ меняется
структурно (`resources.map(r => ({value:r.uri,label:r.name}))` уже принимает любой
`{uri,name}` массив) — только composition-точка в `screen-rights.jsx` меняется.

```jsx
// screen-rights.jsx — рядом с fetchDictionaries()
async function fetchRealResources() {
  try {
    const res = await fetch('/api/rights/resources', { headers: authHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.resources) ? data.resources : [];
  } catch {
    return [];
  }
}
// на загрузке: const [dicts, real] = await Promise.all([fetchDictionaries(), fetchRealResources()]);
// dictionaries передаваемый в формы: { ...dicts, resources: [...real, ...(dicts?.resources ?? [])] }
```

### 1.3. Почему НЕ переключаем `resource_type` на T-0570 resource-hierarchy формат

T-0570 READ-PDP канон (`migrations/117_default_read_grant_backfill.sql`): `resource_type`
= грубый род (`'record'`/`'registry'`/`'application'`), а конкретный ресурс — в
`scope = {kind:'node', hierarchy:'resource', nodeLevel, nodeId:<uuid>}`. Формально это
«канонический» формат для НОВЫХ resource-hierarchy грантов. НО `GrantRightForm` целиком
спроектирована вокруг ДРУГОГО, тоже полностью легитимного паттерна (используемого 10+
пресетами, осями критичности, SoD): `resource_type` = именующая строка КОНКРЕТНОГО
ресурса, `scope` = org-hierarchy сужение (какое подразделение). Переключение первого на
второе потребовало бы:

- Переписать `ScopePicker` так, чтобы для гранта (в отличие от назначения роли) он выбирал
  RESOURCE-узел, а не ORG-узел — но тот же компонент используется в `AssignRoleForm` для
  org-охвата назначения; расщепление на два разных виджета — уже архитектурное решение,
  не «правка справочника».
- Переписать `axesFromGrants`/`RES_BY_URI` (`ra-data.jsx:254-265`) — критичность роли
  сегодня читается ПО ИМЕНИ ресурса (`r.guarded`/`r.external`/`r.sensitive` по `resource_type`
  строке); в resource-hierarchy формате эта информация должна была бы жить ГДЕ-ТО ещё
  (на `registry_def`? На отдельной таблице классификации?) — не определено, не тривиально.
- Переписать все 14 `DICT_PRESETS` (`grants.ts:457-672`, ФАЙЛ ЗАМОРОЖЕН — физически
  невозможно без нарушения freeze-гейта).

Это НЕ «второй формат вместо канонического» — оба формата (resource-hierarchy и
именующая-строка) уже сосуществуют в репозитории СЕГОДНЯ, обслуживая РАЗНЫЕ участки
системы (READ-PDP default-open грант vs ролевые компетентностные гранты). Задача
«зафиксирована в спеке» напрямую предупреждает не изобретать ВТОРОЙ формат — мы этого не
делаем: используем формат, УЖЕ живущий именно в этом (компетентностном) паттерне, только
наполняем его реальными значениями. Полное слияние двух паттернов в один — follow-up
(O2), отдельная и существенно более широкая архитектурная работа.

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

2. **Полное переключение `resource_type` на T-0570 resource-hierarchy формат
   (`scope.nodeId` = registry/application UUID).** Отвергнуто как ВНЕ ПЕРИМЕТРА этой
   задачи (см. §1.3) — требует переписать `ScopePicker`, `axesFromGrants`, критичность-оси,
   14 замороженных пресетов. Это «построить новый экран прав» по факту (переработка всей
   модели формы), что задача прямо запрещает («не строй новый экран прав — только честный
   источник ресурсов в существующей форме»). Follow-up O2.

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
- **O2** — полное переключение компетентностных грантов (`GrantRightForm`/
  `DICT_PRESETS`) на T-0570 resource-hierarchy формат — большой рефактор грант-модели
  (`ScopePicker`, критичность-оси, 14 пресетов, SoD). Два параллельных resource-адресующих
  паттерна (hierarchy vs именующая строка) продолжат сосуществовать до этого рефактора.
- **O3** — типизированный редактор переменных (со схемой типов) вместо плоского списка
  имя/значение.

## 5. Fitness-функции и трассируемость

См. `docs/adr/T-0609.adr.contract.json` (FF-1..FF-8, traceability AC↔FF).

## 6. Эскалация

Нет. Оба решения — READ-only расширения (новый GET-эндпоинт, два новых read-метода
FlowableClient), не вводят новых прав/authority-путей, не трогают замороженные
write-core файлы, не расширяют видимость сверх текущего гейта. Узлы охвата и полное
resource-hierarchy переключение — сознательно вынесены в follow-up (задача явно
разрешает это для узлов охвата; для resource-hierarchy — по аналогии, т.к. это тот же
класс «отдельная архитектурная работа вне периметра существующей формы»).
