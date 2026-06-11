# ADR · T-0121 — Отчёты как кастомные UI-страницы (two-floor) + реестр зависимостей страниц от полей схемы

**Task:** T-0121 · type=design · product=choros · prio 57 · phase = DESIGN (architect)
**Status:** ready
**Date:** 2026-06-11
**Spec источник:** `docs/specs/T-0121-reports-pages-design.spec.md` (22 AC) + `docs/specs/T-0121.spec.contract.json`
**ADR-родитель:** `docs/design/extensibility-and-authoring.md` §4 (TWO-FLOOR), §5 (Section→App→Page NAV), §6 (RLS-канал кросс-данных), §9.2 (машинно-проверяемая граница этажей), §11 (Floor-1 day-1 секвенирование)
**Прецеденты:** T-0072 (named-binding / `checkBindingCompat`), T-0082 (bundle-coherence), T-0077 (config-агент / authoring_draft / MCP-seed), T-0087 (draft→published тиры), T-0013/T-0115 (tenant-table контракт + RLS), T-0014 (registry_def.record_schema), T-0018/T-0021 (grant-алгебра + PDP), T-0016 (audit floor), T-0084 (semantic changelog — потребитель)
**Migration slots (бронь, DDL не выполняется в DESIGN):** `report_page` = **046**, `report_page_dep` = **047** (T-0072 занял 045 на сестринской ветке; T-0082 миграций не добавляет; следующие свободные — 046+; «следующий свободный при материализации» — если к моменту coder-фазы 046/047 заняты, coder берёт следующие свободные ≥046 и сохраняет порядок `report_page` перед `report_page_dep` ради FK).

---

## 1. Decision (суть в одном экране)

Отчёт в Choros — это **кастомная UI-страница** третьего уровня навигации Section→App→**Page**, а не отдельный тип артефакта со своей подсистемой прав/версий/согласованности. Страница материализуется двумя tenant-таблицами ядра:

1. **`report_page`** — метаданные страницы (`app_id`, `slug`, `title`, `floor ∈ {'1','2'}`, `tier ∈ {'draft','published'}`, `bundle_ref` nullable, `page_def jsonb`/`page_code text`) с полным T-0013-контрактом.
2. **`report_page_dep`** — реестр зависимостей: одна строка = одна страница зависит от одного `field_key` одной `registry_def.record_schema`, с `dep_kind ∈ {'read','aggregate'}` и `stale boolean`.

**Этажи (ось A extensibility §4) с машинной границей:**
- **Floor-1 (дефолт-поверхность, zero-LLM)** — декларативная JSON-Schema агрегата (`page_def`): список метрик `{source_registry_def_id, field_key, agg ∈ {count|sum|avg|min|max|list}, filter?}`. Рендерится детерминированно server-side, переживает агента-офлайн (NF-4), редактируется кнопочно администратором.
- **Floor-2 (governed-потолок)** — React-компонент (`page_code`), авторит config-агент в DRAFT, промоутит человек. Floor-2 **никогда** не читает record-данные напрямую — только через тот же авторизованный RLS-gated серверный канал, что extensibility §6 (cross-app data). DB-credentials в клиентском бандле структурно отсутствуют.
- **Граница (машинная, §9.2):** страница **обязана** быть Floor-1, если её содержимое целиком выразимо через vocab Floor-1 JSON-Schema агрегата (см. §4 ADR — функция `classifyReportPageFloor`). Floor-2 допустим **только** когда `page_def` не пуст по «не-агрегируемой» презентации: нестандартная вёрстка/интерактив/композиция, не выразимая агрегат-vocab. ADR запрещает эмиссию Floor-2 для тривиальной агрегации (детерминизм не теряется зря).

**Реестр зависимостей — расширение T-0072, не третий механизм.** Форма (T-0072) _производит_ переменные в схему (`form_binding`); отчётная страница _потребляет_ поля схемы (`report_page_dep`). Это две стороны одного named-binding контракта «артефакт ↔ поля схемы». Проверка симметрична: T-0072 экспортирует `checkBindingCompat`; T-0121 экспортирует **`checkReportPageDepFields`** из `src/core/report-page-compat.ts` — чистую функцию (no I/O), `BindingViolation` → `DepViolation`. **Один control plane согласованности** (NF-1).

**Способ наполнения реестра — ГИБРИД (зона дизайна, решено):**
- **Floor-1 → автоматически:** `page_def` JSON-Schema агрегата _и есть_ декларация зависимостей; deps выводятся синтаксическим разбором `page_def` (каждая метрика `{source_registry_def_id, field_key, agg}` → строка `report_page_dep` с `dep_kind='aggregate'` для agg-метрик, `'read'` для list-полей). Ручной труд = ноль, ложных срабатываний нет.
- **Floor-2 → ручная декларация:** автор (config-агент через `author_report_page`, либо администратор) явно передаёт `deps[]`; статический анализ React-кода для автоизвлечения — **Stage-2** (out-of-scope §5.4 спеки), приемлемы ложные отрицания, не ложные срабатывания (best-effort, как T-0072 NF-5 EL-парсер).

