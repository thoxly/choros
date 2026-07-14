# Spec · T-0177 — Reports T-0121c: registry_def schema-change API

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0177 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0121-reports-pages.adr.md`
  §5 (классификация изменений схемы + механизм блокировки),
  §3 (`checkReportPageDepFields` — `lossy_narrowing` триггер реализуется здесь),
  §6 (права — `mgmt_object:schema_destructive`/`apply`),
  §7 (аудит — `appendAuditEvent`, `report_page.schema_destructive_force`),
  §8 (FF-SOFT-WARN, FF-DESTRUCTIVE-DENY, FF-FORCE-DEMOTE, FF-CHANGELOG-T84),
  §9 T-0121c (декомпозиция)
**Foundations:** T-0175 (DDL tables 051/052), T-0176 (`checkReportPageDepFields`,
  `PageDep`, `classifyReportPageFloor` — T-0177 добавляет `lossy_narrowing`),
  T-0014 (`registry_def.record_schema`), T-0016 (`appendAuditEvent`),
  T-0021 (PDP), T-0087 (tier-promote/demote паттерн — SET LOCAL choros.promoting)

---

## 1. Summary

Эндпоинт `PUT/PATCH /api/registry-defs/:id` расширяется логикой
«schema-change guard»: при изменении `record_schema` он опрашивает
`report_page_dep` через `checkReportPageDepFields`, классифицирует
изменение как **мягкое** или **деструктивное**, и применяет одну из трёх ветвей:

1. **Мягкое** (`relabel`, add field, enum widening, toggle `required`) → изменение
   применяется + ответ дополняется `warnings: [{page_slug, registry_def_id, field_key}]`.
2. **Деструктивное** без `force` (drop/rename `field_key`, lossy type-narrowing при
   `dep_kind='aggregate'`) → **409 destructive_schema_change**; `record_schema`
   не меняется.
3. **Деструктивное** с `force=true` + grant `mgmt_object:schema_destructive`/`apply`
   → изменение применяется + затронутые deps помечаются `stale=true` + страницы
   депромоутируются в `tier='draft'` + пишется audit-event
   `report_page.schema_destructive_force` с полным `affected_pages`.

**Зависимости не удаляются молча** — stale + депромоут + аудит-след.

Задача также закрывает R-1-carry от T-0176: документирует поле
`DepViolation.message` в ADR §3 и в данной спеке.

---

## 2. Functional requirements

- **FR-1** Определить/найти существующий `PUT/PATCH /api/registry-defs/:id`
  HTTP-роут (или создать новый маршрут, если его нет). Маршрут принимает тело с
  полем `record_schema` (новая схема). Всё остальное поведение роута сохраняется.

- **FR-2** При изменении `record_schema`: до применения UPDATE загрузить все
  активные (`stale=false`) `report_page_dep`, привязанные к данному
  `registry_def_id`. Для каждого `field_key` из dep-таблицы выполнить
  сравнение старой и новой схемы и классифицировать изменение.

- **FR-3** **Мягкое изменение** (ADR §5.1): операция применяется. В ответе
  появляется `warnings: [{page_slug, registry_def_id, field_key}]` — машинно-читаемый
  массив (NF-8 ADR). Для tier='published' схемы регистрируется changelog-предупреждение
  (структура `affected_pages` передаётся потребителю T-0084); для draft — тоже
  warning, без changelog-эмиссии.

- **FR-4** **Деструктивное без `force`** (ADR §5.2): `409 { error: {
  code: 'destructive_schema_change', message: '...', affected_pages: [...],
  fields: [...] } }`. `record_schema` остаётся без изменений — AC-16.

- **FR-5** **Деструктивное с `force=true`** (ADR §5.3): только при наличии
  гранта `mgmt_object:schema_destructive`/`apply`; без гранта → `403 FORBIDDEN`.
  Выполняется в одной транзакции:
  (а) применить новый `record_schema` в `registry_def`;
  (б) пометить затронутые `report_page_dep` → `stale=true`;
  (в) депромоутировать затронутые `report_page` → `tier='draft'`;
  (г) вызвать `appendAuditEvent({ action: 'report_page.schema_destructive_force',
      affected_pages, fields, actor })`.

- **FR-6** **Классификатор изменений** (ADR §5.2) — чистая функция
  `classifySchemaChange(oldSchema, newSchema, deps)` в `src/core/`:
  - drop `field_key` (ключ есть в старой схеме, нет в новой) → `destructive` для
    всех deps с этим field_key.
  - rename (= drop старого + add нового) → `destructive` для зависимых (эквивалент drop).
  - lossy type-narrowing (`number→integer`, `string→enum` с меньшим vocab,
    расширение→сужение) при `dep_kind='aggregate'` → `destructive`.
    При `dep_kind='read'` type-narrowing → `soft` (warning).
  - add field, enum widening, relabel (`title`/description), toggle `required` → `soft`.
  Возвращает: `{ softWarnings: AffectedDep[], destructiveDeps: AffectedDep[] }` где
  `AffectedDep = { page_slug: string, registry_def_id: string, field_key: string, dep_kind: DepKind }`.

- **FR-7** `lossy_narrowing` реализуется в расширении `checkReportPageDepFields`
  (или отдельной helper-функции поверх неё — per ADR §3 carry из T-0176).
  Триггер: dep присутствует в новой схеме, но тип поля изменился `lossy` (сужение)
  при `dep_kind='aggregate'`.

- **FR-8** Аудит-событие через единственный `appendAuditEvent` (T-0016). Никакого
  второго audit-sink. Событие `report_page.schema_destructive_force` несёт поля
  `affected_pages` и `fields` в `payload`.

- **FR-9** Депромоут (force-ветка) через `UPDATE report_page SET tier='draft'` с
  `SET LOCAL choros.promoting='1'` — тот же GUC-механизм, что tier-promote (T-0087),
  чтобы триггер `tier_published_locked` не блокировал UPDATE.

- **FR-10** Весь путь (soft / deny / force) выполняется внутри одной транзакции:
  READ deps → классификация → action (UPDATE schema + stale + demote + audit).
  Нет partial-state.

- **FR-11** R-1 carry: в документации (`DepViolation` и в данной спеке) зафиксировать
  поле `message: string` как часть интерфейса (additive, зеркало `BindingViolation`).

---

## 3. Non-functional requirements

- **NF-1** Нет нового permission-механизма: проверка гранта `mgmt_object:schema_destructive`/`apply`
  использует существующий PDP T-0021 (или его dev-mode stub); никакого нового
  grant-поля / второй таблицы прав.
- **NF-2** Tenant-изоляция структурная: все SELECT/UPDATE идут через `withTenantTx`
  с `SET LOCAL choros.tenant_id` — RLS обеспечивает изоляцию (T-0013).
- **NF-3** Нет тихого удаления зависимостей: dep остаются в таблице со `stale=true`;
  удаление — прерогатива автора страницы после починки.
- **NF-4** `classifySchemaChange` — чистая функция (no I/O, no DB, no net). Тестируется
  unit без DB.
- **NF-5** Ответ `warnings` — структурный машинно-читаемый массив (не строка).
  Shape: `{ page_slug: string, registry_def_id: string, field_key: string }[]`.
- **NF-6** Fitness FF-SOFT-WARN и FF-DESTRUCTIVE-DENY и FF-FORCE-DEMOTE — live-DB
  проверки в `ci/checks/db/` (T-0144 дисциплина: BEGIN перед SET LOCAL, cleanup).
- **NF-7** Fitness FF-CHANGELOG-T84 — структурный `affected_pages`/`warnings` в
  ответе API (static assert через grep/type-check).

---

## 4. Out of scope

- report_page CRUD API (авторинг, promote, dep registration) — T-0121d
- bundle-coherence расширение `check-report-page-deps` — T-0121e
- MCP-tool seed `author_report_page` — T-0121f
- Floor-1 server-side renderer — T-0121g
- Статический анализ Floor-2 React (Stage-2) — T-0121h
- promote human-gate на stale-dep (409 при promote stale страницы) — T-0121d

---

## 5. Acceptance criteria

### AC-1 — `PUT/PATCH /api/registry-defs/:id` зарегистрирован (fitness)
`grep -r "registry-defs\|registry_defs" src/http/ src/server.ts` выдаёт строки
с регистрацией роута. tsc — exit 0.
*verifiable_as: fitness*

### AC-2 — Мягкое изменение применяется + warnings (unit)
`classifySchemaChange` с `relabel`-only изменением схемы (поле не удалено, тип
не сужен) → `{ softWarnings: [...], destructiveDeps: [] }`.
*verifiable_as: test*

### AC-3 — Drop field_key → destructive (unit)
`classifySchemaChange(oldSchema={properties:{amount:{}}}, newSchema={properties:{}},
deps=[{fieldKey:'amount', depKind:'aggregate'}])` → `destructiveDeps.length === 1`.
*verifiable_as: test*

### AC-4 — lossy type-narrowing при aggregate → destructive (unit)
`classifySchemaChange(old={properties:{count:{type:'number'}}},
new={properties:{count:{type:'integer'}}}, deps=[{fieldKey:'count',depKind:'aggregate'}])`
→ `destructiveDeps.length === 1`.
*verifiable_as: test*

### AC-5 — lossy type-narrowing при read → soft (unit)
Та же пара схем, но `depKind='read'` → `softWarnings.length === 1, destructiveDeps = []`.
*verifiable_as: test*

### AC-6 — Нет активных deps → ни warnings ни destructive (unit)
`classifySchemaChange(old, new_with_dropped_field, deps=[])` → обе списки пустые,
изменение проходит без предупреждений (нет затронутых страниц).
*verifiable_as: test*

### AC-7 — HTTP: PUT схемы без deps → 200, no warnings (live-DB)
PUT `record_schema` на registry_def без `report_page_dep` → ответ 200/204, нет
поля `warnings` (или `warnings: []`), схема обновлена в БД.
*verifiable_as: test*

### AC-8 — HTTP: мягкое изменение с deps → 200 + warnings[] (live-DB)
Создать dep на field_key; добавить новое поле в схему (add field → мягкое) →
ответ 200/204, `warnings` содержит запись с `field_key` dep, схема обновлена.
*verifiable_as: test*

### AC-9 — HTTP: деструктивное без force → 409 + schema неизменна (live-DB)
Создать dep на field_key; удалить это поле из схемы без `force` →
ответ 409 `destructive_schema_change`, `record_schema` в БД не изменилась.
*verifiable_as: test*

### AC-10 — HTTP: деструктивное с force=true → 200, stale=true, tier='draft', audit (live-DB)
force=true + dep → ответ 200, dep.stale=true, report_page.tier='draft',
audit_event с `action='report_page.schema_destructive_force'` записан.
*verifiable_as: test*

### AC-11 — DepViolation.message задокументировано в спеке
Поле `message: string` явно упомянуто в разделе "Типы" данной спеки и в
`src/core/report-page-compat.ts` (уже реализовано в T-0176; документация закрывает R-1).
*verifiable_as: manual*

### AC-12 — classifySchemaChange — pure функция (fitness)
`grep -E "from.*pg|from.*node:fs|from.*node:http|import\.meta|process\.env"
src/core/schema-change-classifier.ts` → пустой результат (exit 1 grep = PASS).
*verifiable_as: fitness*

### AC-13 — Транзакционность force-ветки (live-DB)
Если UPDATE registry_def успевает, но аудит-write бросает исключение (симуляция) →
ROLLBACK: record_schema не изменена, stale=false, tier='published'.
*verifiable_as: test*

### AC-14 — Нет тихого удаления deps (fitness)
`grep -rn "DELETE.*report_page_dep" src/http/ src/db/` → только в тестах/cleanup,
не в schema-change пути; deps помечаются stale, не удаляются.
*verifiable_as: fitness*

### AC-15 — tsc --noEmit exit 0 (fitness)
После добавления новых файлов — tsc без ошибок.
*verifiable_as: fitness*

### AC-16 — record_schema не изменяется при 409 (live-DB)
Аналог AC-9: SELECT record_schema после 409-ответа равен исходному.
*verifiable_as: test*

### AC-17 — warnings — структурный массив (fitness/static)
`grep -n "warnings" src/http/registry-defs.ts` показывает сборку массива объектов
`{page_slug, registry_def_id, field_key}`, не строкового concat.
*verifiable_as: fitness*

### AC-18 — npm run fitness exit 0 (fitness)
Fitness-скрипт `schema-change-classifier-isolation.sh` добавлен и проходит.
*verifiable_as: fitness*

---

## 6. Типы (R-1 carry документация)

```ts
// T-0177 добавляет тип classifySchemaChange и уточняет DepViolation.message.

