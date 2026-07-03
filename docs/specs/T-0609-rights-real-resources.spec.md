# T-0609 — Спека: честные ресурсы в форме «Дать роли право» + переменные/история экземпляра процесса

**Status:** ready
**Phase:** SPEC
**Task:** T-0609 [P1]
**Date:** 2026-07-03
**База:** dev @ `51fbc32` (ветка `task/T-0609-rights-real-resources`, содержит T-0605)

---

## 1. Контекст (живые факты приёмки, 2026-07-03)

Две отдельные дыры продуктовой правды, обе найдены при разборе живого стенда.

### 1.1. Экран «Доступ» (`/rights`) — форма «Дать роли право» оперирует демо-ресурсами

Селектор РЕСУРС в `GrantRightForm` (`web/src/screens/rights/ra-overview-forms.jsx:254-331`)
показывает ровно 10 демо-строк: «Реестр счетов», «Сверка платежей», «Платёжный шлюз»,
«Возвраты средств», «Контрагенты (KYC)», «Справочник договоров», «Очередь обращений»,
«CRM клиента», «База знаний», «Очередь эскалаций» — сид демо-тенанта («Аксон» и подобные),
не реальные реестры/приложения ТЕКУЩЕГО тенанта («Заявка на закупку», «Поставщик»,
«Каталог номенклатуры», «Статья бюджета», «Клиенты» и т.п.). Выдать право на реальную
сущность тенанта из UI **невозможно** — справочник ресурсов на это не рассчитан.

### 1.2. Инстанс процесса не показывает переменные и детальную историю

`/processes/:id` (`web/src/screens/screen-process-instance.jsx:294-301`) при разборе
P0-ветвления не давал увидеть, какой веткой пошёл инстанс и с какими значениями —
диагностика была возможна ТОЛЬКО прямым SQL в таблицы Flowable. Экран честно
показывает заметку «Детальная история переходов пока недоступна», но продукт не
даёт минимума: переменные процесса и пройденные шаги с временами.

## 2. Разведка (карта фактов, file:line)

### 2.1. Источник демо-ресурсов формы «Дать роли право»

| что | file:line | природа |
|---|---|---|
| Frontend-константа (сорс правды рендера) | `web/src/screens/rights/ra-data.jsx:50-61` (`RESOURCES`) | хардкод JS-массив, `{uri: "mcp://...", name, sensitive?, external?, guarded?}` |
| Серверная зеркальная копия | `src/http/grants.ts:362-373` (`DICT_RESOURCES`) | хардкод, отдаётся `GET /api/rights/dictionaries` (`grants.ts:683-698`) — **без DB**, дублирует `ra-data.jsx` вручную |
| Форма использует | `ra-overview-forms.jsx:262,310` | `dictionaries.resources` → `<Select options={resources.map(r=>({value:r.uri,label:r.name}))}>` — value уходит как `resource_type` в `POST /api/grants` (`grantRight()`, `:73-81`) |
| Демо-имена также в | `src/http/rights.ts:54-141` (`RIGHTS_SEED`, no-DB демо-путь `GET /api/rights`), `seed/showcase/pack.json:61-193` (JSON demo-seed), `src/__tests__/ra-axes.test.ts` (фикстура) | легитимные демо-контуры — не трогаем |

`DICT_RESOURCES`/`registerDictionariesRoute` живут в `src/http/grants.ts`, который
**заморожен байт-в-байт** гейтом `ci/checks/rights-ui-frozen-write.sh` (T-0572,
FF-T0572-FROZEN) — этот файл нельзя редактировать. Значит источник реальных ресурсов
должен прийти из НОВОГО, отдельного read-эндпоинта, а не правкой `grants.ts`.

### 2.2. Реальные ресурсы тенанта — `application` / `registry_def`

- Схемы: `migrations/003_application.sql` (`tenant_id, id, slug, display_name, …`),
  `migrations/004_registry_def.sql` (`tenant_id, id, application_id, slug, display_name,
  record_schema, …`) — обе tenant-scoped таблицы с RLS (`FORCE ROW LEVEL SECURITY`).
