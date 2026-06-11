# ADR · T-0147 — Postgres template-DB изоляция db-тестов (per-run клон)

**Status:** ready
**Phase:** DESIGN
**Date:** 2026-06-11
**Task:** T-0147 — изоляция `npm run fitness:db` от загрязнения параллельных prогонов (данные + schema)
**Spec:** `docs/specs/T-0147-db-test-isolation.spec.md` (9 AC, `status: ready`)
**Base:** dev (текущий HEAD); worktree `task/T-0147-db-test-isolation`
**Deps:** T-0144 (afterAll-паттерн — остаётся вторым слоем; T-0147 не отменяет)

---

## 1. Контекст (корневые причины)

Два независимых вектора загрязнения при параллельных прогонах из разных worktree:

- **V-1 (данные):** `genesis-owner-seed.test.ts` AC-12 (`count = 17`) — гонка afterAll, другой прогон удаляет строки раньше; при N параллельных прогонах count дрейфует.
- **V-2 (schema):** соседняя task-ветка применяет новые миграции к общему silo 55432; FK-ссылки на несуществующие таблицы ломают INSERT-тесты (`FF-FK-RESOLVE`).

T-0144 фиксирует только идемпотентность afterAll **внутри одного прогона**. T-0147 устраняет загрязнение **между прогонами**.

---

## 2. Decision (механизм, один абзац)

**Виtest `globalSetup`/`globalTeardown` в отдельном файле `ci/checks/db/globalSetup.ts`, регистрируемый через секцию `test.projects` виtest.config.ts (`dbIsolation`-проект).** Перед каждым прогоном `fitness:db` globalSetup: (1) проверяет существование `choros_test_template` — если нет, завершается с exit-кодом 1 и сообщением «run `npm run fitness:db:setup-template` first»; (2) генерирует `run_id = choros_test_<epoch_ms>_<random_4hex>` (D-2, см. §4); (3) выполняет `CREATE DATABASE <run_id> TEMPLATE choros_test_template` через migrator-URL с правом CREATEDB (D-4: подтверждено — `choros_migrator` superuser, CREATEDB=t); (4) записывает `process.env.DATABASE_URL` и `process.env.APP_DATABASE_URL` в main-процессе до форка vitest-workers (D-3, см. §5); (5) globalTeardown выполняет `SELECT pg_terminate_backend(pid) … WHERE datname = $run_id` + `DROP DATABASE <run_id>`. Шаблонная база обновляется через отдельную команду `npm run fitness:db:setup-template` (идемпотентный `node migrations/run.mjs` с `DATABASE_URL` указывающим на `choros_test_template`). Orphan-cleanup через `npm run fitness:db:cleanup-orphans` (SELECT datname LIKE 'choros_test_%' + DROP каждой). Режим обратной совместимости: при `DB_ISOLATION=off` механизм пропускается, прогон идёт напрямую на текущий `DATABASE_URL`.

---

## 3. Решения развилок D-1..D-4

### D-1 — Lifecycle-механизм: `globalSetup` vs npm-обёртка

**Решение: `vitest globalSetup/globalTeardown`.**

Опора в коде: `vitest.config.ts:1` — файл уже является TypeScript (`export default defineConfig`), что подтверждает отсутствие барьера на TypeScript в конфиге. Vitest 2.x (`package.json devDependencies: "vitest": "^2.0.0"`) поддерживает `globalSetup` как массив файлов в `test`-секции. GlobalSetup выполняется в main-процессе до форка workers — это ключевое свойство, используемое для D-3.

Отклонена npm-обёртка (`scripts/run-db-tests.sh`): bash-скрипт сложнее в части надёжного teardown при SIGKILL (trap не ловит SIGKILL), TypeScript naturalнее для проекта без bash-экспертизы в CI (весь `fitness:db` — `vitest run …`).

### D-2 — Именование per-run базы: PID vs timestamp vs random hex

**Решение: `choros_test_<epoch_ms>_<random_4hex>`.**

- `choros_test_<pid>`: PID переиспользуется OS после завершения процесса → следующий прогон может создать одноимённую базу, которую не удалил предыдущий SIGKILL-аварийно завершившийся процесс. PID не уникален.
- `choros_test_<epoch_ms>`: при >1 прогоне в одну миллисекунду (маловероятно, но возможно в CI на быстрых машинах) → конфликт.
- `choros_test_<epoch_ms>_<random_4hex>`: collision probability ≈ 1 / (65536) при совпадении ms → пренебрежимо мало; имя ≤ 63 символов (Postgres limit): `choros_test_` (12) + 13 (epoch_ms ~1749700000000 = 13 цифр) + 1 + 4 = 30 символов; паттерн `choros_test_*` идентифицирует orphan'ов; нет секретов (NF-5).

