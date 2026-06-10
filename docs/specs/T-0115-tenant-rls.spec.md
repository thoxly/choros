# T-0115 · Подложка-2: Tenant RLS — cross-tenant CI-тест + fail-closed async

**Title:** Подложка-2: блокирующий CI-тест cross-tenant-утечки от реальной app-роли (несущий 152-ФЗ-инвариант) + fail-closed в async-путях
**Status:** ready (нет blocking-вопросов)
**Authored:** 2026-06-10
**spec_ref:** `docs/design/stack-and-fleet-ops.md` §1 «Порядок работ», пункт 2
**Depends on:** T-0013 (RLS-фундамент), T-0053 (Postgres + миграции 001-009), T-0114 (миграция 010, pgJobStore)

---

## 1. Summary

T-0013 и T-0053 выложили полный RLS-фундамент (FORCE RLS, default-DENY, NOBYPASSRLS-роль,
`choros.tenant_id` GUC, 8 таблиц). T-0114 добавил pgJobStore с SET LOCAL контрактом.
T-0115 закрывает единственную оставшуюся дельту: **CI-блокер**, который доказывает от лица
реальной app-роли, что запрос в контексте тенанта A не возвращает ни одной строки тенанта B
(несущий 152-ФЗ-инвариант), плюс **проверяемый контракт fail-closed** для всех async-путей
(отсутствие tenant-контекста → ошибка, не глобальная запись).

---

## 2. Что уже сделано — не дублируется

Следующие инварианты **полностью покрыты** предыдущими задачами и CI-тестами.
T-0115 на них опирается, но не переопределяет:

| Что | Где реализовано | Где проверяется в CI |
|---|---|---|
| `tenant_id uuid NOT NULL` ведущей колонкой, все 8 таблиц `choros_*` | migrations/001-009 | `schema.test.ts` FF-LEAD |
| `ENABLE + FORCE ROW LEVEL SECURITY` на всех таблицах | migrations/002-009 | `schema.test.ts` FF-RLS |
| Default-DENY policy (`current_setting('choros.tenant_id', true)`) | migrations/002-009 | `behavior.test.ts` FF-DENY |
| `choros_app`: NOBYPASSRLS, NOSUPERUSER, не-owner | migrations/001 | `schema.test.ts` FF-ROLE |
| Scoped uniqueness `(tenant_id, slug)` | migrations/002-009 | `behavior.test.ts` FF-SCOPE |
| Tenant context через `SET LOCAL choros.tenant_id` в явной транзакции | pgJobStore.ts | `pgJobStore.integration.test.ts` |
| `known_tenant_tables.txt` fixture покрывает все таблицы | ci/checks | `schema.test.ts` FF-RLS (anti-decorative) |

---

## 3. Дельта — что строим в T-0115

### FR-1  Blocking CI-тест: cross-tenant утечка от реальной app-роли

В CI должен существовать тест, который:
1. Подключается **как `choros_app`** (реальная runtime-роль, NOBYPASSRLS).
2. Сидирует строки под двумя разными `tenant_id` (TENANT_A, TENANT_B).
3. Открывает транзакцию с `SET LOCAL choros.tenant_id = TENANT_A`.
4. Выполняет запросы к **каждой** таблице из `known_tenant_tables.txt`.
5. Проверяет: ни один запрос не возвращает строк с `tenant_id = TENANT_B`.
6. Проверяет: явный `WHERE tenant_id = TENANT_B` тоже возвращает 0 строк.
7. Проверяет: UPDATE с явным `WHERE tenant_id = TENANT_B` изменяет 0 строк.
8. Проверяет (после commit/rollback): строки TENANT_B физически нетронуты
   (верификация через migrator-роль, которая не фильтруется RLS).

Этот тест — несущий 152-ФЗ-инвариант: **он блокирует мерж**, если провалится.

### FR-2  Контракт fail-closed в async-путях

Любой async-путь (job-потребитель, таймер, future Flowable external-worker)
**должен** при отсутствии tenant-контекста бросать ошибку, а не читать/писать глобально.

