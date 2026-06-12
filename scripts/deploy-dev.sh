#!/usr/bin/env bash
# deploy-dev.sh — авто-деплой dev-среды на homeserver-vm.
#
# Назначение: исполняется из GitHub Actions (job deploy-dev) после зелёного CI
# на ветке dev. Также запускается вручную оператором:
#
#   ssh -i ~/.ssh/homeserver_vm homeserver-vm 'bash /srv/choros/scripts/deploy-dev.sh'
#   # или локально с проксированием (нужен SSH-ключ):
#   scripts/deploy-dev.sh [--dry-run]
#
# Требования:
#   - Доступ к homeserver-vm через SSH (ключ $SSH_KEY_PATH или $DEPLOY_SSH_KEY secret).
#   - Публичный репо на GitHub — git pull не требует токена.
#   - docker compose >=2 на сервере.
#
# Переменные окружения (опциональны — есть дефолты для dev):
#   DEPLOY_HOST      — IP/hostname сервера (default: 100.121.76.86)
#   DEPLOY_USER      — SSH user (default: ubuntu)
#   DEPLOY_DIR       — каталог на сервере (default: /srv/choros)
#   SSH_KEY_PATH     — путь до SSH-ключа (default: ~/.ssh/homeserver_vm)
#   DRY_RUN          — если non-empty, подставляет echo вместо исполнения

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-100.121.76.86}"
DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
DEPLOY_DIR="${DEPLOY_DIR:-/srv/choros}"
SSH_KEY_PATH="${SSH_KEY_PATH:-${HOME}/.ssh/homeserver_vm}"
DRY_RUN="${DRY_RUN:-}"

# --dry-run flag
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

log() { echo "[deploy-dev] $*"; }
run() {
  if [[ -n "$DRY_RUN" ]]; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

SSH_CMD="ssh -o ConnectTimeout=10 -o BatchMode=yes -i ${SSH_KEY_PATH} ${DEPLOY_USER}@${DEPLOY_HOST}"

log "=== Choros dev deploy ==="
log "Host:  ${DEPLOY_HOST} (user=${DEPLOY_USER})"
log "Dir:   ${DEPLOY_DIR}"
log "Key:   ${SSH_KEY_PATH}"
[[ -n "$DRY_RUN" ]] && log "Mode:  DRY-RUN (no remote commands will execute)"

# 1. Connectivity check
log "1/5 Checking SSH connectivity..."
run $SSH_CMD "echo 'SSH OK'"

# 2. Pull latest dev from origin (public repo — no token needed)
log "2/5 Pulling origin/dev..."
run $SSH_CMD "
  set -euo pipefail
  cd ${DEPLOY_DIR}
  git fetch origin dev
  git checkout dev
  git reset --hard origin/dev
  echo 'Git pull done. HEAD: '$(git log --oneline -1)
"

# 3. Build and restart compose stack (only choros service rebuilt; substrates skip)
log "3/5 Building choros image and restarting..."
run $SSH_CMD "
  set -euo pipefail
  cd ${DEPLOY_DIR}
  # Build only the app service (postgres/keycloak/flowable images are pinned, no rebuild)
  docker compose build --no-cache choros
  # Rolling restart: substrates stay up, only choros restarts
  docker compose up -d --no-deps choros
"

# 4. Health check — wait up to 60 s for choros to be healthy
log "4/5 Waiting for health (up to 60 s)..."
run $SSH_CMD "
  set -euo pipefail
  for i in \$(seq 1 12); do
    STATUS=\$(docker inspect --format='{{.State.Health.Status}}' choros-choros-1 2>/dev/null || echo 'unknown')
    echo \"  attempt \${i}/12: \${STATUS}\"
    if [ \"\${STATUS}\" = 'healthy' ]; then
      echo 'Health check PASSED'
      exit 0
    fi
    sleep 5
  done
  echo 'Health check FAILED after 60 s'
  docker compose logs --tail=50 choros
  exit 1
"

# 5. Report
log "5/5 Deploy complete."
run $SSH_CMD "
  cd ${DEPLOY_DIR}
  echo 'Running containers:'
  docker compose ps
  echo ''
  echo 'HEAD on server:'
  git log --oneline -1
"

log "=== dev deploy OK ==="