### D-3 — Передача DATABASE_URL в vitest workers

**Решение: мутация `process.env` в `globalSetup` до спавна workers.**

Vitest 2.x: `globalSetup` исполняется в main-процессе. Workers форкаются **после** завершения всех `globalSetup`-функций (sequentially) — т.е. унаследованный `process.env` main-процесса уже содержит выставленные значения. Это нативный механизм, без файловых артефактов `.env.test`.

Опора: `vitest.config.ts` использует `configDefaults` из `vitest/config` — стандартный API v2; `package.json:devDependencies` `"vitest": "^2.0.0"` — версия подтверждена.

Контракт: globalSetup выставляет `process.env.DATABASE_URL` и `process.env.APP_DATABASE_URL` **до** `return` из функции setup. `_helpers.ts:26` (`migratorUrl()`) и `_helpers.ts:32` (`appUrl()`) читают именно эти переменные — уже корректно параметризованы без изменений.

Отклонён `.env.test` перезапись: гонка записи при параллельных прогонах одного worktree; файл в git потенциально закоммичен; ненужная сложность.

### D-4 — Права CREATEDB

**Решение: существующих прав `choros_migrator` достаточно — никаких ALTER ROLE не требуется.**

Живая проверка:
```
SELECT rolname, rolcreatedb, rolsuper FROM pg_roles
WHERE rolname IN ('choros_migrator', 'choros_app');
 choros_migrator | t | t   ← CREATEDB + SUPERUSER
 choros_app      | f | f   ← без CREATEDB, без SUPERUSER
```

Контекст: `docker-compose.yml:20-22` — `POSTGRES_USER=choros_migrator` есть bootstrap-суперпользователь (`POSTGRES_USER` в официальном образе postgres:16 всегда superuser). Миграция `001_roles_and_schema.sql:28-33` создаёт `choros_app` как `NOSUPERUSER NOCREATEDB`. `choros_migrator` используется в `DATABASE_URL` через весь migrations/run.mjs. Дополнительный superuser (`postgres`) отсутствует в compose (не нужен: bootstrap = choros_migrator).

Вывод: local dev-стек — расходник; choros_migrator superuser по design. Никаких `ALTER ROLE`. На prod `DATABASE_URL` поставляется фаундером с нужными правами (GT-4 gate, founder-held).

---

## 4. Шаблонная база: жизненный цикл и инвалидация

### 4.1 Создание / обновление

Команда `npm run fitness:db:setup-template`:
1. Подключается через migrator-URL к `postgres` (системная БД — не choros).
2. `SELECT 1 FROM pg_database WHERE datname = 'choros_test_template'` — если нет, `CREATE DATABASE choros_test_template TEMPLATE template0` (template0 — пустой, без encoding-артефактов).
3. Устанавливает `datistemplate = true` через `UPDATE pg_database SET datistemplate = true WHERE datname = 'choros_test_template'` (предотвращает случайный DROP без explicit `FORCE`).
4. Запускает `node migrations/run.mjs` с `DATABASE_URL` указывающим на `choros_test_template` — применяет все pending миграции. Идемпотентен: run.mjs пропускает уже записанные версии (`schema_migrations` таблица в шаблоне).
5. Выводит «nothing to apply» при отсутствии новых миграций (паттерн run.mjs).

### 4.2 Когда пересоздавать шаблон

Шаблон **не пересоздаётся автоматически** в рамках `fitness:db:setup-template`. Он обновляется инкрементально (новые миграции добавляются). Полная пересборка (`DROP + CREATE`) выполняется только вручную при несовместимых изменениях структуры — это осознанное решение developer'а.

Детектирование «шаблон устарел» (необязательная оптимизация для coder): вычислить hash всех файлов `migrations/*.sql` (SHA256 конкатенации имён + содержимого), сравнить с `SELECT description FROM schema_migrations WHERE version = 'template_hash'` (специальная sentinel-запись). Если расходится — вывести предупреждение. Это необязательная оптимизация; основной критерий приёмки (AC-7) — идемпотентность.

### 4.3 Сериализация конкурентных прогонов при клонировании

