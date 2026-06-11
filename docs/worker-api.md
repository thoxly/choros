# Choros External Worker API

> Reference documentation for connecting an external worker to Choros in any language.
> You do not need to read the Choros source to build a working worker.
>
> **Base URL** (dev): `http://localhost:3000`
> **Content-Type**: all requests and responses use `application/json`.

---

## 1. Что такое external worker

> Запуск сервера: см. [docs/environments.md](environments.md) (dev-режим).

Choros реализует **pull-модель** внешних задач (external task pattern).
Воркер — это любой процесс (на любом языке), который:

1. Вызывает `POST /external-task/fetch-and-lock`, забирая пакет задач под эксклюзивный лок.
2. Выполняет каждую задачу локально.
3. Сообщает результат: `POST /external-task/:id/complete` или `POST /external-task/:id/fail`.

Voркер сам управляет темпом и параллелизмом. Choros не push'ит задачи и не требует
постоянного соединения. Задачи создаются через `POST /jobs` (процессным движком или
любым клиентом) и ждут в очереди до первого fetch-and-lock.

---

## 2. Быстрый старт (happy-path walkthrough)

> Запуск сервера: см. [docs/environments.md](environments.md) (dev-режим).

Три шага: enqueue → fetch-and-lock → complete.

### Шаг 1. Enqueue — создать задачу

```bash
curl -s -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"topic": "invoice.generate", "variables": {"invoiceId": "INV-001"}, "retries": 3}' \
  | jq .
```

Ответ (HTTP 201):

```json
{
  "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "topic": "invoice.generate",
  "variables": { "invoiceId": "INV-001" },
  "state": "CREATED",
  "retries": 3,
  "createdAt": 1718100000000,
  "available_at": 1718100000000
}
```

### Шаг 2. Fetch-and-lock — захватить задачу

```bash
curl -s -X POST http://localhost:3000/external-task/fetch-and-lock \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{
    "workerId": "my-worker-1",
    "topics": ["invoice.generate"],
    "maxJobs": 5,
    "lockDurationMs": 30000
  }' | jq .
```

Ответ (HTTP 200):

```json
{
  "jobs": [
    {
      "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "topic": "invoice.generate",
      "variables": { "invoiceId": "INV-001" },
      "state": "LOCKED",
      "retries": 3,
      "lockOwner": "my-worker-1",
      "lockExpiry": 1718100030000,
      "createdAt": 1718100000000,
      "available_at": 1718100000000
    }
  ]
}
```

Если нет доступных задач по указанным топикам — возвращается `{"jobs": []}`.

### Шаг 3. Complete — сообщить об успехе

```bash
JOB_ID="3f2504e0-4f89-11d3-9a0c-0305e82c3301"

curl -s -X POST "http://localhost:3000/external-task/${JOB_ID}/complete" \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"workerId": "my-worker-1"}' \
  | jq .
```

Ответ (HTTP 200):

```json
{ "ok": true }
```

### Альтернатива: fail с повторной попыткой

Если задача не удалась, а вы хотите, чтобы её подобрал другой воркер через 5 секунд:

```bash
curl -s -X POST "http://localhost:3000/external-task/${JOB_ID}/fail" \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"workerId": "my-worker-1", "retries": 2, "retryTimeoutMs": 5000}' \
  | jq .
```

Ответ (HTTP 200):

```json
{ "ok": true }
```

`retries: 2` — число оставшихся попыток после этой. Если `retries: 0`, задача
переходит в состояние `FAILED` (терминальное).

---

## 3. Аутентификация

Все четыре эндпоинта требуют аутентификации. Режим задаётся переменной окружения
`CHOROS_AUTH_MODE` на сервере Choros.

### 3.1 Dev-режим (CHOROS_AUTH_MODE=dev)

По умолчанию (`CHOROS_AUTH_MODE=dev`). JWT не требуется.
Заголовок `x-dev-user` **опционален**: в dev-режиме `withAuth` — полный no-op,
сервер принимает запросы без проверки идентичности. Если передан, используется
как контекст пользователя (employee-id):

```
x-dev-user: e-kravtsova
```

Используется только для локальной разработки. В prod всегда `keycloak`.

### 3.2 Keycloak-режим (CHOROS_AUTH_MODE=keycloak)

При `CHOROS_AUTH_MODE=keycloak` сервер ожидает JWT Bearer токен в каждом запросе:

```
Authorization: Bearer <JWT>
```

