# ADR · T-0570 — READ через PDP (D3: record- и field-видимость чтения)

- **Task:** T-0570 (Wave W1 / D3)
- **Phase:** DESIGN (architect)
- **Status:** ready
- **Date:** 2026-07-02
- **Spec:** `docs/specs/T-0570-read-pdp.spec.md` + `docs/specs/T-0570.spec.contract.json` (AC-1..AC-11)
- **Ratified founder decision (не переспрашивается):** карта примитивов §7 п.1, вариант (а) —
  default-open внутри тенанта ЧЕРЕЗ СИДИРОВАННЫЙ ГРАНТ; сужение = настройка грантов.
- **Reads-through (do NOT contradict):** T-0018 `grant-lattice.ts` (латтис ⊑/⊓/⊥),
  T-0021 `grant-resolver.ts` (`resolveFor`, единственная проекция), T-0081/T-0419/T-0421
  `field-visibility.ts` (`roleFieldVisibility`/`applyFieldVisibilityRedaction`),
  access-and-tenant-zero.spec §3.3 (`registerTenant` T-0373 seed).

---

## 1. Контекст и проблема (LIMITATION-018, доказано живьём 2026-07-01/02)

`src/http/records.ts` читает записи двумя функциями:

- `listRecordsPaginated(pool, tenantId, applicationId, registryDefId, limit, cursor, actorIsPrivileged)`
  — WHERE = `r.tenant_id = $1 AND <sandboxReadPredicate("a.tier")> [AND rd.application_id=$N] [AND r.registry_id=$N] [AND keyset-cursor]`;
  keyset-пагинация (`ORDER BY r.created_at DESC, r.id ASC LIMIT $N`, fetch `limit+1`).
- `getRecordDetail(pool, tenantId, id, actorIsPrivileged)` — WHERE = `r.tenant_id=$1 AND r.id=$2 AND <sandboxReadPredicate>`; `null` ⇒ HTTP 404 (`HttpError(404,"NOT_FOUND")`).

**Ни одна не резолвит гранты на чтение конкретной СТРОКИ.** Фильтруется только (1) tenant-RLS
(`record_tenant_isolation`) и (2) sandbox/draft-tier gate. Действия (`card-action.ts` →
`resolveFor`, D2) уже проходят PDP и fail-closed 403, а чтение — нет. Внутри тенанта запись видят
все аутентифицированные акторы. Это блокирует К1 «менеджер видит своих» и делает пустым фундамент
столпов 4 (агент=сотрудник) и 6 (ассистент-в-контуре-прав).

### 1.1 Ключевая архитектурная развилка (находка SPEC-разведки — эта ADR её закрывает)

Containment грант⊒запись в `resolveFor` проверяется через
`isNarrowerOrEqual(handleScope, grant.scope, ancestry)` (grant-resolver.ts:603), где для записи
`refToScope` (grant-resolver.ts:213) даёт `handleScope = {kind:"node", hierarchy:"resource",
nodeLevel:"record", nodeId:recordId}`.

**Оракул, реально подключённый в проде для `hierarchy:"resource"`-скоупов, НЕ существует.**
`makeOrgAncestryOracle` (`src/http/seed-ancestry.ts:46`) **игнорирует параметр `hierarchy`** и
ходит только по инжектированной org-adjacency-карте (департаменты); `loadTenantOrgAncestry`
(`src/db/org-ancestry.ts`) строит её из `choros.department`. Для
`hierarchy:"resource"` (application→registry→record) живого оракула нет — `isDescendantOrSelf(
"resource", recordId, anyResourceNode)` возвращает `false` (в org-карте нет resource-id).

Следствие из латтис-семантики (`grant-lattice.ts:242–297`), проверено по коду:

