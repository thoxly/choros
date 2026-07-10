# T-0734 — LIVE_PROOF: KC 25 declarative profile now persists `actor_type` for UI-created users

Дата: 2026-07-10. Стенд: локальный KC **25.0.6** (`t-0633-keycloak-1`, :8180), realm
`choros`, admin `choros_kc_admin`. Продуктовый dev-стенд offline — доказательство
локальное на том же KC-образе/версии, что и стенд; плюс план browser-live-proof для
стенда (см. §4). Метод: прямой admin REST через `choros-registrar`
(client_credentials) — тот же путь, что `createHumanUser` (`src/keycloak/admin-port.ts`)
— и ROPC через `choros-api`; декод JWT payload; сверка `verifyClaims` (`src/http/auth.ts:302`).

## Вердикт: **GREEN**

Корень подтверждён живьём и фикс доказан сквозняком: UI-путь создания учётки теперь
кладёт `actor_type` в БД KC, токен несёт claim `actor_type='human'`, `verifyClaims`
проходит (нет 401). Анти-кейс (невалидное значение → 400), регрессия seeded и
`setUserEnabled` — зелёные. Точный коммиченный `realm-choros.json` доказан через
import-десериализатор KC.

## 1. RED (до фикса) — воспроизведение корня

Создание юзера через registrar admin REST `POST /users` с `attributes.actor_type=["human"]`:

```
POST /users -> HTTP 201
GET user back:  attributes = "NONE"          <-- KC МОЛЧА выбросил actor_type
GET /users/profile: unmanagedAttributePolicy = DISABLED
                    declared attributes = ['username','email','firstName','lastName']
ROPC token (с firstName/lastName): actor_type claim = <<MISSING>>
Сравнение: seeded e-kravtsova token: actor_type claim = 'human'   (import пишет в обход профиля)
```

Асимметрия seeded-OK / UI-401 воспроизведена ровно как в отчёте T-0705.

## 2. GREEN (после фикса) — применён declarative user-profile с managed `actor_type`

`PUT /users/profile` (эквивалент того, что делает import через `components` и
`kc-dev-setup.sh` шаг 5):

```
A. PUT /users/profile -> HTTP 200; declared = ['username','email','firstName','lastName','actor_type']
B. POST /users (actor_type=[human], +имена)     -> HTTP 201
C. GET user back:  attributes = {"actor_type": ["human"]}          <-- ПЕРСИСТИТ
D. ROPC token:     actor_type claim = 'human' | preferred_username = t0734-fix-...
E. АНТИ-КЕЙС: POST actor_type=["superadmin"]    -> HTTP 400 {"field":"actor_type","errorMessage":"error-invalid-value"}
F. РЕГРЕССИЯ seeded e-kravtsova token: actor_type = 'human'         (не сломан)
G. РЕГРЕССИЯ setUserEnabled: PUT {enabled:false} -> 204; attributes = {"actor_type":["human"]}, enabled=false
```

Токен из шага D несёт `iss=http://localhost:8180/realms/choros`, `aud` включает
`choros-api`, `sub`, `preferred_username`, и `actor_type='human'` → все проверки
`verifyClaims` проходят → **нет 401**.

## 3. Коммиченный артефакт доказан через IMPORT (путь `--import-realm` / CI)

Точный `config/keycloak/realm-choros.json` (с новой секцией `components`),
переименованный в throwaway-realm, импортирован через `POST /admin/realms`
(тот же десериализатор, что `--import-realm`):

```
IMPORT committed realm -> HTTP 201
declared profile attrs after import: ['username','email','firstName','lastName','actor_type']
admin POST /users -> HTTP 201
user attributes persisted: {"actor_type": ["human"]}
TOKEN actor_type claim = 'human' | aud=['choros-api','account'] | iss ok=True
```

Это доказывает, что фикс срабатывает на пути импорта — механизме, который использует
CI-job `kc` и свежая инициализация стенда (там `kc-dev-setup.sh` не запускается).

## 4. План live-proof на стенде (когда online)

1. UI: владелец открывает "Создать учётку", заводит нового человека (логин+email+пароль).
2. Новый юзер логинится в браузере (реальная Keycloak-форма, паттерн
   choros-acceptance-t0583-users) и открывает любой раздел → **200, не 401**.
3. Перед этим на стенде применить фикс без wipe: `bash scripts/kc-dev-setup.sh`
   (шаг 5 реконсилит профиль через `PUT /users/profile`). НЕ переимпортировать realm
   (переимпорт может стереть `actor_type` у существующих и сбросить пароли — память
   T-0638; при необходимости — `scripts/kc-reset-fixture-passwords.sh`).

## Fitness

- Static: `ci/checks/kc/user-profile-actor-type.sh` → PASS.
- Live:   `ci/checks/kc/ui-created-user-actor-type.sh` → PASS (против :8180).
