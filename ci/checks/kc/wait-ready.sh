#!/usr/bin/env bash
# FF-1 (live-kc): Poll GET /health/ready until HTTP 200 or timeout (120 s).
set -euo pipefail
PORT="${KEYCLOAK_PORT:-8180}"
TIMEOUT=120
INTERVAL=5
ELAPSED=0
URL="http://localhost:${PORT}/health/ready"

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
