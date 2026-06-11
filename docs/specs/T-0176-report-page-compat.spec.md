# Spec · T-0176 — Reports T-0121b: core/report-page-compat.ts

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-11
**Task:** T-0176 (product=choros, type=standard_code, prio 50)
**ADR consumed:** `docs/design/T-0121-reports-pages.adr.md` §3 (`checkReportPageDepFields`), §4 (`classifyReportPageFloor`), §8 (fitness: FF-COMPAT-PURE, FF-COMPAT-BEHAVIOR, FF-FLOOR), §9 T-0121b (декомпозиция)
**Foundations:** T-0072 (`binding-compat.ts` — зеркальный паттерн), T-0175 (DDL report_page / report_page_dep — структура PageDep), T-0163 (no-env-in-core инвариант)

---

## 1. Summary

Модуль `src/core/report-page-compat.ts` реализует две **чистые функции** (no I/O, no DB, no network, no `process.env`):

1. **`checkReportPageDepFields`** — проверяет, что все `field_key` зарегистрированных зависимостей (`PageDep[]`) присутствуют в `record_schema.properties` реестра (`registry_def.record_schema`); возвращает структурированный список нарушений (`DepViolation[]`) или `{ok: true}`.
2. **`classifyReportPageFloor`** — определяет машинную границу Floor-1 ↔ Floor-2: если `page_def` целиком выразим vocab Floor-1 (массив метрик с `agg` + optional `group_by`/`filter` + `title`/`subtitle`), возвращает `{requiredFloor: '1'}`, иначе `{requiredFloor: '2'}`.

Модуль — зеркало `src/core/binding-compat.ts` (T-0072): тот же purity-дисциплин, тот же стиль, `DepViolation` ≡ `BindingViolation`. Это NF-1 ADR («один контрол плейн согласованности»).

Экспортируемый публичный контракт (§9 T-0121b ADR) потребляется T-0177 (schema-change API).

---

## 2. Functional requirements

- **FR-1** `checkReportPageDepFields(deps, recordSchema)` — чистая функция (NO I/O). Принимает `deps: PageDep[]` и `recordSchema: JsonSchema`; возвращает `DepCompatResult`. Для каждого `dep` в `deps`: если `dep.fieldKey ∉ recordSchema.properties` → `DepViolation { type: 'missing_in_schema', registryDefId: dep.registryDefId, fieldKey: dep.fieldKey }`. Все ключи присутствуют → `{ ok: true }`.

- **FR-2** `classifyReportPageFloor(pageDef)` — чистая функция (NO I/O). Принимает `pageDef: unknown`; возвращает `{ requiredFloor: '1' | '2', reason: string }`. Если `pageDef` — массив, где каждый элемент соответствует vocab Floor-1 (объект с `source_registry_def_id: string`, `field_key: string`, `agg: 'count'|'sum'|'avg'|'min'|'max'|'list'`; опционально `group_by?: string`, `filter?: { field_key: string, op: '='|'!='|'<'|'>'|'in', value: unknown }`, `title?: string`, `subtitle?: string`) → `{ requiredFloor: '1', reason: ... }`. Если `pageDef` — пустой массив `[]` → `{ requiredFloor: '1', reason: 'empty metrics array' }`. Если `pageDef` не массив, либо любой элемент содержит поле вне vocab Floor-1, либо `agg` не из допустимого enum — `{ requiredFloor: '2', reason: ... }`.

- **FR-3** `DepViolation` — зеркало `BindingViolation` (T-0072): `type: 'missing_in_schema' | 'lossy_narrowing'`; `registryDefId: string`; `fieldKey: string`. Vocab закрытый (расширяем доп-миграцией, не правкой этого файла).

- **FR-4** Тип `JsonSchema` объявляется локально в этом модуле как минимально-достаточный интерфейс: `{ properties?: Record<string, unknown> }`. Нет import pg/ajv/jsonschema; нет circular dep.

- **FR-5** Модуль не импортирует `pg`, `fs`, `net`, `http`, `child_process`, `import.meta`, `process.env`, `process.exit`, ни одного DAO/db-файла из проекта. Это инвариант (FF-COMPAT-PURE).

- **FR-6** Модуль размещён в `src/core/report-page-compat.ts`. Файл содержит ADR-комментарий со ссылкой на T-0072 `checkBindingCompat` (paттерн-прецедент, NF-1 ADR §3).

