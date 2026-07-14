# T-0061 · docker-compose: dev + prod стеки Spec

**Title:** E0.6 · docker-compose: dev + prod стеки (раздельные тома/БД/порты; dev = non-prod креды)
**Task type:** infrastructure
**Status:** ready (no blocking questions)
**Authored:** 2026-06-11
**Authoritative sources (do NOT re-open):**
- `CONCEPT.md` §12 — «Один артефакт: docker-compose (ядро + Postgres + Keycloak + агентский рантайм)»; режим = конфигурация, не ветка кода.
- `docs/environments.md` §2–§4 — dev vs prod: два постоянных независимых compose-стека; dev авто-деплой, prod только фаундер; dev = non-prod данные + kreды.
- `docs/environments.md` §3 — «dev и prod — два независимых compose-стека (раздельные тома, БД, порты/неймспейсы), чтобы dev физически не мог дотянуться до прод-данных».
- `docs/design/tenancy-and-delivery.md` §7 — один артефакт; режим = конфигурация; НЕ ветка `src/`; docker-compose — обёртка silo/on-prem поставки.
- `docs/design/T-0054-keycloak-compose.adr.md` §7 (seam) — «A unified single-command compose including the app server is E0.6 scope».
- Sister tasks with existing compose blocks: **T-0053** (postgres), **T-0054** (keycloak), **T-0058** (flowable) — все три сервиса уже в `docker-compose.yml`; T-0061 не трогает эти блоки деструктивно.
- **E0.7** (провижн home-server, founder-gated) — вне скоупа.

---

## 0. Контекст и шов

**Что существует (не ломать):**

- `docker-compose.yml` в корне репо определяет три сервиса: `postgres` (T-0053), `keycloak` (T-0054), `flowable` (T-0058). Все три сервиса имеют dev-дефолты кредов и один именованный том `choros_pgdata`. Compose-файл — единственный источник истины для dev-запуска.
- Choros-ядро (Node.js/TypeScript) запускается вручную (`node dist/index.js`). Dockerfile'а нет. Его наличие в compose — часть скоупа T-0061.
- Существующие ci/checks (flowable smokes, kc checks, no-committed-secret.sh, pg-single-dep.sh) должны продолжать проходить.

**Механика «одного артефакта» (ratified ADR):**