`CREATE DATABASE ... TEMPLATE <tmpl>` требует **нулевых активных соединений к шаблонной базе**. Шаблонная база доступна только через `fitness:db:setup-template` (миграции) — не через тестовые процессы. Тесты подключаются к рабочей базе, не к шаблону.

Конкурентный `fitness:db:setup-template` + `fitness:db` (clone): взаимное исключение через Postgres advisory lock:
- `setup-template` держит `pg_advisory_lock(147_SETUP_LOCK_ID)` на время применения миграций к шаблону.
- globalSetup клонирования ждёт `pg_advisory_lock(147_SETUP_LOCK_ID)` перед `CREATE DATABASE`.
- Lock-ID: `hashtext('choros_test_template_setup')` — детерминированный, не требует реестра.

Два параллельных `fitness:db` (разные worktree): каждый генерирует уникальный run_id, создаёт свою базу из шаблона. `CREATE DATABASE ... TEMPLATE` — читает шаблон, не блокирует его для других `CREATE DATABASE` (Postgres позволяет параллельные клоны). Advisory lock нужен только для защиты от `setup-template` во время клонирования.

---

## 5. Lifecycle: создание и дроп рабочей базы

### 5.1 globalSetup (`ci/checks/db/globalSetup.ts`)

```
setup():
  1. check DB_ISOLATION env: if 'off' → log "DB isolation skipped" → return
  2. adminUrl = DATABASE_URL (migrator, CREATEDB)
  3. check choros_test_template exists → if not → error + exit(1) + hint
  4. acquire pg_advisory_lock(147_SETUP_LOCK_ID) on adminUrl
  5. run_id = "choros_test_" + Date.now() + "_" + randomHex(4)
  6. CREATE DATABASE <run_id> TEMPLATE choros_test_template
  7. release advisory lock
  8. process.env.DATABASE_URL = adminUrl with dbname=run_id
  9. process.env.APP_DATABASE_URL = appUrl with dbname=run_id
  10. store run_id in process.env.CHOROS_TEST_RUN_ID (for teardown)
```

### 5.2 globalTeardown (`ci/checks/db/globalSetup.ts`, export `teardown`)

```
teardown():
  1. run_id = process.env.CHOROS_TEST_RUN_ID
  2. if not set → return (DB_ISOLATION=off path)
  3. connect to adminUrl (postgres db, not run_id — can't drop current db)
  4. pg_terminate_backend all backends on run_id:
       SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $run_id AND pid <> pg_backend_pid()
  5. DROP DATABASE IF EXISTS <run_id>
```

### 5.3 Orphan cleanup (`scripts/db-cleanup-orphans.ts`)

```
SELECT datname FROM pg_database WHERE datname LIKE 'choros_test_%'
  AND datname != 'choros_test_template'
FOR EACH: pg_terminate_backend + DROP DATABASE IF EXISTS
```

Регистрируется как `npm run fitness:db:cleanup-orphans`.

---

## 6. Совместимость с существующими тестами

**Ни один файл `ci/checks/db/*.test.ts` не изменяется (AC-4).**

- `_helpers.ts:26` `migratorUrl()` — читает `DATABASE_URL` из env → получит обновлённый URL рабочей базы автоматически.
- `_helpers.ts:32` `appUrl()` — читает `APP_DATABASE_URL` или деривирует из `DATABASE_URL` → аналогично.
- Роли `choros_migrator` и `choros_app` уже существуют в кластере — `CREATE DATABASE TEMPLATE` копирует **схему и данные**, но не роли; роли принадлежат кластеру Postgres, не отдельной базе данных. Поэтому после клонирования оба роля автоматически доступны (AC-8).
- `--no-file-parallelism` сохраняется (FR-7): `package.json:fitness:db` не меняется — обёртка через vitest.config.ts projects-секцию, которая добавляет globalSetup не меняя cli-флаги.

---

## 7. vitest.config.ts — изменение

Текущая конфигурация (`vitest.config.ts`) не имеет `globalSetup`. Требуется добавить секцию `test.projects` с проектом `dbIsolation`:

```typescript
// Добавляется в defineConfig:
test: {
  projects: [
    {
      test: {
        name: 'db',
        include: ['ci/checks/db/**/*.test.ts'],
        globalSetup: ['ci/checks/db/globalSetup.ts'],
        // --no-file-parallelism остаётся через cli
      }
    }
  ],
  // ... existing exclude remains for default project
}
```

