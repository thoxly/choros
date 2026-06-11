# Spec · T-0072 — E11.1 Named-Binding Contract (field-key == variable-name)

**Phase:** SPEC · **Status:** ready (no blocking questions) · **Date:** 2026-06-11
**Task:** E11.1 — Named-binding контракт (field-key == variable-name) — единый источник истины + compat-check между этажами [ADR §9.3]
**Parent:** T-0070 (E11)
**Raw TZ:** `docs/design/extensibility-and-authoring.md` §9 гард 3 + §4 TWO-FLOOR контекст
**Сёстры в полёте:** T-0077 (migration 044, seed config-agent), T-0066 (worker-api docs)
**Migration slot:** 045

---

## 0. Контекст (почему это день-1 несущий гард)

ADR §4 зафиксировал двухэтажную модель авторинга:

- **Floor-1** — декларативная JSON Schema + UI-schema. Поля идентифицируются
  ключом (`field-key`). При сохранении значений из формы ключ становится именем
  переменной Flowable-процесса (`variable-name`).
- **Floor-2** — React-компонент поверх того же named-binding контракта, DMN,
  External-Task воркеры. Floor-2-код ссылается на переменные по имени.

Несущий инвариант ADR §4: «код Floor-2 НЕ мутирует состояние процесса напрямую —
он презентация/интеракция над **тем же** named-binding, валидируемым на бэке».

ADR §9 гард 3 формулирует: нужен **единый источник истины** для соответствия
`field-key == variable-name` и **машинная compat-проверка** между этажами — чтобы
скрытое/удалённое поле в схеме Floor-1 не приводило к тихому рассинхрону с
Floor-2-кодом, который на это поле ссылается. Нарушение должно быть
**блокирующей ошибкой**, а не «тихим» расхождением.

**Что T-0072 строит:** единый источник истины (таблица `form_binding` + её
структурный контракт) + чистая функция-валидатор `checkBindingCompat` +
deploy-gate интеграция (BPMN-линтер блокирует deploy при несовместимости).

**Что НЕ является скоупом T-0072:**
- UI-редактор форм (Floor-1 кнопочный интерфейс) — другой E11.x
- Генератор кода Floor-2 (MCP-тул `emit_form_code`, T-0077) — другой E11.x;
  T-0072 задаёт контракт/рельсы, по которым T-0077 авторит
- DMN-таблицы / External-Task worker — другие задачи E11
- Round-trip агента и UI-schema для кнопочного редактирования — E11.x

---

## 1. Что строим (одна строка)

**Единый источник истины для named-binding контракта** (`form_binding` tenant-таблица
со схемой полей формы и именами переменных процесса) + **чистая функция-compat-валидатор**
`checkBindingCompat(schema, bpmnVariableNames)` + **deploy-gate интеграция**: BPMN-линтер
(T-0027 `lintBpmn`) расширяется новым типом нарушения `binding_mismatch`, блокирующим
deploy процессов, чьи переменные рассинхронизированы с зарегистрированной схемой.

---

## 2. Функциональные требования

**FR-1: Таблица `form_binding` — единый источник истины.**
Tenant-таблица (T-0013-дисциплина: `tenant_id` leading PK, FORCE RLS) хранит
одну запись связки на `(tenant_id, process_key, form_key)`. Каждая запись содержит:
- `process_key` (text) — ключ BPMN-процесса (совпадает с `processDefinitionKey` Flowable);
- `form_key` (text) — идентификатор формы, соответствующий `formKey` в `<userTask>`;
- `fields` (jsonb, NOT NULL) — массив объектов `{key: string, type: string,
  required: boolean}`, где `key` = `field-key` = имя переменной процесса;
- `version` (integer NOT NULL DEFAULT 1) — монотонно-растущий при каждом UPDATE;
- `created_at`, `updated_at` (bigint).

Уникальность: UNIQUE (tenant_id, process_key, form_key).

**FR-2: Контракт `field-key == variable-name`.**
Значение поля `fields[i].key` — это одновременно ключ поля в UI-форме Floor-1
и имя переменной процесса Flowable. Никакого маппинга/трансляции между ними нет —
они тождественны. Эта инвариантность enforced структурно: одна запись, один ключ.

**FR-3: Чистая функция compat-валидатора.**
Экспортировать из `src/core/binding-compat.ts` чистую функцию:

```
checkBindingCompat(
  fields: BindingField[],           // из form_binding.fields
  bpmnVarNames: ReadonlySet<string> // переменные, упомянутые в BPMN-процессе
): BindingCompatResult
```

