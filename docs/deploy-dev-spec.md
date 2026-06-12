# T-0008 SPEC — dev auto-deploy + PR dev→main

Версия: 1.0 · Дата: 2026-06-12 · Статус: approved (agent-doable реализован)

---

## 1. Capability-детекция (preflight)

| Capability | Статус | Деталь |
|---|---|---|
| SSH к homeserver-vm (100.121.76.86) | **ЕСТЬ** | `~/.ssh/homeserver_vm` (ed25519), беспарольный; `ubuntu@homeserver-vm`; `id` = ubuntu/docker group |
| git pull на сервере (public repo) | **ЕСТЬ** | HTTPS без токена; `git fetch origin dev` работает |
| docker compose на сервере | **ЕСТЬ** | docker compose v2; 4 контейнера healthy (postgres/keycloak/flowable/choros) |
| `/srv/choros` на сервере | **ЕСТЬ** | git repo на ветке dev, HEAD = b6a1cd6 |
| `gh` PAT — открытие PR | **ЕСТЬ** | `thoxly` auth, scope `repo`+`workflow`; `gh pr create` работает |
| `gh` PAT — листинг PR | **ЕСТЬ** | `gh pr list -R thoxly/choros` работает |
| GitHub Actions — ubuntu-latest runner | **ЕСТЬ** | ci.yml уже работает на ubuntu-latest |
| GitHub Actions secret DEPLOY_SSH_KEY | **ОТСУТСТВУЕТ** | нужен founder: добавить приватный ключ в Secrets → workflow активируется автоматически |
| Self-hosted runner на homeserver-vm | **ОТСУТСТВУЕТ** | альтернативный путь (не обязателен — выбран ubuntu-latest + SSH) |
| Branch protection dev → main PR | **FOUNDER-GATED** | RL-2/GT-3; агент может только создать PR |

---

## 2. Разделение: agent-doable vs founder-gated

### Agent-doable (реализовано в этом PR)

1. **`scripts/deploy-dev.sh`** — скрипт развёртывания: SSH → git pull → docker compose build choros → up → healthcheck. Работает с `--dry-run`. Запускается из GitHub Actions или вручную оператором.

2. **`.github/workflows/deploy-dev.yml`** — GitHub Actions workflow: триггер на push `dev`, устанавливает SSH-ключ из secret, вызывает `scripts/deploy-dev.sh`. Dormant до добавления секрета (условие `if: secrets.DEPLOY_SSH_KEY != ''`).

3. **PR dev→main** — открыт (URL ниже). Система обновляет его авто-push в dev; фаундер кликает «Merge» когда готов.

### Founder-gated (необходимо одно действие)

**`founder_request`: добавить GitHub secret DEPLOY_SSH_KEY**

- Репо: `thoxly/choros`
- Settings → Secrets and variables → Actions → New repository secret
- Name: `DEPLOY_SSH_KEY`
- Value: содержимое приватного ключа `~/.ssh/homeserver_vm` (тот же ключ, которым авторизован `ubuntu@100.121.76.86`)
- После добавления: следующий push в `dev` запустит авто-деплой автоматически — никаких изменений в коде не требуется.

---

## 3. AC (acceptance criteria) для agent-doable части

- [x] `scripts/deploy-dev.sh --dry-run` завершается без ошибок (smoke-test пройден)
- [x] `deploy-dev.yml` содержит dormancy gate (`if: secrets.DEPLOY_SSH_KEY != ''`) — не шумит до добавления секрета
- [x] Workflow НЕ касается `main` и prod-кредов (все операции только на dev ветке, dev-стек)
- [x] PR `dev → main` открыт на GitHub (фаундеру один клик)
- [x] Healthcheck в скрипте ждёт статус `healthy` (docker inspect), timeout 60 s

---

## 4. Что НЕ автономно (RL-2, GT-3, GT-4)

- Мерж PR dev → main — фаундер (RL-2/GT-3)
- Прод-деплой — фаундер (RL-1)
- Добавление GitHub secret — фаундер (GT-4: внешние креды)
- Branch protection rules — фаундер (GT-3)