Альтернативный вариант (simpler): добавить `globalSetup: ['ci/checks/db/globalSetup.ts']` напрямую в существующую `test` секцию. GlobalSetup выполняется только при наличии тестов в include/dir — если `fitness:db` запускается с `--dir ci/checks/db`, globalSetup отработает. При обычном `vitest run` (без `--dir ci/checks/db`) globalSetup должен быть no-op (DATABASE_URL не указывает на choros — guard по `DB_ISOLATION` env или по отсутствию `DATABASE_URL`).

**Решение (simpler path):** добавить `globalSetup: ['ci/checks/db/globalSetup.ts']` в root `test` секцию; в globalSetup первым шагом проверять `process.env.DATABASE_URL` — если не установлен или `DB_ISOLATION=off` — немедленный return без side effects.

---

## 8. Объектная модель

| Сущность | Поля | Тип |
|----------|------|-----|
| `TestRunContext` | `run_id` | `string` — `choros_test_<ms>_<hex>` |
| | `migrator_url` | `string` — postgres URL для create/drop |
| | `app_url` | `string` — postgres URL с choros_app creds |
| `TemplateSetupConfig` | `template_name` | `string` — `choros_test_template` |
| | `migrations_dir` | `string` — абсолютный путь к `migrations/` |
| `OrphanRecord` | `datname` | `string` — имя осиротевшей базы |
| | `created_at_approx` | `number` — epoch_ms из имени (парсинг) |

---

## 9. Контракты API / сигнатуры

```typescript
// ci/checks/db/globalSetup.ts — экспорт для vitest
export async function setup(): Promise<void>
export async function teardown(): Promise<void>

// scripts/db-setup-template.ts — npm run fitness:db:setup-template
// env: DATABASE_URL (migrator, CREATEDB required)
// exit 0 → ok; exit 1 → error with message

// scripts/db-cleanup-orphans.ts — npm run fitness:db:cleanup-orphans
// env: DATABASE_URL (migrator, CREATEDB required)
// prints each dropped database; exit 0

// Env contract (set by globalSetup, consumed by _helpers.ts):
// DATABASE_URL      = postgres://choros_migrator:...@host:port/<run_id>
// APP_DATABASE_URL  = postgres://choros_app:...@host:port/<run_id>
// CHOROS_TEST_RUN_ID = <run_id> (for teardown cross-reference)
```

---

## 10. Fitness-функции (CI-правила)

### FF-T147-1 — globalSetup файл зарегистрирован в vitest.config.ts

**Rule:** `vitest.config.ts` должен содержать `globalSetup` со ссылкой на `ci/checks/db/globalSetup.ts`.
**CI-check:** `bash ci/checks/db-isolation-setup-registered.sh --self-test`
```bash
grep -q "globalSetup.*globalSetup" vitest.config.ts || exit 1
```

### FF-T147-2 — test-файлы не изменены

**Rule:** `git diff HEAD -- ci/checks/db/*.test.ts` пустой.
**CI-check:** `bash ci/checks/db-isolation-no-test-change.sh`
```bash
changed=$(git diff HEAD -- ci/checks/db/*.test.ts 2>/dev/null); [ -z "$changed" ] || exit 1
```

### FF-T147-3 — globalSetup.ts не импортирует production-модули

**Rule:** `ci/checks/db/globalSetup.ts` импортирует только `pg` (devDep), Node builtins. Не тянет `src/` модули.
**CI-check:** `bash ci/checks/db-isolation-globalsetup-pure.sh`
```bash
grep -E "^import .* from '(src/|@choros)" ci/checks/db/globalSetup.ts && exit 1 || exit 0
```

### FF-T147-4 — DATABASE_URL с template имеет choros_test_template в имени

**Rule:** `fitness:db:setup-template` использует URL с базой `choros_test_template`, не `choros`.
**CI-check:** self-test в `scripts/db-setup-template.ts` — при `--self-test` флаге проверяет, что URL содержит `/choros_test_template`.

### FF-T147-5 — cleanup-orphans скрипт существует и исполняем

**Rule:** `scripts/db-cleanup-orphans.ts` существует; `package.json` содержит `fitness:db:cleanup-orphans`.
**CI-check:** `bash ci/checks/db-isolation-cleanup-registered.sh`
```bash
[ -f scripts/db-cleanup-orphans.ts ] || exit 1
grep -q "fitness:db:cleanup-orphans" package.json || exit 1
```

### FF-T147-6 — run_id pattern соответствует choros_test_<digits>_<hex>