**Изменение схемы → две дисциплины:**
- **«Мягкое»** (relabel, add optional field, расширение enum, toggle `required`) → операция **применяется**, в ответе `warnings: [{page_slug, registry_def_id, field_key}]` (машинно-читаемо, NF-8), список входит в changelog-payload T-0084.
- **«Деструктивное»** (drop `field_key`, rename `field_key`, lossy type-narrowing при `dep_kind='aggregate'`) при наличии активного non-stale dep → **default-DENY**: API `409 destructive_schema_change`, изменение **не применяется**; `bundle-coherence.sh` (T-0082) fail при stale dep в CI; promote страницы со stale-dep заблокирован (`409`).
- **Escape-hatch** (необходим — схема обязана эволюционировать): `force:true` + grant `mgmt_object:schema_destructive`/`operation:apply` (admin-only) → изменение применяется, затронутые deps помечаются `stale=true`, страницы депромоутируются в `tier='draft'`, пишется один audit-event `report_page.schema_destructive_force` с `affected_pages`. Никогда не «тихое удаление зависимостей» — депромоут + аудит-след.

**Права — единый PDP T-0021, ноль новых permission-механизмов (FF-R6).** Просмотр = grant `read` на `application`; авторинг DRAFT = `mgmt_object:report_page`/`author` (config-агент + админ); promote = `mgmt_object:report_page`/`promote` (**human-only**, не агент); деструктив-force = `mgmt_object:schema_destructive`/`apply` (admin-only). Все `resource_type`-строки живут как TEXT (паттерн T-0077 §2.2 widening-cast), не правят frozen `ResourceType`-union.

**Аудит — единый `appendAuditEvent` T-0016**, ноль второго sink. **Tenant-изоляция — структурная** (T-0013 FORCE RLS на обеих таблицах), не на дисциплине кода (NF-2).

---

## 2. Object model (DDL бронируется, не выполняется)

### 2.1 `choros.report_page` (migration 046 — или следующий свободный ≥046 при материализации, см. §0) — T-0013-контракт

| Колонка | Тип | Примечание |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK, RLS-ключ |
| `id` | `uuid NOT NULL` | |
| `app_id` | `uuid NOT NULL` | FK `(tenant_id, app_id) → application(tenant_id, id)` (T-0014); cross-tenant FK структурно невозможен |
| `slug` | `text NOT NULL` | URL-safe; `UNIQUE (tenant_id, app_id, slug)` |
| `title` | `text NOT NULL` | человеко-видимое имя в left-sidebar |
| `floor` | `text NOT NULL` | `CHECK (floor IN ('1','2'))` |
| `tier` | `text NOT NULL DEFAULT 'draft'` | `CHECK (tier IN ('draft','published'))` (T-0087) |
| `page_def` | `jsonb NULL` | Floor-1: JSON-Schema агрегата. Floor-2: NULL или презентационный конфиг |
| `page_code` | `text NULL` | Floor-2: сырой TSX/JS (компилируется в deploy-шаге, **не** бинарь в Postgres). Floor-1: NULL |
| `bundle_ref` | `text NULL` | ссылка на git-ref связки (extensibility §7); `DEFAULT NULL` — explicit deferral до git-под-капотом (T-0082 out-of-scope) |
| `created_at` | `bigint NOT NULL` | epoch ms (паттерн T-0119) |
| `updated_at` | `bigint NOT NULL` | |

PK `(tenant_id, id)`; `UNIQUE (tenant_id, app_id, slug)`. `CHECK`: Floor-1 ⇒ `page_def IS NOT NULL`, Floor-2 ⇒ `page_code IS NOT NULL` (`report_page_floor_payload_chk`). ENABLE+FORCE RLS; policy `report_page_tenant_isolation` USING/WITH CHECK на `current_setting('choros.tenant_id', true)::uuid`; `GRANT SELECT,INSERT,UPDATE,DELETE TO choros_app`; занесена в `ci/checks/known_tenant_tables.txt`.

### 2.2 `choros.report_page_dep` (migration 047 — или следующий свободный ≥047 при материализации, см. §0) — T-0013-контракт

| Колонка | Тип | Примечание |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK, RLS-ключ |
| `id` | `uuid NOT NULL` | |
| `page_id` | `uuid NOT NULL` | FK `(tenant_id, page_id) → report_page(tenant_id, id)` ON DELETE CASCADE (удаление страницы убирает её deps; аудит переживает, NF-7) |
| `registry_def_id` | `uuid NOT NULL` | FK `(tenant_id, registry_def_id) → registry_def(tenant_id, id)` (T-0014) |
| `field_key` | `text NOT NULL` | ключ поля в `registry_def.record_schema.properties` |
| `dep_kind` | `text NOT NULL` | `CHECK (dep_kind IN ('read','aggregate'))`; vocab закрытый, расширяем доп-миграцией |
| `stale` | `boolean NOT NULL DEFAULT false` | ставится в `true` при деструктив-force; гейтит promote |
| `created_at` | `bigint NOT NULL` | |

