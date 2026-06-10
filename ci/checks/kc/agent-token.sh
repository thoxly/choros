#!/usr/bin/env bash
# FF-4 (live-kc): Agent client_credentials token — POST with agent-orchestrator → HTTP 200, non-empty access_token.
set -euo pipefail
PORT="${KEYCLOAK_PORT:-8180}"
REALM="${KEYCLOAK_REALM:-choros}"
TOKEN_URL="http://localhost:${PORT}/realms/${REALM}/protocol/openid-connect/token"

echo "[FF-4] Requesting agent client_credentials token for agent-orchestrator..."

HTTP_STATUS=$(curl -s -X POST "$TOKEN_URL" \
  -d "grant_type=client_credentials" \
  -d "client_id=agent-orchestrator" \
  -d "client_secret=agent-orchestrator-dev-secret" \
  -o /tmp/choros_agent_resp.json \
  -w "%{http_code}" \
  2>/dev/null)

BODY=$(cat /tmp/choros_agent_resp.json 2>/dev/null || echo "")

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "[FF-4] FAIL: HTTP $HTTP_STATUS" >&2
  echo "$BODY" >&2
  exit 1
fi

TOKEN=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "[FF-4] FAIL: access_token is empty in response" >&2
  exit 1
fi

echo "[FF-4] PASS: agent client_credentials token obtained (${#TOKEN} chars)."
echo "$TOKEN" > /tmp/choros_agent_token.txt
