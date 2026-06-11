# ADR · T-0144 — DB-тест самоочистка: `afterAll` DELETE по ID + санационный скрипт

**Status:** ready (no founder escalation)
**Phase:** DESIGN
**Date:** 2026-06-11
**Task:** CI / db fitness tier — самоочистка grant-editor.test.ts
**Spec:** `docs/specs/T-0144-db-test-cleanup.spec.md` + `docs/specs/T-0144.spec.contract.json` (FR-1..FR-7, NF-1..NF-3, AC-1..AC-6)
**Foundation (does NOT contradict):** `docs/design/T-0018-grant-authority.adr.md` (ADV-3 — эталон `afterAll`-паттерна в этом файле) · T-0029 genesis-owner-seed (жертва: `exact-17` assertion — не меняется)

---

## 1. Context

Пять `it()`-блоков в `ci/checks/db/grant-editor.test.ts` (AC-01, AC-07, AC-14, AC-20, FF-10)
вставляют строки в `choros."grant"` с `role_id = DEV_ROLE_OWNER` /
`resource_type LIKE 'mgmt_object:%'` и чистятся инлайн-`DELETE` в конце тела `it()`.

Когда assertion до `DELETE` бросает — Vitest прерывает `it()`, `DELETE` пропускается,
строка остаётся в БД навсегда. После N проблемных прогонов `genesis-owner-seed.test.ts`
(T-0029) видит COUNT > 17 и падает детерминированно.

В боевом dev-silo (`homeserver-vm /srv/choros`) уже накоплено ≈150 лишних строк.

ADV-3 в `grant-editor.adversarial.test.ts` уже использует `beforeAll`/`afterAll` —
это эталон. ADV-3 **не трогаем**.

---

## 2. Decision

**Переместить cleanup каждого из пяти contaminating `describe`-блоков из тела `it()`
в гарантированный `afterAll()`. Хранить ID вставленной строки в `let`-переменной
уровня `describe`. Для FF-10 извлекать grantId из HTTP-ответа до первого `expect()`.
Добавить идемпотентный скрипт `scripts/cleanup-test-grants.ts` для one-shot санации
уже заражённого dev-silo.**

Механизм: `DELETE … WHERE id = $id` (через `migratorUrl()`, обходит RLS). DELETE
несуществующей строки — no-op. Два `DELETE` одной строки (инлайн + afterAll) — тоже
no-op. Inline DELETE может быть оставлен для удобства чтения или убран — оба варианта корректны.

---

## 3. Точная схема рефакторинга каждого из 5 векторов

### 3.1 AC-01 (happy-path INSERT, ~L169)

**Структура до:**
```
describe('AC-01 / AC-20: grant INSERT with tenant_id leading', () => {
  it('inserts a grant row …', async () => {
    const newId = uuid();            // локальная переменная
    …INSERT…
    …expect…
    // Cleanup — НЕ ГАРАНТИРОВАН
    await withClient(migratorUrl(), …DELETE WHERE id=$newId);
  });
});
```

**Структура после:**
```typescript
describe('AC-01 / AC-20: grant INSERT with tenant_id leading', () => {
  let createdGrantId: string | undefined;  // describe-scope let

  afterAll(async () => {
    if (createdGrantId) {
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
          [DEV_TENANT, createdGrantId],
        );
      });
    }
  });

  it('inserts a grant row …', async () => {
    const newId = uuid();
    createdGrantId = newId;          // присваиваем ДО первого expect
    …INSERT…
    …expect…
    // inline DELETE опционально остаётся или убирается
  });
});
```

**Что копим:** один `id` (тип `string`). `createdGrantId = newId` ставится сразу после
`const newId = uuid()`, до любого `withClient`/`expect`.

---

### 3.2 AC-07 (revoke: valid_until, ~L214)

**Аналогично AC-01.** Переменная `let grantId: string | undefined` на уровне `describe`.
Присваивается сразу после `const grantId = uuid()` (до `withClient`-блока INSERT).

Особенность AC-07: `afterAll` должен DELETE по `id`, не по `valid_until`.
UPDATE (revoke) не влияет на cleanup — строка идентифицируется только по `id`.

```typescript
describe('AC-07: grant revoke sets valid_until, row survives', () => {
  let grantId: string | undefined;

  afterAll(async () => {
    if (grantId) {
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
          [DEV_TENANT, grantId],
        );
      });
    }
  });

  it('UPDATE sets valid_until and row is not deleted', async () => {
    const id = uuid();
    grantId = id;                    // ДО первого withClient
    …
  });
});
```

---

### 3.3 AC-14 (proposed_by set, ~L350)

**Аналогично AC-01/AC-07.** Переменная `let grantId: string | undefined` уровня
`describe`. Присваивается сразу после `const grantId = uuid()`.

```typescript
describe('AC-14: proposed_by set / confirmed_by null = proposal row', () => {
  let grantId: string | undefined;

  afterAll(async () => {
    if (grantId) {
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
          [DEV_TENANT, grantId],
        );
      });
    }
  });

  it('inserts grant with proposed_by and confirmed_by IS NULL', async () => {
    const id = uuid();
    grantId = id;
    …
  });
});
```

