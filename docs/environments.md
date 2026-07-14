# Choros — среды и инфраструктура

> Чтобы нормально тестировать, нужно более одной среды. На старте — две
> постоянные (prod и dev) плюс эфемерные под CI.

Версия документа: 0.1 · Дата: 2026-06-07 · Статус: рабочий

---

## 1. Зачем несколько сред

Нельзя тестировать на проде и нельзя проверять интеграцию «в голове». Нужна
постоянная среда, где собранный код уже работает целиком, но падение ничего не
ломает у пользователей. Отсюда минимум две постоянные среды. На старте этого
достаточно — дробить на staging/qa/preview будем, когда появится реальная
потребность, а не впрок.

---

## 2. Среды (на старте — две постоянные)

| Среда | Из какой ветки | Назначение | Данные | Деплой |
|---|---|---|---|---|
| **dev** | `dev` | Разработка, интеграция, ручное/исследовательское тестирование собранного кода. Может быть нестабильной. | Тестовые / синтетические, **не прод** | Автоматически из `dev` (CI) |
| **prod** | `main` | Боевая. Реальные пользователи и данные. Стабильна. | Реальные | **Только фаундер** (гейт RL-1) |

### Эфемерные CI-среды (сосуществуют, не заменяются)

Под каждый прогон гейтов поднимается одноразовая среда (build → lint → types →
tests → fitness/e2e) и сносится после. Это остаётся основным машинным сигналом
качества **до** слияния. Постоянная dev — это уже про *интеграционное и ручное*
тестирование слитого кода, а не про per-run гейты. Одно не отменяет другое.

```
рабочая ветка → эфемерная CI-среда (per-run, сносится)
       │ авто-мерж (зелёный CI, merge-lock)
       ▼
     dev  → dev-среда (постоянная, авто-деплой)
       │ промоушн (фаундер, вручную)
       ▼
     main → prod-среда (постоянная, деплой фаундера, RL-1)
```

---

## 3. Топология рантайма

Рантайм — `docker-compose` (ядро + Postgres + Keycloak + агентский рантайм; см.
CONCEPT §12). dev и prod — два независимых compose-стека (раздельные тома, БД,
порты/неймспейсы), чтобы dev физически не мог дотянуться до прод-данных. Целевая
площадка — домашний сервер фаундера (`/srv/choros`, доступ через Tailscale).

- **dev-стек** — отдельные креды и том, только тестовые данные. Авто-деплой по
  push в `dev` использует **исключительно non-prod креды**.
- **prod-стек** — прод-креды есть только у фаундера; деплой запускает фаундер
  отдельным шагом (RL-1). У сессий-агентов прод-кредов нет by design.

---

## 4. Границы (что чему соответствует)

- `dev` ветка → dev-среда → авто, non-prod креды.
- `main` ветка → prod-среда → гейт фаундера, прод-креды.
- Никакой путь от рабочей ветки в prod не идёт в обход `main` и подписи фаундера.

Процесс слияния, который наполняет `dev`, описан в [branching.md](branching.md).

---

## 5. Переменные окружения — Postgres (T-0053, E0.3)

| Переменная | По умолчанию (dev) | Назначение |
|---|---|---|
| `POSTGRES_DB` | `choros` | Имя БД |
| `POSTGRES_USER` | `choros_migrator` | Bootstrap-суперпользователь (мигратор/владелец) |
| `POSTGRES_PASSWORD` | `choros_dev_pw` | **DEV ONLY** — пароль мигратора (RL-1) |
| `POSTGRES_PORT` | `55432` | Хост-порт (не 5432, чтобы не конфликтовать с локальным Postgres) |
| `DATABASE_URL` | `postgres://choros_migrator:choros_dev_pw@localhost:55432/choros` | Строка подключения для миграций и приложения |

---

## 6. Keycloak — переменные окружения (T-0054, E0.4)

Keycloak запускается в `start-dev` режиме с импортом realm из `config/keycloak/`.
Все значения ниже — **DEV ONLY** и никогда не используются в prod (RL-1).
Prod-креды держит фаундер и инжектит при деплое (E0.7).