- **FR-7** Отдельный файл тестов `src/__tests__/report-page-compat.test.ts`. Покрывает ровно ADR-правила §3/§4: каждый путь `checkReportPageDepFields` + каждый путь `classifyReportPageFloor` (Floor-1/Floor-2/пустой массив/невалидный agg). Без баз данных, без сети, без `process.env`.

- **FR-8** Fitness-check `ci/checks/report-page-compat-isolation.sh` (owner T-0176): (а) `src/core/report-page-compat.ts` существует; (б) нет запрещённых I/O-импортов; (в) экспортируются все публичные символы (`DepKind`, `PageDep`, `DepViolation`, `DepCompatResult`, `checkReportPageDepFields`, `classifyReportPageFloor`). Скрипт вызывается из `npm run fitness`.

---

## 3. Non-functional requirements

- **NF-1** Полная симметрия паттерна с `src/core/binding-compat.ts` (T-0072): те же соглашения об именовании, тот же purity-дисциплин, тот же стиль header-комментария. Нет нового механизма согласованности — один контрол плейн (ADR §3 «прецедентная ссылка обязательна»).

- **NF-2** Нет `process.env` ни в коде, ни в импортах (`no-env-in-core.sh` T-0163 должен оставаться зелёным).

- **NF-3** `JsonSchema`-тип объявляется минимально-достаточным интерфейсом (только `properties`); расширяется без breaking-change при необходимости потребителями.

- **NF-4** `classifyReportPageFloor` принимает `pageDef: unknown` (не `any`), валидирует структуру внутри функции (runtime-guard без throw — только через возврат `requiredFloor: '2'` с описательным reason).

- **NF-5** `checkReportPageDepFields` принимает `deps: PageDep[]` — дублей `fieldKey` в пределах одного `registryDefId` функция не проверяет (это ответственность write-path guard при регистрации dep; функция работает на уже-сохранённых данных, как `checkBindingCompat` ADR §3 pre-conditions).

---

## 4. Out of scope

- registry_def schema-change API (soft-warning, destructive-deny, force-escape-hatch) — T-0121c / T-0177
- `lossy_narrowing` violation-тип: `DepViolation.type` включает `'lossy_narrowing'` в union (ADR §3), но триггер для него (`dep_kind='aggregate'` + type-narrowing) находится в T-0177 (schema-change API — знает старую и новую схему). `checkReportPageDepFields` в T-0176 реализует `missing_in_schema`; `lossy_narrowing` добавляется в T-0177 расширением той же функции или отдельной helper-функцией поверх неё.
- Авто-извлечение deps из `page_def` Floor-1 (Floor-1 deps → `report_page_dep` автоматически) — T-0121d
- Bundle-coherence расширение — T-0121e
- MCP-tool `author_report_page` seed — T-0121f
- Floor-1 server-side renderer — T-0121g
- Статический анализ Floor-2 React (Stage-2) — T-0121h

---

## 5. Acceptance criteria

### AC-1 — Файл `src/core/report-page-compat.ts` существует (fitness)
`test -f src/core/report-page-compat.ts` — exit 0.
*verifiable_as: fitness*

### AC-2 — Модуль не содержит запрещённых I/O-импортов (fitness FF-COMPAT-PURE)
`grep -E "from.*['\"]pg['\"]|from.*['\"]node:fs|from.*['\"]node:http|from.*['\"]node:net|child_process|import\.meta|process\.env|process\.exit" src/core/report-page-compat.ts` — пустой результат (exit 1 от grep = PASS).
*verifiable_as: fitness*

### AC-3 — Все публичные символы экспортируются (fitness FF-COMPAT-PURE)
Файл содержит `export.*DepKind`, `export.*PageDep`, `export.*DepViolation`, `export.*DepCompatResult`, `export.*function checkReportPageDepFields`, `export.*function classifyReportPageFloor`.
*verifiable_as: fitness*

### AC-4 — `checkReportPageDepFields`: field_key присутствует → ok:true (test FF-COMPAT-BEHAVIOR)
`checkReportPageDepFields([{ registryDefId:'r1', fieldKey:'amount', depKind:'aggregate' }], { properties:{ amount:{} } })` возвращает `{ ok: true }`.
*verifiable_as: test*

