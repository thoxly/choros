#!/usr/bin/env bash
# FF-1 (live-kc): Poll GET /health/ready until HTTP 200 or timeout (120 s).
# In Keycloak 25 start-dev mode, the management interface (health) runs on port 9000
# (KEYCLOAK_MGMT_PORT, default 9000) while the main server runs on KEYCLOAK_PORT (8180).
set -euo pipefail
MGMT_PORT="${KEYCLOAK_MGMT_PORT:-9000}"
TIMEOUT=120
INTERVAL=5
ELAPSED=0
URL="http://localhost:${MGMT_PORT}/health/ready"

echo "[FF-1] Waiting for Keycloak readiness at $URL (timeout: ${TIMEOUT}s)..."

while true; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || echo "000")
  if [[ "$STATUS" == "200" ]]; then
    echo "[FF-1] PASS: Keycloak is ready (HTTP 200 after ${ELAPSED}s)."
    exit 0
  fi
  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    echo "[FF-1] FAIL: Keycloak not ready after ${TIMEOUT}s (last HTTP status: $STATUS)." >&2
    exit 1
  fi
  echo "  ... waiting (${ELAPSED}s elapsed, HTTP $STATUS)"
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done
