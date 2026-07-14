# T-0145 · ADR: счётчик таблиц known_tenant_tables.txt без хардкода

## Контекст

Блок `FF-5 / AC-19` в `ci/checks/db/grant-editor.test.ts` проверяет реестр
`ci/checks/known_tenant_tables.txt` статической проверкой:

```ts
expect(lines.length, '...').toBe(29);
```

Задача T-0120 (invoke_proposal) добавила в реестр 30-ю строку — тест стал красным
в `db`-тире. Каждое последующее добавление таблицы будет создавать конфликт
«кто синхронизирует число»: реестр обновляется в одной задаче, а тест — в другой.

## Разграничение CI-тиров

### Почему `npm test` / `vitest run` не видит этот тест

`vitest.config.js` явно исключает `ci/checks/db/**`:

```js
exclude: [
  ...configDefaults.exclude,
  '.claude/**',
  'web/**',
  '../choros-wt/**',
  'ci/checks/db/**',   // ← db-зонд исключён из ambient vitest run
],
```

Причина: принцип D-056 «integration-honest gate» — тесты в `ci/checks/db/`
требуют живого Postgres (`withClient` / `migratorUrl`), и смешивать их
с unit-прогоном запрещено, чтобы ambient-free `ci` job оставался зелёным без БД.

### В каком CI-тире гоняется `grant-editor.test.ts`

Тест выполняется только в **`db` job** (`npm run fitness:db`):

```yaml
# .github/workflows/ci.yml — job db
- run: npm run fitness:db
```

Команда: `vitest run --dir ci/checks/db --no-file-parallelism`

Локальный эквивалент:
```bash
DATABASE_URL=... npm run fitness:db
```

> **Примечание:** хотя блок `FF-5` сам не использует `withClient` / `DATABASE_URL`,
> он живёт в `ci/checks/db/` и запускается только через `fitness:db`. Это
> сделано намеренно: весь каталог — одна «db-зона». Блок FF-5 остаётся
> чисто статическим (без Postgres), но вынесен из ambient-прогона в соответствии
> с каталожной принадлежностью.

## Рассмотренные варианты

### Вариант A — `toBeGreaterThan(0)` (предложение аналитика)

```ts
expect(lines.length, '...').toBeGreaterThan(0);
```

**Оценка:** счётчик динамический (не хардкод), но инвариант деградирует.
Тест стал бы зелёным даже при реестре из одной строки, пустом или
урезанном. Смысл FF-5 — «реестр читается, структурирован и
содержит критически важные таблицы»; `>0` даёт слабую гарантию, почти ноль.
Сам файл можно случайно перезаписать одной строкой — тест не поймает это.

**Вывод: отклонён.** Инвариант теряется без реального выигрыша.

### Вариант B — `lines.length` сверять с parsed-структурой из файла (источник сам = авторитет)

```ts
// lines уже прочитаны из файла — длина выводится из него же
expect(lines.length).toBeGreaterThan(0);   // только «файл непустой»
expect(lines).toContain('grant');
expect(lines).toContain('invoke_proposal');
// ... остальные точечные guard-и
```

Файл прочитан один раз (`readFileSync`), `lines.length` — это и есть
«реестр говорит сам за себя». Добавление строки в txt не требует
трогать тест. Структурная целостность («каждая критическая таблица
присутствует») гарантируется набором `toContain`.

**Итог совмещения A и B:** `toBeGreaterThan(0)` нужен только как «файл прочитан
и непуст». Реальный инвариант — набор `toContain`-проверок обязательных таблиц.

## Решение

**Убрать `toBe(29)`; заменить на `toBeGreaterThan(0)` + расширить набор `toContain`.**

Конкретно:

1. `expect(lines.length).toBeGreaterThan(0)` — минимальный guard «файл прочитан,
   не пуст», без хардкода числа.
2. Добавить `expect(lines).toContain('invoke_proposal')` — таблица уже в реестре
   с T-0120, но не была покрыта точечным тестом (пробел).
3. Обновить `describe`/`it`-заголовки: убрать число `29`, заменить `unchanged`
   на `is well-formed`.
4. Обновить шапочный комментарий `FF-5`: «known_tenant_tables file is well-formed
   (static; count from file)».

**Инвариант «реестр = схема»** остаётся в `schema.test.ts` (live Postgres,
`FF-RLS anti-decorative`) без каких-либо изменений.

**Разграничение ответственностей после фикса:**

| Тест | Что проверяет | Требует БД? |
|---|---|---|
| `grant-editor.test.ts` FF-5 (после) | Файл читаем, непуст, содержит обязательные таблицы | Нет (статический) |
| `schema.test.ts` FF-RLS | Каждая таблица реестра = таблица в DB и наоборот | Да (live Postgres) |

## Fitness-критерии

| ID | Правило | CI-проверка |
|---|---|---|
| FF-T145-1 | В `grant-editor.test.ts` отсутствует `toBe(29)` (и любой `toBe(<число>)` в контексте длины реестра); блок FF-5 использует `toBeGreaterThan(0)` | `bash ci/checks/invoke-grant-isolation.sh` (grep-based) + `npm run fitness:db` |
| FF-T145-2 | `invoke_proposal` включён в `toContain`-набор FF-5 | `npm run fitness:db` |
| FF-T145-3 | Добавление новой строки в `known_tenant_tables.txt` не требует правки теста (файл читается динамически) | Ручная проверка при имплементации AC-1: прогон до и после добавления строки-фиктивной записи |
| FF-T145-4 | Блок FF-5 не содержит `withClient`, `migratorUrl`, `information_schema` (чисто статический) | `npm run fitness:db` (grep по файлу) |
| FF-T145-5 | Все остальные describe-блоки `grant-editor.test.ts` (FF-1/2/7/8/10, AC-01..20) не изменены | `npm run fitness:db` (полный прогон) |
| FF-T145-6 | `tsc --noEmit`, `eslint src`, `npm run fitness`, `vitest run` зелёные после коммита | `npm run ci` |

## Трассировка к AC

| AC | Покрывает |
|---|---|
| AC-1 | FF-T145-1 + FF-T145-3: `toBeGreaterThan(0)` не привязан к конкретному числу |
| AC-2 | FF-T145-2 + набор `toContain`: удаление любой точечной таблицы из txt → красный |
| AC-3 | FF-T145-4: grep-фитнес на отсутствие `withClient`/`information_schema` в FF-5 |
| AC-4 | FF-T145-1: grep-фитнес на отсутствие `toBe(29)` |
| AC-5 | FF-T145-2: `toContain('invoke_proposal')` добавлен |
| AC-6 | FF-T145-5: все остальные блоки untouched, подтверждается полным `fitness:db` прогоном |

## Out of scope

- `schema.test.ts`, `_helpers.ts`, `known_tenant_tables.txt` — не трогать.
- Новые live-DB проверки в FF-5.
- Перенос FF-5 в другой файл.
- Любые изменения вне `ci/checks/db/grant-editor.test.ts`.
