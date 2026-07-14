# Spec · T-0060 — Auth эндпоинтов воркера (E1.4)

**Title:** E1.4 · JWT-аутентификация на эндпоинтах external worker: enqueue / fetch-and-lock / complete / fail
**Status:** ready (нет блокирующих вопросов)
**Phase:** SPEC
**Date:** 2026-06-11
**Task type:** standard_code

**Авторитетные источники (не переоткрывать):**
- `playbooks/mvp-backlog.md` E1.4 — «Валидация Keycloak-токена на enqueue/fetch-and-lock/complete/fail. Acceptance: запрос без токена отклонён; сервис-аккаунт воркера проходит.»
- `docs/design/T-0054-keycloak-compose.adr.md` §4.1 (JWT contract frozen) + §4.2 (CHOROS_AUTH_MODE seam) + §4.5 (scope boundary vs T-0060)
- `docs/design/tenancy-and-delivery.md` §6 — «Обязательно day-1: ядро валидирует `iss` / `aud` / `tenant-claim` на каждом запросе.»
- `CONCEPT.md` §5 (external worker API, pull-модель) + §6 (Identity = Keycloak) + §8 (OAuth 2.0 / mTLS для агентов; сервис-аккаунт на агента)
- `src/http/auth.ts` (AUTH_MODE seam, заглушка stub до T-0060)
- `src/http/externalWorker.ts` (4 эндпоинта без аутентификации)

**Зависимости (должны быть выполнены до DESIGN):**
- **T-0054 (E0.4)** — Keycloak в compose + realm `choros` + JWT contract frozen. Статус: DONE.
- **T-0020 (E5.1)** — `agent_card` schema, колонка `kc_client_id` (FK-linkage key от KC service-account до employee). Статус: DONE (migrations/032_agent_card.sql).
- **T-0022 (E3.2)** — таблицы `role` / `role_assignment` (identity spine). Статус: DONE (migrations 019–021 в этой ветке).

**Границы с сёстрами (работают параллельно — не залезать в их скоуп):**
- **T-0042 (E5.2)** — владеет СОЗДАНИЕМ агентов и KC service-account'ов. T-0060 лишь ПОТРЕБЛЯЕТ уже выпущенный токен.
- **T-0024 (E5.4)** — владеет invoke-grant'ами и request/command-split. T-0060 не трогает grant-решения.

**Constraint для DESIGN (DB-migration seam):**
Если потребуется таблица для JWKS-кэша или аудита auth-решений — зарезервированный номер миграции **041** (042 занята T-0042, 043 — T-0043). При отсутствии нужды в БД-артефакте миграция 041 не создаётся.

---

## 1. Summary

Активировать ветку `keycloak` в `AUTH_MODE`-заглушке `src/http/auth.ts` и защитить четыре worker-эндпоинта (`POST /jobs`, `POST /external-task/fetch-and-lock`, `POST /external-task/:id/complete`, `POST /external-task/:id/fail`) Bearer JWT-аутентификацией: проверить подпись через Keycloak JWKS, валидировать claims (`iss`, `aud`, `actor_type`) и отклонять запросы без токена или с невалидным токеном с кодом 401. Существующий dev-auth путь (`x-dev-user`, `CHOROS_AUTH_MODE=dev`) остаётся нетронутым.

---

## 2. Функциональные требования

- **FR-1 · Middleware auth-guard.** Запросы ко всем четырём worker-эндпоинтам проходят через единый middleware-guard (одна точка ветвления по `CHOROS_AUTH_MODE`), вызываемый до исполнения бизнес-логики обработчика. Разброс проверки по N обработчикам — не допускается.

- **FR-2 · Валидация Bearer JWT (режим `keycloak`).** В режиме `CHOROS_AUTH_MODE=keycloak` guard извлекает токен из заголовка `Authorization: Bearer <token>`. Если заголовка нет или формат неверный — `401 UNAUTHENTICATED`. Токен проверяется против JWKS Keycloak. Ключи JWKS получаются по `OIDC Discovery URL` (`{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/.well-known/openid-configuration` → `jwks_uri`) или напрямую по `KEYCLOAK_JWKS_URI`.

