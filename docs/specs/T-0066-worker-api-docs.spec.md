# Spec · T-0066 — E1.5 · Документация external-worker API

**Title:** E1.5 · Документация подключения external worker на любом языке
**Status:** ready (нет блокирующих вопросов)
**Phase:** SPEC
**Date:** 2026-06-11
**Task type:** standard_code (доковая задача)

**Авторитетные источники (не переоткрывать):**
- `src/http/externalWorker.ts` — 4 эндпоинта, request/response/validation (единственный источник истины)
- `src/http/auth.ts` — auth-guard `withAuth`, env-переменные, режимы dev/keycloak
- `src/http/router.ts` — error envelope `{"error":{"code":...,"message":...}}`, HTTP-коды
- `src/core/types.ts` — Job-тип (id, topic, variables, state, retries, lockOwner, lockExpiry, createdAt, available_at, result)
- `src/core/jobStoreTypes.ts` — ErrorCode (NOT_FOUND / NOT_LOCKED / LOCK_EXPIRED / NOT_OWNER / RECORD_IN_PAYLOAD)
- `src/core/inMemoryJobStore.ts` — семантика методов, idempotency, available_at, retry-backoff
- `docs/design/T-0060-worker-endpoint-auth.adr.md` — JWT-контракт, env-переменные KC, 401/503-семантика
- `docs/design/T-0063-retry-reclaim.adr.md` — lock-reclaim, incident-outbox, sweepIntervalMs
- `docs/design/T-0062-idempotency-outbox.adr.md` — idempotencyKey, outbox-паттерн
- `docs/environments.md` — все env-переменные Postgres / Keycloak / choros-app
- `CONCEPT.md` §5 — pull-модель external task; §13 — роадмап

**Зависимости (все DONE на момент SPEC):**
- T-0060 (E1.4) — Bearer JWT auth на 4 эндпоинтах — DONE
- T-0062 (E1.2) — idempotencyKey + outbox — DONE
- T-0063 (E1.3) — lock-reclaim + retry-backoff — DONE
- T-0114 — PostgresJobStore, available_at enforced — DONE

**Куда ложится документ:** `docs/worker-api.md` в репо Choros.
Выбор обоснован: `docs/` — плоская директория на верхнем уровне рядом с `environments.md`;
нет поддиректории `guides/` или `api/` — не создаём. Имя `worker-api.md` согласуется с
тематикой "worker API" и не конфликтует с существующими файлами.

---

## 1. Summary

Написать справочный документ `docs/worker-api.md`, который позволяет внешнему разработчику
поднять воркер на любом языке без чтения исходников Choros. Документ описывает все 4
worker-эндпоинта с request/response-схемами, сверенными с кодом, полный happy-path
walkthrough (enqueue → fetch-and-lock → complete), механику retry/lock-timeout/reclaim,
auth-режимы (dev-stub и Keycloak Bearer JWT) и содержит примеры на curl и Python.

---

## 2. Функциональные требования

- **FR-1 · Все 4 эндпоинта с полными схемами.** Документ описывает все четыре
  worker-эндпоинта из `src/http/externalWorker.ts`:
  - `POST /jobs` — enqueue нового job
  - `POST /external-task/fetch-and-lock` — lock-and-acquire batch
  - `POST /external-task/:id/complete` — success-completion
  - `POST /external-task/:id/fail` — failure + optional retry

  Для каждого: URL, метод, заголовки, request body (все поля, типы, required/optional,
  ограничения из кода), response body (success), HTTP-коды успеха.

- **FR-2 · Схемы сверены с кодом.** Каждое поле в спецификации соответствует
  валидации в `externalWorker.ts` и семантике в `inMemoryJobStore.ts` / `pgJobStore.ts`.
  Никакой инвентаризации "по памяти" — только то, что проверяется кодом.

