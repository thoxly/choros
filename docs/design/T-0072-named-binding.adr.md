# ADR · T-0072 — E11.1 Named-Binding Contract (field-key == variable-name)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-11
**Task:** E11.1 — единый источник истины для соответствия `field-key == variable-name`
между Floor-1 (JSON Schema форм) и Floor-2 (BPMN-переменные) + машинная compat-проверка.
**Parent:** T-0070 (E11) · **Spec:** `docs/specs/T-0072-named-binding.spec.md`
**Raw TZ:** `docs/design/extensibility-and-authoring.md` §4 (TWO-FLOOR хребет) + §9 гард 3.
**Migration slot:** 045 (044 = sibling T-0077, HARD seam — см. §8).

---

## 1. Решение (decision)

Построить три аддитивных артефакта поверх существующих T-0013/T-0027 рельсов, **без**
изменения замороженной поверхности (grant-lattice, grant-resolver, bpmn-xml-parser
сигнатуры, существующие linter-контракты):

1. **`form_binding`** — tenant-таблица (migration 045) по T-0013-дисциплине
   (`tenant_id` leading PK, ENABLE+FORCE RLS, tenant-isolation policy на
   `current_setting('choros.tenant_id', true)::uuid`, GRANT DML `choros_app`,
   регистрация в `ci/checks/known_tenant_tables.txt`). Поле `fields` (jsonb) хранит
   массив `{key, type, required}`, где `key` **физически тождественен** имени
   Flowable-переменной — контракт `field-key == variable-name` выражен отсутствием
   маппинга, не сверкой двух колонок.

2. **`src/core/binding-compat.ts`** — новый **чистый** модуль (NF-2/AC-5): экспортирует
   `checkBindingCompat(fields, bpmnVarNames)` + типы `BindingField`,
   `BindingViolation`, `BindingCompatResult`. Никаких импортов pg/fs/net/http/
   child_process; зеркалит purity-дисциплину `bpmn-linter.ts` (T-0027).

3. **Аддитивное расширение `src/core/bpmn-linter.ts`**: `LintViolationType` получает
   член `"binding_mismatch"` (union-расширение, не ломает существующие тесты —
   NF-4/AC-13), `lintBpmn` получает **второй опциональный** параметр
   `opts?: { bindingSchema?: BindingField[] }`. Вызов `lintBpmn(xml)` без второго
   аргумента **байт-в-байт** сохраняет поведение T-0027 (обратная совместимость —
   это несущий инвариант, см. §5).

Плюс тонкие интеграционные слои: CLI-флаг `--binding-schema` (FR-5), HTTP GET/POST
`/binding` (FR-6), dev-seed в миграции 045 (FR-7).

**Почему так, а не иначе:** ADR §4 фиксирует, что `field-key == variable-name` —
это **инвариант хребта** («код Floor-2 не мутирует процесс напрямую — он презентация
над тем же named-binding, валидируемым на бэке»). Единственная таблица с единственным
ключом — самая дешёвая физическая реализация тождества: невозможно рассинхронизировать
два имени, которых нет. Compat-check ловит расхождение между **зарегистрированной
схемой формы** и **фактическими переменными BPMN-процесса** — то, что таблица одна,
не отменяет того, что BPMN-артефакт правится отдельно и может отстать.

---

## 2. Объектная модель

### 2.1 Таблица `form_binding` (migration 045)

| Колонка        | Тип       | Ограничение                                          |
|----------------|-----------|------------------------------------------------------|
| `tenant_id`    | uuid      | NOT NULL, leading PK                                  |
| `id`           | uuid      | NOT NULL (вторая компонента PK — T-0017 self-contained PK-дисциплина) |
| `process_key`  | text      | NOT NULL — = Flowable `processDefinitionKey`         |
| `form_key`     | text      | NOT NULL — = `formKey` в `<userTask>`                |
| `fields`       | jsonb     | NOT NULL — массив `BindingField` (схема ниже)        |
| `version`      | integer   | NOT NULL DEFAULT 1 — инкремент на каждый UPDATE      |
| `created_at`   | bigint    | NOT NULL (epoch ms)                                  |
| `updated_at`   | bigint    | NOT NULL (epoch ms)                                  |

- **PK:** `(tenant_id, id)` — self-contained, без cross-table FK (зеркалит
  043_invoke_proposal / T-0017 урок).