| кандидат-scope сидированного гранта | `isNarrowerOrEqual(recordNode, scope)` | почему |
|---|---|---|
| `{kind:"set",members:[]}` (BOTTOM ⊥) | **false** | `isBottom(parent)` ⇒ `false` (⊥ = ноль охвата; это НЕ «всё») |
| `{kind:"tags",tags:[]}` | **false** | cross-kind (node vs tags) ⇒ `atomIsNarrowerOrEqual` = `false` |
| `{kind:"node",hierarchy:"resource",nodeLevel:"application",nodeId:X}` | **false СЕГОДНЯ** | оракул не поднимает record→registry→application |

Латтис **не имеет TOP-элемента**; любой не-node scope cross-kind-несравним с record-node. Значит
«вся запись тенанта» одним существующим scope-значением **невозможна без resource-ancestry-оракула**.
Это и есть развилка, которую architect обязан решить (§2/§5 спеки, §8 «инженерное решение в пределах
T-0018»). **Решение — ниже.**

---

## 2. Решение

Три сцепленных элемента; ни один не вводит вторую систему прав (FR-7) и не переизобретает латтис
(NF-5). READ-путь начинает СПРАШИВАТЬ тот же `resolveFor`, а открытость держит СИДИРОВАННЫЙ грант.

### 2.1 Resource-ancestry-оракул (закрытие развилки §1.1)

Ввести живой оракул для `hierarchy:"resource"` — **композитный** оракул, который на `hierarchy==="org"`
делегирует существующему org-оракулу (без изменения его семантики), а на `hierarchy==="resource"`
отвечает по цепочке `record → registry_def → application`, дополненной **per-tenant resource-root
сентинелом**:

```
isDescendantOrSelf("resource", descId, ancId):
  1. descId === ancId                                  → true (self)
  2. ancId === RESOURCE_ROOT(tenant)                   → true  // корень покрывает ВСЁ дерево ресурсов тенанта
  3. иначе: подъём descId по реальной цепочке
        record.registry_id → registry_def.application_id,
        проверяя ancId на каждом уровне               → true если найден, иначе false
```

- `RESOURCE_ROOT(tenant)` — **зарезервированный сентинел-узел** уровня `nodeLevel:"application"`
  (константа платформы, НЕ хардкод конкретного tenant-UUID; nodeId = детерминированный
  `RESOURCE_ROOT_NODE_ID`, один для всех тенантов, различение по tenant делает RLS-гейт §2.4/NF-3,
  а не nodeId). Правило 2 даёт **O(1)** ответ для default-гранта — без загрузки карты.
- Правило 3 обслуживает БУДУЩЕЕ record/registry/application-сужение (FR-3): цепочка
  `record.registry_id`/`registry_def.application_id` уже читается `records.ts` per-row (SELECT
  включает `rd.application_id`, `r.registry_id`), поэтому оракул получает ancestry **inline из уже
  выбранной строки**, а не отдельным сетевым вызовом на строку (NF-1).

`refToScope` **НЕ меняется** (record → record-node) — оба теста (default и узкий) идут через один
`isNarrowerOrEqual`; никакой новой ветки в латтисе (FF-RP-8: `grant-lattice.ts`/`object-handle.ts`
байт-frozen).

### 2.2 Сидированный default-open READ-грант (FR-2)

Ровно один класс платформенного гранта: `operation:"read"`, `resource_type:"record"`,
`resource_facet: NULL` (whole-resource ⇒ все поля), `scope = {kind:"node", hierarchy:"resource",
nodeLevel:"application", nodeId: RESOURCE_ROOT_NODE_ID}`, `delegable:true` (сужаемо потомками через
`validateNarrowing`), `confirmed_by` выставлен (грант эффективен), `valid_from/until: NULL`.

Держит его платформенная роль `role-reader` (сид рядом с `role-configurator` из T-0373), назначаемая
владельцу тенанта и `assistant-agent` — тем же паттерном `role_assignment`, что T-0373. `RESOURCE_ROOT`
покрывает любую запись через правило 2 §2.1 ⇒ «read всё внутри тенанта».

**Сидируется в двух местах, без хардкода tenant-UUID:**

