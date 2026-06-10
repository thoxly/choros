#!/usr/bin/env bash
# T-0058 · FF-FL-1 (live): Poll GET /flowable-rest/service/management/engine
# with admin basic-auth until HTTP 200 or 120 s timeout.
# Pattern mirrors ci/checks/kc/wait-ready.sh.
# Exit 0 on ready, exit 1 on timeout.
set -euo pipefail

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
TIMEOUT=120
INTERVAL=5
ELAPSED=0
URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service/management/engine"

echo "[FF-FL-1] Waiting for Flowable readiness at ${URL} (timeout: ${TIMEOUT}s)..."

while true; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -u "${ADMIN_USER}:${ADMIN_PASS}" "${URL}" 2>/dev/null || echo "000")
  if [[ "${STATUS}" == "200" ]]; then
    echo "[FF-FL-1] PASS: Flowable is ready (HTTP 200 after ${ELAPSED}s)."
    exit 0
  fi
  if [[ ${ELAPSED} -ge ${TIMEOUT} ]]; then
    echo "[FF-FL-1] FAIL: Flowable not ready after ${TIMEOUT}s (last HTTP status: ${STATUS})." >&2
    exit 1
  fi
  echo "  ... waiting (${ELAPSED}s elapsed, HTTP ${STATUS})"
  sleep ${INTERVAL}
  ELAPSED=$((ELAPSED + INTERVAL))
done