- **UNIQUE:** `(tenant_id, process_key, form_key)` — естественный ключ связки; на него
  опирается ON CONFLICT в POST-upsert (FR-6) и GET-lookup (FR-9). RLS-tenant и UNIQUE
  оба ведут с `tenant_id` — нет cross-tenant коллизии ключей.
- **CHECK** (опционально, рекомендация): `jsonb_typeof(fields) = 'array'` —
  структурный пол на уровне БД (детальная валидация — в приложении, см. §3.1).

### 2.2 Схема `fields` jsonb (особо-1)

`fields` — JSON-массив объектов `BindingField`:

```ts
interface BindingField {
  key: string;       // обязателен. = field-key = имя Flowable-переменной.
  type: string;      // обязателен. логический тип поля (string|number|boolean|date|enum|…)
  required: boolean;  // обязателен. UI/валидационный флаг обязательности поля.
  label?: string;    // опционален. человеко-видимая подпись (relabel — Floor-1 правка §4).
}
```

**Решение по обязательности (особо-1):** обязательны `key`, `type`, `required`
(спека FR-1 фиксирует именно эту тройку как форму записи). `label` — опционален:
он нужен Floor-1 relabel (ADR §4 «кнопочно: relabel/hide/toggle required»), но
**не участвует** в compat-check (compat смотрит только на `key`), поэтому его
отсутствие не нарушает контракт. `type`/`required` хранятся как несущий каркас
будущего Floor-1-редактора и Floor-2 codegen (T-0077), но T-0072 их семантику
**не валидирует против объект-схемы** — это ADR §9 гард 4, явно вне скоупа.

**Валидация `key` (особо-1).** `key` обязан быть валидным именем переменной
Flowable/BPMN-EL. Flowable резолвит переменные через идентификаторы JUEL/MVEL,
которые суть Java-идентификаторы. Берём **консервативное** правило (узкое, не широкое
— ложные допуски опаснее ложных отказов в контракте имён):

```
KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/      // первый символ — буква/подчёркивание; далее — буквенно-цифровое/подчёркивание
MAX_KEY_LEN = 255                         // защитный пол; Flowable хранит имена переменных как varchar
```

Это согласовано с EL-экстрактором `${\w+}` (см. §2.4): `\w` = `[A-Za-z0-9_]`, и
KEY_RE — его супермножество с ограничением первого символа. Имена с `.` (dot-walking),
пробелами, дефисами — **отвергаются** на записи (POST → 400), чтобы compat-check не
сталкивался с именами, которые EL-экстрактор заведомо не извлечёт.

**Уникальность `key` внутри binding (особо-1):** дубликат `key` в массиве `fields` —
**ошибка валидации** (POST → 400). Контракт «один ключ = одно имя переменной»
несовместим с двумя полями под одним именем (тихая перезапись переменной). Проверка:
`new Set(fields.map(f=>f.key)).size === fields.length`.

### 2.3 Экспортируемые типы `binding-compat.ts`

```ts
export interface BindingField { key: string; type: string; required: boolean; label?: string; }

export type BindingViolationType = "missing_in_schema" | "missing_in_bpmn";

export interface BindingViolation {
  type: BindingViolationType;
  fieldKey: string;     // имя переменной/ключа в центре расхождения
  message: string;
}

export type BindingCompatResult =
  | { ok: true }
  | { ok: false; violations: BindingViolation[] };

export function checkBindingCompat(
  fields: BindingField[],
  bpmnVarNames: ReadonlySet<string>,
): BindingCompatResult;
```

### 2.4 Источники `bpmnVarNames` — статическая экстракция из XML (особо-2)

`bpmnVarNames` строится **внутри `lintBpmn`** (когда передан `opts.bindingSchema`)
поверх **существующего** токенайзера `tokenize()` (T-0027 `bpmn-xml-parser.ts`) —
**без** изменения его сигнатуры и без второго парсера. Точный, замороженный в этом
ADR перечень мест объявления/использования переменной во Flowable-7 BPMN:

| # | Источник                                          | Что берём                          | Извлечение |
|---|---------------------------------------------------|------------------------------------|------------|
| 1 | `<in name="X" .../>` (call-activity in-mapping)   | атрибут `name`                     | open/self-close attr |
| 2 | `<out name="Y" .../>` (call-activity out-mapping) | атрибут `name`                     | open/self-close attr |
| 3 | `<formProperty id="Z" .../>` (legacy form)        | атрибут `id`                       | open/self-close attr |
| 4 | `<formField id="W" .../>` (Flowable form)         | атрибут `id`                       | open/self-close attr |
| 5 | `<conditionExpression>${myVar}</conditionExpression>` | EL `${...}` в text-content     | regex по text-token |

