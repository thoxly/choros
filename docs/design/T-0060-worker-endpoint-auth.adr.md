# ADR · T-0060 — Auth эндпоинтов воркера (E1.4 · Keycloak JWT-guard)

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-06-11
**Task:** E1.4 — активировать ветку `keycloak` в `CHOROS_AUTH_MODE`-заглушке (T-0054 §4.2) и
защитить четыре worker-эндпоинта единым Bearer-JWT guard'ом: подпись через Keycloak JWKS
(stdlib `node:crypto`, zero-dep), валидация claims `iss`/`aud`/`exp`/`actor_type` (T-0054 §4.1);
dev-режим (`x-dev-user`) нетронут; 401 на несоответствие, 503 при недоступном KC.

**Spec (input):** `docs/specs/T-0060-worker-endpoint-auth.spec.md` +
`docs/specs/T-0060.spec.contract.json` (status: ready; FR-1..FR-8, NF-1..NF-6, AC-1..AC-23;
blocking_questions: []).

**Авторитетные источники (потреблены, НЕ переоткрываются):**
- `docs/design/T-0054-keycloak-compose.adr.md` §4.1 — **frozen JWT-контракт** (`iss`/`aud`/`sub`/
  `preferred_username`/`actor_type`/`alg=RS256`); §4.2 — `CHOROS_AUTH_MODE` seam; §4.5 — scope
  boundary: T-0054 определяет seam как no-op stub, T-0060 наполняет ветку `keycloak`.
- `docs/design/tenancy-and-delivery.md` §6 — day-1 инвариант: ядро валидирует `iss`/`aud`/
  `tenant-claim` на каждом запросе; `iss` идентифицирует тенанта в silo.
- `docs/design/T-0061-dev-prod-stacks.adr.md` §… — choros-сервис уже получает env-seam
  (`KC_ISSUER`, `KEYCLOAK_PORT`, `KEYCLOAK_REALM`) в compose; «`KC_ISSUER` may or may not be
  consumed by T-0060». T-0060 фиксирует контракт потребления (см. §1.2).
- `CONCEPT.md` §5 (external worker API, pull-модель) + §6 (Identity = Keycloak) + §8
  (OAuth 2.0 для агентов; service-account на агента).
- `src/http/auth.ts` (seam-константа `AUTH_MODE`, ветка `keycloak` сейчас → 501 stub в `/api/me`).
- `src/http/externalWorker.ts` (4 эндпоинта без аутентификации), `src/server.ts` (`buildRouter`
  регистрирует роуты), `src/http/router.ts` (`RouteHandler`, `HttpError`, error-envelope).

> **Эта ADR проектирует guard как тонкое middleware-обёртывание 4 worker-роутов и stdlib
> JWT-валидатор; реализацию пишет `coder`. §3–§6 — источник правды для `coder`/`tester`.**

---

## 1. Decision

Внедрить **единый JWT-guard как декоратор RouteHandler'а**, применяемый в одной точке —
`registerExternalWorkerRoutes` (`src/http/externalWorker.ts`) — ко всем четырём worker-роутам,
с **одной точкой ветвления** по `CHOROS_AUTH_MODE`, живущей в `src/http/auth.ts` (там же, где
seam T-0054). Механизм проектируется как stdlib-only, in-process, fail-closed.

### 1.1 Точка вставки guard'а — декоратор хендлеров в `registerExternalWorkerRoutes`

Спека (§6 DESIGN-constraint) оставляет архитектору выбор из трёх вариантов: параметр-middleware,
обёртка над Router, pre-handler в `dispatch`. **Решение: декоратор `withAuth(handler)`**, которым
оборачивается каждый из 4 worker-хендлеров в момент их `router.register(...)` внутри
`registerExternalWorkerRoutes`. Обоснование (соразмерность, ось 5):

- **Не трогает `router.ts`** (контракт швов: только аддитивные правки; `dispatch` не меняется).
  Guard — это композиция функций над существующим `RouteHandler`-типом, а не новый слой в роутере.
- **Покрывает ровно 4 эндпоинта**, не все роуты (org/inbox/rights/processes остаются на
  `x-dev-user` — spec Out-of-scope). Wrapper над всем Router'ом или pre-handler в `dispatch`
  навесили бы guard на весь трафик — нарушение границы скоупа.