| Переменная | По умолчанию (dev) | Назначение |
|---|---|---|
| `KEYCLOAK_PORT` | `8180` | Хост-порт Keycloak HTTP (OIDC/auth; не 5432/55432/3000; см. AC-13) |
| `KEYCLOAK_MGMT_PORT` | `9000` | Хост-порт Keycloak management-интерфейса (health/ready, metrics — отдельный от HTTP-порта в KC 25) |
| `KEYCLOAK_REALM` | `choros` | Имя realm (закодировано в `config/keycloak/realm-choros.json`) |
| `KEYCLOAK_ADMIN` | `choros_kc_admin` | **DEV ONLY** — логин admin-консоли Keycloak (RL-1) |
| `KEYCLOAK_ADMIN_PASSWORD` | `choros_kc_dev_pw` | **DEV ONLY** — пароль admin-консоли Keycloak (RL-1) |
| `CHOROS_AUTH_MODE` | `dev` | Режим аутентификации: `dev` = x-dev-user-stub; `keycloak` = Bearer JWT (T-0060) |

### JWT-контракт (заморожен для T-0060)

Realm `choros` выдаёт токены со следующими свойствами (фиксирует T-0054; валидирует T-0060):

| Claim | Значение |
|---|---|
| `iss` | `http://<host>:<KEYCLOAK_PORT>/realms/<KEYCLOAK_REALM>` (напр. `http://localhost:8180/realms/choros`) |
| `aud` | включает `choros-api` (client-id core API клиента) |
| `sub` | UUID пользователя Keycloak (non-empty) |
| `preferred_username` | id сотрудника для людей (`e-kravtsova` и т.п.) или `service-account-<clientId>` для агентов (напр. `service-account-agent-orchestrator`) — KC 25 выдаёт username service-account пользователя, а не сам `client_id` |
| `actor_type` | `"human"` для людей; `"agent"` для service-account токенов агентов |
| `alg` (JWT header) | `RS256` (Keycloak default) |

### Dev-креды realm (DEV ONLY — не для prod)

Файл `config/keycloak/realm-choros.json` содержит dev-фикстуры:

- **Core API client**: `choros-api` / secret `choros-api-dev-secret`
- **Пользователи (люди)**: логин = employee-id из `src/http/org.ts`, пароль = `dev-pw-<username>`
  (напр. `e-kravtsova` / `dev-pw-kravtsova`)
- **Агентские service-account клиенты**: `agent-orchestrator` / `agent-orchestrator-dev-secret`
  (аналогично для `agent-recon`, `agent-invoice`, `agent-triage`)

### Режим CHOROS_AUTH_MODE

| Значение | Поведение |
|---|---|
| `dev` (по умолчанию) | Хедер `x-dev-user` активен; JWT не требуется. Все существующие тесты проходят без изменений. |
| `keycloak` | Хедер `x-dev-user` отключён; сервер ожидает Bearer JWT. Требует живой Keycloak с realm. Реализует T-0060. |

#### Фронтенд: как браузер узнаёт режим (T-0258)

Браузерный SPA узнаёт активный режим и публичные OIDC-параметры через **`GET /api/auth-config`**
(публичный, non-secret endpoint; секрет клиента НИКОГДА не отдаётся — браузер использует PKCE).

```jsonc
// dev:
{ "mode": "dev" }
// keycloak:
{ "mode": "keycloak",
  "keycloak": { "url": "<KEYCLOAK_PUBLIC_URL>", "realm": "<KEYCLOAK_REALM>",
                "clientId": "<KEYCLOAK_WEB_CLIENT_ID>", "audience": "<KEYCLOAK_AUDIENCE>" } }
```

В `keycloak`-режиме фронт запускает Authorization Code + PKCE против публичного клиента
`choros-web` (см. `config/keycloak/realm-choros.json`); полученный токен несёт `aud=choros-api`
и `actor_type`, которые валидирует серверный JWT-гард (T-0060). В `dev`-режиме остаётся
dev-user-picker с хедером `x-dev-user`.

---

## 7. choros-app — переменные окружения (T-0061, E0.6)

choros-app (Node.js) запускается через Docker Compose (`choros` сервис).
Dev-значения ниже — **DEV ONLY**; prod-значения инжектятся фаундером через `.env.prod` при деплое (E0.7, RL-1/RL-3).