Возвращает `{ ok: true }` либо `{ ok: false; violations: BindingViolation[] }`.
`BindingViolation` содержит: `type: "missing_in_schema" | "missing_in_bpmn"`,
`fieldKey: string`, `message: string`.

- `"missing_in_bpmn"` — переменная есть в `bpmnVarNames`, но не в `fields[].key`
  (BPMN-процесс ссылается на переменную, которую форма не объявила — рассинхрон).
- `"missing_in_schema"` — ключ есть в `fields[].key`, но не упомянут ни в одной
  BPMN-переменной выбранного процесса (форма объявляет поле, которое процесс
  не ожидает — потенциально мёртвая переменная; предупреждение, не блокирующая
  ошибка, если ADR не требует жёсткого блока — см. AC-4 уровень нарушения).

**FR-4: BPMN-линтер — новый тип нарушения `binding_mismatch`.**
`LintViolationType` в `src/core/bpmn-linter.ts` расширяется значением
`"binding_mismatch"`. Функция `lintBpmn(xml, opts?)` принимает опциональный второй
параметр `opts.bindingSchema?: BindingField[]`. Если `opts.bindingSchema` передан,
линтер вызывает `checkBindingCompat(opts.bindingSchema, bpmnVarNames)` после
токенизации и добавляет нарушения типа `binding_mismatch` в список. При
наличии нарушений `binding_mismatch` функция возвращает `{ ok: false }`.

Извлечение `bpmnVarNames` из BPMN XML: имена переменных считываются из атрибутов
`name` и `sourceExpression`/`targetExpression` элементов `<in>`, `<out>`,
`<formProperty>`, `<formField>`, а также из EL-выражений вида `${varName}` в
`<conditionExpression>` и extension-атрибутах (best-effort regex-парсер EL, не
полный EL-парсер).

**FR-5: CLI-расширение.**
`src/cli/lint-bpmn.ts` принимает опциональный флаг `--binding-schema <path>`
(путь к JSON-файлу с массивом `BindingField[]`). При его наличии передаёт схему
в `lintBpmn(xml, { bindingSchema })`. Без флага — поведение без изменений
(обратная совместимость).

**FR-6: HTTP API-эндпоинт записи/обновления binding.**
POST `/tenants/:tenantId/processes/:processKey/forms/:formKey/binding` —
принимает `{ fields: BindingField[] }`, upsert в `form_binding`
(INSERT ON CONFLICT UPDATE fields, version=version+1, updated_at).
Требует аутентифицированного пользователя с ролью `process_designer`
(проверка через существующий auth-middleware; роль — конвенциональная,
не новая таблица в T-0072 скоупе).

GET `/tenants/:tenantId/processes/:processKey/forms/:formKey/binding` —
возвращает текущую запись или 404. Используется config-агентом (T-0077)
перед эмиссией Floor-2-кода.

**FR-7: Миграция 045.**
Новая миграция `migrations/045_form_binding.sql`:
- DDL `form_binding`;
- ENABLE + FORCE RLS + tenant-isolation policy;
- GRANT SELECT, INSERT, UPDATE, DELETE ON form_binding TO choros_app;
- 1 dev-seed строка (ON CONFLICT DO NOTHING) для dev-тенанта
  (00000000-0000-0000-0000-000000000001), process_key='purchase-approval',
  form_key='purchase-form', с 3 полями из web/src/forms/form-defs.js
  (supplier, category, decision).

---

## 3. Нефункциональные требования

**NF-1:** Zero new npm dependencies. `binding-compat.ts` — pure TS, node:crypto не нужен.

**NF-2:** `checkBindingCompat` — pure function (no I/O, no DB, no network).
Входной контракт: только примитивные типы и ReadonlySet.

**NF-3:** `form_binding` следует T-0013-дисциплине: `tenant_id` leading PK,
ENABLE + FORCE RLS, listed in `ci/checks/known_tenant_tables.txt`,
case в `ci/checks/db/cross_tenant.test.ts` (T-A строка невидима для T-B).

**NF-4:** Расширение `LintViolationType` в bpmn-linter.ts — аддитивное: не меняет
сигнатуру `lintBpmn(xml)` при вызове без второго аргумента (обратная совместимость).
Все существующие тесты T-0027 остаются зелёными без изменений.

**NF-5:** EL-парсер для извлечения varNames — best-effort (regex `\$\{(\w+)\}`),
не полный OGNL/MVEL-парсер. Ложные отрицания возможны для сложных выражений;
ложные срабатывания на не-переменные — не допускаются. Документируется в коде.

**NF-6:** HTTP-эндпоинты FR-6 — совместимы с существующим middleware стека
(express/koa/имеющийся сервер). Не добавляют новый web-фреймворк.