- **Одна точка ветвления** (FR-1, AC-17): `withAuth` вызывает `authenticate(req)` из `auth.ts`;
  именно `authenticate` читает `AUTH_MODE` и решает dev/keycloak. В `externalWorker.ts` ветвления
  по `AUTH_MODE` НЕТ — там только `withAuth(...)`-обёртки. `grep -r CHOROS_AUTH_MODE src/` остаётся
  ≤ 2 (в `auth.ts`; опционально `server.ts` для fail-fast-валидации конфига).

Guard вызывается **до** `readJsonBody` и бизнес-логики хендлера: 401/503 возвращается без чтения
тела (NF-4 fail-closed, не раскрывать детали).

### 1.2 Источник конфигурации — `KEYCLOAK_URL`+`KEYCLOAK_REALM`, `KC_ISSUER` как override-seam

Spec FR-7/AC-20/AC-21 требует переменные `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_AUDIENCE`,
`JWKS_CACHE_TTL_MS`. T-0061 уже прокинул в choros-сервис `KC_ISSUER`
(`http://keycloak:8180/realms/choros`) как seam. **Решение (примирение, автономно — это
инфра-нейминг, не продуктовая развилка):**

1. `KEYCLOAK_URL` — base URL Keycloak (server-side: имя сервиса в compose, напр.
   `http://keycloak:8180`). **Обязателен** при `CHOROS_AUTH_MODE=keycloak`.
2. Issuer вычисляется как `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}` (default realm `choros`).
3. `KC_ISSUER` (seam T-0061) — **опциональный override**: если задан, используется как
   ожидаемый `iss` напрямую (полезно, когда внутренний хост ≠ выписанный KC issuer). Если
   не задан — issuer выводится из `KEYCLOAK_URL`+`KEYCLOAK_REALM`. Это сохраняет существующий
   compose-блок T-0061 валидным и одновременно удовлетворяет grep-проверки AC-20/AC-21.
4. JWKS-источник: OIDC Discovery (`${issuerBase}/.well-known/openid-configuration` → `jwks_uri`)
   ИЛИ прямой `KEYCLOAK_JWKS_URI` (опциональный override).
5. `KEYCLOAK_AUDIENCE` (default `choros-api`), `JWKS_CACHE_TTL_MS` (default `300000`).

`coder` ДОБАВЛЯЕТ `KEYCLOAK_URL` в choros-env-блок `docker-compose.yml` рядом с уже существующим
`KC_ISSUER`/`KEYCLOAK_PORT`/`KEYCLOAK_REALM` (аддитивно; default
`http://keycloak:${KEYCLOAK_PORT:-8180}`). `KEYCLOAK_AUDIENCE`/`JWKS_CACHE_TTL_MS` имеют код-дефолты
и в compose не обязательны (документируются в environments.md).

### 1.3 stdlib RS256-валидация (zero-dep, NF-1/FR-8)

JWT-валидатор пишется на `node:crypto` + глобальном `fetch` (Node ≥ 20, `engines: ">=20"`):

- **Парсинг**: split по `.`; base64url-decode header+payload; `JSON.parse`. Невалидная структура →
  401 (не 500).
- **Подбор ключа**: header `kid` → ищется в кэше JWKS (массив JWK). JWK (`kty:"RSA"`, `n`,`e`)
  конвертируется в `crypto.KeyObject` через `crypto.createPublicKey({ key: jwk, format: "jwk" })`
  (поддержано в Node 20). `alg` ∈ {`RS256`} (а также `ES256`, если realm так сконфигурирован —
  T-0054 §4.1 допускает; маппинг alg→{hash, keyType} в валидаторе).
- **Проверка подписи**: `crypto.verify("RSA-SHA256", Buffer(signingInput), keyObject,
  Buffer(signature, base64url))` → boolean. Неверная подпись → 401 (AC-8).
- **Claims**: `iss` === ожидаемый issuer (AC-10); `aud` (string | string[]) включает
  `KEYCLOAK_AUDIENCE` (AC-11); `exp` (число, секунды) > now/1000 с допуском clock-skew ≤ 60 с
  (AC-9); `actor_type` ∈ {`"human"`,`"agent"`} — отсутствие → 401 (AC-12).
- Никаких npm JWT-библиотек (AC-18: `grep -E 'jsonwebtoken|jose|jwks-rsa' src/` = 0).

### 1.4 JWKS-кэш — in-memory, без БД (миграция 041 НЕ создаётся)

