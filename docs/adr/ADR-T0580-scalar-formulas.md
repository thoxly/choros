# ADR T-0580 — Скаляр-формулы в computed: грамматика + безопасный evaluator рядом с rollup

Фаза: DESIGN. Столп 3. Кейс К4. Ветка `task/T-0580-scalar-formulas` (от dev@9e7d9f7).
Вход: `docs/specs/T-0580-scalar-formulas.spec.md` (status: ready).
Runtime-таргет: **сервер** (тот же derived-контур, что rollup) + чистое ядро;
внешних ресурсов НЕ требует (GT-4 не нужен).

---

## 1. Контекст

Поле `computed` («Итог») сегодня 1:1 равно rollup-агрегату. Механизм derived-полей уже
построен и доказан живьём (Σ(a×b)=407500, карта §A7):

- **Контур:** `x-rollup`/`x-matrix-lookup` — `x-`-аннотации на свойстве `record_schema`.
  `extractDerivedFields` (`rollup-contract.ts:593`) сканирует свойства → `DerivedFieldSpec[]`
  (`kind: "rollup" | "rollup-embedded" | "matrix-lookup"`). `computeAllDerivedFields`
  (`derived-fields-dao.ts:239`) диспетчит по `kind`; значения оверлеятся в ответ READ
  (`records.ts:1762`, ключ `derived`) и в переменные процесса на старте (`records.ts:892`).
- **Прецедент чистого расчёта:** `computeEmbeddedRollup` (`rollup-contract.ts:439`) — ЧИСТАЯ
  in-memory функция над `record.data`, БЕЗ БД, зеркало клиентского `records-form.js::computeRollup`.
  Скаляр-формула ложится в ЭТОТ ЖЕ паттерн (операнды — поля своей записи, уже в памяти).
- **Схема-строб:** `stripXExtensions` (`record-schema-validator.ts:174`) срезает ЛЮБОЙ `x-`-ключ
  перед AJV-compile → `x-formula` не требует правки whitelist. `date` хранится как
  `{type:"string","x-date":true}`, значение — ISO `YYYY-MM-DD` без времени (`apps-schema.js:40`).
- **Zero-dep:** `package.json` deps = `{ajv, pg}`; `pg-single-dep.sh`/`no-env-in-core.sh` держат
  чистоту ядра. Готовой безопасной либы-эвалуатора в зависимостях НЕТ, и добавлять нельзя.

## 2. Решение (обзор)

Ввести **второй флейвор поля `computed` — скаляр-формулу** — как аддитивную `x-formula`-аннотацию
РЯДОМ с `x-rollup` (не замена). Вычисление — собственный **безопасный evaluator в `src/core/`:
рекурсивно-нисходящий (Pratt) парсер → замороженный AST → тайп-чекер → tree-walking интерпретатор**.
БЕЗ `eval`/`Function`/`vm`. Расчёт — ЧИСТАЯ in-memory функция над `record.data` + уже-вычисленными
derived (rollup/matrix), встроенная в существующий `computeAllDerivedFields`. Значение read-only,
НЕ хранится в `record.data` (PD-20).

### 2.1 Грамматика v1 (EBNF)

```
expr        := term (('+' | '-') term)*
term        := factor (('*' | '/') factor)*
factor      := '-' factor | primary
primary     := NUMBER | FIELD_REF | '(' expr ')'
NUMBER      := /-?[0-9]+(\.[0-9]+)?/        (знак минуса — через unary factor)
FIELD_REF   := /[A-Za-z_][A-Za-z0-9_]{0,63}/   (тот же FIELD_KEY_RE, что apps-schema.js:137)
```