Deployment mode = конфигурация, не ветка. Механизм реализации — `docker compose` override-файлы: `docker-compose.yml` (base, dev-дефолты), `docker-compose.prod.yml` (prod-overrides, только переопределения). Prod-запуск: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up`. Dev-запуск: `docker compose up` (как сейчас). Это стандартный compose-паттерн, не требует founder-решения (имплементационная деталь в зоне DESIGN).

**Шов с downstream:**

- E0.7 (провижн сервера фаундера): берёт оба файла и `.env.prod.example` как-есть. T-0061 не деплоит на сервер, не создаёт реальных прод-кредов.
- T-0060 (auth-mode KEYCLOAK/JWT): `CHOROS_AUTH_MODE` уже в `docs/environments.md`; choros-app сервис должен принимать этот env-флаг.

---

## 1. Summary

T-0061 превращает существующий dev-only `docker-compose.yml` в **полностью самодостаточный dev-стек одной командой** (`docker compose up`), включая choros-app сервис, и добавляет **`docker-compose.prod.yml` — override для prod**, который: (a) переключает все чувствительные переменные на `required`-форму (нет дефолта — compose упадёт с ошибкой, если не задан), (b) использует отдельные именованные тома, (c) запускает Keycloak в `start` (prod) режиме вместо `start-dev`. Prod-креды хранятся вне репо (`.env.prod` или secrets inject); в репо только `.env.prod.example` с placeholder-значениями. Ни один реальный prod-секрет не коммитится (RL-3).

---

## 2. Скоуп

T-0061 **строит**:
- Choros-app сервис (`choros` или `app`) в `docker-compose.yml` с dev-дефолтами и `depends_on` на postgres/keycloak/flowable.
- `Dockerfile` для choros-app (multi-stage: `npm ci` → `tsc` → runtime; непродакшн-образ в dev-режиме; в prod тот же образ без `NODE_ENV=development` — конфигурация).
- `docker-compose.prod.yml` — compose override-файл (только prod-специфичные переопределения): required-форма кредов (без дефолтов), prod-тома, Keycloak prod-mode, `NODE_ENV=production` для choros-app.
- `.env.prod.example` — шаблон prod-переменных с placeholder-значениями и инструкцией «замени перед деплоем»; коммитится в репо.
- `.gitignore` — добавить `.env.prod` (реальный файл с prod-кредами) если ещё не добавлен.
- Обновление `docs/environments.md` §3 — добавить таблицу переменных choros-app.
- CI-проверки (static): `ci/checks/compose-prod-config.sh` — `docker compose config -q` для обоих режимов, проверки томов/портов/кредов (см. AC).

T-0061 **НЕ строит**:
- Провижн home-server фаундера (/srv/choros, Tailscale) — E0.7 (founder-gated).
- Helm-чарт, Kubernetes — не MVP (CONCEPT §12).
- Реальные prod-креды — никогда в репо (RL-3).
- Secrets management UI/vault (HashiCorp Vault, AWS Secrets Manager) — за MVP.
- Второй экземпляр Postgres-контейнера — нарушение single-Postgres-invariant; dev и prod **не запускаются одновременно на одном хосте** в одном stack-namespace.
- Staging / preview / QA среды — `docs/environments.md` §2: «на старте этого достаточно — дробить будем, когда появится реальная потребность».
- Изменение `src/` кода — только compose-инфра и Dockerfile.
- Миграции БД — не скоуп (seam T-0053/T-0054 уже запущен; миграции идут при старте приложения, не в compose-файле).

---

## 3. Функциональные требования

### FR-1 · choros-app сервис в dev-compose

- `docker-compose.yml` ДОЛЖЕН определять сервис `choros` (или `app`), образ которого собирается из `Dockerfile` в корне репо.
- Сервис ДОЛЖЕН принимать все env-переменные, необходимые для старта ядра: `DATABASE_URL`, `CHOROS_AUTH_MODE`, `KEYCLOAK_PORT`, `KEYCLOAK_REALM`, `NODE_ENV`, `PORT` — с dev-дефолтами (нет необходимости в секрете для dev).
- Сервис ДОЛЖЕН объявить `depends_on` на `postgres: condition: service_healthy`, `keycloak: condition: service_healthy`, `flowable: condition: service_healthy`.
- Хост-порт приложения: `${APP_PORT:-3000}:3000` (dev-дефолт `3000`; не конфликтует с `55432`, `8180`, `9000`, `8082`).
- `docker compose up` ДОЛЖНА поднять весь стек (postgres + keycloak + flowable + choros) без ручных шагов.

### FR-2 · Dockerfile для choros-app

- Multi-stage Dockerfile: stage `builder` (`node:20-alpine`) — `npm ci`, `npm run build` (tsc); stage `runtime` — копирует `dist/` и `package*.json`, `npm ci --omit=dev`, запускает `node dist/index.js`.
- `EXPOSE 3000` в runtime-stage.
- Prod и dev используют **тот же образ** — разница в env-переменных (`NODE_ENV`, `CHOROS_AUTH_MODE` и т.д.), не в ветке или отдельном Dockerfile.
- Образ НЕ коммитит `node_modules/` или `.env*` файлы (`.dockerignore`).

### FR-3 · docker-compose.prod.yml (prod override)

- Файл `docker-compose.prod.yml` переопределяет только prod-специфичные значения поверх `docker-compose.yml`.
- Все choros-app env-переменные с чувствительными значениями ДОЛЖНЫ быть в **required-форме** `${VAR}` (без `:-default`). Compose упадёт с явной ошибкой `variable VAR is not set`, если prod-перем не задана оператором.
- Аналогично для Postgres, Keycloak, Flowable: `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `FLOWABLE_REST_APP_ADMIN_PASSWORD` — в prod override ДОЛЖНЫ быть в required-форме.
- Keycloak ДОЛЖЕН запускаться в prod-режиме (`command: start`) в override-файле (не `start-dev`).
- Prod-тома ДОЛЖНЫ иметь имена с суффиксом `_prod` (напр. `choros_pgdata_prod`), чтобы физически не пересекаться с dev-томами при возможном сосуществовании на одном хосте.
- `NODE_ENV=production` в prod override для choros-app.
- Порты в prod overlay МОГУТ оставаться теми же (env-configured) или быть переопределены оператором через `.env.prod`; по умолчанию prod и dev не запускаются одновременно (разные compose-стеки).