- **FR-3 · Job-объект задокументирован.** Документ содержит описание Job-объекта
  (все поля `src/core/types.ts`): id, topic, variables, state (CREATED/LOCKED/COMPLETED/FAILED),
  retries, lockOwner, lockExpiry, createdAt, available_at, result.

- **FR-4 · Все коды ошибок задокументированы.** Документ содержит таблицу HTTP-кодов и
  кодов ошибок, реально возвращаемых кодом:
  - `400 VALIDATION` — невалидный request body (перечислены все validation-правила из кода)
  - `400 INVALID_JSON` — тело не JSON или пустое
  - `401 UNAUTHENTICATED` — нет/битый/просроченный/неверный JWT (только при keycloak-режиме)
  - `403 NOT_OWNER` — workerId не совпадает с lockOwner
  - `404 NOT_FOUND` — job с указанным id не существует
  - `409 LOCK_EXPIRED` — лок истёк до вызова complete/fail
  - `409 NOT_LOCKED` — job не в состоянии LOCKED
  - `409 RECORD_IN_PAYLOAD` — payload complete() содержит raw record-объект
  - `413 PAYLOAD_TOO_LARGE` — request body > 1 MiB
  - `503 AUTH_UNAVAILABLE` — Keycloak недоступен (JWKS-таймаут)

  Все коды берутся из `router.ts` mapDomainError + HttpError в handlers.

- **FR-5 · Happy-path walkthrough.** Документ содержит полный пошаговый сценарий:
  enqueue (POST /jobs) → fetch-and-lock (POST /external-task/fetch-and-lock) →
  complete (POST /external-task/:id/complete). Каждый шаг — curl-команда + ответ сервера.

- **FR-6 · Примеры на curl и Python.** Документ содержит:
  - curl-примеры для каждого из 4 эндпоинтов
  - Минимальный рабочий Python-воркер (один модуль, stdlib + requests или httpx):
    fetch-and-lock-цикл → обработка → complete/fail. Не требует установки SDK Choros.

- **FR-7 · Auth-раздел.** Документ описывает оба режима аутентификации из `auth.ts`:
  - Dev-режим (`CHOROS_AUTH_MODE=dev`): заголовок `x-dev-user: <employee-id>`,
    JWT не требуется, для локальной разработки.
  - Keycloak-режим (`CHOROS_AUTH_MODE=keycloak`): `Authorization: Bearer <JWT>`,
    получение токена (client_credentials для агентов, ROPC для людей в dev),
    JWT-claims (iss, aud, actor_type).
  - JWT-claim `actor_type`: `"human"` | `"agent"`.
  - env-переменные auth из `docs/environments.md` секция 7: CHOROS_AUTH_MODE,
    KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_AUDIENCE, JWKS_CACHE_TTL_MS, KC_ISSUER.

- **FR-8 · Retry и lock-timeout раздел.** Документ объясняет механику из кода:
  - `lockDurationMs` — на сколько воркер захватывает задачу
  - `lock_expiry` — когда лок истекает (Unix epoch ms)
  - Lock-reclaim: задача с истёкшим локом возвращается в пул (sweepIntervalMs ≈ 30 с)
  - Семантика `retries` в POST /jobs (initial count) и POST /external-task/:id/fail
    (remaining count after failure): `retries > 0` → job возвращается в CREATED с
    задержкой `retryTimeoutMs`; `retries = 0` → state=FAILED (terminal)
  - `available_at`: задача станет доступна fetchAndLock не раньше этого момента

- **FR-9 · Идемпотентность.** Документ описывает `idempotencyKey` (опциональное поле
  POST /jobs): строка ≤ 255 символов; повторный enqueue с тем же ключом возвращает
  существующий job, не создаёт дубль (AC-2 T-0062).

- **FR-10 · Env-переменные задокументированы.** Документ перечисляет env-переменные
  choros-app из `docs/environments.md` §7, релевантные воркер-подключению:
  PORT, CHOROS_AUTH_MODE, KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_AUDIENCE,
  JWKS_CACHE_TTL_MS, KC_ISSUER — и совпадают ли они с тем, что реально читает `auth.ts`.