Токен валидируется по JWKS Keycloak. При ошибке валидации — `401 UNAUTHENTICATED`.
При недоступности Keycloak (JWKS timeout 5 с) — `503 AUTH_UNAVAILABLE`.

**JWT claims (контракт T-0054/T-0060):**

| Claim | Ожидаемое значение |
|---|---|
| `iss` | `http://<keycloak-host>/realms/<KEYCLOAK_REALM>` |
| `aud` | включает `choros-api` (значение `KEYCLOAK_AUDIENCE`) |
| `sub` | UUID пользователя (non-empty) |
| `preferred_username` | employee-id или `service-account-<clientId>` |
| `actor_type` | `"human"` или `"agent"` |

Поддерживаемые алгоритмы подписи: `RS256`, `ES256`.
Допустимый clock-skew: ≤ 60 секунд.

### 3.3 Получение токена (dev-фикстуры)

Для тестирования keycloak-режима используйте dev-realm Choros.

**Для человека (ROPC):**

```bash
curl -s -X POST http://localhost:8180/realms/choros/protocol/openid-connect/token \
  -d "grant_type=password" \
  -d "client_id=choros-api" \
  -d "client_secret=choros-api-dev-secret" \
  -d "username=e-kravtsova" \
  -d "password=dev-pw-kravtsova" \
  | jq -r .access_token
```

**Для агента (client_credentials):**

```bash
curl -s -X POST http://localhost:8180/realms/choros/protocol/openid-connect/token \
  -d "grant_type=client_credentials" \
  -d "client_id=agent-orchestrator" \
  -d "client_secret=agent-orchestrator-dev-secret" \
  | jq -r .access_token
```

Используйте полученный токен в заголовке `Authorization: Bearer <token>`.

### 3.4 Env-переменные auth

Следующие переменные окружения управляют аутентификацией на стороне Choros-сервера.
Полная таблица — `docs/environments.md` §6–7.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CHOROS_AUTH_MODE` | `dev` | Режим: `dev` = x-dev-user; `keycloak` = Bearer JWT |
| `KEYCLOAK_URL` | — | Base URL Keycloak (обязателен при `keycloak`-режиме, если не задан `KC_ISSUER`) |
| `KEYCLOAK_REALM` | `choros` | Имя realm |
| `KEYCLOAK_AUDIENCE` | `choros-api` | Ожидаемый `aud` claim JWT |
| `KC_ISSUER` | — | Опциональный override OIDC issuer (приоритет над `KEYCLOAK_URL`+`KEYCLOAK_REALM`) |
| `JWKS_CACHE_TTL_MS` | `300000` | TTL in-memory JWKS-кэша (мс) |

Дополнительно: `PORT` (по умолчанию `3000`) — порт сервера Choros.

---

## 4. Типы данных

### 4.1 Job-объект

Все эндпоинты возвращают объект `Job` (или массив `Job` в fetch-and-lock).

| Поле | Тип | Описание |
|---|---|---|
| `id` | `string` (UUID) | Уникальный идентификатор задачи |
| `topic` | `string` | Тип задачи (например `invoice.generate`) |
| `variables` | `object` | Входные данные задачи; произвольный JSON-объект |
| `state` | `string` enum | Состояние задачи: `CREATED`, `LOCKED`, `COMPLETED`, `FAILED` |
| `retries` | `integer ≥ 0` | Число оставшихся попыток |
| `lockOwner` | `string` (absent when not locked) | `workerId` воркера, удерживающего лок; **отсутствует** когда не залочена |
| `lockExpiry` | `integer` ms epoch (absent when not locked) | Unix epoch ms истечения лока; **отсутствует** когда не залочена |
| `createdAt` | `integer` | Unix epoch ms момента создания задачи |
| `available_at` | `integer` | Unix epoch ms не раньше которого задача доступна для fetch-and-lock |
| `result` | `object \| undefined` | Payload результата complete (если передан); отсутствует если не передавался |

**Жизненный цикл состояний:**

```
CREATED → (fetch-and-lock) → LOCKED → (complete) → COMPLETED
                                     → (fail, retries>0) → CREATED [с задержкой available_at]
                                     → (fail, retries=0) → FAILED
                                     → (lock истёк, reclaim) → CREATED
                                     → (lock истёк, retries=0) → FAILED