| Переменная | По умолчанию (dev) | Назначение |
|---|---|---|
| `DATABASE_URL` | `postgres://choros_migrator:choros_dev_pw@postgres:5432/choros` | Строка подключения (хост = `postgres` внутри compose) |
| `CHOROS_AUTH_MODE` | `dev` | Режим аутентификации: `dev` = x-dev-user-stub; `keycloak` = Bearer JWT (T-0060) |
| `KEYCLOAK_PORT` | `8180` | Порт Keycloak HTTP (для внешних клиентов; сервер-сайд KC_ISSUER использует имя сервиса) |
| `KEYCLOAK_REALM` | `choros` | Имя realm Keycloak |
| `KC_ISSUER` | `http://keycloak:8180/realms/choros` | OIDC issuer (внутренний хост compose для server-side валидации JWT) |
| `KEYCLOAK_URL` | `http://keycloak:8180` | **T-0060** Base URL Keycloak (server-side). Обязателен при `CHOROS_AUTH_MODE=keycloak` если не задан `KC_ISSUER`. |
| `KEYCLOAK_AUDIENCE` | `choros-api` | **T-0060** Ожидаемая аудитория JWT (`aud` claim). Зафиксирована T-0054 §4.1. |
| `JWKS_CACHE_TTL_MS` | `300000` | **T-0060** TTL in-memory JWKS-кэша (мс). Горячий кэш — нулевой сетевой хоп (NF-3). |
| `KEYCLOAK_JWKS_URI` | — | **T-0060** Опциональный override URI JWKS; по умолчанию резолвится через OIDC discovery. |
| `KEYCLOAK_PUBLIC_URL` | `http://localhost:8180` | **T-0258** Browser-reachable Keycloak origin, отдаётся фронту через `GET /api/auth-config` (НЕ compose-внутренний `keycloak`-хост). Fallback на `KEYCLOAK_URL`. В prod = реальный внешний auth-origin. Публичное (non-secret) значение. |
| `KEYCLOAK_WEB_CLIENT_ID` | `choros-web` | **T-0258** Публичный PKCE SPA-клиент для браузера (`config/keycloak/realm-choros.json`). Отдаётся фронту через `/api/auth-config`. Публичный клиент без секрета — браузер использует Authorization Code + PKCE. |
| `NODE_ENV` | `development` | Режим Node (`development` / `production`); prod overlay устанавливает `production` |
| `PORT` | `3000` | Внутренний порт приложения (EXPOSE 3000 в Dockerfile) |
| `APP_PORT` | `3000` | Хост-порт маппинга (`${APP_PORT:-3000}:3000`); не конфликтует с 55432/8180/9000/8082 |
| `FILE_STORE_ROOT` | `/app/uploads` | **T-0624** Каталог внутри контейнера, куда `FsObjectStore` (`src/adapters/s3-object-store.ts`) пишет физические байты файлов (`src/server.ts`). Смонтирован на именованный docker-volume (см. ниже) — НЕ голый путь контейнера. |

### T-0624 — persistent volume для файлового контента (FsObjectStore)

**Проблема (LIVE_PROOF T-0579):** `FsObjectStore` хранит байты вложений на файловой
системе контейнера. Без volume-mount `FILE_STORE_ROOT` — это часть writable-слоя
образа: `docker compose up` с пересборкой образа (или пересоздание контейнера)
стирает каталог. Метаданные (`file_version.size` и т.д.) в Postgres переживают,
байты — нет → скачивание старого файла отдаёт HTTP 500 / `len=0`. Свежие загрузки
в ТЕКУЩЕМ контейнере работали (маскировало проблему до передеплоя).

**Фикс:** `FILE_STORE_ROOT=/app/uploads` смонтирован на именованный docker-volume:

| Стек | Volume | Объявлен в |
|---|---|---|
| dev | `choros_uploads` | `docker-compose.yml` (base) |
| prod | `choros_uploads_prod` | `docker-compose.prod.yml` (override, физически изолирован от dev — AC-4 паттерн, как `choros_pgdata_prod`) |

