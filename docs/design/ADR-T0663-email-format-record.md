# ADR · T-0663 — format:"email" в record_schema: AJV strict compile-time throw

**Status:** ready (bug fix, no escalation — root cause structural, fix additive)
**Phase:** DESIGN · **Date:** 2026-07-05
**Task:** T-0663 [P0/bug, столп 2 — интерфейс из блоков на данных]
**Spec:** `T-0663.spec.md` (AC-1..AC-11)

---

## 1. Context

LIVE_PROOF в реестре «Контрагенты» (`kontragenty`) вскрыл: создание записи с
email-полем падает в UI с `unknown format "email" ignored in schema` — **даже
когда email-поле оставлено пустым**. Запись не сохраняется никогда, для
любого значения.

## 2. Где живёт AJV для валидации записей

`src/core/record-schema-validator.ts` — единственный модуль, создающий AJV для
валидации данных записи. Два экспорта, каждый с собственной `new Ajv()` (были
раздельные инстансы без общего состояния — намеренно, "fresh instance to avoid
state leaks"):

1. `validateRecordAgainstSchema(record, schemaHistory)` — валидирует
   `record.data` против исторической схемы версии. Вызывается из
   `src/http/records.ts::assertDataValid` — **два живых call-site**: POST
   `/api/records` (records.ts:813) и PUT `/api/records/:id` (records.ts:1417).
   Это единственный путь, которым проходит прямой REST-запись записи.
2. `validateRecordSchemaDefinition(schema)` — валидирует, что
   `registry_def.record_schema` сам по себе компилируемая JSON-Schema
   (T-0263 authoring guard). Вызывается из `src/http/registry-defs.ts:921`.

Третий путь записи — form-submit (`src/http/form-record-persister.ts`) — НЕ
использует AJV напрямую: он через `deriveFormDefFromSchema` строит `FormDef`
(`field-type-dictionary.ts::deriveFieldType` мапит `format:"email"` →
канонический `FieldType "email"`), а затем валидирует
`validateFormSubmissionAgainst` (`form-validator.ts`) — свой собственный
регэксп-валидатор email (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), НЕ AJV `format`
keyword. Этот путь бага НЕ имел (он изолирован от AJV strict-mode).
`form-validator.ts`'s `isAbsent()` уже трактует пустую строку как отсутствие —
корректная семантика, независимо не пострадавшая.

Фронтовые `web/src/screens/apps-schema.test.js` /
`web/src/screens/records-form.test.js` создают СВОЙ `new Ajv()` — но это
**test-only зеркало**: тест импортирует `ajv` (root devDependency) чтобы
проверить в юнит-тесте, что схемы, которые эмитит `apps-schema.js`
(x-*-конвенция, НЕ `format`), компилируются на голом AJV — то есть
подтверждает, что конструктор реестров УЖЕ обходит баг другим путём. Это не
второй продакшн-валидатор.

**Вывод: единственный продакшн-путь валидации записи — `record-schema-validator.ts`.
Фикс в одном месте (общая фабрика `makeAjv()`) закрывает оба call-site
(`validateRecordAgainstSchema` + `validateRecordSchemaDefinition`) разом.**

## 3. Корень: AJV strict-mode бросает на compile(), не на validate()

```
$ node -e "new (require('ajv').Ajv)().compile({type:'object',properties:{e:{type:'string',format:'email'}}})"
unknown format "email" ignored in schema at path "#/properties/e"
```

AJV v8's `strict` default = `true`. Strict-режим бросает **при
`ajv.compile(schema)`** для любого `format`, не зарегистрированного на
инстансе. Это compile-time ошибка — она срабатывает ДО того, как
`validate(data)` вообще посмотрел на значение поля. Именно поэтому баг
воспроизводится «даже с пустым email»: `assertDataValid` в `records.ts` ловит
исключение из `ajv.compile()` внутри try/catch и заворачивает ЛЮБОЕ такое
исключение в `400 VALIDATION` (см. `record-schema-validator.ts`'s
`validateRecordAgainstSchema` catch-блок: `schema validation error: ${message}`)
— для ЛЮБОГО payload, пока схема реестра несёт нераспознанный `format`.

### 3.1. Почему в системе УЖЕ было частичное решение (T-0516), но не полное

`web/src/screens/apps-schema.js` (комментарии T-0516) уже знает про этот
класс бага: для схем, которые СОЗДАЁТ конструктор реестров через UI (после
T-0516), email/url/date НЕ эмитятся как `format:"email"/"uri"/"date"` — вместо
этого используется x-*-конвенция (`x-email: true`, `x-url: true`, `x-date:
true`), которую `stripXExtensions` (record-schema-validator.ts) снимает перед
компиляцией. Комментарий в коде прямым текстом: *"AJV strict rejects
format:"email" (unknown format) — use x-email as the round-trip
discriminator"*.

Это латает НОВЫЕ схемы. Но два SEED-реестра, заведённых миграциями ДО T-0516,
несут «сырой» `format`:

| Миграция | Реестр | Поле | format | required? |
|---|---|---|---|---|
| `073_vendor_crm_seed.sql` | `customer-subscription` | `contact_email` | `email` | да |
| `073_vendor_crm_seed.sql` | `customer-subscription` | `not_after` | `date` | да |
| `073_vendor_crm_seed.sql` | `customer-subscription` | `activation_key_issued_at` | `date-time` | нет |
| `083_core_system_registries_seed.sql` | `kontragenty` («Контрагенты», **is_system=true**) | `contact_email` | `email` | нет |
| `083_core_system_registries_seed.sql` | `prod-kalendar` («Производственный календарь») | `date` | `date` | да |

`kontragenty` — B2B-хаб, "используется всеми процессами и реестрами, которые
ссылаются на юридическое лицо" (комментарий в 083) — это системный реестр,
который потенциально блокирует любой кейс, ссылающийся на контрагента.

## 4. Решение

**Зарегистрировать стандартный словарь `format` через `ajv-formats` на обоих
AJV-инстансах `record-schema-validator.ts`, через общую фабрику `makeAjv()`.**

### 4.1. Пакет

`ajv-formats@^3.0.1` добавлен как root dependency (`package.json`
`"dependencies"`, рядом с `ajv`/`pg`). Peer-зависимость `ajv@^8.0.0` совпадает
с уже используемым `ajv@8.20.0` — конфликта версий нет.
`ajv-formats` уже присутствовал КАК devDependency? — нет, отсутствовал
полностью; это первое добавление пакета в проект под T-0663.

### 4.2. Полный список зарегистрированных форматов

`addFormats(ajv)` БЕЗ allowlist-опции `formats: [...]` — регистрируется ПОЛНЫЙ
дефолтный словарь ajv-formats (стоит копейки: чистые regex/предикаты, никакого
I/O):

`date`, `time`, `date-time`, `iso-time`, `iso-date-time`, `duration`, `uri`,
`uri-reference`, `uri-template`, `url`, `email`, `hostname`, `ipv4`, `ipv6`,
`regex`, `uuid`, `json-pointer`, `json-pointer-uri-fragment`,
`relative-json-pointer`, `byte`, `int32`, `int64`, `float`, `double`,
`password`, `binary`.

Решение регистрировать весь словарь, а не только `email`/`date`/`date-time`
(минимально нужные для устранения репортнутого бага): любой из этих ключевых
слов, до которого доберётся автор схемы (`uri` уже используется — см. `x-url`
конвенция для URL-полей; `uuid` нужен для relation-подобных ручных схем), либо
компилируется правильно сразу, либо снова 400-ит тем же классом бага при
следующем обнаружении в проде. Цена регистрации всего словаря — нулевая
(в отличие от цены повторного LIVE_PROOF-инцидента).

### 4.3. Пустая строка — семантика (§1.3 спеки)

JSON Schema `format` ограничивает форму ЗНАЧЕНИЯ, которое присутствует;
присутствие/обязательность — компетенция `required`, отдельного ключевого
слова. Библиотеки типа ajv-formats этого разделения не соблюдают: их regex для
`email`/`date`/`uri`/… не матчит `""` (RFC 5321 mailbox-грамматика не
допускает пустую строку) — значит даже ПОСЛЕ регистрации форматов,
явно посланное `contact_email: ""` на НЕОБЯЗАТЕЛЬНОМ поле всё ещё 400-ило бы.

Фронт (`web/src/screens/records-form.js::serializeRecordData`) уже ОПУСКАЕТ
пустые необязательные строковые поля из payload (T-0294/T-0516: "Blank
optional ⇒ omit") — так что через штатную форму баг был бы наполовину не
воспроизводим. Но сервер — источник истины валидации — не должен полагаться
на клиентское поведение (defense in depth; прямой API-вызов, будущий
клиент, баг во фронте — всё это легитимные пути, которыми `""` может
долететь до валидатора).

**Решение**: `emptyStringTolerant()` — обёртка над каждым СТРОКОВЫМ
format-валидатором ajv-formats, которая всегда пропускает `""`, делегируя
остальное оригинальному валидатору. `required` (и AJV-шная обязательность)
остаются ЕДИНСТВЕННЫМ судьёй присутствия — обёртка НЕ ослабляет `required`:
`required`-поле с пустой строкой уже проходило бы FORMAT-проверку и до этой
правки (для простого `type:"string"` без `format`, обязательность и
непустота — разные предикаты в JSON Schema; это не новая дыра, а
согласованность с уже существующим поведением для полей без `format`).

Числовые форматы (`int32`/`int64`/`float`/`double`, `type:"number"`) — НЕ
обёрнуты (пустая строка неприменима к типу `number`; `format` там применяется
к JS-числу, не к строке).

### 4.4. Верификация форм ajv-formats (важно для реализации)

`ajv.formats[name]` после `addFormats(ajv)` возвращает РАЗНЫЕ формы в
зависимости от формата (проверено на установленном `ajv-formats@3.0.1`):

- скомпилированный `RegExp` (`email`, `uri`, `hostname`, `ipv4`, `ipv6`, …);
- голая функция-валидатор (`uri`, `regex`, `byte`, …) — TS-тип
  `FormatValidator<string>`;
- объект `FormatDefinition` с полем `.validate` (`string | RegExp |
  function`) — так зарегистрированы `date`/`time`/`date-time`/
  `int32`/`int64`/`float`/`double`;
- буквальный `boolean` (`password`, `binary` — no-op форматы).

`emptyStringTolerant()` явно разбирает все 4 формы (плюс `string`-имя другого
формата и `format.async === true`, не встречающиеся в текущем словаре
ajv-formats, но допустимые типом `Format`) — иначе часть форматов (например,
`email`, зарегистрированный как голый `RegExp`, а не `{validate}`-объект) не
получила бы empty-string carve-out несмотря на код, который выглядел бы
работающим для `date`.

### 4.5. TS-импорт ajv-formats — известная шероховатость Node16-без-esModuleInterop

`ajv-formats`'s `.d.ts` использует ESM-синтаксис `export default formatsPlugin`
поверх реального CJS-рантайма (`module.exports = exports = formatsPlugin`) —
его `package.json` не имеет `"type": "module"` и не имеет `exports`-карты.
Под конфигом этого репо (`module: Node16`, `moduleResolution: Node16`, БЕЗ
`esModuleInterop`) простой `import addFormats from 'ajv-formats'` резолвится в
TS как **весь namespace модуля**, а не в дефолтный экспорт — компилятор
кидает `TS2349: This expression is not callable` (воспроизведено в изоляции,
задокументировано инлайн-комментарием в коде). `@types/pg`'s `export =`-форма
даёт `pg`'s `import pg from "pg"` работать "бесплатно" — у ajv-formats такой
формы `.d.ts` нет.

**Обходной путь**: `import ajvFormatsNs = require('ajv-formats')` +
`ajvFormatsNs.default(ajv)`. Реальный `tsc` (используемый в `npm run build`)
эмитит для этой формы `const __require = createRequire(import.meta.url); …
const ajvFormatsNs = __require("ajv-formats");` — корректный, портируемый
CJS-в-ESM interop-шим, который работает и под `node`, и под `vitest`.
Проверено: (а) `npx tsc --noEmit` зелёный; (б) полный `npx tsc` (build)
зелёный, скомпилированный `dist/core/record-schema-validator.js` запущен
напрямую через `node -e "import(...)"` — работает; (в) `npx vitest run`
зелёный. Единственное окружение, где голый `import ... = require(...)` НЕ
работает — `tsx` в чистом ESM-режиме (`require is not defined`), но `tsx` не
используется ни в build, ни в тестовом пайплайне этого проекта (только в
scratch-скриптах разведки), так что это не блокер.

## 5. Затронутые файлы

- `src/core/record-schema-validator.ts` — `makeAjv()` фабрика (заменяет два
  голых `new Ajv()`), `emptyStringTolerant()`.
- `package.json` / `package-lock.json` — добавлен `ajv-formats@^3.0.1`
  (root dependency).
- `src/__tests__/record-schema-validator.test.ts` — юнит-тесты T-0663 (AC-a/b/c
  + validateRecordSchemaDefinition + date/date-time).
- `ci/checks/db/records_crud.test.ts` — DB-тест T-0663 (реальный HTTP POST
  `/api/records` на реальном Postgres, схема — точная копия seed'а
  `kontragenty` из migrations/083).

## 6. Не в рамках / оставлено как есть

- Миграции 073/083 НЕ переписаны на x-*-конвенцию — обратная совместимость
  схемы (registry_schema_history versioning) не требует замены; фикс делает
  ОБЕ конвенции (`format:` и `x-*`) корректно работающими на сервере.
- `web/src/screens/apps-schema.js` конструктор реестров — не тронут (уже
  корректно эмитит x-*-конвенцию для новых полей; независимый путь).
- Живой LIVE_PROOF в UI (создание записи «Контрагенты» с email через реальный
  браузер) — не выполнялся в рамках этой сессии (нет доступа к развёрнутому
  стенду из write-worktree); DB-тест через реальный HTTP-роут на реальном PG
  — ближайший эквивалент, доказывающий именно тот путь (`POST
  /api/records` → `assertDataValid` → `validateRecordAgainstSchema`), которым
  идёт UI-форма.