PK `(tenant_id, id)`; `UNIQUE (tenant_id, page_id, registry_def_id, field_key)`. ENABLE+FORCE RLS; policy `report_page_dep_tenant_isolation`; `GRANT … TO choros_app`; занесена в `known_tenant_tables.txt`. `dep_kind`-CHECK имеет имя `report_page_dep_kind_chk` (расширение vocab = аддитивная миграция, drop+recreate CHECK).

> **Замечание по FK-применимости (урок T-0017/T-0033, T-0032 §32):** обе FK указывают на уже-живые таблицы (`application`, `report_page`, `registry_def`) → применяются без bounce. Никаких deferred-FK на отсутствующие таблицы.

---

## 3. Чистое ядро согласованности (`src/core/report-page-compat.ts`) — расширение T-0072

```ts
// Симметрично src/core/binding-compat.ts (T-0072). NO I/O. NO DB. NO network.
export type DepKind = 'read' | 'aggregate';
export interface PageDep { registryDefId: string; fieldKey: string; depKind: DepKind; }
export interface DepViolation {
  type: 'missing_in_schema' | 'lossy_narrowing';   // closed vocab, расширяем
  registryDefId: string;
  fieldKey: string;
}
export type DepCompatResult = { ok: true } | { ok: false; violations: DepViolation[] };

export function checkReportPageDepFields(
  deps: PageDep[],
  recordSchema: JsonSchema,         // тип импортируется, не редекларируется
): DepCompatResult;
```

Контракт (AC-4/AC-18/AC-22):
- `field_key ∉ recordSchema.properties` → `{type:'missing_in_schema', fieldKey, registryDefId}`.
- Все ключи присутствуют → `{ok:true}`.
- Опционально (тип-narrowing для `dep_kind='aggregate'`) — `{type:'lossy_narrowing'}` (см. §5 критерий деструктива).
- Функция **pure**: импортирует только тип `JsonSchema`; не импортирует `pg`/`fs`/`net`/DAO. Это инвариант (FF-PURE: jest-тест на отсутствие I/O-импортов, аналог T-0072 NF-2).

**Прецедентная ссылка обязательна:** ADR явно объявляет `checkReportPageDepFields` расширением паттерна `checkBindingCompat` — _не_ второй механизм согласованности «артефакт→поля». `DepViolation` — зеркало `BindingViolation`. Это NF-1 и закрывает gap-map §4б («не плодить три механизма»).

---

## 4. Граница Floor-1 ↔ Floor-2 (машинное правило, §9.2)

Экспортируется чистая функция `classifyReportPageFloor(pageDef): {requiredFloor: '1'|'2', reason}` (в том же модуле или `src/core/report-page-floor.ts`):

**Vocab Floor-1 (исчерпывающий, детерминированный):** `page_def` — массив `metrics[]`, каждая метрика:
```
{ source_registry_def_id: uuid, field_key: string,
  agg: 'count'|'sum'|'avg'|'min'|'max'|'list',
  group_by?: field_key, filter?: { field_key, op: '='|'!='|'<'|'>'|'in', value } }
```
плюс заголовки секций (`title`, `subtitle` — статичный текст).

**Правило:** если страница целиком выразима этим vocab → `requiredFloor='1'` (Floor-2 для неё **запрещён** — ADR-гард). Floor-2 разрешён **только** если требуется презентация/интерактив вне vocab (кастомная вёрстка, drill-down-интеракция, нестандартная композиция). Граница — синтаксическое свойство `page_def`, не «вкус агента» (§9.2 инвариант). Config-агент, эмитящий Floor-2 для агрегации, выразимой Floor-1, ловится фитнесом FF-FLOOR (см. §8).

**Day-1 секвенирование (extensibility §11, confidence high):** Floor-1 — поверхность day-1; Floor-2 React-runtime может опираться на существующие React/Vite-зависимости (NF-6, ноль новых prod npm-зависимостей для ядра). Полная git-под-капотом машинерия Floor-2 (`bundle_ref`) — инкрементально, поле зарезервировано nullable.

---

## 5. Классификация изменений схемы + механизм блокировки

### 5.1 Мягкое (warning, не блок) — AC-6
`relabel` (только `title`/UI-отображение), `add field` (новое опциональное/required поле), `enum widening`, `toggle required`. Триггер: `PUT/PATCH /api/registry-defs/:id` с `record_schema`, где поля имеют активные `report_page_dep` (`stale=false`). Сервер вычисляет затронутые страницы (join `report_page_dep` по изменённым `field_key`), применяет изменение, возвращает `warnings: [{page_slug, registry_def_id, field_key}]`. Видит вызывающий клиент (админ/config-агент). Только для `tier='published'`-схемы регистрируется changelog-предупреждение (для черновой схемы — тоже warning, но без changelog-эмиссии).

