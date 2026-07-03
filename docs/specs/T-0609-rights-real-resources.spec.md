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

### 2.3. Формат resource-идентификации у РЕАЛЬНЫХ грантов (T-0570 READ-PDP) — канон

- `choros."grant".resource_type` — колонка `text NOT NULL`, **без CHECK/enum на уровне
  БД** (`migrations/008_grant.sql:19`). TS-тип `Grant["resourceType"]`
  (`src/core/grant-lattice.ts:38-49`, ФАЙЛ ЗАМОРОЖЕН) — закрытый union
  `"application"|"registry"|"record"|"process_instance"|mgmt_object:${string}|"effect_resource"`,
  но это ТОЛЬКО TS-каст (`as Grant["resourceType"]`), не рантайм-проверка.
- **Канонический паттерн READ-PDP** (`migrations/117_default_read_grant_backfill.sql:162-189`):
  `resource_type = 'record'` (грубый КАКОЙ-РОД-ресурса), а КОНКРЕТНАЯ адресация — в
  `scope = {"kind":"node","hierarchy":"resource","nodeLevel":"application","nodeId":"<id>"}`
  (`src/core/grant-resolver.ts:197-218` `refToScope`). Т.е. в этом паттерне «что за
  ресурс» несёт `scope`, а не `resource_type`.
- **Параллельный, тоже реальный и тоже широко используемый паттерн** — компетентностные
  гранты (`DICT_PRESETS`, `src/http/grants.ts:457-672`, использован в 10+ пресетах ролей,
  SoD, оси критичности `ra-data.jsx:240-265`): `resource_type` = свободная строка,
  ИМЕНУЮЩАЯ конкретный ресурс/инструмент (`"mcp://ledger.invoices"`), а `scope` несёт
  ТОЛЬКО org-hierarchy сужение (`scope_org: "fin"` → `{kind:"node",hierarchy:"org",…}`).
  Это ДРУГАЯ, но равно легитимная и глубоко укоренённая (presets/SoD/critLevel/
  audit-trail) конвенция резолюции ресурса.
- `GrantRightForm` относится ВТОРОМУ паттерну (org-scope + именующий `resource_type`) —
  именно так уже был спроектирован весь стек над ним (`ScopePicker` → `hierarchy:"org"`,
  `axesFromGrants`/`RES_BY_URI` читают признаки ресурса по `resource_type`-строке).
  Переключать этот паттерн на resource-hierarchy (T-0570-style) means переписывать
  `ScopePicker`, `axesFromGrants`, критичность-оси и все 14 пресетов — это НОВЫЙ большой
  рефактор грант-модели, вне периметра «честный источник ресурсов в существующей форме».
  Решение (см. ADR §1): оставить `resource_type` тем же свободно-строковым форматом,
  который эта форма и весь её нижестоящий стек уже используют — не выдумывать ВТОРОЙ
  формат, просто наполнить его РЕАЛЬНЫМИ значениями вместо демо-фикстуры.

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
   `{uri, name}`, где `uri` — стабильный строковый идентификатор в ТОМ ЖЕ свободном
   формате, что уже используется этой формой (`resource_type` как именующая строка),
   построенный из РЕАЛЬНЫХ `application`/`registry_def` строк тенанта (переиспользуя
   существующие `listApplications`/`listRegistryDefs` DAO). Frontend (`screen-rights.jsx`)
   подгружает оба справочника и передаёт в `GrantRightForm` ОБЪЕДИНЁННЫЙ список: реальные
   ресурсы тенанта — первыми, демо-ресурсы (если тенант демо-сид держит) — следом,
   явно ничего не удаляя из демо-контура (демо-тенант легитимно может показывать демо-сид).
2. **Переменные/история**: два новых read-only метода `FlowableClient`
   (`getHistoricVariableInstances`, `getHistoricActivityInstances`), вызываемые из
   `GET /api/processes/:id` под СУЩЕСТВУЮЩИМ tenant-membership гейтом; ответ несёт
   `variables: [{name, value}]` и `history: [{step, kind, startedAt, endedAt, completedBy?}]`;
   `screen-process-instance.jsx` рендерит их вместо/в дополнение к текущей
   best-effort audit-фильтрации, с честной деградацией при недоступности движка.

## 4. Функциональные требования

- **F1.** `GET /api/rights/resources` возвращает `{resources: [{uri, name}]}`,
  tenant-scoped (RLS через `resolveActorTenant`), построенные из `application`+
  `registry_def` строк ТЕКУЩЕГО тенанта (`uri` — стабильная строка, см. ADR §2 для
  точного формата).
- **F2.** `screen-rights.jsx` подгружает новый эндпоинт наряду с
  `/api/rights/dictionaries` и передаёт `GrantRightForm` объединённый список
  ресурсов (реальные + демо, реальные первыми). Пустой тенант (нет ни одного
  application/registry_def) — честно деградирует к демо-списку (не пустой
  дропдаун), с явной информацией что это демо (без нового «demo:true»-флага —
  честная надпись в hint, как и для остальных пустых справочников этой формы).
- **F3.** Выбор реального ресурса и сабмит формы даёт РАБОЧИЙ грант — round-trip
  через `POST /api/grants` (незаменённый, замороженный write-путь) с новым
  `resource_type` проходит валидацию (уже принимает произвольную непустую строку).
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
- **N3.** Не изобретать второй resource-идентификационный формат — `resource_type`
  остаётся свободной именующей строкой (тот же паттерн, что уже несёт этот стек,
  §2.3); scope остаётся org-hierarchy (не переключаем на resource-hierarchy —
  это отдельный рефактор, вне периметра).
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
- **O2.** Переключение `GrantRightForm`/`DICT_PRESETS`-паттерна на resource-hierarchy
  (T-0570 READ-PDP style, `scope.nodeId` = конкретный registry/application id) —
  отдельный, гораздо более широкий рефактор грант-модели (затрагивает `ScopePicker`,
  оси критичности, все 14 пресетов, SoD). Follow-up (ADR §4 обсуждает подробнее).
- **O3.** Полный редактор/просмотрщик переменных с типами/схемой — только плоский
  список имя/значение (минимум приёмки), не типизированный редактор.
- **O4.** Действия над инстансом (approve/reject из detail-вью) — экран остаётся
  read-only (T-0556 §3 инвариант не меняется).

## 7. Acceptance criteria

См. `docs/specs/T-0609.spec.contract.json` (AC-1..AC-14).