- **Новый тенант** — в `registerTenant` (`src/core/register.ts`), в ТОЙ ЖЕ транзакции T-0373 seed
  (BEGIN…COMMIT, `SET LOCAL choros.tenant_id`), рядом с блоками 3e–3j: INSERT `role-reader` +
  `role_assignment`(owner→reader, agent→reader) + `grant`(read/record/RESOURCE_ROOT), все
  `ON CONFLICT DO NOTHING` (AC-4, атомарно).
- **Существующие тенанты** — backfill-миграция `115_default_read_grant_backfill.sql`, которая
  **итерирует `choros.tenant`** (`INSERT … SELECT t.id, gen_random_uuid()…, 'read', … FROM
  choros.tenant t`), генерируя per-tenant роль/назначения/грант БЕЗ единого захардкоженного UUID.
  Это ЗЕРКАЛО-АНТИПОД migration 088 (`088_configurator_authoring_draft_grant_seed.sql`, которая
  хардкодит `'a0000000-…-000000000001'` в каждый INSERT — паттерн, который здесь ЗАПРЕЩЁН, FF-RP-6).

### 2.3 READ-путь спрашивает PDP — через optional-resolver seam (FR-1, FR-6, NF-2)

`RecordRoutesDeps` уже несёт optional honest-degrade-резолверы (`resolveWriteFacet?`,
`resolveFieldVisibility?`, `resolveSandboxPrivilege?`). Добавить **тем же паттерном**
`resolveReadVisibility?: ReadVisibilityResolver` — резолвер, который ОДИН РАЗ на HTTP-запрос
резолвит covering READ-гранты актора (через тот же `getGrantsForSubject`/`makeDbGrantSource` DAO —
single-resolver, FR-7) и строит per-request `AncestryOracle` (`loadTenantOrgAncestry` для org +
resource-оракул §2.1). Затем:

- **LIST:** после `listRecordsPaginated` каждая строка страницы проверяется чистой функцией
  `isRecordReadable(row, grants, ancestry, nowMs)` = `resolveFor`-эквивалентный containment
  (`isEffective ∧ operation==="read" ∧ isNarrowerOrEqual(recordNode(row), grant.scope, ancestry)`)
  над УЖЕ ЗАГРУЖЕННЫМИ грантами; невидимые строки исключаются из ответа (список короче, AC-1).
  Гранты берутся один раз ⇒ **O(1) grant-запросов на HTTP-запрос**, containment — O(N) чистых
  проверок над одной страницей, БЕЗ сетевого вызова на строку (NF-1, AC-7).
- **DETAIL:** после `getRecordDetail` тот же `isRecordReadable`; нет covering-гранта ⇒ **404**
  (не 200, не 403), неотличимо от not-found/cross-tenant (FR-5, AC-2).

**Honest-degrade (несущее для NF-2 и совместимости):** когда `resolveReadVisibility` НЕ инжектирован
(unit-тесты, ещё-не-подключённый composition root), READ-путь ведёт себя как СЕГОДНЯ (RLS + sandbox,
без PDP-фильтра). PDP-гейт активируется РОВНО тогда, когда composition root подключил резолвер —
после того как backfill-миграция §2.2 засидировала гранты (NF-2: сид — предусловие включения гейта,
не следствие). Это делает переход byte-совместимым и держит все существующие read-тесты зелёными
(§6). Production-wiring в `server.ts` подключает `resolveReadVisibility` в том же коммите, что
применяет миграцию 115.

Опция оптимизации (разрешена, не обязательна): SQL-предикат `EXISTS` на `choros."grant"` в WHERE
`listRecordsPaginated` (доп. `AND`, как `sandboxReadPredicate`) — если профилирование потребует;
контракт NF-1 («не N+1»), а не конкретная реализация. По умолчанию — in-memory per-row над страницей.

### 2.4 Field-видимость — переиспользуется, не дублируется (FR-4, AC-6)