- Приоритет: `* /` > `+ −`; лево-ассоциативность; скобки переопределяют. Унарный минус.
- Токенизатор — закрытый алфавит: цифры, `.`, `+ - * / ( )`, идентификатор `[A-Za-z0-9_]`,
  пробелы. Любой иной символ → лексическая ошибка (это и глушит инъекцию: `;`, `$`, `` ` ``,
  `{`, `}`, `[`, `]`, `'`, `"`, `:`, `,`, `!`, `.`-в-идентификаторе (`a.b`) — все НЕ в алфавите).
- FIELD_REF резолвится ТОЛЬКО по имени поля в `record.data`/derived-map — НЕ по глобалам,
  НЕ по свойствам объектов (нет `.`-доступа в грамматике → `constructor`, `__proto__`,
  `process` как идентификатор просто резолвятся в «нет такого поля» → null, а `x.y` вообще
  не парсится).

### 2.2 Типовая система evaluator (число ⊕ дата)

Каждый узел имеет статический тип из `{ number, date }` (выводится тайп-чекером на авторинге,
проверяется на расчёте). Правила (закрытая таблица, ADR-таблица, не код-кейс):

| Операция | left | right | результат | иначе |
|----------|------|-------|-----------|-------|
| `+` `−` `*` `/` | number | number | number | — |
| `+` | date | number(дни) | **date** | — |
| `−` | date | number(дни) | **date** | — |
| `−` | date | date | **number**(дни) | — |
| unary `−` | number | — | number | date → ошибка типа |
| любая иная с date | date | * | — | **ошибка типизации (авторинг)** |

`money`-операнд трактуется как `number` (T-0509: money = {величина, валюта}; арифметика над
величиной; валюта результата — вне scope v1, O-2). Тайп-чекер запускается при сохранении схемы
(FR-7); на расчёте несоответствие типа данных ожидаемому → `null` (FR-8).

### 2.3 Модель хранения — `x-formula` (аннотация свойства)

Автор в редакторе выбирает режим поля `computed`: «агрегат» (rollup, как сегодня) или «формула».
Режим «формула» эмитит:

```
// числовой результат:
{ "type": "number", "x-formula": { "expr": "<строка>", "result_type": "number" } }
// датовый результат (date+дни):
{ "type": "string", "x-formula": { "expr": "<строка>", "result_type": "date" }, "x-date": true }
```

- `result_type` — вычислен тайп-чекером на авторинге и записан в аннотацию (кэш типа, чтобы
  READ-путь знал, форматировать ли результат как дату, без повторного тайп-чека).
- Взаимоисключение: свойство с ОБОИМИ `x-formula` и `x-rollup` — невалидно (FR-1/AC-12);
  `extractDerivedFields` отвергает такое поле (не угадывает флейвор).
- `stripXExtensions` уже срезает `x-formula` (generic `x-`) — AJV-compile не задет.
- Значение НЕ в `record.data` (как rollup); computed никогда не required и не сериализуется
  в data (`records-form.js:787`, `apps-schema.js:523`) — распространяется на формула-режим.

### 2.4 Контур вычисления (аддитивно в существующий диспетчер)

`DerivedFieldSpec` получает четвёртый вариант:
`{ kind: "formula"; fieldKey: string; def: FormulaFieldDef }`.
`computeAllDerivedFields` (`derived-fields-dao.ts`) получает ветку `kind === "formula"` →
ЧИСТЫЙ `evalFormula(def.ast, scope)` (без `client`, как `rollup-embedded`).

Ключевой нюанс — **порядок**: формула может ссылаться на rollup/matrix-результат ИЛИ на другую
формулу. Поэтому `computeAllDerivedFields` перестаёт быть плоским `Promise.all` для формул:

1. Считаем rollup/rollup-embedded/matrix-lookup (независимы от формул) — как сейчас, параллельно.
2. Строим `scope = { ...record.data, ...derivedNonFormula }`.
3. Формулы разрешаем в **топологическом порядке** графа зависимостей (рёбра — FIELD_REF на
   другое формула-поле). Порядок вычислен ОДИН РАЗ на авторинге (ацикличность — FR-6) и может
   быть закэширован; на расчёте — обход в этом порядке, каждый результат дописывается в `scope`.
4. Результат формулы: `number | string(ISO-date) | null`. Тип derived-map расширяется до
   `number | string | null` (был `number | null`) — см. §7 (контракт совместимости).

Изоляция сбоя сохранена: расчёт формулы обёрнут так же, как derived-precompute (SAVEPOINT на
старте `records.ts:883`; per-field swallow-to-null на READ `derived-fields-dao.ts:273`).

### 2.5 Безопасность evaluator (P0, NF-1)

- Разбор — собственный Pratt-парсер над закрытым токен-алфавитом (§2.1). Ни `eval`, ни
  `new Function`, ни `vm`, ни `import()`, ни доступ к прототипам. FIELD_REF — плоский lookup в
  scope-объекте через `Object.prototype.hasOwnProperty.call(scope, key)` (НЕ `scope[key]` напрямую,
  чтобы `__proto__`/`constructor`-как-ключ не резолвились в цепочку прототипов — хотя грамматика
  и так их не пропускает как многосимвольные, `hasOwnProperty`-гард — defense-in-depth).
- Лимиты (NF-5), проверяются на авторинге И расчёте: строка ≤ 500; глубина рекурсии парсера/AST
  ≤ 32 (счётчик глубины, отказ при превышении — не полагаться на стек JS); FIELD_REF ≤ 32.
- Детерминизм (NF-6): нет `today()`/`Date.now()` — v1 без функций (O-1). Дата-литералов в
  грамматике нет; даты приходят ТОЛЬКО из полей записи.

### 2.6 UI редактора формулы (web, NF-7)

`FieldRow` (`screen-app-schema.jsx:697`) при `field.type === 'computed'` показывает переключатель
режима «Агрегат / Формула». «Агрегат» → существующий `RollupConfigEditor`. «Формула» → новый
`FormulaConfigEditor`:

- `<textarea class="chs-input">` для выражения, лейбл «Формула», подсказка «поля записи по имени,
  операции + − * / ( ), для дат: дата + число дней».
- Список сиблинг-полей допустимого типа (number/integer/money/date/computed) — как справка;
  клик по имени вставляет ключ в textarea (O-5 автодополнение — по возможности, не золотим).
- Инлайн-валидация: парсит выражение на лету (тот же чистый парсер, шаренный core-модуль
  импортируется в web), показывает ошибку синтаксиса/типа/несуществующего поля/цикла честным
  сообщением (G-гейт: «поле X не найдено», не «parse error at token»).
- Honest-empty: если в приложении нет ни одного скаляр-поля — гид-сообщение вместо сломанного
  редактора (зеркало `RollupConfigEditor` empty-state).
- Kit-токены, обе темы, без dev-жаргона (NF-7 / G1–G7).

Клиентское превью значения в форме (`records-form.js`) — опционально (NF-4): если добавляется,
использует ТОТ ЖЕ core `evalFormula` (шаренный модуль), чтобы UI-число ≡ серверное (не повторить BUG-016).

## 3. Объектная модель / контракты

- **FormulaFieldDef** (`src/core/formula-contract.ts`): `{ expr: string; result_type: "number" | "date" }`.
  `expr` — исходная строка (source of truth); `result_type` — кэш вывода тайп-чекера.
- **FormulaAst** (`src/core/formula-parser.ts`, замороженный union):
  `{ kind: "num"; value: number } | { kind: "ref"; field: string } | { kind: "unary"; op: "-"; operand: FormulaAst } | { kind: "binary"; op: "+"|"-"|"*"|"/"; left: FormulaAst; right: FormulaAst }`.
- **parseFormula(src): { ok: true; ast } | { ok: false; error }** — лексер+Pratt-парсер, лимиты
  длины/глубины. Чистый.
- **typeCheckFormula(ast, fieldTypes): { ok: true; result_type } | { ok: false; error }** —
  проверяет FIELD_REF существуют и допустимого типа, выводит `result_type` по §2.2, запрещает
  недопустимые дата-комбинации. `fieldTypes: Record<fieldKey, "number"|"date"|...>`. Чистый.
- **validateFormulaFieldDef(raw): Result<FormulaFieldDef>** — форма аннотации (зеркало
  `validateRollupFieldDef`): `expr` non-empty string ≤500, `result_type ∈ {number,date}`. Чистый.
- **evalFormula(ast, scope): number | string | null** — интерпретатор; `scope` — `record.data`
  + derived; null-распространение, деление-на-0→null, нечисло→null, дата-семантика (дни, ISO).
  `hasOwnProperty`-гард на FIELD_REF. Предел глубины обхода. Чистый.
- **detectFormulaCycles(specs): { ok: true; order } | { ok: false; cycle }** — топосорт графа
  формула-полей; возвращает порядок вычисления или найденный цикл. Чистый.
- **DerivedFieldSpec** (`rollup-contract.ts`) += `{ kind: "formula"; fieldKey; def: FormulaFieldDef; ast: FormulaAst }`.
- **extractDerivedFields** += ветка `x-formula` (взаимоисключение с `x-rollup` — оба → skip как
  невалидное); парсит `expr`→`ast` один раз, кладёт в spec.
- **computeAllDerivedFields** (`derived-fields-dao.ts`) += ветка `kind === "formula"` +
  топо-упорядоченный проход формул после не-формульных derived (§2.4).
- **web**: `formula-contract.js`/`formula-parser.js` — шаренная копия core-логики ИЛИ импорт
  скомпилированного core в web-бандл (предпочтительно один источник, см. §4 D2). `apps-schema.js`
  `buildRecordSchema`/`parseRecordSchema` += формула-режим; `FormulaConfigEditor` в `screen-app-schema.jsx`.
- **Миграции: не требуются.** `x-formula` — данные внутри `record_schema` JSONB, как `x-rollup`;
  никакой ALTER. (Следующий свободный номер — 123, если понадобится сид демо-приложения К4, но
  это не часть ядра задачи — O-scope.)

## 4. Отвергнутые альтернативы

- **A1. `new Function(expr)` / безопасный-eval с sandboxed-scope.** ОТВЕРГНУТО: инъекция кода = P0
  (NF-1). Любой `Function`-путь исполняет произвольный JS; «песочница» через `with`/прокси —
  хрупкая и обходимая (`constructor.constructor`). Собственный AST-обход — единственный контракт
  без исполнения пользовательского кода.
- **A2. Готовая npm-либа (expr-eval, mathjs, jsep).** ОТВЕРГНУТО: нарушает zero-dep
  (`pg-single-dep.sh`, deps={ajv,pg}); mathjs тянет `eval`-подобные пути и мегабайты; добавление
  либы в чистое ядро противоречит конвенции. Грамматика v1 крошечная (арифметика+2 дата-правила) —
  Pratt-парсер ~150 строк дешевле аудита сторонней либы на инъекцию.
- **A3. Хранить/материализовать результат формулы в `record.data`.** ОТВЕРГНУТО: ломает PD-20
  (derived НИКОГДА не в data; на этом стоит no-rollup-of-rollup и честная null-семантика). Расчёт
  на READ + оверлей в переменные — уже работающий контур; материализация добавила бы инвалидацию
  кэша при правке зависимых полей (класс багов).
- **A4. Новый тип поля `formula` рядом с `computed`.** ОТВЕРГНУТО: computed уже = «вычисляемое,
  read-only, не в data, единый readout-рендерер». Формула — второй флейвор ТОЙ ЖЕ семантики
  (как `rollup` vs `rollup-embedded` уже сосуществуют под `x-rollup`). Новый тип раздул бы
  FIELD_TYPES, форм-контракт, list-cell-рендерер без выгоды.
- **A5. SQL-вычисление формулы в БД (как rollup GROUP BY).** ОТВЕРГНУТО: rollup идёт в БД, потому
  что агрегирует ДРУГИЕ строки; скаляр-формула оперирует полями ЭТОЙ записи (уже в памяти) —
  как `computeEmbeddedRollup`. Гнать выражение в SQL = интерполяция пользовательского выражения в
  запрос (SQL-инъекция, тот же класс P0) + потеря чистого юнит-тестируемого ядра. Считаем в TS.
- **A6. Плоский `Promise.all` для формул (как сейчас для derived).** ОТВЕРГНУТО: формула на
  формулу требует порядка; параллельный проход дал бы гонку «формула видит ещё-не-посчитанную
  формулу» → недетерминизм (нарушает NF-6). Топосорт (ацикличность гарантирована авторингом) —
  детерминированный порядок.
- **A7. Разрешить `today()`/`now()` для дедлайнов от «сегодня».** ОТВЕРГНУТО в v1: нарушает
  детерминизм (NF-6) — одна запись даёт разное значение в разные дни, ломает воспроизводимость
  тестов/переменных процесса. Дедлайн v1 = дата-поле + срок-поле (обе из данных). `today()` —
  осознанный future-scope (O-1), требует отдельного решения о времени-как-входе.

Дубли / кросс-вендор: решение НЕ высоколеверажно в смысле product-loop (аддитивный примитив в
уже-построенном derived-контуре, границы из карты §A8). `escalation` пуст.

## 5. Fitness-функции (исполнимые CI-правила против дрейфа)

| ID | Правило | ci_check |
|----|---------|----------|
| FF-1 | Безопасность (P0): парсер/evaluator (`src/core/formula-*.ts`) НЕ содержат `eval(`, `new Function`, `Function(`, `require(`, `import(`, `\bvm\b`, `process.`, `globalThis`, `__proto__`, `child_process`, `constructor.constructor`, обратных кавычек с `${`. | `bash ci/checks/formula-evaluator-isolation.sh` (grep-denylist над `src/core/formula-*.ts` + web-копией; хит=exit 1) + `--self-test` (плантует `new Function` — детектор срабатывает) |
| FF-2 | Чистота ядра: `formula-*.ts` не импортирует `pg`/`node:*`, не читает `process.env`, импортирует ТОЛЬКО из `src/core/`. | `formula-evaluator-isolation.sh` (тот же скрипт, import-скан — зеркало `cross-app-refs-isolation.sh` CA1) + периметр `no-env-in-core.sh`/`pg-single-dep.sh` |
| FF-3 | Zero-dep: `package.json` `dependencies` остаётся ровно `{ajv, pg}` — ни expr-eval/mathjs/jsep. | `pg-single-dep.sh` (существует; расширить allowlist-ассерт при необходимости) |
| FF-4 | Анти-кейс D-064: диф не добавляет бизнес-констант (ставка НДС `0.2`/`20`, имена демо-полей) в `src/`/`web/src/` сверх baseline. | `bash ci/checks/anti-case-lock.sh` (baseline не растёт) |
| FF-5 | Инъекция отвергается (юнит): `parseFormula` над строками `process.exit(1)`, `require('fs')`, `constructor.constructor(...)`, `a;b`, `${x}`, `__proto__`, `a.b` → `{ok:false}`; ни один не исполняется. | `vitest run src/core/__tests__/formula-parser.test.ts -t "injection rejected"` (AC-6) |
| FF-6 | Арифметика+приоритет+унарный (юнит): `100000*(1+0.2)`→120000; `2+3*4`→14; `(2+3)*4`→20; `-a+b`. | `vitest run src/core/__tests__/formula-eval.test.ts -t "arithmetic"` (AC-3) |
| FF-7 | Дата-семантика (юнит): `date+30`→ISO+30дн; `date−date`→дни (целое); `date+date`/`date*2` → тайп-ошибка. | `vitest run src/core/__tests__/formula-eval.test.ts -t "date"` (AC-4) |
| FF-8 | Ошибки расчёта (юнит): null-операнд → результат null (не 0); `/0`→null (не Infinity/NaN/throw); нечисло→null. | `vitest run src/core/__tests__/formula-eval.test.ts -t "null and div-by-zero"` (AC-5) |
| FF-9 | Валидация авторинга (юнит): несуществующее поле/недопустимый тип/цикл(`a=b+1,b=a+1`)/самоссылка/пустая формула → отказ. | `vitest run src/core/__tests__/formula-typecheck.test.ts` + `formula-cycles.test.ts` (AC-7) |
| FF-10 | Лимиты (юнит): строка >500 / глубина AST >32 / >32 ссылок → отказ авторинга; порченая переглубокая AST на расчёте → null (не stack overflow). | `vitest run src/core/__tests__/formula-limits.test.ts` (AC-8) |
| FF-11 | Дискриминация флейворов (юнит): `extractDerivedFields` над `x-formula` → `kind:"formula"`; над `x-rollup` → прежнее; ОБА на одном свойстве → skip/невалидно. | `vitest run src/__tests__/rollup-contract.test.ts -t "formula flavor"` (AC-12) |
| FF-12 | Round-trip авторинга (web юнит): `buildRecordSchema` формула-режим → `x-formula`; `parseRecordSchema` восстанавливает режим+expr; rollup round-trip не сломан. | `vitest run web/src/screens/apps-schema.test.js -t "formula"` (AC-13) |
| FF-13 | Регрессия rollup: существующие computed(rollup)-тесты зелёные без правки. | `vitest run src/__tests__/rollup-contract.test.ts web/src/screens/apps-schema.test.js web/src/screens/records-form*.test.js` (AC-14) |
| FF-14 | Интеграция (fitness:db, живой PG): запись с формула-полем на READ → корректное значение в `derived`-map; формула в `field_mapping` on_create → вычислена в переменных процесса (не undefined). | `vitest run --dir ci/checks/db ci/checks/db/formula-derived.db.test.ts` (lane `fitness:db`; AC-15) |
| FF-UX-1 | Редактор формулы: kit-токены (нет hardcode цветов), контраст обеих тем, честные Empty/Loading/Error, без dev-жаргона (`AST`/`eval`/`parse error`), бейдж≡контент. | `bash ci/checks/ux/ux-g6-no-new-hardcode.sh && bash ci/checks/ux/ux-g2-theme-pairing.sh && bash ci/checks/ux/ux-g5-jargon-denylist.sh` над `screen-app-schema.jsx` (G-гейт, D-062/OBLIK) |

## 6. Трассировка AC → покрытие

| AC | covered_by |
|----|------------|
| AC-1 | §2.3/§2.4 x-formula+derived-контур; живой стенд; FF-14 (data-путь) |
| AC-2 | §2.2 дата-семантика; FF-7; живой стенд |
| AC-3 | §2.1 грамматика + §2.5 evalFormula; FF-6 |
| AC-4 | §2.2 типовая таблица; FF-7 |
| AC-5 | §2.5 null-распространение/div0→null; FF-8 |
| AC-6 | §2.1 закрытый токен-алфавит + §2.5; FF-1/FF-5 |
| AC-7 | §3 typeCheckFormula + detectFormulaCycles; FF-9 |
| AC-8 | §2.5 лимиты (авторинг+расчёт); FF-10 |
| AC-9 | §2.5 нет eval/Function; FF-1 |
| AC-10 | §2/§3 чистое ядро; FF-2 |
| AC-11 | §1/§4 zero-dep + D-064; FF-3/FF-4 |
| AC-12 | §2.3 взаимоисключение + §3 extractDerivedFields; FF-11 |
| AC-13 | §2.6/§3 web round-trip; FF-12 |
| AC-14 | §2 аддитивность (rollup не тронут); FF-13 |
| AC-15 | §2.4 контур derived на READ+старте; FF-14 |

## 7. Совместимость public-поверхности / схемы (импортёры как контракт)

- **`DerivedFieldSpec`** (`rollup-contract.ts:214`) — РАСШИРЯЕТСЯ вариантом `formula` (union add).
  Импортёры: `derived-fields-dao.ts` (диспетчер — обязан обработать новый `kind`, иначе TS-`never`
  поймает), `records.ts` (потребляет map — прозрачно). Расширение union аддитивно; `switch` по
  `kind` в `computeAllDerivedFields` получает новую ветку. Ни один существующий вызов не ломается.
- **`DerivedFieldMap`** (`derived-fields-dao.ts:78`) — тип значения РАСШИРЯЕТСЯ
  `number | null` → `number | string | null` (формула-дата = ISO-строка). Импортёры: `records.ts`
  сериализует map в JSON as-is (строка проходит), клиентский рендер `derived[key]` (форма/список)
  отображает строку-дату как есть (нужен date-формат в readout-ячейке — web-задача BUILD, не ломает
  число). Это ЕДИНСТВЕННОЕ расширение типа — перечислено как контракт совместимости (правило 7).
- **`extractDerivedFields`** — сигнатура не меняется; добавляет распознавание `x-formula` (+ отказ
  при `x-formula`+`x-rollup` вместе). Существующие схемы без `x-formula` → тот же результат.
- **`computed`-поле в форме/списке** (`records-form.js`, `apps-schema.js`) — computed уже
  read-only, не-required, не-в-data; формула-режим наследует эти инварианты (никакой новый write-путь).
- **`x-formula`** — новый `x-`-ключ; `stripXExtensions` (generic) уже срезает перед AJV → **никакой
  правки AJV-strict / record-schema-validator whitelist**. Персистится в `record_schema` JSONB.

## 8. Runtime / deploy-таргет

Сервер (Node, тот же процесс, что READ/старт). Ядро (`src/core/formula-*.ts`) — чистое, без БД/сети.
web-редактор — статический бандл. **Внешних ресурсов НЕТ**: без миграций (x-formula = JSONB-данные),
без новых сервисов, без секретов, без сети. GT-4 (провижн фаундера) НЕ требуется.

## 9. Границы (что эта задача НЕ делает)

Функции-встроенки/`today()`/агрегаты-в-формуле (O-1) — future. Строки/relation-операнды,
форматирование вывода (O-2). Кросс-записевые формулы (O-3) = rollup/relation-контур. Материализация
в data (O-4). Единицы времени кроме дней (O-6). Формула как условие шлюза/DMN (O-7) — T-0524-контур.
Автодополнение (O-5) — по возможности, не блокер. Демо-приложение К4 (миграция-сид 123) — вне ядра.