- Уже существующие READ-эндпоинты (не тронуты этой задачей, только ПЕРЕИСПОЛЬЗУЮТСЯ):
  `GET /api/applications` (`src/http/applications.ts:613-621`, `listApplications` `:298`) и
  `GET /api/registry-defs?application_id=` (`src/http/registry-defs.ts:943-967`,
  `listRegistryDefs` `:818`) — оба tenant-scoped через `resolveActorTenant` + RLS, DAO уже
  готовы, ничего писать заново не нужно.

### 2.3. Enforcement-путь гранта — что РЕАЛЬНО решает PDP (ревизия после ревью F-1)

- `choros."grant".resource_type` — колонка `text NOT NULL`, **без CHECK/enum на уровне
  БД** (`migrations/008_grant.sql:19`). TS-тип `Grant["resourceType"]`
  (`src/core/grant-lattice.ts:38-49`, ФАЙЛ ЗАМОРОЖЕН) — закрытый union, но это ТОЛЬКО
  TS-каст (`as Grant["resourceType"]`), не рантайм-проверка.
- **ЕДИНСТВЕННЫЙ enforcement-предикат PDP** (`src/core/grant-resolver.ts:589-607`
  `resolveFor`, зеркально `src/core/read-visibility.ts:130-143` `isRecordReadable`):
  грант покрывает запрос ⇔ `tenantId` совпал ∧ `operation` совпала ∧ `isEffective(now)`
  ∧ `isNarrowerOrEqual(handleScope, g.scope, ancestry)`. **`resource_type` НЕ читается
  вообще** (`refToResourceType` используется лишь в buildMaskContext для T-0033
  маскировки — не в allow/deny). Runtime-запрос несёт `handleScope =
  {hierarchy:"resource", nodeId:<UUID>}` (`refToScope`, `grant-resolver.ts:197-237`);
  `isNarrowerOrEqual` короткозамыкает на несовпадении иерархий
  (`grant-lattice.ts:280`): **org-scope грант НИКОГДА не покрывает resource-запрос**.
- **Следствие (ревью F-1, blocking, доказано живым probe)**: org-scope гранты
  компетентностного паттерна (`DICT_PRESETS`/демо `mcp://…`, `scope_org` →
  `{hierarchy:"org"}`) НЕ драйвят PDP allow/deny. Они питают ТОЛЬКО отображение —
  оси критичности/SoD-обзор (`axesFromGrants`/`RES_BY_URI`, `ra-data.jsx:240-265`,
  и то лишь для 10 захардкоженных demo-uri). Первая редакция этой спеки называла это
  «равно легитимной конвенцией резолюции ресурса» — ФОРМУЛИРОВКА ВВОДИЛА В ЗАБЛУЖДЕНИЕ
  и снята: у формы «Дать роли право» до фикса НЕ БЫЛО enforcement-эффекта ни для
  демо-, ни для реальных ресурсов.
- **Канонический enforcement-паттерн** (T-0570 READ-PDP,
  `migrations/117_default_read_grant_backfill.sql:162-189`): конкретная адресация
  ресурса живёт в `scope = {"kind":"node","hierarchy":"resource","nodeLevel":…,
  "nodeId":"<UUID>"}`; composite resource-ancestry oracle
  (`src/db/resource-ancestry.ts` rules 1/3) покрывает record→registry→application
  цепочку. `resource_type` — классификационная/display-метка.
- **Решение (фикс F-1, путь A ревью)**: при выборе РЕАЛЬНОГО ресурса форма эмитит
  `scope = {kind:"node", hierarchy:"resource", nodeId:<реальный UUID
  application/registry_def>, nodeLevel:"application"|"registry"}` — id и node_level
  отдаёт `GET /api/rights/resources` рядом с uri/name. Грант резолвится ТЕМ ЖЕ путём,
  что READ-PDP. `resource_type` остаётся человекочитаемой меткой
  (`registry:<slug>[.<slug>]`) — PDP её не читает, а grant-trail/обзор показывают как
  есть. Org-`ScopePicker` для реального ресурса не применим (охват гранта ЕСТЬ узел
  ресурса) — заменяется честной строкой охвата. Демо-ресурсы остаются на прежнем
  org-scope пути, но помечаются в UI («· демо») с честной подсказкой и
  квалифицированным тостом — без ложного успеха (UX-1/UX-2).