---

## 3. Нефункциональные требования

- **NF-1 · Полнота для внешнего разработчика.** Читатель может поднять работающий
  воркер без единого обращения к исходникам. Acceptance-критерий: внешний разработчик
  понимает, как получить первый job за < 30 минут.

- **NF-2 · Один язык-пример (не JS).** Python выбран как пример не-JS воркера:
  он реален (агентский рантайм на Python, CONCEPT §6), прост, широко понятен.
  JS/TS-примеры не нужны — у читателя уже есть curl.

- **NF-3 · Машинная верифицируемость схем.** Fitness-функции (AC) проверяют
  наличие текстовых паттернов в итоговом `docs/worker-api.md` через grep.
  Документ должен содержать названия эндпоинтов, поля и коды в форме,
  доступной grep без парсинга.

- **NF-4 · Синхронизация с environments.md.** Env-переменные в `worker-api.md`
  должны совпадать с env-переменными в `docs/environments.md` (не дрейфовать).

- **NF-5 · Нет runtime-зависимостей.** Документ — Markdown-файл. Никаких
  генераторов, никаких build-шагов. Обновляется вручную при изменении кода.

---

## 4. Out of scope

- Документация non-worker эндпоинтов (inbox, org, rights, grants, processes, audit)
- Развёртывание самого Choros-сервера (это `docs/environments.md`)
- Документация BPMN-процессов и Flowable-интеграции
- OpenAPI/Swagger-генерация (отдельная задача)
- SDK или клиентская библиотека
- Авторизация (RBAC) — только описание аутентификации
- Prod Keycloak TLS (E0.7)

---

## 5. Структура документа (скоуп для BUILD)

BUILD пишет `docs/worker-api.md` со следующими разделами (обязательно для DoD):

```
# Choros External Worker API

## 1. Что такое external worker
## 2. Быстрый старт (happy-path walkthrough: curl)
## 3. Аутентификация
   ### 3.1 Dev-режим (x-dev-user)
   ### 3.2 Keycloak-режим (Bearer JWT)
   ### 3.3 Получение токена (dev-фикстуры)
   ### 3.4 Env-переменные auth
## 4. Типы данных
   ### 4.1 Job-объект
   ### 4.2 Коды ошибок
## 5. Эндпоинты
   ### 5.1 POST /jobs — Enqueue
   ### 5.2 POST /external-task/fetch-and-lock
   ### 5.3 POST /external-task/:id/complete
   ### 5.4 POST /external-task/:id/fail
## 6. Retry и lock-timeout
## 7. Идемпотентность (idempotencyKey)
## 8. Пример воркера на Python
```

---

## 6. Acceptance Criteria

### AC-1 · 4 эндпоинта с request/response схемами
Документ перечисляет все 4 эндпоинта: `POST /jobs`, `POST /external-task/fetch-and-lock`,
`POST /external-task/:id/complete`, `POST /external-task/:id/fail` с request body-полями,
типами, required/optional и response body schema.
**Верификация (fitness):**
```bash
grep -cE 'POST /jobs|POST /external-task/fetch-and-lock|POST /external-task/.*complete|POST /external-task/.*fail' docs/worker-api.md
# Ожидается ≥ 4
```

### AC-2 · Все поля POST /jobs задокументированы
Документ содержит описание полей: `topic` (required, string), `variables` (optional, object),
`retries` (optional, integer ≥ 0), `idempotencyKey` (optional, string ≤ 255).
**Верификация (fitness):**
```bash
grep -cE '\btopic\b|\bvariables\b|\bretries\b|\bidempotencyKey\b' docs/worker-api.md
# Ожидается ≥ 4
```