Именованный volume переживает `docker compose up`/`down`/пересборку образа —
Docker управляет его данными вне writable-слоя контейнера; стирает его только
`down -v` или явный `docker volume rm`. В Dockerfile нет `USER` (рантайм — root),
поэтому контейнер пишет в volume без проблем с правами независимо от того, кто
создал volume.

**Prod-долговечность (за рамками этой задачи, GT-4):** именованный volume решает
проблему «файл теряется при передеплое на ТОМ ЖЕ хосте», но не «хост потерян/
диск умер». Настоящая prod-долговечность — S3-совместимый провайдер за портом
`ObjectStore` (T-0579 ADR §deploy, T-0119 §8) — деплой-тайм выбор фаундера, вне
объёма T-0624.

**Как проверить живьём, что volume переживает передеплой:**

```bash
# 1. Залить файл на дев-стенде (через UI или напрямую curl, дав валидный auth):
curl -sf -X POST "http://<host>:3000/api/records/<recordId>/files" \
  -H "X-File-Name: probe.txt" -H "Content-Type: text/plain" \
  --data-binary "T-0624 persistence probe $(date -u +%FT%TZ)" \
  -H "x-dev-user: <actor>"
# Запомнить fileVersionId из ответа (201 {fileId, versionId, versionNo}).

# 2. Убедиться, что байты реально лежат в volume (не только в живом контейнере):
docker compose exec choros sh -c 'ls -la /app/uploads'
docker volume inspect <project>_choros_uploads   # Mountpoint существует на хосте

# 3. Передеплой С пересборкой образа (это ключевой момент — именно пересборка
#    стирала writable-слой контейнера ДО фикса):
docker compose build choros
docker compose up -d --force-recreate choros
# (дождаться healthy: docker compose ps)

# 4. Скачать файл, залитый ДО передеплоя — байты должны быть на месте:
curl -sf "http://<host>:3000/api/files/<versionId>/download" \
  -H "x-dev-user: <actor>" -o /tmp/probe-after-redeploy.txt
diff <(echo -n "T-0624 persistence probe ...") /tmp/probe-after-redeploy.txt
# ИЛИ проще: сравнить Content-Length ответа с исходным size — не 0, не 500.
```

Критерий успеха: HTTP 200 (не 500), тело непустое, байты совпадают с загруженными
до передеплоя. Провал (500/len=0) после `--force-recreate` без volume — это ровно
дефект, зафиксированный LIVE_PROOF T-0579; после фикса он не должен повторяться.

### Запуск prod-стека

```bash
# 1. Скопировать .env.prod.example → .env.prod и заполнить все REPLACE_* значения
cp .env.prod.example .env.prod
# ... отредактировать .env.prod ...

# 2. Запустить prod-стек
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d
```

`.env.prod` находится в `.gitignore` — никогда не коммитить (RL-3).

### Фикстурные dev-креды на persistent-стенде (T-0695)

**Проблема:** `dev-pw-<username>` из `config/keycloak/realm-choros.json` работают
только при СВЕЖЕМ импорте realm (первый `docker compose up`, пустой том Keycloak).
На PERSISTENT dev-стенде `scripts/kc-dev-setup.sh` реконсилит realm идемпотентно —
но для `users` это **create-if-not-exists** (намеренно: сохраняет
само-зарегистрированных юзеров, добавленных после первого импорта). Если юзер уже
существует в KC-томе стенда, повторное применение realm-JSON НЕ восстанавливает
его пароль — скрипт просто печатает `[SKIP]`. Итог: пароли фикстурных юзеров на
живом стенде дрейфуют от `dev-pw-*` независимо, и раньше каждая LIVE_PROOF-сессия
сбрасывала их по-своему через KC admin REST на одноразовый ad-hoc пароль (не
задокументированный централизованно) — см. находку `docs/live-proof/T-0639.md` P1.

**Решение:** `scripts/kc-reset-fixture-passwords.sh` — идемпотентный скрипт,
переустанавливающий пароли ТОЛЬКО не-владельческих фикстурных юзеров на
**детерминированное** значение (не зависящее от даты/задачи/сессии).

#### Схема паролей

Формула: `LiveProof-Fixture-<username>!` (чистая функция username → пароль).