Реализуется двумя составляющими:

**FR-2a.** Postgres-уровень: `current_setting('choros.tenant_id', false)` (третий аргумент
`false` = raise ERROR если GUC не задан) используется **в DML-вставках** (INSERT/UPDATE).
В политиках RLS используется `true` (возвращает NULL → 0 строк) — это уже корректное
поведение по умолчанию. Разделение намеренное: запись без tenant-контекста → явная ошибка;
чтение → 0 строк (тоже безопасно). Это **не противоречие**, а defense-in-depth:
запись молча в пустоту хуже, чем явная ошибка.

**FR-2b.** Application-уровень: любой async-обработчик (job worker, timer callback)
перед обращением к DB **обязан** иметь явный tenant-контекст. Если контекст не получен
из джоба или переданного параметра — операция должна завершаться с ошибкой (throw /
reject / failed-job), не выполняться.

### FR-3  Стандартизированное имя GUC

Везде используется строго `choros.tenant_id` (namespace = `choros`, key = `tenant_id`).
Никаких альтернативных имён (`app.current_tenant_id`, `app.tenant_id`). Это уже закреплено
в T-0013/T-0053; T-0115 подтверждает, что CI-тест cross-tenant использует то же имя.

---

## 4. Нефункциональные требования

### NF-1  Блокирующий gate в CI

Cross-tenant-тест (FR-1) должен быть в составе `db` CI-job (тот же, что запускает
`schema.test.ts`, `behavior.test.ts`, `two_tenant.test.ts`). Провал теста — build failure,
мерж заблокирован.

### NF-2  Реальная app-роль, не migrator

Тест FR-1 ОБЯЗАН использовать `choros_app` (не `choros_migrator`). Тест через migrator
не несёт инварианта: migrator — superuser, у которого FORCE RLS применяется к нему как
к владельцу таблицы. Только app-роль подтверждает сценарий реальной атаки.

### NF-3  Охват всех таблиц из known_tenant_tables.txt

Тест FR-1 должен итерировать по `known_tenant_tables.txt`, а не хардкодить подмножество.
Это предотвращает ситуацию, когда новая таблица добавляется в миграцию, но не попадает
в CI-проверку cross-tenant.

### NF-4  Fail-closed верифицируем как тест

Поведение FR-2 (async без контекста → ошибка) должно проверяться как integration-тест
над `PostgresJobStore`: попытка вызова `enqueue()`/`fetchAndLock()` без предварительного
`SET LOCAL choros.tenant_id` в транзакции должна бросать ошибку Postgres (или прикладную
ошибку на уровне store), а не возвращать успешный результат с данными другого тенанта.

---

## 5. Out of Scope

Следующее явно НЕ входит в T-0115:

1. **DDL / изменение схемы миграций** — T-0013/T-0053 уже выложили полный RLS-фундамент.
   T-0115 не добавляет колонок, не меняет политики, не создаёт новых таблиц.
2. **Keycloak / JWT-валидация** — AC-11/12/13 из T-0013 — отдельные задачи (auth layer).
3. **Flowable TENANT_ID_ isolation** — движок-сторонний, вне дельты.
4. **Timer-dispatcher fail-closed** — §1 п.3 стека, отдельная задача (Подложка-3).
5. **Pooled-mode** — заблокирован founder-решением; не затрагивается.
6. **SECURITY DEFINER функции** — на текущей кодовой базе их нет в async-путях; если
   появятся — требуют отдельного аудита.
7. **Новые таблицы** — если в рамках T-0115 потребуется добавить таблицу, это выходит за
   scope и требует отдельной задачи с DDL-миграцией.

---

## 6. Критерии приёмки

### AC-1  Cross-tenant SELECT → 0 строк от app-роли (все таблицы)