Кэш JWKS живёт в module-scope `Map`/объекте процесса (FR-6). TTL = `JWKS_CACHE_TTL_MS`
(default 300000). **Миграция 041 НЕ создаётся** — кэш не персистентный (zero-dep, соразмерность;
spec §6 «in-memory наиболее вероятно и предпочтительно»). При неудачном подборе `kid` (ключ
проротирован) — **однократная** принудительная инвалидация + повторный fetch JWKS; повторный
промах по `kid` → 401 (FR-6). Горячий кэш не инициирует сетевой хоп (AC-23, NF-3 ≤ 2 мс).

### 1.5 Коды ответов (NF-4 fail-closed)

- Нет/битый `Authorization`, битый JWT, неверная подпись, неверный/просроченный claim →
  **401** `{"error":{"code":"UNAUTHENTICATED","message":"..."}}` (envelope из `router.ts`).
- KC недостижим (таймаут discovery/JWKS-fetch, сетевая ошибка, не-200 от KC) → **503**
  `{"error":{"code":"AUTH_UNAVAILABLE","message":"..."}}`; stacktrace/детали НЕ раскрываются
  (AC-16). Различие 401 vs 503: проблема в **токене** → 401; проблема в **доступности KC** → 503.
- Любая внутренняя ошибка валидатора (исключение) ловится → 401 (fail-closed, не 500).

### 1.6 Request-контекст идентичности (FR-4, AC-15)

После успешной валидации guard кладёт `{ sub, preferredUsername, actorType }` в
**WeakMap<IncomingMessage, AuthContext>** (module-scope в `auth.ts`), доступный через
`getAuthContext(req)`. Не мутируем `IncomingMessage` нестандартными полями (типобезопасность,
no any-cast). Запись в аудит — НЕ в скоупе (T-0016/E2). dev-режим контекст не заполняет
(worker-роуты в dev не требуют identity — существующее поведение).

### 1.7 fail-fast валидация конфига (AC-20)

При `CHOROS_AUTH_MODE=keycloak` и отсутствии `KEYCLOAK_URL` (и отсутствии `KC_ISSUER`-override) —
**бросить Error при инициализации guard'а** (eager, при первом `buildRouter`/старте сервера), не
silent-fail и не на первом запросе. Реализуется функцией `assertKeycloakConfig()` в `auth.ts`,
вызываемой из `registerExternalWorkerRoutes` (или `server.ts`) в keycloak-режиме. dev-режим
конфиг не требует.

Механизм **соразмерен** (ось 5): ~1 новый модуль (`jwtValidator` внутри `auth.ts` или
`src/http/jwt.ts`), ~3 функции (`authenticate`, `withAuth`, `getAuthContext`), in-memory кэш,
без БД, без npm-зависимостей. Аддитивные правки `auth.ts`+`externalWorker.ts`; `router.ts`,
`org.ts`, миграции — не трогаются.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Pre-handler в `Router.dispatch`** | Требует правки `router.ts` (контракт швов: только аддитив, без рефактора) и навешивает guard на ВЕСЬ трафик, включая non-worker роуты (inbox/org/rights) — нарушает spec Out-of-scope (они остаются на x-dev-user). |
| **Wrapper над всем Router'ом** | То же — глобальное покрытие; пришлось бы белым списком исключать non-worker роуты. Хрупко, anti-«одна точка»: список роутов дрейфует. |
| **Ветвление по `CHOROS_AUTH_MODE` в каждом из 4 хендлеров** | Разброс guard-логики по N точкам (FR-1 запрещает); `grep CHOROS_AUTH_MODE src/` вырос бы > 2 (AC-17 fail). Декоратор `withAuth` + единый `authenticate` в auth.ts = одна точка. |
| **npm `jose` / `jsonwebtoken` / `jwks-rsa`** | Нарушает zero-dep конвенцию (NF-1, AC-18) и продуктовый принцип stdlib. Node 20 `crypto.createPublicKey({format:"jwk"})` + `crypto.verify` покрывают RS256/ES256 нативно. |
| **JWKS-кэш в Postgres/Redis (миграция 041)** | Избыточно: JWKS — маленький, редко меняющийся набор ключей; in-memory TTL-кэш на процесс достаточен и zero-dep. Персистентный стор добавил бы БД-связанность и (для Redis) новую зависимость. Spec §6 явно предпочитает in-memory. |
| **Интроспекция токена через KC introspection endpoint (RFC 7662)** | Сетевой хоп на каждый запрос (NF-3 ≤ 2 мс нарушен), привязка к доступности KC на горячем пути. Локальная подпись-валидация по JWKS — стандарт для resource-server'ов и self-contained. |
| **Переименовать `KC_ISSUER` (T-0061) в `KEYCLOAK_URL`** | Сломало бы уже смерженный compose-seam T-0061 (правка в зоне сестры по смыслу). Решение §1.2: `KEYCLOAK_URL` — основной источник, `KC_ISSUER` — опциональный override; оба сосуществуют. |
| **Дублировать guard и в `/api/me` (auth.ts)** | Out-of-scope: T-0060 защищает только 4 worker-эндпоинта. `/api/me` keycloak-ветка остаётся 501-stub'ом (отдельная задача UI-auth, spec Out-of-scope). Не трогаем. |
| **403 при отсутствии токена** | Spec фиксирует 401 UNAUTHENTICATED (аутентификация, не авторизация). 403 — это RBAC, явно вне скоупа T-0060. |