/** Одна запись о затронутой зависимости при изменении схемы. */
export interface AffectedDep {
  page_id: string;        // UUID report_page
  page_slug: string;      // URL-safe slug страницы
  registry_def_id: string;
  field_key: string;
  dep_kind: DepKind;
}

/** Результат классификации schema-change. */
export interface SchemaChangeClassification {
  softWarnings: AffectedDep[];   // мягкие изменения — предупреждения, операция проходит
  destructiveDeps: AffectedDep[]; // деструктивные — блокируют без force
}

// DepViolation (T-0176, R-1 carry): поле message обязательно.
// Зеркало BindingViolation из T-0072.
export interface DepViolation {
  type: 'missing_in_schema' | 'lossy_narrowing';
  registryDefId: string;
  fieldKey: string;
  message: string;   // R-1: human-readable description (additive; mirrors BindingViolation)
}
```

---

## 7. HTTP contract

```
PUT /api/registry-defs/:id
PATCH /api/registry-defs/:id

Body: { record_schema?: JsonSchema, force?: boolean, ...other fields }
Headers: x-dev-user: <actor> (dev mode)

Responses:
  200 { updated: true, registry_def_id: string, warnings?: AffectedDep[] }
  409 { error: { code: 'destructive_schema_change',
                 message: string,
                 affected_pages: AffectedDep[],
                 fields: string[] } }
  403 { error: { code: 'FORBIDDEN', message: 'grant schema_destructive/apply required' } }
  404 { error: { code: 'NOT_FOUND', ... } }
  503 { error: { code: 'DB_UNAVAILABLE', ... } }
```