**EL-регекс (особо-2, best-effort, NF-5):**

```
EL_VAR_RE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\b/g
```

Извлекает **корневое** имя переменной из начала EL-выражения (`${supplier}`,
`${supplier.name}` → `supplier`, `${amount > 100}` → `amount`). Это **best-effort**:
сложные выражения (`${a && b}`, методы, литералы) дают только первый корень —
**ложные отрицания допустимы (NF-5)**, ложные срабатывания (не-переменные как имена)
— **нет**. Регекс закреплён в коде комментарием как граница T-0072; полный
OGNL/MVEL-парсер — вне скоупа.

**Точки регистрации в обходе токенов** (аддитивно к существующему walk-циклу
`lintBpmn`): при `open-tag`/`self-close-tag` с localName ∈ {`in`,`out`} — берём
`attrs.find(a=>a.name==="name")?.value`; с localName ∈ {`formProperty`,`formField`}
— `attrs.find(a=>a.name==="id")?.value`; при накоплении text внутри
`conditionExpression` (контекст уже отслеживается в T-0027 walker через
`isConditionExpression`) — прогоняем `EL_VAR_RE`. Все имена кладутся в `Set<string>`.
Имена, не прошедшие `KEY_RE` shape (теоретически невозможны для #1–#4, возможны для
мусорного EL), отбрасываются — экстрактор не порождает ложных переменных.

> **Важно для не-вырожденности compat-check:** перечень источников намеренно покрывает
> и **объявление** (`formField`/`formProperty`/`in`), и **использование**
> (`out`/EL-условия) переменной. Без этого compat-check сравнивал бы схему с пустым
> множеством. Перечень закрыт этим ADR; расширение (напр. `flowable:variableAggregation`)
> — отдельная задача.

---

## 3. Compat-политика (особо-3)

`checkBindingCompat(fields, bpmnVarNames)`:

- `schemaKeys = new Set(fields.map(f => f.key))`.
- Для каждого `v ∈ bpmnVarNames`, если `v ∉ schemaKeys` → violation
  `{ type: "missing_in_schema", fieldKey: v }` — *«BPMN ссылается на переменную,
  которую схема формы не объявила»*. (Имя `missing_in_schema` = «отсутствует в схеме».)
- Для каждого `f ∈ fields`, если `f.key ∉ bpmnVarNames` → violation
  `{ type: "missing_in_bpmn", fieldKey: f.key }` — *«форма объявляет поле, которое
  процесс нигде не упоминает»* (потенциально мёртвая переменная).
- `ok: true` ⟺ `schemaKeys === bpmnVarNames` как множества (взаимное включение),
  включая случай «оба пустые».

**Решение по severity и направлению (особо-3):** **оба** случая — нарушения на уровне
валидатора (`ok:false`). Это снимает риторическое противоречие в спеке FR-3
(где `missing_in_schema` помечен «предупреждение, не блок, если ADR не требует жёсткого
блока»): **ADR требует жёсткого блока для обоих** — AC-4 и AC-6 однозначно требуют
`ok:false` для обоих направлений, а несущий инвариант §9 гард 3 говорит «нарушение
должно быть **блокирующей ошибкой**, а не тихим расхождением». Дифференцировать
severity (warn/error) на уровне чистой функции — преждевременно: функция возвращает
типизированные violations, а **политику эскалации владеет caller** (linter → deploy-block,
CLI → exit 1). Если позже понадобится «warn для висячих полей», это аддитивное поле
`severity` в `BindingViolation` — но **не в скоупе T-0072** (фиксируем как развилку §7).

> **Терминологическая сверка с FR-3/спекой.** Спека в одном месте называет «переменная
> без поля» как `missing_in_bpmn`, в другом — описывает симметрично. Этот ADR
> **нормализует** именование строго по семантике слова: `missing_in_schema` = «нет в
> схеме формы» (т.е. BPMN-переменная без поля); `missing_in_bpmn` = «нет в BPMN»
> (т.е. поле формы без переменной). Реализация и тесты следуют **этой** ADR-нормализации;
> AC-4 формулирован абстрактно («переменная без поля → mismatch; лишний ключ → mismatch»)
> и обоими именами удовлетворяется. См. traceability AC-4.

---