**NF-7:** Миграция 045 идемпотентна (повторный запуск без ошибки).

---

## 4. Явно вне скоупа (out of scope)

- UI-редактор форм Floor-1 (кнопочный relabel/hide/toggle — другой E11.x).
- Генерация Floor-2-кода React-компонентов по binding-схеме (T-0077 / `emit_form_code`).
- DMN-middle слой, External-Task worker scaffolding.
- Полный EL/MVEL/OGNL-парсер для извлечения переменных из BPMN (только regex).
- Versioned diff / семантический changelog между версиями binding.
- Кросс-процессные переменные и межпроцессные ссылки.
- Roлевая модель `process_designer` — T-0072 проверяет наличие роли через
  существующий auth, но не создаёт новую роль-строку (не граница T-0072).
- object-schema (registry_def.record_schema) ↔ form_binding согласование —
  отдельная задача когерентности связки (ADR §9 гард 4, другой E11.x).

---

## 5. Критерии приёмки

| ID | Описание | Тип |
|----|----------|-----|
| AC-1 | Миграция 045: `form_binding` создаётся, ENABLE+FORCE RLS, UNIQUE(tenant_id,process_key,form_key), choros_app DML grant. Dev-seed строка вставляется и идемпотентна (повторная миграция без ошибки). | test |
| AC-2 | `form_binding` добавлена в `ci/checks/known_tenant_tables.txt`; в `cross_tenant.test.ts` есть case: строка тенанта A невидима при pg-сессии тенанта B (SELECT возвращает 0 строк). | fitness |
| AC-3 | `checkBindingCompat(fields, bpmnVarNames)` — если `bpmnVarNames` ⊆ `{f.key}` и `{f.key}` = `bpmnVarNames`, возвращает `{ ok: true }`. | test |
| AC-4 | `checkBindingCompat`: переменная в `bpmnVarNames`, отсутствующая в `fields[].key` → `binding_mismatch` violation с `type="missing_in_bpmn"`, `{ ok: false }`. Лишний ключ в `fields`, которого нет в `bpmnVarNames` → violation с `type="missing_in_schema"`, `{ ok: false }` (оба случая блокирующие на уровне валидатора; интеграция в линтер — AC-6). | test |
| AC-5 | `checkBindingCompat` — pure function: не импортирует pg/fs/net/http; `import.meta` или `process.env` не читается; jest coverage подтверждает отсутствие I/O. | fitness |
| AC-6 | `lintBpmn(xml, { bindingSchema: [...] })` возвращает `{ ok: false, violations: [{type:"binding_mismatch",...}] }` при наличии рассинхрона. `lintBpmn(xml)` (без opts) — поведение идентично T-0027 (0 изменений для существующих тестов). | test |
| AC-7 | `lintBpmn(xml, { bindingSchema })` извлекает переменные из `<in name="x"/>`, `<out name="y"/>`, `<formProperty id="z"/>`, `<formField id="w"/>` и EL `${myVar}` в `<conditionExpression>`; корректно распознаёт эти имена как `bpmnVarNames` для checkBindingCompat. | test |
| AC-8 | CLI `lint-bpmn --binding-schema ./schema.json ./process.bpmn` — при несовместимости выводит violations в stderr и завершается с кодом 1; без флага `--binding-schema` поведение без изменений. | test |
| AC-9 | GET `/tenants/T/processes/P/forms/F/binding` → 200 с `{fields:[...],version:N}` если строка существует; 404 если нет. | test |
| AC-10 | POST `/tenants/T/processes/P/forms/F/binding` с `{fields:[...]}` → 201/200; повторный POST → `version` инкрементируется, `fields` обновляются (upsert-идемпотентность). Без аутентификации → 401. | test |
| AC-11 | Dev-seed в migration 045: GET dev-тенант/purchase-approval/purchase-form/binding → 200, fields содержит ключи `supplier`, `category`, `decision`. | test |
| AC-12 | Типы `BindingField`, `BindingCompatResult`, `BindingViolation` экспортированы из `src/core/binding-compat.ts`; `LintViolationType` в `bpmn-linter.ts` включает `"binding_mismatch"` (TypeScript compile clean, `tsc --noEmit` зелёный). | fitness |
| AC-13 | Существующие тесты T-0027 (`src/__tests__/bpmn-linter.test.ts`) проходят без изменений после добавления `"binding_mismatch"` в `LintViolationType`. | fitness |

---

## 6. Блокирующие вопросы

*(Нет. Скоуп ADR §9.3 однозначен: единый источник истины + compat-check. Машинная
проверка достижима без уточнений фаундера.)*