```

### 4.2 Коды ошибок

Все ошибки возвращаются в едином конверте:

```json
{ "error": { "code": "NOT_FOUND", "message": "..." } }
```

| HTTP | Code | Когда возникает |
|---|---|---|
| 400 | `VALIDATION` | Невалидный request body: отсутствует обязательное поле, неверный тип, нарушение ограничений |
| 400 | `INVALID_JSON` | Тело запроса не является JSON, пустое, или ошибка чтения потока |
| 401 | `UNAUTHENTICATED` | Нет/битый/просроченный/неверный JWT (только `keycloak`-режим) |
| 403 | `NOT_OWNER` | `workerId` в complete/fail не совпадает с `lockOwner` задачи |
| 404 | `NOT_FOUND` | Задача с указанным `id` не существует |
| 409 | `LOCK_EXPIRED` | Лок задачи истёк до вызова complete/fail |
| 409 | `NOT_LOCKED` | Задача не находится в состоянии `LOCKED` (complete/fail на незалоченную задачу) |
| 409 | `RECORD_IN_PAYLOAD` | Payload complete содержит сырой Job-объект (защита от случайной передачи `job` вместо результата) ¹ |
| 413 | `PAYLOAD_TOO_LARGE` | Тело запроса превышает 1 MiB |
| 503 | `AUTH_UNAVAILABLE` | Keycloak недоступен (JWKS-запрос упал по таймауту 5 с) |

> ¹ `RECORD_IN_PAYLOAD` недостижим через HTTP в текущей версии: обработчик `complete`
> вызывает `store.complete(workerId, jobId)` без payload-аргумента, поэтому ветка
> проверки в `JobStore` никогда не активируется по HTTP-пути. Код задокументирован
> как часть `ErrorCode`-union (FR-4); через внутренний интерфейс `JobStore` он возможен.

---

## 5. Эндпоинты

### 5.1 POST /jobs — Enqueue

Создаёт новую задачу в очереди. Возвращает созданный Job-объект.

**Request:**

```
POST /jobs
Content-Type: application/json
```

| Поле | Тип | Required | Ограничения |
|---|---|---|---|
| `topic` | `string` | Да | Непустая строка |
| `variables` | `object` | Нет | Плоский JSON-объект (не массив, не примитив) |
| `retries` | `integer` | Нет | Целое число ≥ 0; по умолчанию `0` |
| `idempotencyKey` | `string` | Нет | Непустая строка ≤ 255 символов |

**Response (HTTP 201):** полный Job-объект.

**Curl:**

```bash
curl -s -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{
    "topic": "email.send",
    "variables": {"to": "user@example.com", "template": "welcome"},
    "retries": 2,
    "idempotencyKey": "onboarding-email-user-42"
  }'
```

### 5.2 POST /external-task/fetch-and-lock

Захватывает до `maxJobs` задач с одним из указанных топиков под эксклюзивный лок.
Возвращает массив захваченных Job-объектов (может быть пустым).

**Request:**

```
POST /external-task/fetch-and-lock
Content-Type: application/json
```

| Поле | Тип | Required | Ограничения |
|---|---|---|---|
| `workerId` | `string` | Да | Непустая строка; уникальный идентификатор воркера |
| `topics` | `string[]` | Да | Массив строк; может быть пустым (вернёт `[]`) |
| `maxJobs` | `integer` | Да | Целое число ≥ 1 |
| `lockDurationMs` | `integer` | Да | Целое число ≥ 1; мс на которые задача блокируется |

**Response (HTTP 200):**

```json
{ "jobs": [ /* Job[] */ ] }
```

**Curl:**

```bash
curl -s -X POST http://localhost:3000/external-task/fetch-and-lock \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{
    "workerId": "my-worker-1",
    "topics": ["email.send", "invoice.generate"],
    "maxJobs": 10,
    "lockDurationMs": 60000
  }'