### FR-4 · .env.prod.example

- Файл `.env.prod.example` ДОЛЖЕН коммититься в репо (в `docs/` или корне).
- Содержит все переменные, необходимые для prod-запуска, с **placeholder-значениями** (не реальными кредами), напр. `POSTGRES_PASSWORD=REPLACE_WITH_SECURE_PASSWORD`.
- Содержит инструкцию: «скопировать в `.env.prod`, заполнить реальными значениями перед деплоем; `.env.prod` в `.gitignore`».
- Никакой реальный пароль, ключ или секрет в `.env.prod.example` (RL-3).

### FR-5 · .gitignore

- `.env.prod` (реальный файл с prod-кредами) ДОЛЖЕН быть в `.gitignore` (если ещё не добавлен).
- `.env.local`, `.env.*.local` — аналогично.

### FR-6 · docker compose config -q проходит на обоих режимах

- `docker compose -f docker-compose.yml config -q` — exits 0 (dev-mode, с дефолтами).
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q` — exits 0, **если все required-переменные заданы** (через `--env-file .env.prod.example` с placeholder-заменой или в окружении).
- Ci-скрипт `ci/checks/compose-prod-config.sh` проверяет оба режима.

---

## 4. Нефункциональные требования

### NF-1 · Один артефакт (RL из ADR)

Compose-файл(ы) — это _конфигурация_, не fork кода. `docker-compose.yml` + `docker-compose.prod.yml` = два уровня одного артефакта поставки. Это прямое следствие ratified `tenancy-and-delivery.md` §7.

### NF-2 · Нет prod-секретов в репо (RL-3)

Ни один пароль, ключ, токен или иной prod-секрет не коммитится. Dev-дефолты (e.g. `choros_dev_pw`, `choros_kc_dev_pw`, `choros_flowable_dev_pw`) — допустимы и явно помечены `# DEV ONLY`. Prod override — только required-форма (`${VAR}` без дефолта). `.env.prod.example` — только placeholders.

### NF-3 · Single-Postgres invariant

Prod override НЕ добавляет второй Postgres-контейнер. Dev и prod используют один и тот же образ `postgres:16` — разница в переменных и именах томов.

### NF-4 · Физическая изоляция томов dev/prod

Dev-том: `choros_pgdata`. Prod-том: `choros_pgdata_prod` (и аналогично для других томов, если появятся). Если dev и prod поднимаются на одном хосте одновременно — их данные физически разделены.

### NF-5 · Неатендированный старт (CI, без ручных шагов)

`docker compose up` (dev) поднимает весь стек автоматически. Все healthcheck/depends_on уже определены в T-0053–T-0058; choros-app добавляет `depends_on` аналогично.

### NF-6 · Keycloak prod-mode в prod overlay

`start-dev` — режим без TLS, без hardened security. В prod overlay Keycloak ДОЛЖЕН запускаться в `start`-режиме. Доп. prod-параметры KC (hostname, proxy, TLS) — impl-деталь для E0.7/DESIGN; T-0061 только переключает команду и required-форму кредов.

### NF-7 · Fitness scripts следуют устоявшемуся паттерну

Bash, `set -euo pipefail`, clear PASS/FAIL output, exit 0 on pass, exit 1 on failure — идентично `ci/checks/kc/*.sh`, `ci/checks/flowable/*.sh`.