### 5.2 Деструктивное (default-DENY) — AC-7
**Машинный критерий** (применяется к полю, на которое есть активный non-stale dep):
- **drop `field_key`** из `record_schema.properties` → деструктив (всегда).
- **rename `field_key`** (= remove old + add new) → деструктив для зависимых страниц (эквивалент drop старого ключа).
- **lossy type-narrowing** (`number→integer`, `string→enum` с меньшим vocab, расширение → сужение) при `dep_kind='aggregate'` → **деструктив** (агрегация по суженному типу может потерять данные/сломать сумму). При `dep_kind='read'` type-narrowing → **мягкое** (warning), т.к. чтение поля переживает сужение типа.
- **НЕ деструктив:** add field, enum widening, relabel, toggle `required`.

**Блокировка (три уровня, симметрично extensibility §4 default-DENY + RLS):**
1. **Runtime API:** деструктив без `force` → `409 { error:'destructive_schema_change', affected_pages:[...], fields:[...] }`; изменение **не применяется** (`record_schema` неизменна — AC-16).
2. **CI-гард `bundle-coherence.sh` (T-0082, расширение `check-report-page-deps`):** для каждой строки `report_page_dep` проверяет, что `field_key ∈ registry_def.record_schema.properties`; несуществующий (stale-фактический) dep → `exit 1`. Это ловит десинк, просочившийся в репозиторий конфигов мимо runtime-гарда.
3. **Promote human-gate (AC-9):** `report_page` с любым `dep.stale=true` не промоутится в `published` → `409`; страница остаётся в `draft`, пока stale-deps не исправлены или удалены.

### 5.3 Escape-hatch (AC-8) — `force:true`
Грант `mgmt_object:schema_destructive`/`apply` (admin-only, отдельная операция, явный confirm) + `force:true`:
1. изменение `record_schema` применяется;
2. затронутые `report_page_dep` → `stale=true`;
3. их страницы → `tier='draft'` (депромоут — не остаются «published поверх сломанной схемы»);
4. **один** audit-event `appendAuditEvent({ action:'report_page.schema_destructive_force', affected_pages, fields, actor })`.

**Зависимости НЕ удаляются молча** — они помечаются stale (видимый сломанный край, чинибельный автором), а страница депромоутится. Это extensibility §4 escape-hatch (default-DENY на необратимость, но с явным аудируемым human-confirm-выходом).

### 5.4 `bundle_members.txt` расширение (NF-5, DoD T-0121-impl)
T-0121-impl обязан: (а) добавить `report_page_dep` в `bundle_members.txt` как `kind=choros_table`; (б) добавить `check-report-page-deps` в `bundle-coherence.sh`; (в) пройти `bundle-coherence.sh` после merge. Аналог T-0082 deferral contract FR-7. DESIGN фиксирует обязательство, не выполняет.

---

## 6. Права (единый PDP T-0021, ноль второго механизма) + MCP-tool

| Действие | Grant (`resource_type` / `operation`) | Субъект |
|---|---|---|
| Просмотр страницы | `read` на `application` (через PDP T-0021, fail-closed) | любой с grant на app |
| Авторинг (create/update DRAFT) | `mgmt_object:report_page` / `author` | config-агент (MCP) + админ |
| Управление `report_page_dep` | `mgmt_object:report_page` / `author` (тот же уровень) | автор страницы |
| Promote `draft`→`published` | `mgmt_object:report_page` / `promote` | **human-only** (не агент) |
| Деструктив-force схемы | `mgmt_object:schema_destructive` / `apply` | admin-only |

Гранулярность просмотра — на уровне `application` (страница наследует видимость app), а не отдельный `report_page`-ресурс: ноль нового permission-механизма (FF-R6), одна PDP-проверка. Все `resource_type`-строки (`mgmt_object:report_page`, `mgmt_object:schema_destructive`) — admissible как TEXT в `grant.resource_type` (нет DB CHECK на vocab — T-0077 §2.2); TS-union `ResourceType` (frozen seam) **не правится**, widening-cast только в тестах (паттерн T-0024/T-0077).

### 6.1 MCP-tool `author_report_page` (seed, паттерн T-0077) — AC-12
Новый `choros.mcp_tool`- row (seed в той же migration-волне или отдельный slot, coder выбирает): `declares='[]'::jsonb`, `pure_compute=true`, `resource_ops='[{"resourceType":"authoring_draft","operation":"create"},{"resourceType":"authoring_draft","operation":"update"}]'::jsonb`.

