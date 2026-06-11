# T-0145 · grant-editor.test.ts: счётчик таблиц выводить из known_tenant_tables.txt

## Контекст

`ci/checks/db/grant-editor.test.ts` содержит блок FF-5 / AC-19, который статически (без live-DB)
читает `ci/checks/known_tenant_tables.txt` и сверяет длину списка с хардкодом:

```ts
expect(lines.length, '...').toBe(29);
```

Реестр уже содержит **30 записей** (добавлена `invoke_proposal` — задача T-0120/invoke-grant).
При каждом добавлении таблицы задачи-сёстры конфликтуют на этом числе: реестр обновляется,
а тест падает, пока не будет вручную исправлен синхронно.

`schema.test.ts` уже делает **live** сверку реестра со схемой Postgres (через `KNOWN_TENANT_TABLES`
из `_helpers.ts`) — это и есть «реестр = схема» инвариант при наличии БД.
FF-5 в `grant-editor.test.ts` дублирует лишь статический счётчик: ценность «нельзя добавить таблицу
без правки теста» теперь несут `schema.test.ts` (live) и CI-линт `pg-single-dep.sh`.

## Цель задачи

Убрать хардкод `toBe(N)` из FF-5, заменив его динамическим чтением длины файла через тот же
`readFileSync`-путь, который уже используется в блоке. Инвариант «реестр = файл» остаётся,
`toContain`-проверки точечных таблиц сохраняются.

## Разграничение ролей тестов

| Тест | Что проверяет | Требует БД? |
|---|---|---|
| `grant-editor.test.ts` FF-5 (после фикса) | Реестр читается, содержит обязательные точечные таблицы | Нет (статический) |
| `schema.test.ts` FF-RLS anti-decorative | Каждая таблица в реестре есть в DB и наоборот | Да (live Postgres) |

FF-5 **не** дублирует `schema.test.ts`: он не обращается к `information_schema`, не хранит счётчик.

## Что менять

**Файл:** `ci/checks/db/grant-editor.test.ts`

**Блок FF-5 / AC-19** (строки ~98–114):

*До:*
```ts
describe('FF-5 / AC-19 (static): known_tenant_tables.txt unchanged', () => {
  it('has exactly 29 entries (28 pre-T-0035 incl. agent_card + 4 budget tables + T-0035 substitution_rule)', () => {
    const content = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    );
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines.length, 'known_tenant_tables.txt must have exactly 29 entries').toBe(29);
    expect(lines).toContain('grant');
    ...
    expect(lines).toContain('substitution_rule');
  });
});
```

*После:*
```ts
describe('FF-5 / AC-19 (static): known_tenant_tables.txt is well-formed', () => {
  it('can be read and contains required tables; count derived from file, not hardcoded', () => {
    const content = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    );
    const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    // Count comes from the file itself — no hardcode.
    // Live registry ↔ DB equality is enforced by schema.test.ts (FF-RLS).
    expect(lines.length, 'known_tenant_tables.txt must be non-empty').toBeGreaterThan(0);
    // Point-table guards: adding a table MUST update the registry.
    expect(lines).toContain('grant');
    expect(lines).toContain('role_assignment');
    expect(lines).toContain('instance_budget');
    expect(lines).toContain('agent_budget');
    expect(lines).toContain('reservation');
    expect(lines).toContain('spend_ledger');
    expect(lines).toContain('substitution_rule');
    expect(lines).toContain('invoke_proposal');
  });
});
```

Комментарий в шапке файла: `FF-5  — known_tenant_tables file is well-formed (static; count from file)`.

**Больше никаких изменений не требуется.**  
Файлы `schema.test.ts`, `_helpers.ts`, `known_tenant_tables.txt` — **не трогать**.

## Поведение без live-DB

Блок FF-5 не использует `withClient` / `migratorUrl`. Он чисто статический — читает файл через
`readFileSync`. Поведение без Postgres идентично поведению с Postgres: тест проходит / падает
вне зависимости от наличия `DATABASE_URL`. Это существующий дизайн — сохраняется без изменений.

## Acceptance criteria

| ID | Текст | Как проверяется |
|---|---|---|
| AC-1 | Добавление строки в `known_tenant_tables.txt` не требует правки теста FF-5 | Тест запускается до и после добавления строки-фиктивной записи в txt; оба раза зелёный | `test` |
| AC-2 | Тест FF-5 падает, если в реестре присутствует точечная таблица (из `toContain`-набора) — убрать её из txt → красный | `test` |
| AC-3 | Тест FF-5 не обращается к `information_schema` или `DATABASE_URL` (чисто статический) | `fitness` (grep: отсутствие `withClient`/`information_schema` в блоке FF-5) |
| AC-4 | Шапка файла обновлена: `FF-5` описывает «file is well-formed», не «count unchanged» | `fitness` (grep: отсутствие `toBe(29)` или любого `toBe(<number>)` в FF-5 блоке) |
| AC-5 | `invoke_proposal` добавлен в `toContain`-набор FF-5 (таблица уже есть в реестре, а раньше не была покрыта точечным тестом) | `test` |
| AC-6 | Все остальные тесты в `grant-editor.test.ts` (FF-1, FF-2, FF-7, FF-8, FF-10, AC-01..AC-20) остаются без изменений | `test` |

## Out of scope

- Изменения в `schema.test.ts`, `_helpers.ts`, `known_tenant_tables.txt`
- Добавление новых live-DB проверок в FF-5
- Перенос FF-5 в другой файл
- Любые изменения вне `ci/checks/db/grant-editor.test.ts`