```

### 5.3 POST /external-task/:id/complete

Отмечает задачу выполненной. Воркер должен быть текущим `lockOwner`.
Переводит задачу в состояние `COMPLETED`.

**Request:**

```
POST /external-task/:id/complete
Content-Type: application/json
```

| Поле | Тип | Required | Ограничения |
|---|---|---|---|
| `workerId` | `string` | Да | Должен совпадать с `lockOwner` задачи |

**Response (HTTP 200):** `{ "ok": true }`

**Curl:**

```bash
curl -s -X POST "http://localhost:3000/external-task/${JOB_ID}/complete" \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"workerId": "my-worker-1"}'
```

**Возможные ошибки:** `404 NOT_FOUND`, `409 NOT_LOCKED`, `409 LOCK_EXPIRED`,
`403 NOT_OWNER`, `409 RECORD_IN_PAYLOAD`.

### 5.4 POST /external-task/:id/fail

Сообщает об ошибке обработки. Воркер должен быть текущим `lockOwner`.

- Если `retries > 0` — задача возвращается в `CREATED` и становится доступна
  для следующего fetch-and-lock не раньше чем через `retryTimeoutMs` миллисекунд
  (поле `available_at` обновляется).
- Если `retries = 0` — задача переходит в `FAILED` (терминальное состояние).

**Request:**

```
POST /external-task/:id/fail
Content-Type: application/json
```

| Поле | Тип | Required | Ограничения |
|---|---|---|---|
| `workerId` | `string` | Да | Должен совпадать с `lockOwner` задачи |
| `retries` | `integer` | Да | Целое число ≥ 0; число оставшихся попыток ПОСЛЕ этой |
| `retryTimeoutMs` | `integer` | Да | Целое число ≥ 0; задержка перед следующей попыткой (мс) |

**Response (HTTP 200):** `{ "ok": true }`

**Curl:**

```bash
curl -s -X POST "http://localhost:3000/external-task/${JOB_ID}/fail" \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"workerId": "my-worker-1", "retries": 1, "retryTimeoutMs": 10000}'
```

**Возможные ошибки:** `404 NOT_FOUND`, `409 NOT_LOCKED`, `409 LOCK_EXPIRED`,
`403 NOT_OWNER`.

---

## 6. Retry и lock-timeout

### Lock duration и reclaim

При fetch-and-lock задача захватывается на `lockDurationMs` миллисекунд.
Поле `lockExpiry` в Job-объекте содержит Unix epoch ms истечения лока.

Если воркер не вызвал complete/fail до истечения лока — задача **автоматически
возвращается** в доступный пул фоновым sweep-процессом (lock-reclaim).
Sweep запускается каждые `sweepIntervalMs` ≈ 30 секунд.

При lock-reclaim:
- Декрементируется счётчик `retries`
- Если `retries > 0` → задача переходит в `CREATED` (немедленный retry, `available_at = now`)
- Если `retries = 0` → задача переходит в `FAILED` (терминальное)
- В outbox записывается incident `worker_lock_expired`

### Семантика retries

| Сценарий | `retries` в вызове | Результат |
|---|---|---|
| Создание задачи (POST /jobs) | `retries: 3` | задача создаётся с 3 попытками в запасе |
| fail с оставшимися попытками | `retries: 2` | задача → CREATED, `available_at += retryTimeoutMs` |
| fail без попыток | `retries: 0` | задача → FAILED (terminal) |
| lock expired, retries > 0 | — | sweep → CREATED, `available_at = now` (немедленно) |
| lock expired, retries = 0 | — | sweep → FAILED (terminal) |

> **Важно:** `retries` в `POST /external-task/:id/fail` — это число оставшихся попыток
> **после** текущей неудачи, которое вы передаёте явно. Choros не ведёт автоматический
> счётчик на стороне сервера при fail; его ведёт воркер (берёт `job.retries` и
> передаёт уменьшенное значение).

### available_at

Поле `available_at` (Unix epoch ms) определяет момент, не раньше которого задача
станет видна для fetch-and-lock. При создании равно `createdAt`. После fail с
`retryTimeoutMs > 0` устанавливается в `now + retryTimeoutMs`.

---

## 7. Идемпотентность (idempotencyKey)

Поле `idempotencyKey` в `POST /jobs` — опциональная строка ≤ 255 символов.

**Семантика:** повторный enqueue с тем же `idempotencyKey` не создаёт дубль — сервер
возвращает **существующий** Job-объект (HTTP 201) без изменений.

Это идемпотентный enqueue: безопасно вызывать несколько раз (при retry сети, at-least-once
доставке) — задача будет создана ровно один раз.

Если `idempotencyKey` не передан — каждый вызов создаёт новую задачу.

```bash
# Первый вызов — создаст задачу
curl -s -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"topic": "report.build", "idempotencyKey": "monthly-report-2026-06"}'

# Повторный вызов с тем же ключом — вернёт ту же задачу, не создаст новую
curl -s -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "x-dev-user: e-kravtsova" \
  -d '{"topic": "report.build", "idempotencyKey": "monthly-report-2026-06"}'