> **⚠ WARNING (урок T-0077 §2.3): seed `author_report_page` обязан идти в dev-тенант `a0000000-0000-0000-0000-000000000001`.** `resolveAgentToolset(tenantId)` ищет tools и grants строго в одном `tenantId` под RLS — строка в другом тенанте делает инструмент невидимым для config-агента (критический инвариант: тот же тенант, что migration 044 T-0077).
- **Input-schema:** `{ app_id, slug, title, floor, page_def | page_code, deps?: [{registry_def_id, field_key, dep_kind}] }`.
- **Назначение:** create/update `report_page` в `tier='draft'` + register/update `report_page_dep` (для Floor-1 deps выводятся из `page_def` автоматически; для Floor-2 берутся из `deps[]`).
- **DRAFT-only (структурно):** config-агент имеет гранты только на `authoring_draft` (T-0077 §1) → `resolveAgentToolset` не выдаёт promote-tool. Promote — отдельный human-gated tool/UI (`promote_report_page` либо переиспользование existing promote-механизма T-0087). Агент **не может** self-promote (extensibility §4/§8 governance, ось B).
- **Audit-vocab (frozen seam, как T-0077):** `report_page.authored`, `report_page.promoted`, `report_page.demoted`, `report_page_dep.registered`, `report_page_dep.updated`, `report_page_dep.deleted`, `report_page.schema_destructive_force`.

---

## 7. Tenant-изоляция + аудит (инварианты, non-negotiable)

- **FR-6 / NF-2:** `report_page` и `report_page_dep` — полный T-0013-контракт (см. §2): `tenant_id`-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `choros.tenant_id` GUC, `choros_app` DML-only, в `known_tenant_tables.txt`. Cross-tenant доступ к странице/зависимости структурно невозможен (один leak = смерть GTM). Существующие T-0013/T-0115-пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) применяются к новым таблицам после внесения в фикстуру.
- **Floor-2 RLS-канал (AC-11):** Floor-2 React-код читает record-данные **только** через авторизованный RLS-gated серверный API-эндпоинт (тот же канал, что extensibility §6 cross-app data). DB-credentials в клиентском бандле отсутствуют структурно — прямой DB-доступ из Floor-2 неконструируем.
- **API fail-closed:** `GET /api/report-pages` и все мутации tenant-scoped по tenant-контексту сессии; нет cross-tenant выборки (AC-15).
- **FR-7 аудит (T-0016, единственный canonical `appendAuditEvent`):** события на create/update/delete `report_page`; tier_change (promote/demote); register/update/delete `report_page_dep`; деструктив-force (с `affected_pages`). Ноль второго audit-sink. Аудит-след переживает удаление страницы (append-only, NF-7) — `ON DELETE CASCADE` чистит deps, но не audit_event.

---

## 8. Fitness functions (machine-verifiable)

