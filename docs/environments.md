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