**Rule:** `globalSetup.ts` генерирует run_id матчащий `/^choros_test_\d{10,13}_[0-9a-f]{4}$/`.
**CI-check:** static grep в `ci/checks/db-isolation-run-id-pattern.sh`
```bash
grep -qE "choros_test.*Date\.now\(\).*randomHex|choros_test.*epoch.*hex" ci/checks/db/globalSetup.ts || exit 1
```

### FF-T147-7 — DB_ISOLATION fallback path присутствует

**Rule:** `globalSetup.ts` содержит проверку `DB_ISOLATION` env для bypass.
**CI-check:** `bash ci/checks/db-isolation-fallback-path.sh`
```bash
grep -q "DB_ISOLATION" ci/checks/db/globalSetup.ts || exit 1
```

### FF-T147-8 — teardown использует pg_terminate_backend перед DROP

**Rule:** `globalSetup.ts` teardown функция вызывает `pg_terminate_backend` до `DROP DATABASE`.
**CI-check:** `bash ci/checks/db-isolation-teardown-terminate.sh`
```bash
grep -q "pg_terminate_backend" ci/checks/db/globalSetup.ts || exit 1
```

### FF-T147-9 — self-test globalSetup

**Rule:** `ci/checks/db/globalSetup.ts` содержит `--self-test` путь, который проверяет run_id генерацию (unit-тест без реального Postgres).
**CI-check:** `node --input-type=module <<< "import('./ci/checks/db/globalSetup.ts?self-test')"` или bash flag. Конкретная реализация на усмотрение coder, покрывает AC-1/AC-2/AC-3 smoke.

---

## 11. Трассируемость AC → Design

| AC | FR/NF | Место в дизайне |
|----|-------|----------------|
| AC-1 | FR-1, FR-3 | §5.1: уникальный run_id per globalSetup; разные basе DB per прогон |
| AC-2 | FR-2, FR-5 | §4: шаблон `datistemplate=true` → не изменяется; teardown дропает рабочую, не шаблон |
| AC-3 | FR-2, FR-9 | §4.1: setup-template идемпотентен (run.mjs schema_migrations); T-0144 afterAll остаётся |
| AC-4 | FR-6 | §6: ни один `*.test.ts` не изменяется; FF-T147-2 |
| AC-5 | FR-8, NF-4 | §5.2: teardown + `fitness:db:cleanup-orphans`; orphan pattern `choros_test_*` |
| AC-6 | FR-10 | §5.1 шаг 3: проверка существования template → exit(1) + сообщение |
| AC-7 | FR-4 | §4.1: run.mjs пропускает уже-applied версии; `datistemplate` не мешает повторному migrate |
| AC-8 | FR-2, FR-5 | §6: роли кластерные, не DB-специфичные; choros_app/choros_migrator доступны на клоне |
| AC-9 | NF-2 | Postgres template clone = FS-level copy within cluster; типично < 1 с; подтверждается ручным `time CREATE DATABASE` |

---

## 12. Отклонённые альтернативы

| Вариант | Причина отклонения |
|---------|-------------------|
| Вариант A: BEGIN/ROLLBACK per test | Несовместим с multi-connection тестами: `pgTimerStore.integration.test.ts` AC-8 (SKIP LOCKED с двумя параллельными пулами), `cross_tenant.test.ts` (migratorUrl + appUrl разные соединения), `seed-pack.test.ts` / `grant-editor.test.ts` FF-10 (реальный HTTP-сервер с собственным пулом). Явно зафиксировано в spec §0.2. |
| npm-обёртка (bash script) | Trap не ловит SIGKILL → orphan при OOM. Bash teardown менее надёжен, чем vitest-native globalTeardown (always called by vitest harness). |
| Schema-level isolation | Не изолирует `schema_migrations` (одна таблица на DB); не изолирует по ролям; FK из Keycloak/Flowable-схем остаются общими. |
| Отдельный docker compose per worktree | Оверкилл (NF-1); требует портов; не соответствует размеру задачи (рубрика ось 5). |
| `choros_test_<pid>` именование | PID переиспользуется OS; не гарантирует уникальность при orphan + restart. |
| `.env.test` для передачи URL | Гонка записи при параллельных прогонах; файл может попасть в git; не нужно при process.env mutation. |

---

## 13. Runtime/deploy-таргет

Локальный dev-стек: `docker-compose.yml` postgres:16 на `localhost:55432`. choros_migrator = superuser (verified). Никаких внешних ресурсов не требуется. Prod: DATABASE_URL поставляется фаундером (GT-4 gate) — `choros_migrator` должен иметь CREATEDB на prod также (соответствует текущему prod-design из ADR T-0053/T-0061).

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