### AC-3 · Все поля POST /external-task/fetch-and-lock задокументированы
Документ содержит: `workerId` (required), `topics` (required, array of strings),
`maxJobs` (required, integer ≥ 1), `lockDurationMs` (required, integer ≥ 1).
**Верификация (fitness):**
```bash
grep -cE '\bworkerId\b|\btopics\b|\bmaxJobs\b|\blockDurationMs\b' docs/worker-api.md
# Ожидается ≥ 4
```

### AC-4 · Job-объект описан полностью
Документ описывает все поля Job из `src/core/types.ts`:
id, topic, variables, state, retries, lockOwner, lockExpiry, createdAt, available_at.
**Верификация (fitness):**
```bash
grep -cE '\bid\b|\btopic\b|\bvariables\b|\bstate\b|\bretries\b|\blockOwner\b|\blockExpiry\b|\bcreatedAt\b|\bavailable_at\b' docs/worker-api.md
# Ожидается ≥ 9 (каждое поле хотя бы раз)
```

### AC-5 · Все HTTP-коды ошибок задокументированы
Документ содержит все коды из кода: 400, 401, 403, 404, 409, 413, 503 и
соответствующие error-коды: VALIDATION, INVALID_JSON, UNAUTHENTICATED, NOT_OWNER,
NOT_FOUND, LOCK_EXPIRED, NOT_LOCKED, RECORD_IN_PAYLOAD, PAYLOAD_TOO_LARGE, AUTH_UNAVAILABLE.
**Верификация (fitness):**
```bash
grep -cE 'NOT_FOUND|NOT_LOCKED|LOCK_EXPIRED|NOT_OWNER|RECORD_IN_PAYLOAD|UNAUTHENTICATED|AUTH_UNAVAILABLE' docs/worker-api.md
# Ожидается ≥ 7 (все уникальные коды)
```

### AC-6 · Happy-path walkthrough присутствует
Документ содержит последовательность: enqueue → fetch-and-lock → complete с примерами.
**Верификация (fitness):**
```bash
grep -cE 'enqueue|fetch.and.lock|complete' docs/worker-api.md
# Ожидается ≥ 3 (все три шага упомянуты)
```

### AC-7 · curl-примеры для каждого эндпоинта
Документ содержит curl-примеры со значением -X POST и соответствующим URL для всех 4 эндпоинтов.
**Верификация (fitness):**
```bash
grep -c 'curl' docs/worker-api.md
# Ожидается ≥ 4
```

### AC-8 · Python-пример присутствует
Документ содержит блок кода Python (маркер ```python или ```py).
**Верификация (fitness):**
```bash
grep -cE '```python|```py' docs/worker-api.md
# Ожидается ≥ 1
```

### AC-9 · Auth dev-режим и keycloak-режим задокументированы
Документ содержит описание `CHOROS_AUTH_MODE=dev` (x-dev-user-заголовок) и
`CHOROS_AUTH_MODE=keycloak` (Bearer JWT).
**Верификация (fitness):**
```bash
grep -cE 'x-dev-user|Bearer|CHOROS_AUTH_MODE' docs/worker-api.md
# Ожидается ≥ 3
```

### AC-10 · Env-переменные auth совпадают с environments.md
Документ перечисляет CHOROS_AUTH_MODE, KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_AUDIENCE,
JWKS_CACHE_TTL_MS — те же переменные, что в `docs/environments.md` §6–7.
**Верификация (fitness):**
```bash
for var in CHOROS_AUTH_MODE KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_AUDIENCE JWKS_CACHE_TTL_MS; do
  grep -q "$var" docs/worker-api.md || echo "MISSING: $var"
done
# Ожидается: 0 строк вывода (все переменные присутствуют)
```

### AC-11 · Retry-семантика задокументирована
Документ описывает: retries > 0 при fail → job возвращается в CREATED через retryTimeoutMs;
retries = 0 → state=FAILED (terminal); lock-reclaim через ~30 с.
**Верификация (fitness):**
```bash
grep -cE 'retryTimeoutMs|CREATED|FAILED|lock.reclaim|sweepInterval|30' docs/worker-api.md
# Ожидается ≥ 4
```