| ID | Rule | CI-check (gating) |
|---|---|---|
| **FF-T13-PAGE** | `report_page`/`report_page_dep` — tenant_id-leading PK/FK, ENABLE+FORCE RLS, default-DENY на `choros.tenant_id`, choros_app DML-only, в `known_tenant_tables.txt`. | T-0013/T-0115-пробы (`tenant_id_leading.sql`, `cross-tenant-fitness.sh`) после внесения в фикстуру. **live-impl**. |
| **FF-SCHEMA-046** | Миграции `046_report_page.sql`/`047_report_page_dep.sql` (или следующие свободные ≥046) определяют ровно поля §2.1/§2.2, CHECK на `floor`/`tier`/`dep_kind`, UNIQUE-ключи; бинарь не в Postgres (нет bytea/large-object — `page_code` это text). | `grep`-статик на DDL: assert колонки/CHECK/UNIQUE; `grep -iE '\b(bytea\|lo_)\b'` ⇒ 0. **static-now** (после coder). |
| **FF-COMPAT-PURE** | `checkReportPageDepFields` экспортируется из `src/core/report-page-compat.ts`; pure (нет импортов `pg`/`fs`/`net`/DAO); ADR-комментарий ссылается на T-0072 `checkBindingCompat`. | `vitest src/__tests__/report-page-compat.test.ts -t 'pure'` + grep на запрещённые импорты. Аналог T-0072 NF-2. **static-now**. |
| **FF-COMPAT-BEHAVIOR** | `checkReportPageDepFields`: `field_key ∉ schema.properties` ⇒ `{ok:false, violations:[{type:'missing_in_schema', field_key}]}`; все присутствуют ⇒ `{ok:true}`. | `vitest … -t 'missing-field' / 'all-present'`. Покрывает AC-18. **static-now**. |
| **FF-FLOOR** | `classifyReportPageFloor`: `page_def`, выразимый vocab Floor-1, ⇒ `requiredFloor='1'`; эмиссия Floor-2 для такой страницы запрещена. Граница синтаксическая, не «вкус агента». | `vitest … -t 'floor-boundary'`: агрегатный page_def ⇒ '1'; assert author-path reject Floor-2 для агрегата. Покрывает AC-3, §9.2 инвариант. **static-now**. |
| **FF-DEP-VALIDATE** | Регистрация dep с `field_key ∉ record_schema` ⇒ ошибка 422, не тихий accept. | live-impl probe: POST dep с несуществующим ключом ⇒ 422; запись в `report_page_dep` не создана. Покрывает AC-5. **live-impl**. |
| **FF-SOFT-WARN** | Мягкое изменение схемы (relabel/add/widen) с активными deps ⇒ операция применяется + `warnings:[{page_slug,registry_def_id,field_key}]` (структурный массив, не текст). | live-impl probe + `vitest` на классификатор soft/destructive. Покрывает AC-6, NF-8. **static-now + live-impl**. |
| **FF-DESTRUCTIVE-DENY** | drop/rename field_key (или lossy narrowing при aggregate) с активным non-stale dep без force ⇒ 409 `destructive_schema_change`; `record_schema` неизменна. | live-impl probe (style `cross_tenant.test.ts`): drop поля с dep ⇒ 409, schema unchanged. Покрывает AC-7/AC-16. **live-impl**. |
| **FF-BUNDLE-DEPS** | `bundle-coherence.sh` содержит `check-report-page-deps`: каждый `report_page_dep.field_key` ∈ актуальной `record_schema`; иначе `exit 1`. `report_page_dep` ∈ `bundle_members.txt` (kind=choros_table). | запуск `bundle-coherence.sh` на фикстуре со stale dep ⇒ exit 1; grep `bundle_members.txt`. Покрывает AC-10/NF-5. **static-now** (после T-0121-impl). |
| **FF-FORCE-DEMOTE** | Деструктив с `force:true` + grant schema_destructive/apply ⇒ изменение применено, затронутые deps `stale=true`, страницы `tier='draft'`, audit_event `action='report_page.schema_destructive_force'` с `affected_pages`. | live-impl probe. Покрывает AC-8/AC-19. **live-impl**. |
| **FF-PROMOTE-GATE** | Promote `report_page` с `dep.stale=true` ⇒ 409; страница остаётся `draft`. | live-impl probe. Покрывает AC-9/AC-17. **live-impl**. |
| **FF-NO-2ND-AUTHZ** | Видимость/авторинг/promote страниц = grant-алгебра T-0018 + PDP T-0021; нет `report_page_acl`/`page_visibility`/второго permission-поля; promote-grant отсутствует у config-агента (DRAFT-only). | `grep` forbidden tokens в migrations 046/047 + API-слое; assert PDP-call (`resolveFor`/PDP T-0021), не локальный grant-фильтр. Покрывает AC-12, FF-R6. **static-now**. |
| **FF-FLOOR2-RLS** | Floor-2 код не имеет DB-credentials/прямого DB-доступа; читает record-данные только через RLS-gated серверный API. | static: assert клиентский бандл не содержит DB-connection; data-fetch идёт на серверный эндпоинт. Покрывает AC-11. **static-now**. |
| **FF-AUDIT-EVENTS** | create/update/delete report_page, tier_change, dep register/update/delete, destructive-force ⇒ каждое = `appendAuditEvent` (open vocab `report_page.*`), tenant-scoped; нет второго audit-sink/дубль-таблицы в `known_tenant_tables`. | `vitest … -t 'audit-events'`: каждая операция эмитит ожидаемый event; assert нет audit-дубля. Покрывает AC-13. **static-now**. |
| **FF-CHANGELOG-T84** | Список затронутых страниц при изменении схемы доступен как структурный payload для T-0084 changelog (контрактное требование к T-0084). | static: assert API-ответ содержит machine-readable `affected_pages`/`warnings`; ADR §5.1 фиксирует контракт к T-0084. Покрывает AC-21. **static-now**. |

---

## 9. Build-задачи (декомпозиция; материализуются после ADR)

| Задача | Название | Depends on | Fitness (DoD) |
|---|---|---|---|
| **T-0121a** | `[impl] report_page + report_page_dep DDL (migrations 046/047) + known_tenant_tables` | T-0014 (registry_def), T-0017/T-0013 apparatus | FF-T13-PAGE, FF-SCHEMA-046; обе таблицы под FORCE RLS, в `known_tenant_tables.txt`, T-0013-пробы зелёные |
| **T-0121b** | `[impl] core/report-page-compat.ts — checkReportPageDepFields + classifyReportPageFloor (pure)` | T-0072 (binding-compat паттерн) | FF-COMPAT-PURE, FF-COMPAT-BEHAVIOR, FF-FLOOR; vitest зелёный, нет I/O-импортов |
| **T-0121c** | `[impl] registry_def schema-change API: soft-warning + destructive-deny + force-escape-hatch` | T-0121a, T-0121b, T-0021 (PDP) | FF-SOFT-WARN, FF-DESTRUCTIVE-DENY, FF-FORCE-DEMOTE; 409 на деструктив, warnings на мягкое, depromote+stale на force |
| **T-0121d** | `[impl] report_page CRUD API + author/promote + report_page_dep registration (PDP-gated)` | T-0121a, T-0121b, T-0021, T-0018 | FF-DEP-VALIDATE, FF-PROMOTE-GATE, FF-NO-2ND-AUTHZ, FF-AUDIT-EVENTS; 422 на bad field_key, 409 на stale-promote, единый PDP |
| **T-0121e** | `[impl] bundle-coherence check-report-page-deps + bundle_members.txt` | T-0121a, T-0082 | FF-BUNDLE-DEPS; `bundle-coherence.sh` fail на stale dep, проходит после merge (NF-5 DoD) |
| **T-0121f** | `[seed] mcp_tool author_report_page для config-агента (паттерн T-0077)` | T-0121d, T-0077 (config-agent seed) | author_report_page reachable в `resolveAgentToolset`, только `authoring_draft`-гранты, DRAFT-only; audit-vocab seam |
| **T-0121g** | `[impl] Floor-1 server-side агрегат-рендерер + Floor-2 RLS-gated data API` | T-0121a, T-0121d, §6 extensibility RLS-канал | FF-FLOOR2-RLS, NF-4; Floor-1 рендерится детерминированно без LLM, Floor-2 без прямого DB-доступа |
| **T-0121h** *(Stage-2)* | `[impl] статический анализ Floor-2 React → автоизвлечение field-deps` | T-0121b, T-0121d | best-effort парсер: ложные отрицания ок, ложные срабатывания нет (паттерн T-0072 NF-5) — out-of-scope day-1 |