### 2.4. Узлы охвата (scope-picker) — демо-оргдерево, НЕ реальная оргструктура

- `ScopePicker` (`ra-overview-forms.jsx:94-158`) рендерит `dictionaries.orgTree` →
  из `DICT_ORG_TREE` (`grants.ts:385-398`, хардкод, 12 узлов: `org/fin/fin-calc/
  fin-approve/fin-treasury/cs/cs-l1/cs-l2/plat/sales/sales-smb/sales-ent`).
- Реальная оргструктура тенанта живёт в `choros.department`/`position`/`employee`
  (`migrations/014_department.sql` и далее), читается `GET /api/org`
  (`src/http/org.ts:211-235` → `listOrgTree`, `src/db/org.ts:109`) — **РЕАЛЬНЫЕ** данные,
  сеяны иначе (3 корневых департамента: `fin`/`cs`/`plat`, без `sales`/вложенных).
- Это ДВА разных, несовместимых по форме дерева (`OrgDepartment{id,name,positions[]}` vs
  `DICT_ORG_TREE{id,label,depth,children[]}`), обслуживающих РАЗНЫЕ цели: `/org` —
  департамент/должность/сотрудник; `ScopePicker` — узел лестницы охвата гранта
  (`nodeLevel` в смысле grant-lattice, не department-id). Свести их в одно дерево —
  отдельная архитектурная работа (нужно решить, что такое «узел охвата» — department.id?
  attribute-тег? — вне периметра этой задачи). **Решение: НЕ трогаем узлы охвата в этой
  задаче**, фиксируем разрыв как follow-up в ADR §4 (по прямому указанию задачи — «если
  список НЕ реальный orgstructure — зафиксируй в ADR», что мы и делаем).

### 2.5. Инстанс процесса — текущая гейт-модель (важно не расширить)

- `GET /api/processes/:id` (`src/http/processes.ts:382-416`): гейт — ТОЛЬКО членство в
  тенанте (`resolveActorSlugForRead` → `startDeps.resolveActorTenant(actorSlug)` →
  tenant-scoped `listInstanceProjections`). Любой аутентифицированный член тенанта видит
  статус/шаг/прогресс ЛЮБОГО инстанса тенанта — НЕТ PDP/capability-гейта на конкретный
  инстанс. Это ЗАДОКУМЕНТИРОВАННЫЙ текущий уровень видимости этой страницы (не то, что мы
  вводим — то, что уже есть).
- Контрастный, СТРОЖЕ гейтимый путь — `GET /api/audit` (`src/http/audit.ts:545-564`):
  `holdsAuditRead(admin) = admin.isGenesisOwner` (owner-only, `:504-506`). Это ДРУГОЙ,
  более строгий контур; переменные/история, добавляемые ЭТОЙ задачей, НЕ проксируют через
  `/api/audit` и не наследуют его гейт.
- **Решение (по прямому указанию задачи «не расширяй видимость сверх текущей»)**: новые
  поля variables/history добавляются В ТОТ ЖЕ хендлер `GET /api/processes/:id`, под ТЕМ ЖЕ
  существующим tenant-membership гейтом — ни шире, ни у́же текущего уровня видимости
  страницы. Не вводится новый authority-путь (D-064).

### 2.6. Flowable-клиент — greenfield для истории/переменных

- `src/core/flowable-client.ts` (1124 строк): 12 методов, ни один не читает
  historic-variable-instances/historic-activity-instances. Единственное текущее
  использование `/history/*` — `isInstanceEnded` (`:1060`) читает
  `GET {baseUrl}/history/historic-process-instances/{id}` только для поля `endTime`.
- Паттерн для новых методов — `getFirstActiveUserTask` (`:791-809`): `withRetry(...)`,
  `httpStatusToCode(resp.status)`, `Authorization: auth` header, `resolved.baseUrl`.