### AC-12 · idempotencyKey задокументирован
Документ описывает `idempotencyKey` (строка ≤ 255, опциональный), семантику: повторный
enqueue с тем же ключом возвращает существующий job.
**Верификация (fitness):**
```bash
grep -cE 'idempotencyKey|idempotent' docs/worker-api.md
# Ожидается ≥ 2
```

### AC-13 · Документ не ссылается на несуществующие поля или несуществующие коды
Все поля в документе присутствуют в коде. Верификация выполняется ревьюером BUILD
на этапе DoD-сверки: для каждого задокументированного поля — grep в `externalWorker.ts`
или `types.ts`.
**Верификация (manual):** ревьюер проходит по всем request/response схемам документа
и проверяет grep-совпадение в исходниках.

### AC-14 · Документ существует по правильному пути
**Верификация (fitness):**
```bash
test -f docs/worker-api.md && echo OK
# Ожидается: OK
```

---

## 7. Fitness-функции для CI

Все AC-1..AC-12, AC-14 — fitness-проверки через bash-grep. Добавляются в `npm run fitness`
(или отдельный скрипт `ci/checks/worker-api-docs.sh`). Скрипт запускается в `static-now`
CI-джобе (не требует живого сервера, только файловой системы).

```bash
#!/usr/bin/env bash
# ci/checks/worker-api-docs.sh
set -euo pipefail

DOC=docs/worker-api.md

test -f "$DOC" || { echo "FAIL: $DOC not found"; exit 1; }

check() {
  local desc="$1" pattern="$2" min="${3:-1}"
  local count
  count=$(grep -cE "$pattern" "$DOC" || true)
  if [ "$count" -lt "$min" ]; then
    echo "FAIL [$desc]: pattern '$pattern' found $count times, expected >= $min"
    exit 1
  fi
}

check "AC-1 endpoints"    'POST /jobs|POST /external-task/fetch-and-lock|POST /external-task/.*complete|POST /external-task/.*fail' 4
check "AC-2 /jobs fields" '\btopic\b|\bvariables\b|\bretries\b|\bidempotencyKey\b' 4
check "AC-3 fetch fields"  '\bworkerId\b|\btopics\b|\bmaxJobs\b|\blockDurationMs\b' 4
check "AC-4 job fields"    '\bid\b|\btopic\b|\bvariables\b|\bstate\b|\bretries\b|\blockOwner\b|\blockExpiry\b|\bcreatedAt\b|\bavailable_at\b' 9
check "AC-5 error codes"   'NOT_FOUND|NOT_LOCKED|LOCK_EXPIRED|NOT_OWNER|RECORD_IN_PAYLOAD|UNAUTHENTICATED|AUTH_UNAVAILABLE' 7
check "AC-6 walkthrough"   'enqueue|fetch.and.lock|complete' 3
check "AC-7 curl"          'curl' 4
check "AC-8 python"        '```python|```py' 1
check "AC-9 auth modes"    'x-dev-user|Bearer|CHOROS_AUTH_MODE' 3
check "AC-11 retry"        'retryTimeoutMs|CREATED|FAILED|lock.reclaim|sweepInterval|30' 4
check "AC-12 idempotency"  'idempotencyKey|idempotent' 2

# AC-10 env vars
for var in CHOROS_AUTH_MODE KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_AUDIENCE JWKS_CACHE_TTL_MS; do
  grep -q "$var" "$DOC" || { echo "FAIL [AC-10]: env var $var missing from $DOC"; exit 1; }
done

echo "OK: worker-api-docs checks passed"
```

---

## 8. Blocking questions

Нет. Все зависимости (T-0060, T-0062, T-0063, T-0114) DONE. Реализация определяет
контракт однозначно. Python-пример не требует решений от фаундера. Место документа
(`docs/worker-api.md`) не конфликтует с существующей структурой.