Field-редакция остаётся ЕДИНСТВЕННЫМ полевым слоем: тот же `resolveFieldVisibility` /
`applyFieldVisibilityRedaction` / `roleFieldVisibility` (T-0081/T-0419/T-0421). READ-PDP
record-уровня НЕ вводит второй способ прятать поля. Т.к. default-грант — covering-грант с
`resource_facet:NULL` (whole-resource), из него выводится полный visible-set; узкий грант с
`resource_facet.fields:[…]` сужает поля через существующий intersection (grant-resolver
`grantFacetFields`/`visibleFields`, field-visibility `grantConferredFields`). Недозволенные
JSONB-ключи ФИЗИЧЕСКИ ОТСУТСТВУЮТ (не `null`).

### 2.5 Инварианты сохранены

- **NF-3 tenant-isolation:** RLS + explicit `r.tenant_id=$1` остаются ПЕРВЫМ фильтром; PDP —
  ДОПОЛНИТЕЛЬНЫЙ поверх. `RESOURCE_ROOT_NODE_ID` — общий для тенантов, но `getGrantsForSubject`
  и record-SELECT tenant-scoped (RLS), поэтому широкий scope не пересекает тенанты (AC-10).
- **FR-6 человек==агент:** тот же `resolveFor`/containment/visible-set; агентский reader не имеет
  отдельной read-ветки (AC-8).
- **NF-4 анти-кейс:** ни одной кейс-строки (`role-approver`, `soglasovanie`, `tel-`, `Согласование`,
  `e-larina`/`e-orlov`/`e-configurator`) в добавленном `src/`. `role-reader`/`RESOURCE_ROOT` —
  платформенные примитивы (FF-RP-7, AC-9).

---

## 3. Отвергнутые альтернативы

1. **Fail-closed по умолчанию (как на действиях), без сидированного гранта.** Отвергнуто:
   прямое противоречие ратифицированному решению фаундера (вариант (а), не (б)); сломало бы всех
   существующих тенантов в день выката (NF-2) и потребовало бы ручной настройки прежде чем кто-либо
   что-либо увидит.
2. **BOTTOM-scope `{kind:"set",members:[]}` как «tenant-wide».** Отвергнуто: доказано по латтису
   (`isBottom(parent)⇒false`, grant-lattice.ts:250) — ⊥ = НОЛЬ охвата, покрыл бы НИЧЕГО. Это
   антоним «всё» (⊥ используется в T-0373 для configurator-гранта именно как least-authority).
3. **Новый scope-kind `{kind:"tenant"}` / TOP-элемент в латтисе.** Отвергнуто: правка frozen
   `grant-lattice.ts` (FF-RP-8, mutation-gateway-isolation), рябь по `normalize`/`meet`/adversarial-
   тестам T-0018; несоразмерно (NF-5) — resource-root-сентинел даёт то же «покрывает всё» без нового
   kind, оставаясь `node`-scope, который латтис уже умеет.
4. **`{kind:"tags",tags:[]}` тенант-ширины + tag-based refToScope.** Отвергнуто: потребовало бы
   менять `refToScope` (record → tags-scope), ломая единство с action-путём (D2 читает record как
   node); cross-kind несравнимость означает, что и узкое record/registry-сужение перестало бы
   работать через тот же оракул. Двойная модель scope — источник дрейфа.
5. **Полный per-request resource-ancestry map (загрузить всё дерево record→registry→app тенанта).**
   Отвергнуто как ДЕФОЛТ: на больших тенантах — тяжёлая загрузка на каждый запрос; NF-1 риск.
   Заменено на O(1) root-правило для default-гранта + inline-ancestry из уже выбранной строки для
   узких грантов (§2.1 правило 3) — карта не материализуется.
6. **Второй ACL/whitelist-store record-видимости (таблица `record_read_acl`).** Отвергнуто: FR-7 /
   NF-5 — решение выводится ТОЛЬКО из `choros."grant"` через тот же T-0018-латтис; параллельный
   store = вторая система авторитета (запрещено, зеркалит grant-resolver-isolation Check 2).