- Реальные Flowable 7.1 REST-пути (используются в этом же клиенте, тем же base URL,
  `/history/*` сегмент подтверждён рабочим): `historic-variable-instances`,
  `historic-activity-instances` — ОБА под тем же `/history/` сегментом что уже
  используется, тот же auth, тот же паттерн retry.
- `startDeps.flowable` (тот же `FlowableClient`) уже доступен внутри
  `registerProcessesRoutes` (`src/server.ts:669-687`) — прокидывать новый инстанс клиента
  не нужно.

## 3. Решение (одной фразой на каждую дыру)

1. **Ресурсы**: новый read-only эндпоинт `GET /api/rights/resources` (новый файл,
   НЕ трогает замороженный `grants.ts`), отдающий tenant-scoped список
   `{uri, name, id, node_level}` из РЕАЛЬНЫХ `application`/`registry_def` строк тенанта
   (переиспользуя существующие `listApplications`/`listRegistryDefs` DAO): `uri` —
   человекочитаемая метка для `resource_type`/display, `id` + `node_level` —
   **enforcement-идентичность** (F-1 фикс): форма строит из них
   `scope = {kind:"node", hierarchy:"resource", nodeId:<id>, nodeLevel:<node_level>}`,
   и выданный грант РЕЗОЛВИТСЯ PDP тем же путём, что READ-PDP (§2.3). Frontend
   (`screen-rights.jsx`) подгружает оба справочника и передаёт в `GrantRightForm`
   ОБЪЕДИНЁННЫЙ список: реальные ресурсы тенанта — первыми, демо-ресурсы — следом,
   помеченные `demoSeed` (в селекторе «· демо», честная подсказка + квалифицированный
   тост — демо-грант питает обзор ролей, но не управляет доступом; UX-1/UX-2), явно
   ничего не удаляя из демо-контура (демо-тенант легитимно показывает демо-сид).
2. **Переменные/история**: два новых read-only метода `FlowableClient`
   (`getHistoricVariableInstances`, `getHistoricActivityInstances`), вызываемые из
   `GET /api/processes/:id` под СУЩЕСТВУЮЩИМ tenant-membership гейтом; ответ несёт
   `variables: [{name, value}]` и `history: [{step, kind, startedAt, endedAt, completedBy?}]`;
   `screen-process-instance.jsx` рендерит их вместо/в дополнение к текущей
   best-effort audit-фильтрации, с честной деградацией при недоступности движка.

## 4. Функциональные требования

- **F1.** `GET /api/rights/resources` возвращает `{resources: [{uri, name, id,
  node_level}]}`, tenant-scoped (RLS через `resolveActorTenant`), построенные из
  `application`+`registry_def` строк ТЕКУЩЕГО тенанта: `uri` — стабильная
  display-метка, `id` — реальный UUID строки, `node_level` —
  `"application"|"registry"` (enforcement-идентичность для scope гранта).
- **F2.** `screen-rights.jsx` подгружает новый эндпоинт наряду с
  `/api/rights/dictionaries` и передаёт `GrantRightForm` объединённый список
  ресурсов (реальные + демо, реальные первыми; демо помечены `demoSeed` на
  merge-точке). Пустой тенант (нет ни одного application/registry_def) — честно
  деградирует к демо-списку (не пустой дропдаун), каждый демо-пункт ВИДИМО помечен
  «· демо» в селекторе (не молчаливая подмена).
- **F3.** Выбор РЕАЛЬНОГО ресурса и сабмит формы даёт РЕЗОЛВИМЫЙ грант: форма эмитит
  `scope = {kind:"node", hierarchy:"resource", nodeId:<id>, nodeLevel:<node_level>}`
  через незаменённый `POST /api/grants` (замороженный write-путь; `parseScopeElement`
  уже принимает `hierarchy:"resource"`), и `resolveFor` (production PDP) РАЗРЕШАЕТ
  операцию по записи этого реестра/приложения для держателя роли. Org-`ScopePicker`
  для реального ресурса не рендерится — вместо него честная строка охвата («Охват:
  ресурс целиком…»); демо-ресурс идёт прежним org-scope путём с квалифицированным
  тостом (не ложное «Право выдано»).