### AC-5 — `checkReportPageDepFields`: field_key отсутствует → ok:false, violation type missing_in_schema (test FF-COMPAT-BEHAVIOR)
`checkReportPageDepFields([{ registryDefId:'r1', fieldKey:'amount', depKind:'aggregate' }], { properties:{} })` возвращает `{ ok: false, violations: [{ type:'missing_in_schema', registryDefId:'r1', fieldKey:'amount' }] }`.
*verifiable_as: test*

### AC-6 — `checkReportPageDepFields`: пустые deps → ok:true (test)
`checkReportPageDepFields([], { properties:{ amount:{} } })` возвращает `{ ok: true }`.
*verifiable_as: test*

### AC-7 — `checkReportPageDepFields`: несколько нарушений — по одному на каждый отсутствующий field_key (test)
Два dep с несуществующими ключами → `violations` длиной 2; один dep с существующим + один без → `violations` длиной 1.
*verifiable_as: test*

### AC-8 — `checkReportPageDepFields`: recordSchema без поля properties → все deps нарушают (test)
`checkReportPageDepFields([{ registryDefId:'r1', fieldKey:'f', depKind:'read' }], {})` возвращает `{ ok: false, violations: [{ type:'missing_in_schema', ... }] }` (отсутствие `properties` ≡ пустой объект).
*verifiable_as: test*

### AC-9 — `classifyReportPageFloor`: валидный Floor-1 pageDef → requiredFloor '1' (test FF-FLOOR)
`classifyReportPageFloor([{ source_registry_def_id:'r1', field_key:'amount', agg:'sum' }])` возвращает `{ requiredFloor: '1', reason: ... }`.
*verifiable_as: test*

### AC-10 — `classifyReportPageFloor`: пустой массив → requiredFloor '1' (test FF-FLOOR)
`classifyReportPageFloor([])` возвращает `{ requiredFloor: '1', reason: ... }`.
*verifiable_as: test*

### AC-11 — `classifyReportPageFloor`: pageDef не массив → requiredFloor '2' (test FF-FLOOR)
`classifyReportPageFloor({ metrics: [] })` и `classifyReportPageFloor(null)` и `classifyReportPageFloor("string")` — все возвращают `{ requiredFloor: '2', reason: ... }`.
*verifiable_as: test*

### AC-12 — `classifyReportPageFloor`: неизвестное agg → requiredFloor '2' (test FF-FLOOR)
`classifyReportPageFloor([{ source_registry_def_id:'r1', field_key:'f', agg:'median' }])` возвращает `{ requiredFloor: '2', reason: ... }` (vocab Floor-1 не включает 'median').
*verifiable_as: test*

### AC-13 — `classifyReportPageFloor`: лишнее поле вне vocab → requiredFloor '2' (test FF-FLOOR)
`classifyReportPageFloor([{ source_registry_def_id:'r1', field_key:'f', agg:'count', custom_render: true }])` возвращает `{ requiredFloor: '2', reason: ... }` (custom_render вне vocab Floor-1).
*verifiable_as: test*

### AC-14 — `classifyReportPageFloor`: Floor-1 с допустимыми optional полями → requiredFloor '1' (test)
`classifyReportPageFloor([{ source_registry_def_id:'r1', field_key:'f', agg:'avg', group_by:'dept', filter:{ field_key:'status', op:'=', value:'active' }, title:'Avg', subtitle:'sub' }])` возвращает `{ requiredFloor: '1', reason: ... }`.
*verifiable_as: test*

### AC-15 — Vitest зелёный (fitness)
`npx vitest run src/__tests__/report-page-compat.test.ts` — exit 0, все тесты прошли.
*verifiable_as: fitness*

### AC-16 — tsc --noEmit не даёт ошибок (fitness)
После добавления файлов `tsc --noEmit` — exit 0.
*verifiable_as: fitness*

### AC-17 — no-env-in-core.sh зелёный (fitness FF-NF-2)
`bash ci/checks/no-env-in-core.sh` — exit 0 (новый файл не нарушает инвариант T-0163).
*verifiable_as: fitness*

### AC-18 — report-page-compat-isolation.sh зелёный (fitness FF-COMPAT-PURE)
`bash ci/checks/report-page-compat-isolation.sh` — exit 0.
*verifiable_as: fitness*