---

## 5. Явные не-цели (out of scope)

- Провижн home-server фаундера (/srv/choros, Tailscale, `scp`/`rsync` деплой) — E0.7 (founder-gated, RL-1).
- Helm / Kubernetes — будущее pooled-SaaS (CONCEPT §12, ADR §7).
- Staging, preview, QA среды — `docs/environments.md` §2.
- Secrets manager (Vault, AWS SM, Doppler) — за MVP; prod-инъекция через `.env.prod` достаточна для single-server.
- Flowable безопасностный hardening (TLS на Flowable REST, external SSL) — E0.7 infra.
- Изменение `src/` кода приложения.
- Миграции БД (новые) — не скоуп; существующие миграции запускаются при старте choros-app.
- HTTP/HTTPS reverse proxy (nginx, Caddy) перед choros-app — за MVP; E0.7 или отдельная инфра-задача.

---

## 6. Критерии приёмки

### AC-1 · docker compose config -q (dev) exits 0

`docker compose -f docker-compose.yml config -q` (без доп. env) завершается с кодом 0.
Проверка: `ci/checks/compose-prod-config.sh` — первый шаг, без реальных сервисов.

**verifiable_as:** fitness

### AC-2 · docker compose config -q (prod) exits 0

`docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q` с подставленными placeholder-значениями из `.env.prod.example` завершается с кодом 0.
Проверка: `ci/checks/compose-prod-config.sh` — второй шаг, с `--env-file .env.prod.example` (после замены placeholder на допустимые значения).

**verifiable_as:** fitness

### AC-3 · Prod overlay использует required-форму для всех чувствительных переменных