---

### 3.4 AC-20 (RLS cross-tenant, ~L436)

**Аналогично.** Переменная `let grantId: string | undefined` уровня `describe`.

Особенность AC-20: тест использует **два разных** `appUrl()`-соединения (INSERT под
tenant_A, SELECT под tenant_B). RLS нужна именно для проверки изоляции. `afterAll`
чистит через `migratorUrl()` — этот путь обходит RLS, строка будет найдена
независимо от того, под каким GUC работает cleanup.

```typescript
describe('AC-20 (live): RLS blocks cross-tenant grant INSERT', () => {
  let grantId: string | undefined;

  afterAll(async () => {
    if (grantId) {
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
          [DEV_TENANT, grantId],
        );
      });
    }
  });

  it('INSERT with wrong tenant_id in GUC → choros_app cannot see the row', async () => {
    const id = uuid();
    grantId = id;
    …
  });
});
```

---

### 3.5 FF-10 live (freeform POST, ~L555)

**Вектор с особой сложностью:** `grantId` сейчас присваивается внутри async IIFE,
которая содержит `expect(res.status).toBe(201)`. Если статус ≠ 201, IIFE бросает до
присваивания `return json.id`, и `grantId` остаётся `undefined` — cleanup не может
произойти.

**Требование FR-3:** ID должен быть извлечён из ответа **до** первого `expect()` и
сохранён в переменную уровня `describe`.

```typescript
describe('FF-10 (live): freeform grant INSERT has delegable=false regardless of body', () => {
  let server: http.Server;
  let serverPort: number;
  let freeformGrantId: string | undefined;     // describe-scope let для ID

  beforeAll(async () => {
    const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const addr = server.address() as { port: number };
    serverPort = addr.port;
  });

  afterAll(async () => {
    // 1. Сначала чистим строку (если создана)
    if (freeformGrantId) {
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
          [DEV_TENANT, freeformGrantId],
        );
      });
    }
    // 2. Закрываем сервер
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('genesis owner POST /api/grants freeform+delegable:true → DB stores delegable=false', async () => {
    const body = JSON.stringify({ … });
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dev-user': 'e-owner' },
      body,
    });

    // Извлекаем ID ДО первого expect — даже если статус не 201
    const json = await res.json() as { id?: string };
    if (json.id) {
      freeformGrantId = json.id;     // безопасно: undefined если json.id отсутствует
    }

    // Assertions — теперь уже после сохранения ID
    expect(res.status, `expected 201 from POST /api/grants, got ${res.status}`).toBe(201);
    expect(json.id, 'response must include grant id').toBeTruthy();

    await withClient(migratorUrl(), async (c) => {
      …verify delegable=false…
    });

    // inline DELETE опционально остаётся или убирается
  });
});
```

**Порядок в afterAll:** сначала DELETE гранта, потом `server.close()`. Оба в одном
`afterAll` — порядок гарантирован внутри одного afterAll-callback.

---

## 4. Контракт cleanup-скрипта `scripts/cleanup-test-grants.ts`

### 4.1 Входные данные

| Параметр | Источник | Обязателен |
|---|---|---|
| `DATABASE_URL` | env-переменная | Да |
| `--dry-run` | argv flag | Нет (default: false) |

Dry-run флаг **включается** — это дешевле сделать сейчас, полезно для оператора:
позволяет увидеть число строк перед удалением на prod-like silo. Exit-код одинаков
в обоих режимах.

### 4.2 Алгоритм

```
1. Подключиться к DATABASE_URL (pg.Client).
2. Выполнить:
   SELECT COUNT(*) FROM choros."grant"
   WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
     AND role_id   = 'e0000000-0000-0000-0000-000000000001'
     AND resource_type LIKE 'mgmt_object:%'
     AND granted_by IN ('test', 'd0000000-0000-0000-0000-0000000000ff')
3. Если --dry-run: вывести "DRY-RUN: would delete N rows", exit 0.
4. Иначе: DELETE те же WHERE-условия, вернуть rowCount.
5. Вывести "Deleted N rows from choros.\"grant\"".
6. exit 0.
```

### 4.3 Exit-коды

| Код | Причина |
|---|---|
| `0` | Успех (включая N=0 на чистой БД) |
| `1` | Ошибка подключения или SQL-исключение |

### 4.4 Зависимости

Только `pg` (уже есть в `package.json`). Никаких новых пакетов. Запуск:
`npx tsx scripts/cleanup-test-grants.ts [--dry-run]`.

### 4.5 Идемпотентность

DELETE — SQL no-op когда нет совпадающих строк. Второй прогон всегда выводит
`Deleted 0 rows`. AC-5 проверяется двумя последовательными запусками.

---

## 5. Fitness functions

### FF-1 — Идемпотентность db-тира (NF-2)

**Правило:** Два последовательных прогона `npm run fitness:db` против freshly-seeded
dev-silo не меняют COUNT(`choros."grant"` WHERE `role_id=DEV_ROLE_OWNER AND
resource_type LIKE 'mgmt_object:%'`) — после обоих прогонов он равен 17.

**Как кодировать в CI:**