## 4. RLS / гранты POST /binding (особо-4)

**Решение (особо-4):** POST/GET `/binding` защищены **существующим auth-middleware**
(`withAuth`, `src/http/auth.ts`) + **конвенциональной проверкой роли**
`process_designer` на уровне приложения. **НЕ** вводится новый `resource_type`/
`operation` в grant-lattice, **НЕ** добавляется строка роли в БД, **НЕ** трогается
конверт `authoring_draft` config-агента (T-0077).

Обоснование, со сверкой источников (требование оркестратора):

- **Спека отвечает однозначно** (FR-6 + out-of-scope): «Требует аутентифицированного
  пользователя с ролью `process_designer` (проверка через существующий auth-middleware;
  роль — конвенциональная, не новая таблица в T-0072 скоупе)» и «Roлевая модель
  `process_designer` — T-0072 проверяет наличие роли через существующий auth, но не
  создаёт новую роль-строку». Следуем спеке (директива «если спека отвечает — следуй ей»).
- **Сверка с grant-lattice (T-0018/T-0024):** `ResourceType` union =
  `application | registry | record | mgmt_object:* | effect_resource`; `Operation` =
  `read|create|update|delete|approve|transition|invoke`. Ни `authoring_draft`, ни
  `binding` там нет, и grant-lattice — **frozen** (нельзя расширять в T-0072). Значит
  POST /binding **физически не может** лечь в grant-lattice-конверт без правки
  замороженного ядра → правильный слой защиты здесь — auth-middleware + роль, как у
  read-API процессов, а не PDP-грант.
- **Сверка с config-агентом T-0077 (authoring_draft):** конверт `authoring_draft`
  принадлежит **codegen-петле** config-агента (`emit_form_code`/`edit_jsonschema`),
  который авторит **только в DRAFT** под human-gate (ADR §4). POST /binding — это
  **запись источника истины** (живой контракт), не draft-эмиссия кода. Поэтому он
  лежит в **админском/process_designer лейне**, а не в authoring_draft-конверте.
  Config-агент T-0077 — **читатель** этого контракта (GET /binding перед эмиссией
  Floor-2-кода, FR-9), а пишет его process_designer (человек или его делегат).
  Это согласовано с §4: «агент предлагает (draft) — человек подтверждает»; контракт-
  источник-истины фиксирует человек/админ, агент читает и генерит код под него.

**RLS-механика записи.** POST/GET идут через `withTenantTx` (зеркалит invoke.ts):
`BEGIN; SET LOCAL choros.tenant_id = $tenant; SET LOCAL search_path TO choros; …`.
Сессия `choros_app` (NOBYPASSRLS) видит/пишет **только** строки своего тенанта —
FORCE RLS политика 045 гарантирует cross-tenant изоляцию (AC-2). `tenantId` берётся
из path-параметра `:tenantId` и валидируется UUID-shape; идентичность пользователя —
из auth-middleware (dev: `x-dev-user`; keycloak: JWT-sub). Без идентичности → 401 (AC-10).
Без роли `process_designer` → 403.

> **Заметка о dev-режиме (CHOROS_AUTH_MODE=dev):** в dev `withAuth` — pass-through,
> роль-проверка использует ту же конвенцию, что read-API (`x-dev-user` → employee →
> role_assignment lookup). T-0072 **не** создаёт роль `process_designer`; если в
> dev-seed её ещё нет, проверка роли в dev может быть смягчена до «аутентифицирован»
> (как у соседних write-API на этой стадии) — точная политика dev-роли наследуется
> от auth-слоя, не вводится здесь. Жёсткий 403-гейт активируется в keycloak-режиме.

---

## 5. Несущие инварианты обратной совместимости

- **`lintBpmn(xml)` (одно-арг) — поведенчески замороженный** (NF-4/AC-13). Расширение
  union `LintViolationType` аддитивно: TypeScript union «расширяется вверх», ни один
  существующий тест T-0027 не сравнивает «множество всех возможных типов», только
  конкретные значения — поэтому добавление члена их не ломает.
- **`bpmn-xml-parser.ts` — НЕ трогается** (frozen tokenizer). varNames извлекаются
  поверх его существующего token-stream, в `bpmn-linter.ts`.
- **`binding-compat.ts` — pure** (AC-5): зеркалит дисциплину `bpmn-linter.ts`,
  изолируется тем же классом ci-check (grep на запрещённые импорты).
- **grant-lattice / grant-resolver — НЕ трогаются** (frozen authority core).