---

## 3. Object model (контракты типов — источник правды для coder/tester)

### 3.1 `AuthContext` (идентичность вызывающего)

| Field | Type | Notes |
|---|---|---|
| `sub` | `string` | KC user UUID (human) или service-account UUID (agent); непустой (AC-15) |
| `preferredUsername` | `string` | employee id (human, напр. `e-kravtsova`) или `service-account-<clientId>` (agent); непустой |
| `actorType` | `"human" \| "agent"` | из claim `actor_type` (T-0054 §4.1) |

### 3.2 `KeycloakAuthConfig` (резолвится один раз при init)

| Field | Type | Source / default |
|---|---|---|
| `mode` | `"dev" \| "keycloak"` | `process.env.CHOROS_AUTH_MODE ?? "dev"` |
| `issuer` | `string` | `KC_ISSUER` override, иначе `${KEYCLOAK_URL}/realms/${realm}` |
| `keycloakUrl` | `string` | `process.env.KEYCLOAK_URL` (обязателен в keycloak-режиме, AC-20) |
| `realm` | `string` | `process.env.KEYCLOAK_REALM ?? "choros"` |
| `audience` | `string` | `process.env.KEYCLOAK_AUDIENCE ?? "choros-api"` |
| `jwksUri` | `string \| undefined` | `KEYCLOAK_JWKS_URI` override; иначе резолвится через OIDC discovery |
| `jwksCacheTtlMs` | `number` | `Number(process.env.JWKS_CACHE_TTL_MS ?? 300000)` |

### 3.3 `Jwk` / `JwksCacheEntry` (in-memory кэш)

| Field | Type | Notes |
|---|---|---|
| `Jwk.kid` | `string` | идентификатор ключа из JWKS |
| `Jwk.kty` | `string` | `"RSA"` (или `"EC"` для ES256) |
| `Jwk.n`,`Jwk.e` | `string` | RSA-параметры (base64url) — для `createPublicKey({format:"jwk"})` |
| `Jwk.alg` | `string` | `"RS256"` (\|`"ES256"`) |
| `JwksCacheEntry.keys` | `Jwk[]` | загруженный набор |
| `JwksCacheEntry.fetchedAtMs` | `number` | для TTL-проверки |

### 3.4 `JwtClaims` (декодированный payload — валидируемое подмножество)

| Field | Type | Validated |
|---|---|---|
| `iss` | `string` | === config.issuer (AC-10) |
| `aud` | `string \| string[]` | includes config.audience (AC-11) |
| `exp` | `number` | > now (с допуском skew ≤ 60 с) (AC-9) |
| `sub` | `string` | непустой → AuthContext.sub |
| `preferred_username` | `string` | непустой → AuthContext.preferredUsername |
| `actor_type` | `"human" \| "agent"` | присутствует и валиден (AC-12) |

---

## 4. Contracts (сигнатуры — coder реализует точно)