- **FR-3 · Проверка обязательных claims.** Guard проверяет:
  - `iss` — совпадает с `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}` (настраивается через env).
  - `aud` — содержит `choros-api` (зафиксировано T-0054 §4.1).
  - `exp` — токен не истёк.
  - `actor_type` — значение `"human"` или `"agent"` (выдаётся mapper'ом T-0054 §3.3). Отсутствие `actor_type` — `401`.

- **FR-4 · Идентификатор вызывающего.** После успешной проверки guard делает доступным для обработчика идентификатор субъекта: `sub` (UUID из KC) и `preferred_username`. Эти данные НЕ записываются в аудит-лог в рамках данной задачи (E2 spin, T-0016 scope), но должны быть доступны в request-контексте.

- **FR-5 · Dev-mode без изменений.** При `CHOROS_AUTH_MODE=dev` (или отсутствии переменной) guard не активируется на worker-эндпоинтах: токен не требуется, `x-dev-user` работает как прежде. Существующие тесты `externalWorker.e2e.test.ts` и `auth.e2e.test.ts` не изменяются и проходят без Keycloak.

- **FR-6 · JWKS-кэширование.** JWKS-ключи кэшируются в памяти процесса (TTL ≥ 5 мин). Срок жизни кэша настраивается через env `JWKS_CACHE_TTL_MS`. При 401 от KC (ключ проротирован) кэш инвалидируется и ключи перезапрашиваются единожды; повторный провал → 401 клиенту.

- **FR-7 · Env-переменные конфигурации.** Guard читает конфигурацию из:
  - `CHOROS_AUTH_MODE` — `"dev"` (default) | `"keycloak"`.
  - `KEYCLOAK_URL` — base URL Keycloak (например `http://localhost:8180`). Обязательно в режиме `keycloak`.
  - `KEYCLOAK_REALM` — имя realm (default: `"choros"`).
  - `KEYCLOAK_AUDIENCE` — ожидаемая аудитория (default: `"choros-api"`).
  - `JWKS_CACHE_TTL_MS` — TTL JWKS-кэша в мс (default: `300000` = 5 мин).

- **FR-8 · HTTP-стек без внешних зависимостей.** Код guard пишется на stdlib (`node:https` / `node:http`) без npm-зависимостей от сторонних JWT-библиотек (конвенция проекта: zero-dep stdlib). Парсинг JWT (base64-decode, JSON parse, RS256-verify через `node:crypto`) реализуется нативными средствами Node.js ≥ 18.

---

## 3. Нефункциональные требования

- **NF-1 · Zero-dep.** Без новых npm-зависимостей. Только stdlib Node.js.

- **NF-2 · Обратная совместимость.** `DEV_USER_HEADER`, `registerAuthRoutes`, `registerExternalWorkerRoutes`, `createServer` — сигнатуры публичных экспортов не меняются. `AUTH_MODE` остаётся внутренней константой (не экспортируется).

- **NF-3 · Latency overhead.** При горячем JWKS-кэше проверка токена добавляет ≤ 2 мс на запрос (крипто на Node.js ≤ 1 мс для RS256 на типичном железе; кэш не требует сетевого хопа).

- **NF-4 · Fail-closed.** Любая ошибка при валидации токена (невалидный JWT, таймаут JWKS-запроса, неверный claim) → 401, не 500. Внутренняя ошибка инфраструктуры (KC недоступен) → 503 с кодом `AUTH_UNAVAILABLE` (не раскрывать детали в теле ответа).

- **NF-5 · Secret-не-в-коде.** Конфигурация guard через env vars; ни один dev-секрет не коммитится в TS-код.

- **NF-6 · CI-compatibility.** Тесты `CHOROS_AUTH_MODE=keycloak`-ветки запускаются в `live-kc` CI-джобе (использующем `docker compose up keycloak` из T-0054). `live-dev` CI-джоб (существующий) использует `CHOROS_AUTH_MODE=dev`; guard не активен — Keycloak не нужен.

---

## 4. Out of scope

- Создание KC service-account'ов и provisioning агентов — T-0042.
- Invoke-grant'ы и request/command-split — T-0024.
- Авторизация (RBAC — «что субъекту можно делать»). T-0060 выполняет только **аутентификацию** («кто вызывающий»). Авторизация worker-вызовов — отдельная задача (не определена в текущем бэклоге E1).
- Запись auth-события в аудит-лог — T-0016/E2 scope.
- Ротация KC realm key без downtime — E0.7 (prod-конфигурация).
- mTLS — явно исключён для MVP (§8 CONCEPT.md: OAuth 2.0 или mTLS, для MVP выбран OAuth 2.0).
- Аутентификация на non-worker эндпоинтах (inbox, org, grants, rights, processes). Они остаются за `x-dev-user` dev-stub'ом до выхода полноценного auth для UI (отдельная задача).
- Кастомные Keycloak SPI / extensions.

---

## 5. Критерии приёмки

### Группа A — режим `CHOROS_AUTH_MODE=dev` (регрессия не нарушена)

| ID | Текст | Верификация |
|---|---|---|
| AC-1 | `externalWorker.e2e.test.ts` — все тесты зелёные при `CHOROS_AUTH_MODE=dev` (или unset), Keycloak не запущен | test |
| AC-2 | `auth.e2e.test.ts` — все тесты зелёные при `CHOROS_AUTH_MODE=dev`, поведение `/api/me` с `x-dev-user` неизменно | test |

### Группа B — режим `CHOROS_AUTH_MODE=keycloak` (новое поведение)

| ID | Текст | Верификация |
|---|---|---|
| AC-3 | `POST /jobs` без заголовка `Authorization` → HTTP 401, тело `{"error":{"code":"UNAUTHENTICATED","message":"..."}}` | test |
| AC-4 | `POST /external-task/fetch-and-lock` без `Authorization` → HTTP 401 | test |
| AC-5 | `POST /external-task/:id/complete` без `Authorization` → HTTP 401 | test |
| AC-6 | `POST /external-task/:id/fail` без `Authorization` → HTTP 401 | test |
| AC-7 | `Authorization: Bearer <malformed>` (не JWT) → HTTP 401 | test |
| AC-8 | JWT с неверной подписью (подписан другим ключом) → HTTP 401 | test |
| AC-9 | JWT с истёкшим `exp` → HTTP 401 | test |
| AC-10 | JWT с неверным `iss` (не `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}`) → HTTP 401 | test |
| AC-11 | JWT без `aud: choros-api` (или несовпадающей аудиторией) → HTTP 401 | test |
| AC-12 | JWT без claim `actor_type` → HTTP 401 | test |
| AC-13 | Валидный JWT с `actor_type="agent"` (agent service-account от KC `agent-orchestrator`) → `POST /jobs` → HTTP 201 (запрос проходит) | test |
| AC-14 | Валидный JWT с `actor_type="human"` (ROPC-токен от человека `e-kravtsova`) → `POST /external-task/fetch-and-lock` → HTTP 200 (запрос проходит) | test |
| AC-15 | После успешной валидации обработчик получает доступ к `sub` и `preferred_username` из токена (не пусто, тип string) | test |
| AC-16 | KC недоступен (JWKS недостижим, таймаут) → HTTP 503 с кодом `AUTH_UNAVAILABLE` (не 500, не раскрывать stacktrace) | test |

### Группа C — архитектура и конфигурация

| ID | Текст | Верификация |
|---|---|---|
| AC-17 | Guard реализован в одной точке ветвления по `CHOROS_AUTH_MODE`; `grep -r 'CHOROS_AUTH_MODE' src/` возвращает ≤ 2 совпадения (в `auth.ts` и, опционально, в `server.ts`) | fitness |
| AC-18 | В `src/` нет новых `import` на npm-пакеты, связанные с JWT (jsonwebtoken, jose, jwks-rsa и т.п.); `grep -E "jsonwebtoken\|jose\|jwks-rsa" src/` возвращает 0 совпадений | fitness |
| AC-19 | Сигнатуры `registerExternalWorkerRoutes`, `registerAuthRoutes`, `createServer`, `DEV_USER_HEADER` не изменились; `grep 'DEV_USER_HEADER' src/http/auth.ts` возвращает export | fitness |
| AC-20 | Конфигурация guard содержит переменные `KEYCLOAK_URL`, `KEYCLOAK_REALM` (default `choros`), `KEYCLOAK_AUDIENCE` (default `choros-api`), `JWKS_CACHE_TTL_MS` (default `300000`); отсутствие `KEYCLOAK_URL` при `CHOROS_AUTH_MODE=keycloak` выдаёт ошибку запуска сервера, не silent fail | fitness |
| AC-21 | `docs/environments.md` содержит записи для `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_AUDIENCE`, `JWKS_CACHE_TTL_MS`; `grep -cE 'KEYCLOAK_URL|KEYCLOAK_AUDIENCE|JWKS_CACHE_TTL_MS' docs/environments.md` ≥ 3 | fitness |

### Группа D — интеграционная (live-kc CI-джоб)

| ID | Текст | Верификация |
|---|---|---|
| AC-22 | С живым Keycloak (`docker compose up keycloak`): agent-token от `agent-orchestrator` (client_credentials) → `POST /jobs` → 201; то же с ROPC-токеном `e-kravtsova` | test |
| AC-23 | Второй вызов с тем же токеном (кэш горячий) не инициирует новый JWKS-запрос; время ответа второго вызова ≤ 2 мс overhead (измерить через `Date.now()` в unit-тесте с mocked crypto.subtle.verify) | test |

---

## 6. Зависимости фаз

**DESIGN constraint:** Архитектор определяет точное место вставки guard (в `registerExternalWorkerRoutes` как параметр-middleware, или как обёртка-wrapper над Router, или как pre-handler в `dispatch`) — это архитектурное решение, не предрешённое здесь. Главный инвариант из FR-1: одна точка ветвления, все 4 эндпоинта покрыты.

**Migration:** если DESIGN решает сохранять JWKS-кэш в Redis/Postgres — использовать номер **041**. Если кэш in-memory (наиболее вероятно и предпочтительно для zero-dep) — миграция 041 не создаётся.

**Frozen JWT contract (T-0054 §4.1 — НЕ решать заново):**
```
iss:                http://<host>:<port>/realms/<realm>
aud:                должен включать "choros-api"
actor_type:         "human" | "agent"
preferred_username: непустая строка
alg:                RS256 (допустим ES256 если сконфигурирован в realm)
```
