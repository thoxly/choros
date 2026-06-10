#!/usr/bin/env bash
# FF-2 (live-kc): OIDC discovery URL returns 200 with issuer matching expected pattern.
set -euo pipefail
PORT="${KEYCLOAK_PORT:-8180}"
REALM="${KEYCLOAK_REALM:-choros}"
DISCOVERY_URL="http://localhost:${PORT}/realms/${REALM}/.well-known/openid-configuration"
EXPECTED_ISS="http://localhost:${PORT}/realms/${REALM}"

echo "[FF-2] Checking realm OIDC discovery at $DISCOVERY_URL..."

RESPONSE=$(curl -sf "$DISCOVERY_URL" 2>/dev/null)
if [[ -z "$RESPONSE" ]]; then
  echo "[FF-2] FAIL: no response from $DISCOVERY_URL" >&2
  exit 1
fi

ACTUAL_ISS=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('issuer',''))")
if [[ "$ACTUAL_ISS" != "$EXPECTED_ISS" ]]; then
  echo "[FF-2] FAIL: issuer mismatch. Expected '$EXPECTED_ISS', got '$ACTUAL_ISS'" >&2
  exit 1
fi

echo "[FF-2] PASS: realm provisioned; issuer='$ACTUAL_ISS'."