```typescript
// src/http/auth.ts (или src/http/jwt.ts для валидатора; auth.ts держит seam + публичные функции)

// Декоратор: оборачивает worker-RouteHandler аутентификацией.
// В dev-режиме — pass-through (тело хендлера исполняется как сейчас).
// В keycloak-режиме — валидирует Bearer JWT; при провале НЕ вызывает inner.
export function withAuth(handler: RouteHandler): RouteHandler;

// Единственная точка ветвления по AUTH_MODE. Бросает HttpError(401|503) при провале;
// при успехе кладёт AuthContext в WeakMap и возвращает void.
// dev-режим: no-op (worker-роуты в dev токен не требуют — существующее поведение).
async function authenticate(req: IncomingMessage): Promise<void>;

// Доступ к идентичности после успешной аутентификации (FR-4, AC-15).
export function getAuthContext(req: IncomingMessage): AuthContext | undefined;

// fail-fast валидация конфига (AC-20): бросает Error при keycloak-режиме без KEYCLOAK_URL/KC_ISSUER.
export function assertKeycloakConfig(): void;

// --- stdlib JWT-валидатор (внутренний) ---
// Бросает HttpError(401) на любую токен-ошибку, HttpError(503,'AUTH_UNAVAILABLE') на недоступность KC.
async function verifyJwt(token: string, cfg: KeycloakAuthConfig): Promise<JwtClaims>;
async function getJwks(cfg: KeycloakAuthConfig, forceRefresh?: boolean): Promise<Jwk[]>;
```

**Контракт швов (NF-2, FE-W23-0008 compat):**
- `DEV_USER_HEADER` (export) — НЕ меняется.
- `registerAuthRoutes(router, store?)` — сигнатура НЕ меняется.
- `registerExternalWorkerRoutes(router, store)` — сигнатура НЕ меняется (внутри хендлеры
  оборачиваются `withAuth`; новых параметров нет).
- `createServer(store?)` — сигнатура НЕ меняется.
- `AUTH_MODE` — остаётся внутренней константой (не экспортируется).
- `router.ts` — НЕ трогается.

**Применение в `externalWorker.ts` (аддитивно):**
```typescript
router.register("POST", "/jobs", withAuth(async (req, res) => { /* существующее тело */ }));
router.register("POST", "/external-task/fetch-and-lock", withAuth(async (req, res) => { ... }));
router.register("POST", "/external-task/:id/complete", withAuth(async (req, res, params) => { ... }));
router.register("POST", "/external-task/:id/fail",     withAuth(async (req, res, params) => { ... }));
```

---

## 5. Traceability (AC → дизайн)

| AC | Covered by |
|---|---|
| AC-1 (dev e2e externalWorker зелёные) | §1.1 dev pass-through · `withAuth` no-op в dev · **FF-2** (live-dev) |
| AC-2 (dev auth.e2e `/api/me` неизменно) | §1.6 dev контекст не заполняется · `/api/me` не трогается · **FF-2** |
| AC-3..AC-6 (4 эндпоинта без Authorization → 401) | §1.1 `withAuth` на всех 4 · §1.5 401 envelope · **FF-1**(live-kc) |
| AC-7 (malformed Bearer → 401) | §1.3 парсинг → 401 · **FF-1** |
| AC-8 (неверная подпись → 401) | §1.3 `crypto.verify` → 401 · **FF-1** |
| AC-9 (истёкший exp → 401) | §1.3 exp-проверка со skew · **FF-1** |
| AC-10 (неверный iss → 401) | §1.3 iss === issuer · §1.2 резолв issuer · **FF-1** |
| AC-11 (нет aud:choros-api → 401) | §1.3 aud includes audience · **FF-1** |
| AC-12 (нет actor_type → 401) | §1.3 actor_type ∈ {human,agent} · **FF-1** |
| AC-13 (валидный agent JWT → POST /jobs 201) | §1.3 happy-path · §3.1 AuthContext · **FF-1 / FF-7**(live-kc) |
| AC-14 (валидный human JWT → fetch-and-lock 200) | §1.3 happy-path · **FF-1 / FF-7** |
| AC-15 (sub + preferred_username доступны) | §1.6 WeakMap AuthContext · `getAuthContext` · **FF-1** |
| AC-16 (KC недоступен → 503 AUTH_UNAVAILABLE) | §1.5 503-ветка · §1.3 fetch-ошибка → 503 · **FF-1** |
| AC-17 (одна точка ветвления, ≤2 grep) | §1.1 декоратор+единый authenticate · **FF-3** (static) |
| AC-18 (нет npm JWT-библиотек) | §1.3 stdlib only · **FF-4** (static) |
| AC-19 (публичные экспорты неизменны) | §4 контракт швов · **FF-5** (static) |
| AC-20 (нет KEYCLOAK_URL@keycloak → ошибка старта) | §1.7 `assertKeycloakConfig` · **FF-6** (static) |
| AC-21 (env vars в environments.md) | §1.2 + environments-docs · **FF-6 / FF-8** (static) |
| AC-22 (live-kc: agent+human реальные токены) | §1.3 against живой KC · **FF-7** (live-kc) |
| AC-23 (горячий кэш — 0 JWKS-запросов) | §1.4 in-memory TTL-кэш · **FF-9** (unit, mocked fetch) |