```
CI integration-тест (db job), choros_app:
  Для каждой таблицы T из known_tenant_tables.txt:
    Сидировать ≥1 строку под TENANT_A и ≥1 строку под TENANT_B (через migrator).
    Подключиться как choros_app.
    BEGIN;
    SET LOCAL choros.tenant_id = '<TENANT_A>';
    SELECT count(*) FROM choros.<T> WHERE tenant_id = '<TENANT_B>';
    → результат ДОЛЖЕН быть 0.
    COMMIT;
Провал любой таблицы = build failure.
```
`verifiable_as: test`

### AC-2  Cross-tenant SELECT без WHERE-фильтра возвращает только строки TENANT_A

```
CI integration-тест (db job), choros_app:
  Для каждой таблицы T из known_tenant_tables.txt:
    Подключиться как choros_app.
    BEGIN;
    SET LOCAL choros.tenant_id = '<TENANT_A>';
    SELECT tenant_id FROM choros.<T>;
    → каждая возвращённая строка ДОЛЖНА иметь tenant_id = TENANT_A.
    → строк с tenant_id = TENANT_B — 0.
    COMMIT;
```
`verifiable_as: test`

### AC-3  Cross-tenant UPDATE изменяет 0 строк (не ошибка, но 0 affected)

```
CI integration-тест (db job), choros_app:
  Для таблицы choros.application:
    Сидировать строку под TENANT_B (через migrator).
    Подключиться как choros_app.
    BEGIN;
    SET LOCAL choros.tenant_id = '<TENANT_A>';
    UPDATE choros.application SET display_name = 'HACKED'
      WHERE tenant_id = '<TENANT_B>';
    → rows affected ДОЛЖНО быть 0.
    COMMIT;
  Верификация: подключиться как migrator,
    SELECT display_name FROM choros.application WHERE tenant_id = '<TENANT_B>';
    → значение НЕ изменилось.
```
`verifiable_as: test`

### AC-4  Cross-tenant DELETE изменяет 0 строк (не ошибка, но 0 affected)

```
CI integration-тест (db job), choros_app:
  Для таблицы choros.application:
    Сидировать строку под TENANT_B.
    Подключиться как choros_app.
    BEGIN;
    SET LOCAL choros.tenant_id = '<TENANT_A>';
    DELETE FROM choros.application WHERE tenant_id = '<TENANT_B>';
    → rows affected ДОЛЖНО быть 0.
    COMMIT;
  Верификация: строка TENANT_B физически существует (migrator-count = 1).
```
`verifiable_as: test`

### AC-5  Строки TENANT_B не повреждены после cross-tenant попыток

```
CI post-condition после AC-3 и AC-4:
  Через migrator-роль убедиться, что:
    count(*) WHERE tenant_id = TENANT_B для каждой затронутой таблицы
    совпадает с начальным seed-count (строки не удалены, не обновлены).
```
`verifiable_as: test`

### AC-6  Fail-closed DML без tenant-контекста → ошибка Postgres

```
CI integration-тест, choros_app:
  BEGIN;
  -- НЕ выполняем SET LOCAL choros.tenant_id
  INSERT INTO choros.job
    (tenant_id, id, topic, variables, state, retries,
     lock_owner, lock_expiry, created_at, available_at)
  VALUES
    (current_setting('choros.tenant_id', false)::uuid,
     gen_random_uuid(), 'test', '{}', 'CREATED', 3,
     NULL, NULL, 0, 0);
  → ДОЛЖНО бросить ошибку Postgres (GUC_UNDEFINED или аналог).
  ROLLBACK;
```
`verifiable_as: test`

### AC-7  PostgresJobStore.enqueue без tenant-контекста бросает ошибку

```
CI integration-тест над pgJobStore, choros_app:
  Создать PostgresJobStore с pool choros_app.
  Вызвать store.enqueue('topic', {}, 3) БЕЗ предварительного
  SET LOCAL choros.tenant_id в транзакции.
  → операция ДОЛЖНА отклониться (Promise.reject / throw).
  → НЕ должна возвращать успешный Job.
```
`verifiable_as: test`