`docker-compose.prod.yml` НЕ содержит `${VAR:-default}` для `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `FLOWABLE_REST_APP_ADMIN_PASSWORD` и аналогичных prod-секретов. Только `${VAR}` (без `:-`).
Проверка: static grep/sed на `docker-compose.prod.yml`: наличие `PASSWORD.*:-` → FAIL; отсутствие → PASS.

**verifiable_as:** fitness

### AC-4 · Prod-тома не пересекаются с dev-томами

`docker-compose.prod.yml` определяет тома с именами, отличными от `docker-compose.yml`. В частности, prod-том Postgres НЕ равен `choros_pgdata`.
Проверка: static grep/yaml-parse: prod-overlay не содержит `choros_pgdata:` без суффикса `_prod`.

**verifiable_as:** fitness

### AC-5 · .env.prod.example не содержит реальных секретов

Файл `.env.prod.example` присутствует в репо. Каждое значение, соответствующее ключам `PASSWORD`, `SECRET`, `KEY`, `TOKEN`, содержит слово `REPLACE` или является пустой строкой — не содержит реальных кредов.
Проверка: `ci/checks/no-committed-secret.sh` расширен или отдельный fitness-check на `.env.prod.example`.

**verifiable_as:** fitness

### AC-6 · .env.prod в .gitignore

Файл `.gitignore` содержит строку `.env.prod` (или паттерн, покрывающий `.env.prod`).
Проверка: `grep -E '^\\.env\\.prod$|^\\.env\\.' .gitignore` → должен быть матч.

**verifiable_as:** fitness

### AC-7 · choros-app сервис присутствует в docker-compose.yml

`docker-compose.yml` содержит сервис `choros` (или `app`) с `build: .` (или `build: context: .`), env-переменными c dev-дефолтами, `depends_on` на postgres/keycloak/flowable, хост-портом `${APP_PORT:-3000}:3000`.
Проверка: static yaml-parse + grep на наличие сервиса, depends_on-набора, порта.

**verifiable_as:** fitness

### AC-8 · Dockerfile существует и проходит build

`Dockerfile` присутствует в корне репо. `docker build .` завершается без ошибок (multi-stage build, npm ci, tsc). Образ запускается и `node dist/index.js` стартует (healthcheck или `docker run --rm <img> node -e "require('./dist/index')"` возвращает 0 либо процесс поднимается).
Проверка: CI-шаг `docker build -t choros-test .` — exits 0; либо fitness в `ci/checks/compose-prod-config.sh`.

**verifiable_as:** fitness

### AC-9 · Keycloak в prod overlay запускается в start-режиме (не start-dev)

`docker-compose.prod.yml` переопределяет `command` Keycloak на `start ...` (не `start-dev ...`).
Проверка: static grep на `docker-compose.prod.yml` — наличие `start-dev` → FAIL; наличие `start` без `dev` → PASS (с учётом `--import-realm` или аналогичного аргумента).

**verifiable_as:** fitness

### AC-10 · Существующие смоки Keycloak и Flowable живут в dev-режиме

После `docker compose up` (dev) следующие CI-проверки завершаются с кодом 0:
- `ci/checks/kc/wait-ready.sh` (Keycloak health ready)
- `ci/checks/kc/realm-ready.sh` (realm choros доступен)
- `ci/checks/flowable/wait-ready.sh` (Flowable management/engine)
- `ci/checks/flowable/smoke.sh` (deploy + start instance)
Проверка: CI-прогон на dev-стеке; все перечисленные скрипты exits 0.

**verifiable_as:** fitness

### AC-11 · Порт choros-app не конфликтует с другими сервисами

Хост-порт `APP_PORT` (дефолт `3000`) не совпадает с `POSTGRES_PORT` (55432), `KEYCLOAK_PORT` (8180), `KEYCLOAK_MGMT_PORT` (9000), `FLOWABLE_PORT` (8082).
Проверка: static parse всех host-портов из `docker-compose.yml` — assert уникальность.

**verifiable_as:** fitness

### AC-12 · no-committed-secret.sh exits 0 после изменений

`ci/checks/no-committed-secret.sh` (или его расширенная версия) проходит на новых compose-файлах и `.env.prod.example`.
Проверка: CI-прогон.

**verifiable_as:** fitness

### AC-13 · docker compose up (dev) поднимает все 4 сервиса healthy

`docker compose up -d && docker compose ps` — все четыре сервиса (`postgres`, `keycloak`, `flowable`, `choros`) в состоянии `healthy` или `running` (для сервисов без healthcheck). Полный стек поднимается без ручного вмешательства.
Проверка: CI-интеграционный шаг; или manual smoke на хосте разработчика.

**verifiable_as:** fitness

---

## 7. Сводная таблица шва для downstream

| Downstream задача | Что берёт из T-0061 |
|---|---|
| E0.7 (провижн сервера фаундера) | `docker-compose.yml` + `docker-compose.prod.yml` + `.env.prod.example`; founder копирует на /srv/choros, создаёт `.env.prod` с реальными кредами, запускает `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` |
| T-0060 (Keycloak JWT auth) | Choros-app сервис принимает `CHOROS_AUTH_MODE=keycloak`; переменная должна быть в compose env choros-app |
| T-0114/E1.1 (JobStore Postgres) | Choros-app сервис уже имеет `DATABASE_URL` → JobStore-Postgres подключается через тот же URL |
| CI workflow | Добавить шаг `docker compose up -d` перед интеграционными fitness-проверками |

---

## 8. Blocking questions

Нет. Все архитектурные развилки закрыты:
- «Один артефакт, режим = конфигурация» — ratified `tenancy-and-delivery.md` §7 (фаундер 2026-06-08).
- «choros-app сервис в compose — E0.6 scope» — ratified T-0054 ADR §7 seam.
- «dev = non-prod kreды, prod = only founder» — ratified `docs/environments.md` §3, RL-1.
- Override-файлы vs profiles vs env-файлы — имплементационная деталь (DESIGN-autonomous); compose override-файл (`docker-compose.prod.yml`) выбран как самый явный и стандартный механизм без дополнительного рантайм-компонента.
- Нужен ли Dockerfile — да, явно: T-0054 ADR seam + CONCEPT §12.