- **F4.** `FlowableClient` получает `getHistoricVariableInstances(instanceId)` →
  `GET /history/historic-variable-instances?processInstanceId=` (маппинг
  `{name, value}[]`), и `getHistoricActivityInstances(instanceId)` →
  `GET /history/historic-activity-instances?processInstanceId=&sort=startTime`
  (маппинг `{activityId, activityName, activityType, startTime, endTime, assignee}[]`
  → `{step, kind, startedAt, endedAt, completedBy}`).
- **F5.** `GET /api/processes/:id` (DB-режим, `startDeps` присутствует) добавляет к
  существующему ответу `variables: Array<{name, value}>` и
  `history: Array<{step, kind, startedAt, endedAt, completedBy}>` — best-effort:
  движок недоступен/ошибка → пустые массивы + `historyAvailable:false`
  (честная деградация, НЕ 500).
- **F6.** `screen-process-instance.jsx` рендерит секцию «Переменные процесса»
  (имя/значение) и заменяет best-effort audit-фильтрацию на новую детальную историю
  (шаг, тип, начало, конец, кто закрыл — если есть); при `historyAvailable:false`
  показывает ту же честную заметку что и сегодня (без регресса при недоступности
  движка).

## 5. Нефункциональные требования

- **N1.** Не расширять видимость страницы инстанса сверх текущего tenant-membership
  гейта (§2.5) — никакого нового PDP/capability-пути.
- **N2.** Не редактировать замороженные файлы: `src/http/grants.ts`,
  `src/http/rights.ts`, `src/core/dual-control.ts`, `src/core/role-criticality.ts`,
  `src/core/grant-resolver.ts`, `src/core/grant-lattice.ts`,
  `src/http/rights-change-requests.ts` (`ci/checks/rights-ui-frozen-write.sh`).
- **N3.** Не изобретать второй resource-идентификационный формат для ENFORCEMENT —
  конкретный ресурс адресуется в `scope` (resource-hierarchy nodeId = реальный UUID),
  ровно как канонический T-0570 READ-PDP паттерн (§2.3); `resource_type` — display/
  классификационная метка, PDP её не читает. Демо-путь (org-scope) не переименовывается
  и не мигрирует в этой задаче — он помечается честно (UX-1/UX-2).
- **N4.** D-064: никаких кейс-литералов в `src/` (реальные имена ресурсов приходят из
  данных тенанта на рантайме, не как строковые константы в коде).
- **N5.** Честная деградация: отсутствие движка/DB не должно 500-ить ни один
  затронутый путь — только пустые массивы/понятные сообщения.
- **N6.** Не трогать grant-write путь (`POST /api/grants`) и не вводить новый
  write-эндпоинт (`ci/checks/rights-ui-no-new-write.sh` должен остаться зелёным).

## 6. Вне рамок (out of scope, зафиксировано для follow-up)

- **O1.** Узлы охвата (`ScopePicker`/`DICT_ORG_TREE`) — демо-дерево, НЕ реальная
  оргструктура. Сведение в один источник с `/api/org` — отдельная архитектурная
  задача (нужно решить семантику «узел охвата» как продуктовое понятие). Follow-up.
- **O2.** Миграция ДЕМО-контура (`DICT_PRESETS`, 14 замороженных пресетов, оси
  критичности `axesFromGrants`/`RES_BY_URI`, SoD-правила) на resource-hierarchy —
  отдельный рефактор. РЕАЛЬНЫЕ ресурсы этой формы УЖЕ переключены на
  resource-hierarchy (фикс F-1, §2.3/§3); вне рамок остаётся только демо/пресет-стек,
  который пока живёт org-scope путём (помечен честно в UI). Follow-up (ADR §4).
- **O3.** Полный редактор/просмотрщик переменных с типами/схемой — только плоский
  список имя/значение (минимум приёмки), не типизированный редактор.
- **O4.** Действия над инстансом (approve/reject из detail-вью) — экран остаётся
  read-only (T-0556 §3 инвариант не меняется).

## 7. Acceptance criteria

См. `docs/specs/T-0609.spec.contract.json` (AC-1..AC-14).
