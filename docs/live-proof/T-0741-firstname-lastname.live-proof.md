# T-0741 — LIVE_PROOF: createHumanUser firstName/lastName closes "Account is not fully set up"

Дата: 2026-07-10. Стенд: локальный KC **25.0.6** (`t-0633-keycloak-1`, :8180), realm `choros`,
service-account `choros-registrar` (тот же путь, что `createHumanUser`,
`src/keycloak/admin-port.ts`). Продуктовый dev-стенд offline на момент доказательства — см. §4
для плана browser/UI-leg, когда стенд станет доступен (тот же метод, что T-0734).

## Вердикт: **GREEN**

Живьём подтверждено: пользователь, созданный через registrar admin-REST БЕЗ firstName/lastName,
не может получить НИКАКОЙ токен через direct grant (`400 invalid_grant "Account is not fully set
up"`) — это строже, чем "лишний экран", как описывал T-0734 §5. Тот же самый юзер, созданный С
firstName/lastName (по алгоритму `splitDisplayName`), получает токен нормально. Анти-кейс
(однословное имя, продублированное в оба поля) — тоже зелёный.

## 1. RED — воспроизведение (payload БЕЗ firstName/lastName, как до фикса)

```
POST /admin/realms/choros/users
  {"username":"t0741-red-77014","email":"t0741-red-77014@choros.dev","enabled":true,
   "emailVerified":true,"attributes":{"actor_type":["human"]},
   "credentials":[{"type":"password","value":"...","temporary":false}]}
-> HTTP 201

POST /realms/choros/protocol/openid-connect/token
  grant_type=password&client_id=choros-api&client_secret=...&username=t0741-red-77014&password=...
-> HTTP 400 {"error":"invalid_grant","error_description":"Account is not fully set up"}
```

Никакого токена — не 401, а полный отказ КС выдать хоть что-то по этому пользователю через
direct grant. (Отдельно подтверждено ранее в этой же сессии тем же методом, идентичный результат
— повторный прогон в §5 для итогового артефакта.)

## 2. GREEN — payload С firstName/lastName (splitDisplayName("Иван Петров"))

```
POST /admin/realms/choros/users
  {"username":"t0741-green-77014","email":"t0741-green-77014@choros.dev",
   "firstName":"Иван","lastName":"Петров","enabled":true,"emailVerified":true,
   "attributes":{"actor_type":["human"]},
   "credentials":[{"type":"password","value":"...","temporary":false}]}
-> HTTP 201

GET /admin/realms/choros/users?username=t0741-green-77014&exact=true
-> firstName=Иван lastName=Петров   (персистировано)

POST /realms/choros/protocol/openid-connect/token grant_type=password ...
-> HTTP 200 {"access_token": "...", "expires_in": ..., "refresh_token": "...", ...}
```

Токен выдан — тот же самый direct-grant запрос, который RED-кейс отклонил, теперь проходит.

## 3. Анти-кейс — однословное имя дублируется в оба поля (splitDisplayName("Мадонна"))

```
POST /admin/realms/choros/users
  {"username":"t0741-mono-77014", ..., "firstName":"Мадонна","lastName":"Мадонна", ...}
-> HTTP 201

POST .../token grant_type=password ... -> HTTP 200 (access_token issued)
```

Подтверждает, что дублирование единственного токена имени в firstName И lastName (а не
оставление одного из полей пустым) действительно закрывает гейт — пустое `lastName` вернуло бы
тот же RED-отказ.

## 4. План live-proof на стенде (когда online)

1. UI: владелец открывает «Создать учётку», вводит «Отображаемое имя» = «Иван Петров» (после
   этого фикса — с подсказкой «имя и фамилия…»).
2. Новый юзер логинится в браузере (реальная KC-форма, паттерн
   `choros-acceptance-t0583-users`) → сразу попадает в приложение, БЕЗ интерактивного экрана
   «обновите профиль» (до фикса — этот экран появлялся).
3. Регрессия: существующий сценарий T-0734 (actor_type в токене) остаётся зелёным — firstName/
   lastName не влияют на attributes.actor_type persistence (независимые поля профиля).

## 5. Полный прогон (RED/GREEN/анти-кейс в одной сессии, для протокола)

```
reg token ok: 1203 chars
=== RED: create WITHOUT firstName/lastName (pre-fix payload shape) ===
create status: 201
direct-grant response: {"error":"invalid_grant","error_description":"Account is not fully set up"}

=== GREEN: create WITH firstName/lastName derived from splitDisplayName('Иван Петров') ===
create status: 201
firstName= Иван lastName= Петров
direct-grant response keys: True ['access_token', 'expires_in', 'refresh_expires_in', 'refresh_token', 'token_type', 'not-before-policy', 'session_state', 'scope']

=== ANTI-CASE: single-token displayName ('Мадонна') duplicated into both fields ===
create status: 201
direct-grant response keys: True ['access_token', 'expires_in', 'refresh_expires_in', 'refresh_token', 'token_type', 'not-before-policy', 'session_state', 'scope']

=== cleanup ===
deleted t0741-red-77014 (f65539f5-19da-46d6-ba24-f9056b998b47)
deleted t0741-green-77014 (e89c06cb-8d30-42ce-a7f1-ad33065913f0)
deleted t0741-mono-77014 (e988a18c-5b44-42a4-a0e7-af12b304b32e)
```

All throwaway users created by this proof were deleted (best-effort cleanup, matching T-0734's
proof-hygiene convention).

## Fitness

- Unit: `src/__tests__/admin-port.test.ts` — `splitDisplayName` cases + HTTP-capture proving the
  actual `POST /users` body carries `firstName`/`lastName` (see ADR §5).
- DB-live: `ci/checks/db/user-mgmt.db.test.ts` FF-583-1 — proves `POST /api/users` forwards
  `display_name` as `displayName` into `kc.createHumanUser`.
- No new `ci/checks/kc/*.sh` script added — the existing live-KC checks
  (`human-token.sh`, `jwt-claims.sh`, `ui-created-user-actor-type.sh`) already exercise direct
  grant against fixture/seed users (which HAVE firstName/lastName from realm import, migrations/
  016 convention) and would have caught a regression that broke THEM; this task's own live proof
  (this document) is the targeted regression lock for the specific gap it closes. A dedicated
  `ci/checks/kc/*.sh` was considered but judged redundant with the unit + DB-live coverage above
  for a two-field payload addition (proportionality, ADR §5).