---

## 6. Fitness functions

**static-now** = присоединяется к `npm run fitness` (существующий, без живого KC).
**live-kc** = требует живой Keycloak — джоб `kc` в CI (см. §6.1, additive).
**live-dev** = существующий `ci` джоб с `CHOROS_AUTH_MODE=dev` (default).
**unit** = в `vitest run` (часть `npm run ci`).

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | Все 23-x негативных/позитивных JWT-сценариев (AC-3..AC-16) проходят против живого Keycloak: 4 эндпоинта без токена → 401; malformed/badsig/expired/bad-iss/bad-aud/no-actor_type → 401; валидный agent/human → 201/200; sub+preferred_username доступны; KC-down → 503 | live-kc: `src/__tests__/workerAuth.kc.e2e.test.ts` (vitest) поднимает `createServer()` с `CHOROS_AUTH_MODE=keycloak` против compose-Keycloak; получает реальные токены (ROPC `e-kravtsova`, client_credentials `agent-orchestrator`); ассертит коды | live-kc |
| **FF-2** | Полный набор существующих e2e (externalWorker.e2e + auth.e2e) зелёный при `CHOROS_AUTH_MODE=dev`/unset; нулевая регрессия | live-dev: `CHOROS_AUTH_MODE=dev npm run ci` (existing job, наследует default); `externalWorker.e2e.test.ts` + `auth.e2e.test.ts` без изменений | live-dev (existing) |
| **FF-3** | Одна точка ветвления: `grep -rE 'CHOROS_AUTH_MODE' src/` ≤ 2 совпадения (auth.ts + опц. server.ts); `externalWorker.ts` НЕ содержит `CHOROS_AUTH_MODE` | static-now: `ci/checks/worker-auth-single-branch.sh` — `c=$(grep -rE 'CHOROS_AUTH_MODE' src/ \| wc -l); test "$c" -le 2`; и `! grep -q CHOROS_AUTH_MODE src/http/externalWorker.ts` | static-now |
| **FF-4** | Нет npm JWT-библиотек в `src/`: `grep -rE 'jsonwebtoken\|jose\|jwks-rsa' src/` = 0; `package.json` dependencies не содержит этих пакетов | static-now: `ci/checks/worker-auth-zero-dep.sh` — `! grep -rE 'jsonwebtoken\|\bjose\b\|jwks-rsa' src/`; и `! grep -E '\"(jsonwebtoken\|jose\|jwks-rsa)\"' package.json` | static-now |
| **FF-5** | Публичная поверхность неизменна: `grep -E 'export.*DEV_USER_HEADER' src/http/auth.ts` = 1; `registerExternalWorkerRoutes`/`registerAuthRoutes`/`createServer` экспортируются с прежней арностью; `router.ts` не изменён относительно базовой ветки | static-now: `ci/checks/worker-auth-public-surface.sh` — grep'ы на наличие экспортов + `git diff --quiet origin/dev -- src/http/router.ts` (router.ts не тронут) | static-now |
| **FF-6** | fail-fast: при `CHOROS_AUTH_MODE=keycloak` без `KEYCLOAK_URL`/`KC_ISSUER` сервер падает на старте (не silent, не на первом запросе) | static-now: `ci/checks/worker-auth-config-failfast.sh` — `CHOROS_AUTH_MODE=keycloak node -e "import('./dist/http/auth.js').then(m=>m.assertKeycloakConfig())"` завершается non-zero; с заданным `KEYCLOAK_URL` — zero (требует `tsc` сборки в джобе) | static-now |
| **FF-7** | live-kc happy-path: реальный agent-token (client_credentials `agent-orchestrator`) → `POST /jobs` → 201; реальный human-token (ROPC `e-kravtsova`) → `POST /external-task/fetch-and-lock` → 200 (AC-22) | live-kc: внутри `workerAuth.kc.e2e.test.ts` (FF-1) или отдельный шаг `ci/checks/kc/worker-token-roundtrip.sh` curl'ит токен у KC и бьёт в поднятый choros-сервер | live-kc |
| **FF-8** | `docs/environments.md` документирует новые env: `grep -cE 'KEYCLOAK_URL\|KEYCLOAK_AUDIENCE\|JWKS_CACHE_TTL_MS' docs/environments.md` ≥ 3 | static-now: расширить `ci/checks/kc/environments-docs.sh` (или новый `worker-auth-env-docs.sh`) проверкой ≥ 3 | static-now |
| **FF-9** | Горячий JWKS-кэш: второй `verifyJwt` с тем же `kid` НЕ инициирует новый HTTP-запрос к KC (0 fetch-вызовов после первого); overhead ≤ 2 мс (NF-3, AC-23) | unit: `src/__tests__/jwks-cache.test.ts` — mock глобального `fetch`/`https.get`, дважды валидирует токен, ассертит `fetchSpy.callCount === 1` после прогрева | unit (vitest) |