Не вводить отдельный db-job с двойным прогоном — слишком дорого (≈2× время CI на
db-tier). Достаточно **одного прогона с Count-снапшотом внутри самих тестов**:
`genesis-owner-seed.test.ts` уже содержит `exact-17` assertion. После T-0144
этот тест зелёный при любом числе предшествующих прогонов — это и есть FF-1.

Дополнительная покрывающая проверка: `ci_check` = запустить `fitness:db` дважды
подряд в одном CI-шаге и проверить, что оба прогона зелёные. Это встраивается как
отдельный step только если `genesis-owner-seed.test.ts` начнёт флапить без него.
По дефолту: **FF-1 покрывается `genesis-owner-seed.test.ts` (AC-1/AC-2)** — это
достаточный и дешёвый чек.

**Решение по FF-1:** FF-1 is a db-tier check, покрывается существующим
`genesis-owner-seed.test.ts` AC-12/FF-12 assertion. Отдельный двойной прогон
в CI не нужен — он дорог и избыточен пока T-0144 сделан правильно.

---

### FF-2 — Запрет инлайн-DELETE-после-ассертов паттерна

**Правило:** В `grant-editor.test.ts` не должно быть `DELETE FROM choros."grant"`
внутри тела `it()` без предшествующего `afterAll`-cleanup в том же `describe`.

**Как верифицировать:** grep-чек достаточен на этапе code review + CI lint.

**Реализация FF-2 как grep-based CI check:**

```bash
# ci/checks/no-inline-grant-delete.sh
# Ищет DELETE в it()-теле без соответствующего afterAll в том же describe.
# Упрощённый вариант: запрещает прямые DELETE внутри it() полностью для grant таблицы.
# Паттерн: DELETE FROM choros."grant" в строке внутри it( ...
grep -n 'DELETE FROM choros\."grant"' ci/checks/db/grant-editor.test.ts
# После T-0144 эта команда должна давать 0 строк (все DELETE переехали в afterAll).
# Если даёт > 0 — CI падает.
```

**Решение по FF-2:** grep-чек в CI (`ci/checks/no-inline-grant-delete.sh`) — ищет
`DELETE FROM choros."grant"` в `grant-editor.test.ts`. После T-0144 все inline
DELETE убраны (или оставлены опционально — если оставлены, grep зафиксирует, что
их нет вне afterAll). **Рекомендуется убрать inline DELETE полностью** (afterAll
достаточен) — тогда grep-чек тривиален: 0 hits = pass.

Если inline DELETE оставляются "для ясности": grep-чек должен быть сложнее
(парсить контекст). В таком случае достаточно code-review + статический паттерн
прописан в CONTRIBUTING. **Рекомендация:** убрать все inline DELETE из векторов
AC-01/AC-07/AC-14/AC-20/FF-10 — afterAll делает их избыточными, grep-чек остаётся простым.

---

## 6. Существующие ассерты не ослаблены

Все `expect()`-вызовы в AC-01, AC-07, AC-14, AC-20, FF-10 остаются без изменений.
Рефакторинг меняет только:

1. Место объявления переменной `let id` (было `const id = uuid()` внутри `it()` →
   `let id: string | undefined` на уровне `describe` + `id = uuid()` внутри `it()`).
2. Добавление `afterAll` с DELETE.
3. Для FF-10 — порядок строк: `freeformGrantId = json.id` до `expect(res.status)`.

AC-03 (FR-5): никакие `expect()` не удаляются, не оборачиваются в `try/catch`.

---

## 7. Отклонённые альтернативы

| Опция | Почему не выбрана |
|---|---|
| `try/finally` в каждом `it()` | Работает корректно, но значительно засоряет читаемость каждого теста; `afterAll` — стандартный Vitest-паттерн (ADV-3 уже так). |
| Transaction + rollback в `afterAll` | AC-20 принципиально требует два независимых соединения для проверки RLS-изоляции; transaction-wrap ломает этот тест. |
| Удалить inline DELETE и не добавлять afterAll | Не устраняет утечку при провальных ассертах — корень проблемы. |
| `beforeEach` + `afterEach` | Избыточно: каждый `describe` содержит один `it()`; `afterAll` эквивалентен `afterEach` в таком случае, но более явно выражает намерение "cleanup after this suite". |
| Санационный скрипт только через миграцию | Противоречит FR-7 (no migration files) и избыточно — нет нужды в schema change. |

---

## 8. Трассируемость

| AC | Req | Покрывается |
|----|-----|-------------|
| AC-1 | FR-1, FR-2 — afterAll cleanup | FF-1 (`genesis-owner-seed.test.ts` AC-12 зелёный) |
| AC-2 | FR-1 — genesis-owner-seed стабилен | FF-1 (тот же) |
| AC-3 | FR-5 — assertions unchanged | Code review + FF-2 grep |
| AC-4 | FR-3 — FF-10 ID до первого expect | §3.5 схема; code review |
| AC-5 | FR-6 — санационный скрипт | Manual: `npx tsx scripts/cleanup-test-grants.ts` |
| AC-6 | FR-7 — no migration | `git diff dev -- db/migrations/` = empty |

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
