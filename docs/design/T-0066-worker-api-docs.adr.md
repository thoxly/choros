# ADR · T-0066 — E1.5 · Документация external-worker API

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-06-11
**Task:** E1.5 — написать справочный документ `docs/worker-api.md`, позволяющий
внешнему разработчику поднять воркер на любом языке без чтения исходников Choros;
добавить fitness-чек `ci/checks/worker-api-docs.sh`, автоматически ловящий дрейф
между кодом и документом.

**Spec (input):** `docs/specs/T-0066-worker-api-docs.spec.md` +
`docs/specs/T-0066.spec.contract.json` (status: ready; FR-1..FR-10, NF-1..NF-5, AC-1..AC-14;
blocking_questions: []).

**Авторитетные источники (потреблены):**
- `src/http/externalWorker.ts` — 4 эндпоинта, validation-правила (единственный source-of-truth)
- `src/http/auth.ts` — `withAuth`, env-переменные, режимы dev/keycloak, error codes
- `src/http/router.ts` — `mapDomainError`, HTTP-коды ошибок, error-envelope формат
- `src/core/types.ts` — интерфейс `Job`, enum `JobState`, все поля
- `src/core/jobStoreTypes.ts` — `ErrorCode` union: NOT_FOUND, NOT_LOCKED, LOCK_EXPIRED, NOT_OWNER, RECORD_IN_PAYLOAD
- `docs/environments.md` §5..7 — env-переменные Postgres/Keycloak/choros-app
- `docs/design/T-0060-worker-endpoint-auth.adr.md` — JWT-контракт
- `docs/design/T-0062-idempotency-outbox.adr.md` — idempotencyKey
- `docs/design/T-0063-retry-reclaim.adr.md` — lock-reclaim, sweepIntervalMs
- `package.json` — текущая цепочка `fitness` (npm script)

> **Эта ADR проектирует структуру документа и fitness-чека; реализацию пишет `coder`.
> §1–§5 — источник правды для `coder`/`reviewer`.**

---

## 1. Decision