7. **Backfill в стиле migration 088 (хардкод одного tenant-UUID).** Отвергнуто явно: это
   доказанный анти-паттерн (§2.2); backfill ОБЯЗАН итерировать `choros.tenant` (FF-RP-6).

---

## 4. Объектная модель / контракты (единый источник истины для coder и tester)

### 4.1 Платформенные константы (новые, в `src/core/` — НЕ кейс-строки)

```ts
// src/core/read-visibility.ts (новый модуль, чистый — no DB/net/fs, ports-injected)
export const RESOURCE_ROOT_NODE_ID = "00000000-0000-0000-0000-0000000000r0"; // сентинел-узел уровня "application"; общий для тенантов; различение — RLS-гейт, не nodeId
export const READER_ROLE_SLUG = "role-reader"; // платформенная роль-держатель default-open READ-гранта
```

### 4.2 `ReadVisibilityResolver` (новый optional dep на `RecordRoutesDeps`)

```ts
// src/http/records.ts — additive optional dep; honest-degrade когда absent (NF-2)
export type ReadVisibilityResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<{ grants: Grant[]; ancestry: AncestryOracle }>;
// grants — covering READ-гранты актора из ТОГО ЖЕ getGrantsForSubject DAO (single-resolver).
// ancestry — per-request композит: org (loadTenantOrgAncestry) + resource (§2.1).
```
`RecordRoutesDeps` получает `resolveReadVisibility?: ReadVisibilityResolver;` (optional, additive —
существующая public-поверхность не меняется).

### 4.3 Чистая функция видимости строки (ядро гейта — в `src/core/read-visibility.ts`)

```ts
export function recordResourceScope(recordId: string): ScopeElement; // {kind:"node",hierarchy:"resource",nodeLevel:"record",nodeId:recordId}

export interface RowAncestry { recordId: string; registryId: string; applicationId: string; } // inline из строки

export function isRecordReadable(
  row: RowAncestry,
  grants: Grant[],          // уже отфильтрованные по актору READ-гранты
  ancestry: AncestryOracle, // композит §2.1
  nowMs: number,
): boolean;
// = grants.some(g => g.operation==="read" && isEffective(g,nowMs)
//     && isLatticeScope(g.scope)
//     && isNarrowerOrEqual(recordResourceScope(row.recordId), g.scope, ancestry))
// — тот же containment-предикат, что resolveFor:589–607; НЕ вторая математика (NF-5).
```

### 4.4 Composite resource-ancestry-оракул (`src/db/resource-ancestry.ts` — новый)

```ts
export function makeResourceAncestryOracle(
  orgOracle: AncestryOracle,          // существующий org-оракул (делегирование на hierarchy==="org")
  rowIndex: ReadonlyMap<string, RowAncestry>, // per-request: recordId → {registryId, applicationId} из выбранной страницы
): AncestryOracle;
// isDescendantOrSelf("org", ...)      → orgOracle (без изменений)
// isDescendantOrSelf("resource", d,a):
//    a === d                          → true
//    a === RESOURCE_ROOT_NODE_ID      → true   (правило 2: root покрывает всё дерево ресурсов)
//    иначе — подъём d по rowIndex (record→registry→application), сверяя a на каждом уровне
```
Чистый; `rowIndex` строится edge-слоем из уже выбранной страницы (никакого нового запроса на строку).

### 4.5 Сущности данных (сид/миграция; НЕ новые таблицы)