| Юзер | Детерминированный пароль |
|---|---|
| `e-kravtsova` | `LiveProof-Fixture-e-kravtsova!` |
| `e-mironov` | `LiveProof-Fixture-e-mironov!` |
| `e-larina` | `LiveProof-Fixture-e-larina!` |
| `e-orlov` | `LiveProof-Fixture-e-orlov!` |
| `e-savina` | `LiveProof-Fixture-e-savina!` |
| `e-petrov` | `LiveProof-Fixture-e-petrov!` |
| `e-belov` | `LiveProof-Fixture-e-belov!` |
| `e-configurator` | `LiveProof-Fixture-e-configurator!` |

При каждом сбросе скрипт ТАКЖЕ переустанавливает `attributes.actor_type="human"`
**скаляром** (не массивом `["human"]`) — фикс дрейфа из T-0638: realm-reimport
стирает этот single-valued profile-атрибут, и его нужно восстанавливать той же
формой, иначе actor-резолвер на сервере не распознаёт юзера как человека.

#### ЧЁРНЫЙ список (владельческие креды — этот скрипт их НИКОГДА не трогает)

Правило памяти `founder-cred-lockout`: приёмки/скрипты не сбрасывают владельческие
креды фаундера. Owner skip-list жёстко закодирован в скрипте (не читается из
внешнего файла/аргумента):

| Юзер | Почему владелец |
|---|---|
| `e-owner` | genesis-owner тенанта Dev Silo, создан вручную в T-0583 (`isGenesisOwner: true`) |
| `t0586-admin` | genesis-owner, создан в приёмке T-0583/2026-07-04 (`isGenesisOwner: true`, подтверждено `/api/me/nav-capabilities`) — **НЕ рядовой тест-юзер**, несмотря на то что выглядит как один |
| `pgv@axonteam.ru` | реальный логин фаундера-владельца стенда |

Если владельческий доступ утерян — это отдельная эскалация к фаундеру (не через
этот скрипт); см. память `choros-founder-cred-lockout-2026-07-06` (кандидат:
«Сбросить пароль» на `/users` + SMTP).

#### Как запустить

```bash
# Локально (docker-compose, дефолты уже верны):
bash scripts/kc-reset-fixture-passwords.sh

# Против реального persistent-стенда — переопределить KC_URL/admin-креды:
KC_URL="https://<tailscale-host>:8443" \
KC_ADMIN="choros_kc_admin" \
KC_ADMIN_PW="<реальный admin-пароль стенда>" \
  bash scripts/kc-reset-fixture-passwords.sh

# Офлайн self-test (без KC, без сети) — доказывает guard/детерминизм:
bash scripts/kc-reset-fixture-passwords.sh --self-test
```

Скрипт идемпотентен (повторный запуск безопасен — тот же результат) и в конце
печатает таблицу «юзер → пароль». **Proof-агенты должны брать креды из этой
таблицы выше, а не из археологии по `docs/live-proof/*`.** Если таблица в этом
файле когда-нибудь разойдётся с фактическим выводом скрипта — вывод скрипта
авторитетен (эта таблица — просто удобный человекочитаемый снимок детерминированной
формулы, не отдельный источник правды).

Скрипт НЕ создаёт новых пользователей — если юзера нет в KC на стенде вообще,
сначала нужно применить realm через `scripts/kc-dev-setup.sh`.

---

### Как добавить пользователя или агентский клиент

Все изменения realm — только через `config/keycloak/realm-choros.json` (декларативно):

1. **Добавить человека**: добавить объект в массив `users` с полями `username`, `email`,
   `credentials[{type:"password", value:"dev-pw-<id>"}]` и `attributes.actor_type=["human"]`.
2. **Добавить агентский клиент**: добавить объект в массив `clients` с
   `serviceAccountsEnabled: true`, `clientId: "agent-<name>"`, `directAccessGrantsEnabled: false`
   и соответствующий service-account user в `users` с `serviceAccountClientId: "agent-<name>"`
   и `attributes.actor_type: ["agent"]`.
3. Пересоздать Keycloak-контейнер (`docker compose down keycloak && docker compose up -d keycloak`),
   чтобы импорт realm применился заново.