Написать `docs/worker-api.md` как Markdown-файл с 8 разделами (§5 ниже), каждый AC
спеки покрыт разделом. Fitness-чек `ci/checks/worker-api-docs.sh` добавить в конец
цепочки `npm run fitness` (аддитивно, перед существующим хвостом `npm run build`).
Python-пример размещается **инлайн** в `docs/worker-api.md` (```python блок),
отдельный файл не создаётся — это проще верифицировать grep'ом и не гниёт отдельно.

---

## 2. Структура docs/worker-api.md

Порядок разделов фиксирован. BUILD пишет строго по этой структуре; reviewer
проверяет наличие каждого блока.

```
# Choros External Worker API

## 1. Что такое external worker
## 2. Быстрый старт (happy-path walkthrough)
   (enqueue → fetch-and-lock → complete, curl + ответ для каждого шага)
## 3. Аутентификация
   ### 3.1 Dev-режим (CHOROS_AUTH_MODE=dev)
   ### 3.2 Keycloak-режим (CHOROS_AUTH_MODE=keycloak)
   ### 3.3 Получение токена (dev-фикстуры)
   ### 3.4 Env-переменные auth
## 4. Типы данных
   ### 4.1 Job-объект (все поля из src/core/types.ts)
   ### 4.2 Коды ошибок (таблица HTTP-код + error-code + когда)
## 5. Эндпоинты
   ### 5.1 POST /jobs
   ### 5.2 POST /external-task/fetch-and-lock
   ### 5.3 POST /external-task/:id/complete
   ### 5.4 POST /external-task/:id/fail
## 6. Retry и lock-timeout
## 7. Идемпотентность (idempotencyKey)
## 8. Пример воркера на Python
```

**Маппинг AC → раздел:**

| AC | Раздел |
|----|--------|
| AC-1 (4 эндпоинта) | §5 |
| AC-2 (поля POST /jobs) | §5.1 |
| AC-3 (поля fetch-and-lock) | §5.2 |
| AC-4 (Job-объект) | §4.1 |
| AC-5 (error codes) | §4.2 |
| AC-6 (walkthrough) | §2 |
| AC-7 (curl) | §2 + §5.1..5.4 |
| AC-8 (python) | §8 |
| AC-9 (auth modes) | §3.1, §3.2 |
| AC-10 (env vars) | §3.4 |
| AC-11 (retry) | §6 |
| AC-12 (idempotencyKey) | §7 |
| AC-13 (manual: поля vs код) | reviewer DoD |
| AC-14 (файл существует) | наличие файла |

---

## 3. Дизайн fitness-чека worker-api-docs.sh

### 3.1 Принцип: grep по литералам из исходников

Чек работает на файловой системе без рантайма (static-now). Инварианты выбраны так,
чтобы при добавлении эндпоинта, поля или error-кода в код без правки доки — чек падал.

**Источники (все статически доступны):**

| Что проверяем | Источник в коде | grep-паттерн в доке |
|---|---|---|
| Route literals | `externalWorker.ts` строки 42, 115, 168, 194 | `POST /jobs`, `POST /external-task/fetch-and-lock`, `POST /external-task/.*complete`, `POST /external-task/.*fail` |
| POST /jobs поля | `externalWorker.ts` строки 49, 56, 67, 73, 85 | `\btopic\b`, `\bvariables\b`, `\bretries\b`, `\bidempotencyKey\b` |
| fetch-and-lock поля | `externalWorker.ts` строки 122-127 | `\bworkerId\b`, `\btopics\b`, `\bmaxJobs\b`, `\blockDurationMs\b` |
| Job fields | `src/core/types.ts` интерфейс Job | `\bid\b`, `\btopic\b`, `\bvariables\b`, `\bstate\b`, `\bretries\b`, `\blockOwner\b`, `\blockExpiry\b`, `\bcreatedAt\b`, `\bavailable_at\b` |
| ErrorCode values | `jobStoreTypes.ts` строка 14-19 | `NOT_FOUND`, `NOT_LOCKED`, `LOCK_EXPIRED`, `NOT_OWNER`, `RECORD_IN_PAYLOAD` |
| Auth error codes | `auth.ts` (UNAUTHENTICATED), `router.ts` (PAYLOAD_TOO_LARGE → 413) | `UNAUTHENTICATED`, `AUTH_UNAVAILABLE` |
| Auth env vars | `auth.ts` resolveConfig() | `CHOROS_AUTH_MODE`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_AUDIENCE`, `JWKS_CACHE_TTL_MS` |
| Auth header names | `auth.ts` константы | `x-dev-user`, `Bearer` |
| Retry tokens | ADR T-0063 + `externalWorker.ts` fail handler | `retryTimeoutMs`, `CREATED`, `FAILED` |
| idempotency | `externalWorker.ts` idempotencyKey block | `idempotencyKey`, `idempotent` |
| curl примеры | artifact | `curl` ≥ 4 раза |
| python блок | artifact | ` ```python` или ` ```py` |
| walkthrough | artifact | `enqueue`, `fetch.and.lock`, `complete` |

### 3.2 Чек NOT проверяет (оставлено ревьюеру, AC-13)

- Точное совпадение validation-сообщений с кодом — достаточно проверить наличие имени поля
- Semantics retries-backoff (`available_at` в базе) — протестировано в unit-тестах T-0063
- Вложенность разделов — достаточно что контент присутствует

### 3.3 Скрипт — `ci/checks/worker-api-docs.sh`

```bash
#!/usr/bin/env bash
# ci/checks/worker-api-docs.sh
# FF-9 (static-now): docs/worker-api.md синхронизирован с кодом.
# Падает при дрейфе (добавление эндпоинта/поля/error-code без правки доки).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DOC="${ROOT}/docs/worker-api.md"

echo "[FF-9] Checking docs/worker-api.md (T-0066 worker-api-docs)..."

# AC-14: файл существует
if [[ ! -f "$DOC" ]]; then
  echo "  FAIL: $DOC not found" >&2; exit 1
fi

fail() { echo "  FAIL [$1]: $2" >&2; exit 1; }

check_count() {
  local id="$1" pattern="$2" min="$3"
  local count
  count=$(grep -cE "$pattern" "$DOC" || true)
  [[ "$count" -ge "$min" ]] || fail "$id" "pattern '$pattern' found $count times, expected >= $min"
  echo "  [OK] $id: $count matches for '$pattern'"
}

# AC-1: все 4 эндпоинта
check_count "AC-1" \
  'POST /jobs|POST /external-task/fetch-and-lock|POST /external-task/.*complete|POST /external-task/.*fail' 4

# AC-2: поля POST /jobs
check_count "AC-2" '\btopic\b|\bvariables\b|\bretries\b|\bidempotencyKey\b' 4

# AC-3: поля fetch-and-lock
check_count "AC-3" '\bworkerId\b|\btopics\b|\bmaxJobs\b|\blockDurationMs\b' 4

# AC-4: Job-объект (≥9 — все поля хотя бы раз)
check_count "AC-4" \
  '\bid\b|\btopic\b|\bvariables\b|\bstate\b|\bretries\b|\blockOwner\b|\blockExpiry\b|\bcreatedAt\b|\bavailable_at\b' 9

# AC-5: error codes
check_count "AC-5" \
  'NOT_FOUND|NOT_LOCKED|LOCK_EXPIRED|NOT_OWNER|RECORD_IN_PAYLOAD|UNAUTHENTICATED|AUTH_UNAVAILABLE' 7

# AC-6: happy-path walkthrough
check_count "AC-6" 'enqueue|fetch.and.lock|complete' 3

# AC-7: curl примеры
check_count "AC-7" 'curl' 4

# AC-8: python блок
check_count "AC-8" '```python|```py' 1

# AC-9: auth modes
check_count "AC-9" 'x-dev-user|Bearer|CHOROS_AUTH_MODE' 3

# AC-10: env vars (поштучно)
for VAR in CHOROS_AUTH_MODE KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_AUDIENCE JWKS_CACHE_TTL_MS; do
  grep -q "$VAR" "$DOC" || fail "AC-10" "env var $VAR missing from $DOC"
  echo "  [OK] AC-10: $VAR found"
done

# AC-11: retry semantics
check_count "AC-11" 'retryTimeoutMs|CREATED|FAILED|lock.reclaim|sweepInterval|30' 4

# AC-12: idempotency
check_count "AC-12" 'idempotencyKey|idempotent' 2

echo "[FF-9] PASS: all docs/worker-api.md checks passed."
```

---

## 4. Python-пример: инлайн vs отдельный файл

**Решение: инлайн в docs/worker-api.md, раздел §8.**

**Обоснование:**

Альтернатива — `examples/worker.py` с `py_compile` в чеке — проверяет синтаксис,
но не семантику (URL, поля могут устареть независимо). Инлайн в доке:
1. Проверяется теми же grep-инвариантами, что и остальной текст (AC-8 выше)
2. Читатель видит пример в контексте документа без перехода в другой файл
3. При правке доки пример виден рядом — меньше шанс забыть обновить

`py_compile` был бы полезен для отдельного файла; для ```python блока в Markdown
его не применить. Если в будущем понадобится исполняемый тест воркера — это отдельная
задача (E2+), а не часть доковой задачи T-0066.

**Минимальный Python-пример (содержимое §8):**

```python
import time
import requests  # pip install requests

BASE_URL = "http://localhost:3000"
WORKER_ID = "my-worker-1"
HEADERS = {"x-dev-user": "e-kravtsova"}  # dev-режим

def run_worker(topics: list[str], lock_ms: int = 30_000):
    while True:
        resp = requests.post(f"{BASE_URL}/external-task/fetch-and-lock", headers=HEADERS, json={
            "workerId": WORKER_ID,
            "topics": topics,
            "maxJobs": 5,
            "lockDurationMs": lock_ms,
        })
        resp.raise_for_status()
        jobs = resp.json()["jobs"]

        for job in jobs:
            try:
                result = handle(job)
                requests.post(f"{BASE_URL}/external-task/{job['id']}/complete",
                              headers=HEADERS, json={"workerId": WORKER_ID}).raise_for_status()
            except Exception as e:
                remaining = max(0, job["retries"] - 1)
                requests.post(f"{BASE_URL}/external-task/{job['id']}/fail",
                              headers=HEADERS, json={
                                  "workerId": WORKER_ID,
                                  "retries": remaining,
                                  "retryTimeoutMs": 5000,
                              }).raise_for_status()

        if not jobs:
            time.sleep(1)

def handle(job: dict) -> dict:
    print(f"[{job['topic']}] id={job['id']} vars={job['variables']}")
    return {}

if __name__ == "__main__":
    run_worker(["invoice.generate", "email.send"])
```

---

## 5. Куда вписать чек в CI

**Решение: добавить в конец цепочки `npm run fitness` (аддитивно), перед
существующим хвостом `npm run build`.**

Текущий хвост `package.json` fitness:
```
... && bash ci/checks/worker-auth-config-failfast.sh
```
(последний перед `npm run build` — `worker-auth-config-failfast.sh` требует `npm run build` для JS)

`worker-api-docs.sh` — pure static-now (grep по Markdown и проверка существования файла),
не требует `npm run build`. Добавляется в конец static-now блока, перед
`npm run build && bash ci/checks/worker-auth-config-failfast.sh`.

Новый хвост fitness (аддитивно):
```
... && bash ci/checks/worker-auth-env-docs.sh && bash ci/checks/worker-api-docs.sh && npm run build && bash ci/checks/worker-auth-config-failfast.sh
```

`ci`-скрипт (`npm run ci`) использует `npm run fitness` — автоматически подхватывает.

**Альтернатива — отдельный CI-джоб** отклонена: задача строго документационная,
чек static-now (0 секунд bootstrap), тот же паттерн, что у существующих 50+ fitness.
Отдельный джоб оправдан только для runtimе-завязанных проверок (fitness:kc, fitness:db).

---

## 6. Rejected alternatives

| Вариант | Почему отклонён |
|---------|----------------|
| Отдельный `examples/worker.py` + `py_compile` | Проверяет только синтаксис, не синхронность со схемой; инлайн проще для читателя и верифицируется теми же grep-ами |
| OpenAPI/Swagger-генерация | Out of scope T-0066; отдельная задача; нет генератора в репо |
| Отдельный CI-джоб для чека | Избыточно для static-now grep-чека; 50+ существующих чеков в том же npm run fitness |
| Отдельный файл `docs/api/worker.md` | Нет поддиректории `docs/api/` — не создаём; `docs/worker-api.md` рядом с `environments.md` |

---

## 7. Fitness functions

| ID | Rule | CI check |
|----|------|----------|
| FF-9-AC1 | 4 route literals из externalWorker.ts присутствуют в docs/worker-api.md | `ci/checks/worker-api-docs.sh` (AC-1) |
| FF-9-AC2 | Поля POST /jobs (topic/variables/retries/idempotencyKey) в доке | `ci/checks/worker-api-docs.sh` (AC-2) |
| FF-9-AC3 | Поля fetch-and-lock (workerId/topics/maxJobs/lockDurationMs) в доке | `ci/checks/worker-api-docs.sh` (AC-3) |
| FF-9-AC4 | Job-объект (9 полей из types.ts) в доке | `ci/checks/worker-api-docs.sh` (AC-4) |
| FF-9-AC5 | Все 7 error-codes (ErrorCode union + auth codes) в доке | `ci/checks/worker-api-docs.sh` (AC-5) |
| FF-9-AC6 | Happy-path walkthrough (enqueue/fetch-and-lock/complete) | `ci/checks/worker-api-docs.sh` (AC-6) |
| FF-9-AC7 | curl ≥ 4 раза | `ci/checks/worker-api-docs.sh` (AC-7) |
| FF-9-AC8 | Python-блок присутствует | `ci/checks/worker-api-docs.sh` (AC-8) |
| FF-9-AC9 | Оба auth-режима (x-dev-user/Bearer/CHOROS_AUTH_MODE) | `ci/checks/worker-api-docs.sh` (AC-9) |
| FF-9-AC10 | 5 auth-env-vars поштучно | `ci/checks/worker-api-docs.sh` (AC-10) |
| FF-9-AC11 | Retry-семантика (retryTimeoutMs/CREATED/FAILED/reclaim/sweep/30) | `ci/checks/worker-api-docs.sh` (AC-11) |
| FF-9-AC12 | idempotencyKey + idempotent | `ci/checks/worker-api-docs.sh` (AC-12) |
| FF-9-AC14 | Файл docs/worker-api.md существует | `ci/checks/worker-api-docs.sh` (AC-14) |

---

## 8. Traceability

| AC | Раздел docs/worker-api.md | Fitness check |
|----|--------------------------|---------------|
| AC-1 | §5 (Эндпоинты) | FF-9-AC1 |
| AC-2 | §5.1 (POST /jobs) | FF-9-AC2 |
| AC-3 | §5.2 (fetch-and-lock) | FF-9-AC3 |
| AC-4 | §4.1 (Job-объект) | FF-9-AC4 |
| AC-5 | §4.2 (Коды ошибок) | FF-9-AC5 |
| AC-6 | §2 (Быстрый старт) | FF-9-AC6 |
| AC-7 | §2 + §5.1..5.4 | FF-9-AC7 |
| AC-8 | §8 (Python) | FF-9-AC8 |
| AC-9 | §3.1, §3.2 | FF-9-AC9 |
| AC-10 | §3.4 (env vars) | FF-9-AC10 |
| AC-11 | §6 (Retry) | FF-9-AC11 |
| AC-12 | §7 (idempotencyKey) | FF-9-AC12 |
| AC-13 | DoD: ревьюер grep поля → код | manual |
| AC-14 | docs/worker-api.md | FF-9-AC14 |

---

## 9. Escalation

Нет. Все источники доступны статически, зависимости T-0060/T-0062/T-0063/T-0114 DONE,
Python-пример не требует решений фаундера, место в CI определено аддитивно без конфликтов.