| Сущность | Поля (существующие таблицы) |
|---|---|
| `role` (role-reader) | `tenant_id`, `id`, `slug='role-reader'`, `display_name`, `created_at`, `updated_at` |
| `role_assignment` (owner→reader, agent→reader) | `tenant_id`, `id`, `employee_id`, `role_id`, `org_scope={kind:"set",members:[]}`, `granted_by`, `confirmed_by`, `source`, `created_at`, `updated_at` |
| `grant` (default-open read) | `tenant_id`, `id`, `role_id`, `resource_type='record'`, `resource_facet=NULL`, `operation='read'`, `scope={kind:"node",hierarchy:"resource",nodeLevel:"application",nodeId:RESOURCE_ROOT_NODE_ID}`, `constraint=NULL`, `delegable=true`, `granted_by`, `confirmed_by`, `valid_from=NULL`, `valid_until=NULL`, `created_at` |

Никаких новых столбцов/таблиц: `scope` — существующий единый `jsonb` (миграция 008). Record-node
несёт `registry_id` (005) и `application_id` (через `registry_def` 004) — ancestry queryable.

### 4.6 Публичная поверхность и импортёры (контракт совместимости, FF-RP-5)

Изменяемые модули и их импортёры:
- `src/http/records.ts` — ДОБАВЛЯЕТ экспорт `ReadVisibilityResolver` + optional поле
  `resolveReadVisibility?` в `RecordRoutesDeps` (additive; существующие экспорты
  `registerRecordRoutes`, `RECORD_STATUS_SIGNAL`, `ActorTenantResolver`, `WriteFacetResolver`,
  `FieldVisibilityResolver`, `ActorPrivilegeResolver`, `RecordRoutesDeps`, `RecordStatusSignalEmitter`
  НЕ меняются). Импортёры: `src/server.ts` (production-wiring), `src/http/form-record-persister.ts`
  (только `ActorTenantResolver` type). Тесты `records-*.test.ts` не ломаются (honest-degrade §2.3).
- `src/core/read-visibility.ts`, `src/db/resource-ancestry.ts` — НОВЫЕ (нет импортёров кроме
  composition root + новых тестов).
- `src/core/grant-resolver.ts`, `src/core/grant-lattice.ts`, `src/core/object-handle.ts`,
  `src/core/field-visibility.ts` — **НЕ редактируются** (только импортируются).
- `src/core/register.ts` — ДОБАВЛЯЕТ seed-блок внутри существующей транзакции (additive).

---

## 5. Fitness-функции (исполнимые правила для CI)