---

## 6. Контракты (frozen public surface)

- `export function checkBindingCompat(fields: BindingField[], bpmnVarNames: ReadonlySet<string>): BindingCompatResult` — pure, no I/O.
- `export interface BindingField { key: string; type: string; required: boolean; label?: string }`
- `export type BindingViolationType = "missing_in_schema" | "missing_in_bpmn"`
- `export interface BindingViolation { type: BindingViolationType; fieldKey: string; message: string }`
- `export type BindingCompatResult = { ok: true } | { ok: false; violations: BindingViolation[] }`
- `export type LintViolationType = "raw_object_binding" | "malformed_xml" | "binding_mismatch"` (расширение).
- `export function lintBpmn(xml: string, opts?: { bindingSchema?: BindingField[] }): LintResult` — второй параметр опционален; без него = поведение T-0027.
- HTTP: `GET /tenants/:tenantId/processes/:processKey/forms/:formKey/binding` → 200 `{fields, version}` | 404.
- HTTP: `POST /tenants/:tenantId/processes/:processKey/forms/:formKey/binding` body `{fields}` → 201 (создание) / 200 (обновление, version+=1) / 400 (невалидная схема) / 401 (нет auth) / 403 (нет роли).
- CLI: `lint-bpmn [--binding-schema <path>] <file.bpmn>` — exit 0/1; без флага = поведение T-0027.
- migration `045_form_binding.sql` — DDL + FORCE RLS + policy + GRANT DML + dev-seed.

---

## 7. Нерешённые развилки (вне прав архитектора T-0072)

1. **severity-градация violations (warn vs error).** ADR фиксирует «оба блокирующие»
   по букве AC-4/AC-6 и §9-гард-3. Если продукт захочет «висячее поле формы = warn,
   а не deploy-block», это аддитивное поле `severity` в `BindingViolation` —
   **продуктовое решение, не T-0072**. Помечено, не угадано.
2. **dev-роль `process_designer`.** Создание/seed роли `process_designer` (строка в
   `role`/`role_assignment`, гранты) — вне скоупа T-0072 (спека явно). До её появления
   dev-гейт наследует политику auth-слоя. Точную dev-политику (смягчённую vs строгую)
   ратифицирует владелец RBAC-seed, не T-0072.
3. **object-schema ↔ form_binding когерентность** (ADR §9 гард 4): валидация
   `fields[].type` против `registry_def.record_schema` — отдельная задача E11.x.

---

## 8. Шов (seam) и известные sibling-красные

- **Миграция 045** + строка в `ci/checks/known_tenant_tables.txt` — **единственная**
  правка миграций/реестра в T-0072.
- **ИЗВЕСТНЫЙ КЛАСС sibling-red (НЕ чинить):** появление новой `migrations/*.sql`
  редденит byte-level frozen-foundation checks соседних задач, опирающихся на
  «миграции не тронуты» — конкретно `ci/checks/role-criticality-isolation.sh` (FF-RC5:
  «change does not touch any migrations/*.sql») и аналогичные grant-trail/criticality
  изоляции. На ветке `task/T-0072` эти sibling-checks краснеют **по конструкции**; они
  зеленеют post-merge в dev (их инвариант — «*эта* задача не трогала миграции», а не
  «миграций не появлялось вообще»). Это тот же класс, что описан в MEMORY
  `choros-ci-check-gotchas`. T-0072 **не чинит** чужие гейты.
- **Сёстры в полёте:** T-0077 (migration 044, seed config-agent + authoring_draft),
  T-0066 (worker-api docs). HARD seam по слоту миграции: T-0072 = 045, T-0077 = 044 —
  непересекающиеся слоты, мерж-порядок безразличен.
- **Общие файлы** (`bpmn-linter.ts`, CLI, router) правятся **аддитивно**.
- **Frozen-файлы** (`grant-lattice.ts`, `grant-resolver.ts`, `bpmn-xml-parser.ts`) —
  не трогаются.

---

## 9. Runtime target

local — `npm run ci` (tsc --noEmit && eslint && fitness && vitest run) + миграция 045
применяется к dev-Postgres через `migrations/run.mjs`. Нет нового инфра. `checkBindingCompat`
и расширенный `lintBpmn` — in-process pure calls; T-0058/T-0064 deploy-gate подключит
`bindingSchema` (загруженную из `form_binding`) при реальном deploy — это будущая
интеграция, не скоуп T-0072.