UI-редактор страниц (Floor-1 кнопочный) — задачи **зоны 7** (out-of-scope §5.3 спеки), не входит в T-0121-волну.

---

## 10. Rejected alternatives

| Опция | Почему отвергнута |
|---|---|
| Отдельная подсистема «отчёт» со своими правами/версиями/coherence | Дублирует named-binding (T-0072) и bundle-coherence (T-0082) — третий механизм согласованности, gap-map §4б прямо запрещает. Отчёт = страница в Section→App→Page под существующими механизмами. |
| `report_page_acl` / `page_visibility`-поле | Второй источник истины «кто видит страницу» дрейфует от «кто видит app» → тихий leak/отказ. Запрещено T-0018 §2 / T-0021 FF-R6 / NF-1. Видимость = grant `read` на application через тот же PDP. |
| Чистый статический анализ для всех field-deps (Floor-1+Floor-2) | Floor-2 React-парсинг недетерминирован, даёт ложные срабатывания (ломает мягкие изменения зря). Гибрид: Floor-1 авто из page_def (точно), Floor-2 ручная декларация day-1, статанализ Floor-2 = Stage-2 (приемлемы ложные отрицания, не срабатывания). |
| Чистая ручная декларация для Floor-1 тоже | `page_def` агрегата _и есть_ декларация зависимостей — ручное дублирование рассинхронизируется с самой страницей. Floor-1 deps выводятся автоматически из page_def — единый источник. |
| Тихое удаление зависимостей при деструктив-force | Прячет сломанный край: страница «published» поверх несуществующего поля. Вместо этого — `stale=true` + депромоут в draft + audit-event: видимый чинибельный край, аудируемый необратимый шаг (extensibility §4 escape-hatch). |
| Бинарь/компилированный бандл Floor-2 в Postgres | Раздувает БД/бэкапы/WAL. Хранится сырой TSX/JS (`page_code text`), компиляция в deploy-шаге (паттерн T-0119 «бинарь не в Postgres»). |
| Деструктив = всегда hard-block без escape-hatch | Невозможно полностью заблокировать эволюцию схемы живого клиента. Нужен аудируемый human-confirm-выход (force+grant+депромоут), иначе клиент застревает (extensibility §4 default-DENY ≠ default-impossible). |
| Промоутить может config-агент (self-promote) | Self-apply в prod запрещён для обоих этажей (extensibility §4/§8 governance, ось B). Promote — human-only grant; агент имеет только `authoring_draft` (T-0077). |
| Floor-2 React читает DB напрямую | Cross-tenant leak-вектор + обход RLS. Floor-2 читает данные только через RLS-gated серверный канал (extensibility §6); DB-credentials в клиентском бандле отсутствуют структурно. |
| Править TS-union `ResourceType` под `mgmt_object:report_page`/`schema_destructive` | `grant-lattice.ts` — frozen seam. Out-of-union resource_type живёт как TEXT в DB + widening-cast на границе (доказано T-0024/T-0077 §2.2). Правка union сломала бы frozen-guard. |

---

## 11. Traceability (22 AC → решения ADR)