| id | правило | ci_check |
|---|---|---|
| **FF-RP-1** | `GET /api/records`: строка без покрывающего READ-гранта отсутствует в списке; при пустом grant-множестве (гейт активен, гранта нет) список пуст, не полон. | `src/__tests__/records-read-pdp.test.ts`: инжектировать `resolveReadVisibility`, вернуть 0 covering-грантов ⇒ list=[]; вернуть default-грант ⇒ все строки. (AC-1) |
| **FF-RP-2** | `GET /api/records/:id` без покрывающего гранта ⇒ 404 (не 200/403), неотличимо от not-found/cross-tenant. | `records-read-pdp.test.ts`: detail при 0 covering-грантов ⇒ `HttpError(404)`, форма ответа == not-found. (AC-2) |
| **FF-RP-3** | Backfill не ломает: тенант, существовавший до миграции 115, после сида+гейта даёт тот же видимый набор строк, что через старый RLS-путь. | `ci/checks/db/records-read-pdp.db.test.ts`: seed тенант без reader-гранта → применить 115 → сравнить видимый набор до/после == равны. (AC-3) |
| **FF-RP-4** | `registerTenant` сидирует default-open READ-грант (role-reader + assignment + grant) АТОМАРНО в одной транзакции с T-0373; сразу после регистрации владелец видит записи. | `ci/checks/db/records-read-pdp.db.test.ts`: `registerTenant` → сразу `getGrantsForSubject(owner)` содержит read/record/RESOURCE_ROOT грант; abort-инъекция ⇒ ни role-reader, ни grant не осели. (AC-4) |
| **FF-RP-5** | Сужение record-level без правки платформы: узкий READ-грант одному актору убирает записи вне scope; другой актор с default-грантом видит все. | `records-read-pdp.test.ts`: два актора, одному — грант на подмножество (через `createGrant`/DAO, БЕЗ правки `records.ts`); проверить асимметрию видимости. (AC-5) |
| **FF-RP-6** | Backfill-миграция 115 итерирует `choros.tenant`; НЕТ захардкоженного tenant-UUID (анти-паттерн 088). | `ci/checks/read-pdp-no-hardcoded-tenant.sh`: grep миграции 115 на литерал UUID тенанта (`[0-9a-f]{8}-…`) в позиции tenant_id/VALUES ⇒ FAIL; требует `FROM choros.tenant` / `SELECT … tenant`. Self-test с bad/good фикстурами. (AC-3, FR-2) |
| **FF-RP-7** | Анти-кейс (D-064): в diff `src/` нет строк `role-approver`, `soglasovanie`, `tel-`, `Согласование`(конст.), `e-larina`, `e-orlov`, `e-configurator`. | `ci/checks/read-pdp-anti-case.sh`: `git diff`-scoped grep -nE по добавленным строкам под `src/` ⇒ FAIL при совпадении; self-test bad/good. (AC-9, NF-4) |
| **FF-RP-8** | Латтис/handle не тронуты: `grant-lattice.ts`, `object-handle.ts`, `grant-resolver.ts`, `field-visibility.ts` — байтово без правок экспортов; refToScope не изменён. | `ci/checks/read-pdp-frozen-core.sh`: `git diff --name-only` не содержит этих 4 файлов (кроме импортов); переиспользует `mutation-gateway-isolation.sh` FROZEN_EXPORTS-стиль. (NF-5, FR-7) |
| **FF-RP-9** | N+1 отсутствует: `GET /api/records` с N≥50 строк резолвит гранты за O(1) запросов (не O(N)); containment — in-memory. | `records-read-pdp.test.ts`: счётчик вызовов `resolveReadVisibility`/`getGrantsForSubject` == 1 на HTTP-запрос при N=50. (AC-7, NF-1) |
| **FF-RP-10** | Человек==агент: для одного (grant set, ref) человеческий HTTP-путь и агентский reader дают byte-identical visible-set полей; нет отдельной агентской ветки. | `records-read-pdp.test.ts`: deep-equal проекция человек vs агент над одним грант-набором. (AC-8, FR-6) |
| **FF-RP-11** | Field-level поверх record-level: актор с READ-грантом, чей `resource_facet.fields` сужен, получает запись (не 404), но недозволенные JSONB-ключи ОТСУТСТВУЮТ (не null); через существующий `field-visibility.ts`, без второго проекционного пути. | `ci/checks/db/records_field_mask.test.ts`-стиль + `records-read-pdp.test.ts`: узкий facet ⇒ record present, ключи physically absent. (AC-6, FR-4) |
| **FF-RP-12** | Tenant-isolation первична: запись тенанта B невидима актору тенанта A даже при гипотетически широком READ-гранте (RLS + explicit filter — первый фильтр). | `ci/checks/db/records-read-pdp.db.test.ts`: актор A с RESOURCE_ROOT-грантом, SET tenant=B-строка ⇒ 0 строк/404. (AC-10, NF-3) |
| **FF-RP-13** | Honest-degrade: `resolveReadVisibility` absent ⇒ READ-путь byte-identical дотаск-поведению (RLS+sandbox), все существующие read-тесты зелёные. | `npm run fitness` + `records-pagination.test.ts`/`records-field-visibility*.test.ts`/`records-sandbox-gate.test.ts` (и `ci/checks/db/records_crud.test.ts`) зелёные без инъекции резолвера. (NF-2) |

---

## 6. Совместимость: задетые тесты (контракт — должны остаться зелёными при дефолт-гранте)

Существующие read-тесты инжектируют гранты не всегда; honest-degrade §2.3 держит их зелёными
(гейт неактивен без `resolveReadVisibility`). Перечень как контракт:

