# ADR · T-0115 — Подложка-2: Tenant RLS CI-блокер + fail-closed async

**Status:** ready (no escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** T-0115 — Блокирующий CI-тест cross-tenant-утечки от реальной app-роли (152-ФЗ-инвариант)
         + fail-closed контракт в async-путях
**Spec consumed:** `docs/specs/T-0115-tenant-rls.spec.md` (AC-1..AC-12)
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — FORCE RLS, default-DENY policy,
  NOBYPASSRLS на `choros_app`, 8 таблиц; GUC `choros.tenant_id` с `true`-missing в RLS.
- `docs/design/T-0053-postgres-compose.adr.md` — миграции 001-009, docker-compose,
  `ci/checks/db/` test infrastructure, `npm run fitness:db`.
- `docs/design/T-0114-jobstore-postgres.adr.md` — `PostgresJobStore` в
  `src/core/postgres/pgJobStore.ts`; миграция 010; `current_setting('choros.tenant_id', false)`
  в `enqueue`; `SET LOCAL` контракт в интеграционных тестах.
- `docs/design/T-0028-engine-mutation-guard.adr.md` — `complete`-путь обоих сторов, IN BUILD;
  T-0115 не трогает `complete`/`fail`-сигнатуры — шов зарезервирован за T-0028.

**Siblings (не конфликтуем):**
- T-0054 — владеет `docker-compose.yml`; T-0115 не трогает его.
- T-0028 — IN BUILD; владеет `src/core/jobStore.ts:complete` и `src/core/types.ts:result`.
  T-0115 добавляет только новый `describe`-блок в
  `ci/checks/db/pgJobStore.integration.test.ts` — additive, никаких конфликтов по символам.

---

## 1. Контекст

T-0013/T-0053 полностью выложили RLS-фундамент (FORCE RLS, default-DENY, NOBYPASSRLS,
`choros.tenant_id` GUC, 8 таблиц). T-0114 добавил `PostgresJobStore` с
`SET LOCAL` контрактом и `current_setting('choros.tenant_id', false)` в `enqueue`.

Оставшаяся дельта T-0115: проверить этот фундамент *от лица реальной app-роли* в
блокирующем CI-тесте, плюс зафиксировать machine-verifiable fail-closed контракт для
всех async-путей.

**Ключевые факты из реального кода:**

1. `ci/checks/db/_helpers.ts` экспортирует `appUrl()`, `migratorUrl()`, `withClient()`,
   `TENANT_A`, `TENANT_B`, `KNOWN_TENANT_TABLES` (читает `ci/checks/known_tenant_tables.txt`).
2. `npm run fitness:db` = `vitest run --dir ci/checks/db` — включает все `*.test.ts` в
   `ci/checks/db/`. CI job `db` (`.github/workflows/ci.yml`) запускает `npm run fitness:db`.
3. `ci/checks/known_tenant_tables.txt` содержит 8 таблиц: `job`, `application`,
   `registry_def`, `record`, `audit_event`, `audit_head`, `grant`, `object_handle`.
4. `pgJobStore.ts:enqueue` использует `current_setting('choros.tenant_id', false)::uuid` —
   raise ERROR при отсутствии GUC.
5. `pgJobStore.integration.test.ts` уже содержит `SingleClientStore`, `runAsTenant`,
   `withTenant` — паттерны для транзакций с `SET LOCAL`. Новый describe-блок встаёт рядом.

---

## 2. Решение

**Механизм: два новых тестовых файла + один shell fitness-check.**

### Файл 1: `ci/checks/db/cross_tenant.test.ts` (НОВЫЙ)

Тест, охватывающий AC-1..AC-9. Подключается как `choros_app` через `appUrl()`.
Итерирует по `KNOWN_TENANT_TABLES` из `_helpers.ts` (анти-хардкод). Покрывает:

- **SELECT isolation (AC-1, AC-2):** все 8 таблиц; контекст TENANT_A; явный
  `WHERE tenant_id = TENANT_B` → 0; полный `SELECT tenant_id` → только TENANT_A-строки.
- **UPDATE/DELETE isolation (AC-3, AC-4):** таблица `application`; `choros_app`
  в контексте TENANT_A → 0 affected для TENANT_B-строк; верификация через migrator.
- **Post-condition integrity (AC-5):** migrator-count строк TENANT_B совпадает с seed-count.
- **Fail-closed DML без GUC (AC-6):** `INSERT INTO choros.job` с
  `current_setting('choros.tenant_id', false)::uuid` без `SET LOCAL` → Postgres error.
- **SET LOCAL scope isolation (AC-9):** GUC сброшен после COMMIT; session-level SET не
  протекает в следующую транзакцию как утечка данных.

**Seed-стратегия:** все seed-вставки выполняются через `migratorUrl()` (migrator bypasses RLS).
Верификационные SELECT после мутаций — через `migratorUrl()`. Все cross-tenant операции
запрашиваются через `appUrl()`.

**Транзакционный паттерн** (как в существующем `behavior.test.ts`):
```
withClient(appUrl(), async (c) => {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
  // ... тест ...
  await c.query('COMMIT'); // или ROLLBACK
})
```

### Файл 2: новый `describe`-блок в `ci/checks/db/pgJobStore.integration.test.ts`

Добавляет `describe('T-0115 fail-closed: async paths', ...)` в конец файла — additive,
никаких изменений существующих describe-блоков или импортов T-0028.

Покрывает:
- **AC-7:** `PostgresJobStore.enqueue` без `SET LOCAL` → Promise.reject (Postgres error
  из `current_setting('choros.tenant_id', false)`). Использует `makeAppPool()` +
  `pool.query('BEGIN')` без GUC → `store.enqueue(...)` должен throw.
- **AC-8:** `fetchAndLock` без `SET LOCAL` при сидированных джобах TENANT_A → `[]`
  (default-DENY; ни одного джоба не утекает). READ-путь — правильный fail-closed: 0 строк.

**Паттерн для AC-7:** создать `pg.Pool` как choros_app, вызвать `enqueue` БЕЗ
`BEGIN + SET LOCAL` в пуле — `enqueue` использует `pool.query(...)`, который получает
соединение без GUC; `current_setting('choros.tenant_id', false)` бросает Postgres error.
Тест ловит reject.

**Паттерн для AC-8:** seed через migrator (`withClient(migratorUrl(), ...)`), затем
`makeStore()` с appPool без GUC-обёртки → `fetchAndLock(...)` → `expect([])`.

### Файл 3: `ci/checks/cross-tenant-fitness.sh` (НОВЫЙ shell-check)

Shell-скрипт со статическими фитнес-проверками AC-10..AC-12:

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"

# AC-10: cross_tenant.test.ts читает KNOWN_TENANT_TABLES из _helpers, не хардкодит
grep -qE 'KNOWN_TENANT_TABLES' "$REPO/ci/checks/db/cross_tenant.test.ts"

# AC-11: .github/workflows/ci.yml — fitness:db запускается в db job
grep -qE 'fitness:db' "$REPO/.github/workflows/ci.yml"

# AC-12: cross_tenant.test.ts использует appUrl() для мутирующих запросов
grep -qE 'appUrl\(\)' "$REPO/ci/checks/db/cross_tenant.test.ts"
# и migratorUrl() для верификации
grep -qE 'migratorUrl\(\)' "$REPO/ci/checks/db/cross_tenant.test.ts"
```

Скрипт включается в `npm run fitness` (список bash-скриптов в `package.json`).

---

## 3. Отвергнутые альтернативы

| Опция | Почему нет |
|---|---|
| **Добавить cross-tenant тест в `behavior.test.ts`** | `behavior.test.ts` покрывает FF-DENY/FF-SCOPE/FF-APPEND. Cross-tenant — отдельный инвариант (152-ФЗ): требует 2 тенанта, итерации по всем таблицам, верификации через migrator. Смешивание делает behavior.test.ts монолитным и нарушает single-concern принцип. |
| **Отдельные тесты для каждой таблицы вместо цикла** | AC-10 явно требует итерации по `known_tenant_tables.txt`. Хардкод — архитектурный drift: новая таблица добавляется в миграцию и молчаливо выпадает из CI. |
| **Тест через migrator вместо choros_app** | NF-2: только `choros_app` несёт 152-ФЗ-инвариант. Migrator — superuser, FORCE RLS применяется к нему как к владельцу таблицы; он НЕ проверяет сценарий реальной атаки. |
| **DDL-изменения (новые политики/функции)** | T-0013/T-0053 уже выложили полный фундамент. `current_setting('choros.tenant_id', false)` в DML уже есть в `pgJobStore.ts:enqueue`. Добавление DDL выходит за scope и создаёт риск конфликта миграций. |
| **Объединить AC-7 и AC-6 в один тест** | AC-6 — чистый SQL без store-слоя (проверяет поведение Postgres/GUC напрямую). AC-7 — проверяет store-контракт (`PostgresJobStore.enqueue`). Разные уровни; объединение скрывает конкретный failing layer. |
| **Миграция 011+ для T-0115** | Спека явно гласит: T-0115 не добавляет колонок/политик/таблиц. DDL-фундамент завершён. Резервирование номеров миграций 011+ не требуется для этого прогона. |

---

## 4. Объектная модель

### 4.1 Новые файлы

| Файл | Тип | Владелец T-0115 |
|---|---|---|
| `ci/checks/db/cross_tenant.test.ts` | Vitest integration test | да |
| `ci/checks/cross-tenant-fitness.sh` | Bash shell fitness check | да |

### 4.2 Изменения существующих файлов

| Файл | Тип изменения | Что именно |
|---|---|---|
| `ci/checks/db/pgJobStore.integration.test.ts` | Additive (append-only) | Новый `describe('T-0115 fail-closed: async paths', ...)` в конце файла |
| `package.json` | Additive | Добавить `bash ci/checks/cross-tenant-fitness.sh` в `npm run fitness` |

**T-0028 seam:** `pgJobStore.integration.test.ts` уже используется T-0028 (IN BUILD) для
покрытия `complete`-пути. T-0115 только дописывает новый describe-блок в конец файла —
конфликт по символам невозможен, т.к. T-0028 не трогает конец файла.

### 4.3 Не трогаем

- `docker-compose.yml` (владелец T-0054)
- `src/core/jobStore.ts`, `src/core/types.ts` (T-0028 IN BUILD)
- `src/core/postgres/pgJobStore.ts` — только читаем в тестах
- `migrations/` — нет DDL для T-0115
- `.github/workflows/ci.yml` — `fitness:db` уже запускается в `db` job; изменений не нужно

---

## 5. Контракты

```ts
// _helpers.ts (неизменён, используется как есть)
export const KNOWN_TENANT_TABLES: string[];   // из known_tenant_tables.txt
export function appUrl(): string;             // choros_app
export function migratorUrl(): string;        // choros_migrator (owner/DDL)
export function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T>;
export const TENANT_A: string;  // '11111111-...'
export const TENANT_B: string;  // '22222222-...'

// cross_tenant.test.ts — контракты теста
// Seed-helper (migrator-role): INSERT в choros.<T> для TENANT_A и TENANT_B
// перед каждым cross-tenant тестом; через withClient(migratorUrl(), ...).
// Assertion-helper (migrator-role): SELECT count(*) для верификации post-condition.
// Каждый cross-tenant-запрос: withClient(appUrl(), ...) в BEGIN/SET LOCAL/COMMIT.

// Семантика AC-6 (GUC unset → Postgres error):
// current_setting('choros.tenant_id', false) при отсутствии GUC бросает:
//   SQLSTATE 42704 (undefined_object) в Postgres 16
//   Error message: 'unrecognized configuration parameter "choros.tenant_id"'
//   или SQLSTATE GUC_UNDEFINED зависимо от версии.
// Тест ловит любой throw через .rejects.toBeDefined().

// Семантика AC-7 (store.enqueue без GUC):
// pgJobStore.ts:enqueue: INSERT ... VALUES (current_setting('choros.tenant_id', false)::uuid, ...)
// При отсутствии GUC — Postgres error; Promise.reject.
// Тест: expect(store.enqueue(...)).rejects.toBeDefined()

// Семантика AC-8 (fetchAndLock без GUC):
// RLS default-DENY policy использует current_setting('choros.tenant_id', true) → NULL → 0 строк.
// Без BEGIN+SET LOCAL: fetchAndLock возвращает [] (не throw).
// Тест: expect(result).toEqual([])
```

---

## 6. Fitness-функции

| FF | Правило | ci_check | Покрывает |
|---|---|---|---|
| **FF-CT1** | cross-tenant SELECT: choros_app с контекстом TENANT_A → 0 строк с tenant_id=TENANT_B для каждой таблицы из KNOWN_TENANT_TABLES. | `npm run fitness:db` → `cross_tenant.test.ts` (vitest) | AC-1 |
| **FF-CT2** | cross-tenant SELECT без WHERE: все возвращённые строки имеют tenant_id=TENANT_A; строк TENANT_B нет. | `npm run fitness:db` → `cross_tenant.test.ts` | AC-2 |
| **FF-CT3** | cross-tenant UPDATE: choros_app в контексте TENANT_A → 0 rows affected на строках TENANT_B в `application`; верификация migrator — значение не изменилось. | `npm run fitness:db` → `cross_tenant.test.ts` | AC-3 |
| **FF-CT4** | cross-tenant DELETE: choros_app в контексте TENANT_A → 0 rows affected на строках TENANT_B в `application`; верификация migrator — строка существует. | `npm run fitness:db` → `cross_tenant.test.ts` | AC-4 |
| **FF-CT5** | Post-condition integrity: migrator-count строк TENANT_B после AC-3/AC-4-попыток совпадает с seed-count. | `npm run fitness:db` → `cross_tenant.test.ts` | AC-5 |
| **FF-CT6** | Fail-closed DML без GUC: INSERT с `current_setting('choros.tenant_id', false)::uuid` без SET LOCAL → Postgres error (reject). | `npm run fitness:db` → `cross_tenant.test.ts` | AC-6 |
| **FF-CT7** | PostgresJobStore.enqueue без tenant-контекста → Promise.reject / throw (не тихий успех). | `npm run fitness:db` → `pgJobStore.integration.test.ts` (новый describe) | AC-7 |
| **FF-CT8** | PostgresJobStore.fetchAndLock без tenant-контекста: сидированные джобы TENANT_A не утекают → `[]`. READ-путь fail-closed (0 строк). | `npm run fitness:db` → `pgJobStore.integration.test.ts` (новый describe) | AC-8 |
| **FF-CT9** | SET LOCAL scope isolation: GUC сброшен после COMMIT; нет утечки между транзакциями. | `npm run fitness:db` → `cross_tenant.test.ts` | AC-9 |
| **FF-CT10** | Anti-hardcode: `cross_tenant.test.ts` импортирует/использует `KNOWN_TENANT_TABLES` из `_helpers`, не содержит хардкоженного списка таблиц. | `bash ci/checks/cross-tenant-fitness.sh` (grep) | AC-10 |
| **FF-CT11** | CI gate: `.github/workflows/ci.yml` содержит `fitness:db` в `db` job; провал cross-tenant-теста = non-zero exit = build failure = merge blocked. | `bash ci/checks/cross-tenant-fitness.sh` (grep) | AC-11 |
| **FF-CT12** | Role discipline: `cross_tenant.test.ts` использует `appUrl()` для мутирующих запросов и `migratorUrl()` для верификации. | `bash ci/checks/cross-tenant-fitness.sh` (grep) | AC-12 |

---

## 7. Seam-анализ

### 7.1 Что трогаем

| Зона | Изменение | Риск конфликта |
|---|---|---|
| `ci/checks/db/cross_tenant.test.ts` | НОВЫЙ файл | Нет — новый файл |
| `ci/checks/cross-tenant-fitness.sh` | НОВЫЙ файл | Нет — новый файл |
| `ci/checks/db/pgJobStore.integration.test.ts` | Additive: новый describe-блок в конце | Минимальный; T-0028 пишет в середину файла, T-0115 — в конец |
| `package.json` `fitness` script | Additive: +1 bash-команда | Нет — чистое добавление в строку скрипта |

### 7.2 Что НЕ трогаем

| Зона | Почему |
|---|---|
| `docker-compose.yml` | Владелец T-0054 |
| `src/core/postgres/pgJobStore.ts` | Только читаем в тестах; реализация AC-7 через pool без GUC — не требует изменений store |
| `src/core/jobStore.ts` | T-0028 IN BUILD — исключительный владелец сигнатуры |
| `.github/workflows/ci.yml` | `fitness:db` уже входит в `db` job; изменений не требуется |
| `migrations/` | No DDL for T-0115 |
| `ci/checks/known_tenant_tables.txt` | Уже содержит все 8 таблиц |

### 7.3 T-0028 конфликт-анализ

T-0028 (IN BUILD) добавляет в `pgJobStore.integration.test.ts` тесты для `RECORD_IN_PAYLOAD`
в `complete`-пути. Точка вставки — описано в ADR T-0028 как additive `variable-guard.test.ts`
(отдельный файл), не тот же файл. В `pgJobStore.integration.test.ts` T-0028 не заявляет
ownership.

T-0115 добавляет один `describe`-блок в КОНЕЦ `pgJobStore.integration.test.ts`. Если T-0028
также дописывает в тот же файл — builder должен объединить describe-блоки без пересечения
(разные имена блоков, аддитивно). Конфликта по функциям/импортам нет: оба используют
`SingleClientStore`, `makeAppPool`, `seedJob` — эти символы уже экспортированы / объявлены
в файле.

---

## 8. Совместимость с реальным кодом (REAL-CODE CHECK)

**Проверено против worktree `task/T-0115-tenant-rls`:**

1. `current_setting('choros.tenant_id', false)` используется в `pgJobStore.ts:enqueue` (строка 82).
   Это подтверждает механизм AC-7: pool без GUC → этот вызов бросает Postgres error.

2. `fetchAndLock` не содержит явного `WHERE tenant_id = ...` — полагается на RLS
   (строки 167-187). Это подтверждает AC-8: без GUC RLS default-DENY → 0 строк, не ошибка.

3. `_helpers.ts` экспортирует `KNOWN_TENANT_TABLES`, `TENANT_A`, `TENANT_B`, `appUrl()`,
   `migratorUrl()`, `withClient()` — все нужные символы доступны без изменений файла.

4. `.github/workflows/ci.yml` строка 64: `npm run fitness:db` уже в `db` job.
   Новый файл `cross_tenant.test.ts` в `ci/checks/db/` подхватывается автоматически
   (`vitest run --dir ci/checks/db`). CI-изменений не нужно.

5. `known_tenant_tables.txt` содержит 8 таблиц (job, application, registry_def, record,
   audit_event, audit_head, grant, object_handle). Все они имеют `tenant_id uuid NOT NULL`
   (confirmed: migrations 002-009), FORCE RLS (confirmed: schema.test.ts FF-RLS).

6. Seed-паттерн для всех 8 таблиц: не все таблицы имеют одинаковую схему.
   Для SELECT/AC-2 итерация может использовать простой `SELECT tenant_id FROM choros.<T>`.
   Для seed вставки по каждой таблице coder должен учесть FK-цепочку
   (application → registry_def → record). Порядок seed: application, registry_def,
   record, остальные независимы. Это BUILD-зона (coder решает детали), не архитектурная.

---

## 9. Трассируемость

| AC | covered_by |
|---|---|
| AC-1 | FF-CT1; `cross_tenant.test.ts` SELECT-цикл по KNOWN_TENANT_TABLES с `WHERE tenant_id=TENANT_B` → 0 |
| AC-2 | FF-CT2; `cross_tenant.test.ts` SELECT tenant_id цикл → only TENANT_A rows |
| AC-3 | FF-CT3; `cross_tenant.test.ts` UPDATE application + migrator-верификация |
| AC-4 | FF-CT4; `cross_tenant.test.ts` DELETE application + migrator-верификация |
| AC-5 | FF-CT5; `cross_tenant.test.ts` post-condition migrator-count проверка |
| AC-6 | FF-CT6; `cross_tenant.test.ts` INSERT без GUC → Postgres error |
| AC-7 | FF-CT7; новый describe в `pgJobStore.integration.test.ts` — enqueue без GUC → reject |
| AC-8 | FF-CT8; новый describe в `pgJobStore.integration.test.ts` — fetchAndLock без GUC → [] |
| AC-9 | FF-CT9; `cross_tenant.test.ts` SET LOCAL scope isolation после COMMIT |
| AC-10 | FF-CT10; `ci/checks/cross-tenant-fitness.sh` grep KNOWN_TENANT_TABLES |
| AC-11 | FF-CT11; `ci/checks/cross-tenant-fitness.sh` grep fitness:db в ci.yml |
| AC-12 | FF-CT12; `ci/checks/cross-tenant-fitness.sh` grep appUrl() и migratorUrl() |

---

## 10. Runtime target

**CI-container (db job) + локально против compose Postgres.**

Тесты требуют живой Postgres с применёнными миграциями 001-010. В CI — сервис-контейнер
`postgres:16` в `db` job (уже настроен в `.github/workflows/ci.yml`). Локально — compose
(`docker-compose.yml`). T-0115 не добавляет новой инфраструктуры.

---

## 11. Escalation

Нет. T-0115 — чисто тестовая дельта: закрывает CI-блокер на уже выложенный фундамент.
Нет архитектурных развилок, влияющих на продуктовое направление. Все технические
решения (паттерн тестов, seed-стратегия, размещение файлов) автономны.
