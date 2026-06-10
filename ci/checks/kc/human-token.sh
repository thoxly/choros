#!/usr/bin/env bash
# FF-3 (live-kc): Human ROPC token — POST with e-kravtsova credentials → HTTP 200, non-empty access_token.
set -euo pipefail
PORT="${KEYCLOAK_PORT:-8180}"
REALM="${KEYCLOAK_REALM:-choros}"
TOKEN_URL="http://localhost:${PORT}/realms/${REALM}/protocol/openid-connect/token"

echo "[FF-3] Requesting human ROPC token for e-kravtsova..."

RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST "$TOKEN_URL" \
  -d "grant_type=password" \
  -d "client_id=choros-api" \
  -d "client_secret=choros-api-dev-secret" \
  -d "username=e-kravtsova" \
  -d "password=dev-pw-kravtsova" \
  2>/dev/null)

HTTP_STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[FF-3] FAIL: HTTP $HTTP_STATUS" >&2
  echo "$BODY" >&2
  exit 1
fi

TOKEN=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "[FF-3] FAIL: access_token is empty in response" >&2
  exit 1
fi

# Export for jwt-claims.sh to consume
export HUMAN_TOKEN="$TOKEN"
echo "[FF-3] PASS: human ROPC token obtained (${#TOKEN} chars)."
echo "$TOKEN" > /tmp/choros_human_token.txt