| AC | Покрыто |
|---|---|
| AC-1 | §2.1 (`report_page` T-0013-контракт, все поля, UNIQUE) + FF-T13-PAGE/FF-SCHEMA-046 |
| AC-2 | §2.2 (`report_page_dep` T-0013-контракт, поля, UNIQUE, stale) + FF-T13-PAGE/FF-SCHEMA-046 |
| AC-3 | §4 (`classifyReportPageFloor`, vocab Floor-1, синтаксическая граница) + FF-FLOOR |
| AC-4 | §3 (`checkReportPageDepFields`, ссылка на T-0072 `checkBindingCompat`) + FF-COMPAT-PURE/BEHAVIOR |
| AC-5 | §5.1/§6.1 (валидация при регистрации dep, 422) + FF-DEP-VALIDATE |
| AC-6 | §5.1 (мягкое изменение, warnings машинно-читаемы, операция применяется) + FF-SOFT-WARN/NF-8 |
| AC-7 | §5.2 (критерий деструктива drop/rename/narrowing + 409 + CI fail) + FF-DESTRUCTIVE-DENY/FF-BUNDLE-DEPS |
| AC-8 | §5.3 (escape-hatch force + grant + stale + депромоут + audit) + FF-FORCE-DEMOTE |
| AC-9 | §5.2 п3 (promote human-gate на stale dep) + FF-PROMOTE-GATE |
| AC-10 | §5.4 (`check-report-page-deps`, bundle_members.txt) + FF-BUNDLE-DEPS |
| AC-11 | §7 (Floor-2 RLS-gated, нет DB-credentials) + FF-FLOOR2-RLS |
| AC-12 | §6/§6.1 (PDP T-0021, ноль второго механизма, author_report_page DRAFT-only) + FF-NO-2ND-AUTHZ |
| AC-13 | §7 (аудит-события T-0016, единый appendAuditEvent) + FF-AUDIT-EVENTS |
| AC-14 | §0 header + §2 (слоты ≥046, DDL не в DESIGN) |
| AC-15 | §7 (fail-closed tenant, cross-tenant невозможен) + FF-T13-PAGE → live-impl |
| AC-16 | §5.2 (деструктив без force → 409, schema неизменна) + FF-DESTRUCTIVE-DENY → live-impl |
| AC-17 | §5.2 п3 (promote stale → 409) + FF-PROMOTE-GATE → live-impl |
| AC-18 | §3 (контракт `checkReportPageDepFields`) + FF-COMPAT-BEHAVIOR → test |
| AC-19 | §5.3 (force → stale + draft + audit с affected_pages) + FF-FORCE-DEMOTE → live-impl |
| AC-20 | весь ADR: §1/§3/§6/§10 (ноль второго permission/coherence-механизма, не противоречит T-0072/T-0082/extensibility) — ревью-гейт архитектора §12 |
| AC-21 | §5.1 (changelog-payload контракт к T-0084) + FF-CHANGELOG-T84 |
| AC-22 | §3 (pure function, no I/O) + FF-COMPAT-PURE |

---

## 12. Открытые развилки

**BLOCKING к фаундеру: нет.** Решение фаундера (two-floor + реестр зависимостей + предупреждение + red-line на деструктив) закрывает продуктовый объём; все зоны дизайна решены автономно внутри существующих механизмов (T-0072/T-0082/T-0077/T-0018/T-0021).

**Design-owned точки (решены автономно, зафиксированы выше):**
- Способ наполнения реестра = **гибрид** (Floor-1 авто из page_def, Floor-2 ручная декларация; статанализ Floor-2 = Stage-2). §1/§10.
- Момент предупреждения = на изменении `published`-схемы (changelog-эмиссия); на draft-схеме — warning без changelog. §5.1.
- Критерий деструктива: drop/rename field_key всегда; type-narrowing деструктивен только при `dep_kind='aggregate'`. §5.2.
- Гранулярность просмотра = на уровне `application` (страница наследует видимость app), ноль `report_page`-ACL. §6.
- Floor-1 = дефолт day-1 (extensibility §11); Floor-2 React-runtime инкрементально, `bundle_ref` зарезервирован. §4.
- Migration-слоты 046/047 (с fallback «следующий свободный ≥046 при материализации»). §0.

**Продуктовые развилки вне спеки (помечены, не гадаю — для оркестратора/фаундера, НЕ блокируют ADR):**
- **P-1 (из extensibility §11, не вводится T-0121):** доля Floor-2 у реального клиента → AGENT-SPOF. T-0121 проектирует механизм обоих этажей; порог эскалации на ручной код-путь — продуктовая метрика, собирается после первых клиентских отчётов. Не зона T-0121.
- **P-2:** богатство независимого валидатора changelog↔diff (extensibility §11 review-trust) до открытия one-click promote нетехничному клиенту — частично закрыто FF-CHANGELOG-T84 (контракт к T-0084), но порог «достаточной» проверки перед promote — продуктовое решение T-0084/governance, не T-0121.
- **P-3:** конкретные шаблоны отчётов (дашборд руководителя, SLA-dashboard T-0095) — экземпляры поверх механизма T-0121, не часть механизма (§5.5/§5.6 спеки out-of-scope). Материализуются отдельными задачами.

**Не-блокирующее наблюдение для оркестратора:** T-0072/T-0082-артефакты (`docs/specs/T-0072*`, `docs/specs/T-0082*`, `src/core/binding-compat.ts`) живут на сестринской ветке и НЕ доступны в этом worktree — ADR опирается на их описание в спеке T-0121 и extensibility-ADR §9.3. При материализации T-0121b (`report-page-compat.ts`) coder обязан сверить точную сигнатуру `checkBindingCompat`/`BindingViolation` с живым `src/core/binding-compat.ts` после мержа T-0072 в base и зеркалить её 1:1 (NF-1 — один механизм). Если сигнатуры разошлись — это не развилка дизайна, а синхронизация реализации.