### AC-8  PostgresJobStore.fetchAndLock без tenant-контекста возвращает 0 джобов

```
CI integration-тест над pgJobStore, choros_app:
  Сидировать ≥1 джоб под TENANT_A (через migrator с SET LOCAL).
  Подключиться как choros_app.
  Вызвать store.fetchAndLock('topic', 'worker-1', ...) БЕЗ
  SET LOCAL choros.tenant_id в транзакции.
  → результат ДОЛЖЕН быть пустой массив (RLS default-DENY → 0 строк).
  → НЕ должен вернуть джобы TENANT_A.
Примечание: это корректное fail-closed для READ-пути (0 строк, не ошибка).
```
`verifiable_as: test`

### AC-9  SET LOCAL видим только внутри своей транзакции (scope-isolation)

```
CI integration-тест, choros_app:
  Подключение 1:
    BEGIN;
    SET LOCAL choros.tenant_id = '<TENANT_A>';
    -- (тут строки видны)
    COMMIT;
    -- После commit без нового BEGIN:
    SELECT count(*) FROM choros.application;
    → ДОЛЖНО быть 0 (GUC сброшен).
  Подключение 1 (session-level попытка):
    SET choros.tenant_id = '<TENANT_A>';  -- session-level, НЕ LOCAL
    BEGIN;
    SELECT count(*) FROM choros.application;
    COMMIT;
    → ДОЛЖНО быть 0 (RLS-политика требует transaction-local GUC через SET LOCAL
      потому что при session-level SET политика может пропустить строки,
      но это поведение верифицируется как 0, чтобы подтвердить, что
      session-level GUC не является дырой в isolation при корректно
      написанных политиках).
Fail если любой счётчик > 0 без явного SET LOCAL в открытой транзакции.
```
`verifiable_as: test`

### AC-10  Тест итерирует по known_tenant_tables.txt, не хардкодит список

```
CI fitness-function (статическая):
  Исходный код cross-tenant-теста читает known_tenant_tables.txt
  и итерируется по нему, а не содержит hardcoded список таблиц.
  grep/AST-проверка: файл test существует и импортирует/читает
  known_tenant_tables.txt или KNOWN_TENANT_TABLES из _helpers.
```
`verifiable_as: fitness`

### AC-11  Тест запускается как часть `db` CI-job и блокирует мерж при провале

```
CI fitness-function (конфигурационная):
  .github/workflows/*.yml содержит шаг, запускающий cross-tenant-тест
  в рамках того же job, что schema.test.ts и behavior.test.ts.
  Провал теста приводит к non-zero exit и блокирует мерж.
```
`verifiable_as: fitness`

### AC-12  Тест использует choros_app (APP_DATABASE_URL), не migrator

```
CI fitness-function:
  В cross-tenant-тесте SQL-подключение использует appUrl() из _helpers
  (choros_app, не choros_migrator).
  Верификационные SELECT после мутаций используют migratorUrl().
```
`verifiable_as: fitness`

---

## 7. Blocking-вопросы

Нет. Все ответы однозначно следуют из:
- T-0013 / T-0053 (фундамент уже есть)
- `stack-and-fleet-ops.md` §1 п.2 (прямое ТЗ)
- Решения фаундера: реализация автономна, эскалируются только red-lines и продуктовые направления

---

## 8. Примечания для архитектора

- `current_setting('choros.tenant_id', false)` (raise on missing) в DML vs `true` (return NULL)
  в RLS-политиках — разделение намеренное и правильное (defense-in-depth). Не менять.
- Тест AC-1..AC-5 нужно разместить в `ci/checks/db/` — рядом с `behavior.test.ts`.
  Имя файла: `cross_tenant.test.ts`.
- AC-6 и AC-7 можно объединить с `pgJobStore.integration.test.ts` (новый describe-блок).
- AC-8 тестирует READ-путь pgJobStore — важно для fail-closed семантики.
- AC-10..AC-12 — статические проверки (fitness); могут быть shell-скриптами в `ci/checks/`.