- `src/__tests__/records-pagination.test.ts` (RP-1..RP-8, keyset-пагинация, без гранта).
- `src/__tests__/records-field-visibility.test.ts` (FVR-1/FVR-2 honest-degrade; FVR-3+ с грантами).
- `src/__tests__/records-field-visibility-detail.test.ts` (DFV-1 honest-degrade; DFV-2+ с грантами).
- `src/__tests__/records-field-visibility-integration.test.ts` (server.ts-wired резолвер).
- `src/__tests__/records-sandbox-gate.test.ts` (SG-1..SG-6, без гранта).
- `src/__tests__/data-access-port.test.ts` (DAP-5 no-op; DAP-6/7 с грантами).
- `ci/checks/db/records_crud.test.ts` (полный CRUD, live PG, без инъекции READ-резолвера).
- `ci/checks/db/records-sandbox-gate.test.ts` (sandbox live).
- `ci/checks/db/records_field_mask.test.ts` (field-mask live — переиспользуется для FF-RP-11).
- `src/__tests__/binding-trigger.unit.test.ts`, `src/__tests__/spaAuth.test.ts` (импортируют records).

Контракт: НИ ОДИН не должен потребовать правки, кроме опционального добавления инъекции
`resolveReadVisibility` в новых read-pdp-кейсах. Production-путь (`server.ts`) подключает резолвер
в том же коммите, что применяет миграцию 115 (сид — предусловие включения гейта, NF-2).

---

## 7. Трассировка AC → дизайн

| AC | покрыто |
|---|---|
| AC-1 (list прячет без гранта) | §2.3 LIST-фильтр + FF-RP-1 |
| AC-2 (detail 404 без гранта) | §2.3 DETAIL + FF-RP-2 |
| AC-3 (backfill не ломает) | §2.2 миграция 115 + FF-RP-3, FF-RP-6 |
| AC-4 (registerTenant атомарный сид) | §2.2 register.ts + FF-RP-4 |
| AC-5 (сужение record-level = настройка) | §2.1 правило 3 + §4 `validateNarrowing` + FF-RP-5 |
| AC-6 (field-level поверх record-level) | §2.4 + FF-RP-11 |
| AC-7 (нет N+1) | §2.3 O(1)-резолюция + FF-RP-9 |
| AC-8 (человек==агент) | §2.5 FR-6 + FF-RP-10 |
| AC-9 (анти-кейс) | §2.5 NF-4 + FF-RP-7 |
| AC-10 (tenant-isolation первична) | §2.5 NF-3 + FF-RP-12 |
| AC-11 (LIVE_PROOF §6 спеки) | manual — §6 спеки; поддержан §2 (backfill-видимость, сужение грантом, 404, второй актор не задет) |

---

## 8. runtime_target

`runtime:node` — TS/Node HTTP-слой (`src/http/records.ts`) + чистое ядро (`src/core/read-visibility.ts`)
+ DB-слой (`src/db/resource-ancestry.ts`, `getGrantsForSubject`) + Postgres-миграция
(`migrations/115_default_read_grant_backfill.sql`) + seed в `src/core/register.ts`. Fitness: vitest
(`src/__tests__/records-read-pdp.test.ts`) + live-PG (`ci/checks/db/records-read-pdp.db.test.ts`,
`npm run fitness:db`) + shell-линтеры (`read-pdp-no-hardcoded-tenant.sh`, `read-pdp-anti-case.sh`,
`read-pdp-frozen-core.sh`).

---

## 9. Escalation

Нет. Развилка §1.1 (resource-ancestry-оракул vs новый scope-примитив) — инженерное решение в
пределах ратифицированного T-0018-латтиса и решения фаундера (вариант (а)); §5 спеки явно делегирует
её architect, §8 спеки: «не разворот объёма/поведения». Выбран resource-ancestry-оракул с
root-сентинелом (§2.1) как соразмерный (нет нового kind, латтис frozen, O(1) для default-гранта,
поддерживает будущее сужение). Ничего высоколевериджно-спорного не осталось.