```

---

## 8. Пример воркера на Python

Минимальный рабочий воркер на Python (stdlib + `urllib`), без SDK Choros.
Реализует poll-цикл: fetch-and-lock → выполнение → complete/fail.

```python
"""
Choros external worker — минимальный пример на Python stdlib.
Не требует установки Choros SDK или сторонних пакетов.

Использование:
  python worker.py

Env vars (опционально):
  CHOROS_BASE_URL   — базовый URL сервера (по умолчанию http://localhost:3000)
  CHOROS_WORKER_ID  — идентификатор воркера (по умолчанию python-worker-1)
  CHOROS_DEV_USER   — x-dev-user заголовок для dev-режима (по умолчанию e-kravtsova)
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE_URL = os.environ.get("CHOROS_BASE_URL", "http://localhost:3000")
WORKER_ID = os.environ.get("CHOROS_WORKER_ID", "python-worker-1")
DEV_USER = os.environ.get("CHOROS_DEV_USER", "e-kravtsova")

# dev-режим: x-dev-user; для keycloak-режима замените на:
# HEADERS = {"Content-Type": "application/json", "Authorization": "Bearer <JWT>"}
HEADERS = {
    "Content-Type": "application/json",
    "x-dev-user": DEV_USER,
}

TOPICS = ["invoice.generate", "email.send"]
MAX_JOBS = 5
LOCK_DURATION_MS = 30_000   # 30 секунд
POLL_INTERVAL_S = 1.0       # пауза при пустой очереди


def http_post(path: str, payload: dict) -> dict:
    """Отправляет POST-запрос на Choros, возвращает распарсенный JSON."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=f"{BASE_URL}{path}",
        data=data,
        headers=HEADERS,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        raise RuntimeError(f"HTTP {e.code} {path}: {body}") from e


def complete_job(job_id: str) -> None:
    http_post(f"/external-task/{job_id}/complete", {"workerId": WORKER_ID})
    print(f"  [complete] job {job_id}")


def fail_job(job_id: str, retries_remaining: int, retry_timeout_ms: int = 5_000) -> None:
    http_post(f"/external-task/{job_id}/fail", {
        "workerId": WORKER_ID,
        "retries": retries_remaining,
        "retryTimeoutMs": retry_timeout_ms,
    })
    print(f"  [fail] job {job_id}, retries left: {retries_remaining}")


def handle(job: dict) -> None:
    """
    Ваша бизнес-логика здесь. Бросьте исключение чтобы сигнализировать об ошибке.
    """
    topic = job["topic"]
    variables = job["variables"]
    print(f"  [handle] topic={topic} id={job['id']} vars={variables}")
    # TODO: реальная обработка по топику
    # raise ValueError("something went wrong")  # → fail_job


def run_worker() -> None:
    print(f"Choros worker started: workerId={WORKER_ID}, topics={TOPICS}")
    while True:
        try:
            result = http_post("/external-task/fetch-and-lock", {
                "workerId": WORKER_ID,
                "topics": TOPICS,
                "maxJobs": MAX_JOBS,
                "lockDurationMs": LOCK_DURATION_MS,
            })
        except RuntimeError as e:
            print(f"[fetch-and-lock error] {e}")
            time.sleep(POLL_INTERVAL_S)
            continue

        jobs = result.get("jobs", [])

        if not jobs:
            time.sleep(POLL_INTERVAL_S)
            continue

        for job in jobs:
            job_id = job["id"]
            retries = job["retries"]
            try:
                handle(job)
                complete_job(job_id)
            except Exception as e:
                print(f"  [error] job {job_id}: {e}")
                remaining = max(0, retries - 1)
                try:
                    fail_job(job_id, retries_remaining=remaining, retry_timeout_ms=5_000)
                except RuntimeError as fe:
                    # Лок мог уже истечь (LOCK_EXPIRED) — логируем и идём дальше
                    print(f"  [fail error] {fe}")


if __name__ == "__main__":
    run_worker()
```

### Keycloak-режим

Замените `HEADERS` на:

```python
import urllib.request

token = "<JWT полученный через client_credentials или ROPC>"
HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {token}",
}
```

Для автоматического получения токена агентом:

```python
def fetch_token(keycloak_url: str, realm: str, client_id: str, client_secret: str) -> str:
    data = (
        f"grant_type=client_credentials"
        f"&client_id={client_id}"
        f"&client_secret={client_secret}"
    ).encode("utf-8")
    req = urllib.request.Request(
        url=f"{keycloak_url}/realms/{realm}/protocol/openid-connect/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))["access_token"]
```