### 6.1 CI wiring — джоб `kc` (additive)

В `.github/workflows/ci.yml` сейчас НЕТ `kc`-джоба (есть `ci`, `db`, `flowable`, `stack`).
`coder` ДОБАВЛЯЕТ джоб `kc` (по образцу `flowable`-джоба): `docker compose up -d postgres keycloak`,
ждёт readiness (переиспользует `ci/checks/kc/wait-ready.sh` + `realm-ready.sh` из T-0054), затем
`npm ci && npm run build` и запускает live-kc тесты/скрипты (FF-1, FF-7). Джоб **аддитивный** —
не модифицирует `ci`/`db`/`flowable`/`stack`; `ci` остаётся на `CHOROS_AUTH_MODE=dev` (default) и
зелёный без KC (NF-6, AC-1/AC-2). `static-now`-проверки (FF-3..FF-6, FF-8) присоединяются к строке
`npm run fitness`. `unit` FF-9 идёт в обычном `vitest run`.

> **Контракт швов CI:** существующий `ci-workflow-lint.sh` (FF-CI) проверяет наличие `db`-джоба и
> postgres:16 — добавление `kc`-джоба его не ломает (проверки аддитивны). Новый `kc`-джоб НЕ
> трогает `db`/`flowable` шаги.

---

## 7. Runtime target

**Локально + silo docker-compose.** Guard исполняется внутри choros-сервиса (Node ≥ 20). В
`CHOROS_AUTH_MODE=dev` (default) — ничего нового не требуется. В `keycloak`-режиме нужен живой
Keycloak (сервис `keycloak` из T-0054, уже в compose). Никакого нового внешнего ресурса T-0060 НЕ
вводит: KC уже провижится T-0054; prod-Keycloak (TLS/hostname-pinning) — E0.7, founder-gated
(GT-4). T-0060 не коммитит секретов и не провижит серверов.

---

## 8. Escalation

**None.** Все высоколеверажные форки founder-ратифицированы (Keycloak как identity —
CONCEPT §6/stack-and-fleet-ops §1; dedicated realm — tenancy §6 GT-1; `iss`/`aud`/`tenant-claim`
day-1 — tenancy §6; OAuth 2.0 для агентов — CONCEPT §8). Решения этой ADR (декоратор-guard,
stdlib RS256, in-memory JWKS-кэш без миграции 041, `KEYCLOAK_URL`+`KC_ISSUER`-override-нейминг,
fail-closed 401/503, additive `kc` CI-джоб) — все инфра/архитектурные детали, которые спека
помечает автономными (spec §6 DESIGN-constraint, §7 FR-7). Продуктовая граница не сдвигается:
T-0060 делает только аутентификацию 4 worker-эндпоинтов; авторизация/RBAC, UI-auth,
аудит-запись — явно вне скоупа. `status: ready`.

### Зафиксированная (НЕ блокирующая) развилка нейминга конфига

Spec требует `KEYCLOAK_URL`; T-0061 уже прокинул `KC_ISSUER` в compose. **Решено автономно**
(инфра-нейминг, не продуктовое поведение): `KEYCLOAK_URL`+`KEYCLOAK_REALM` — основной источник
issuer; `KC_ISSUER` — опциональный override (сохраняет compose-seam T-0061 валидным). Обе
переменные сосуществуют; grep-проверки AC-20/AC-21 удовлетворены добавлением `KEYCLOAK_URL` в
choros-env-блок и environments.md. Эскалации не требует.
