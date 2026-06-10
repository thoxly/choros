#!/usr/bin/env bash
# FF-5 (live-kc): Decode JWT tokens from FF-3/FF-4 and assert all required claims.
set -euo pipefail

echo "[FF-5] Checking JWT claims contract..."

# Read tokens written by human-token.sh / agent-token.sh
HUMAN_TOKEN_FILE="/tmp/choros_human_token.txt"
AGENT_TOKEN_FILE="/tmp/choros_agent_token.txt"

if [[ ! -f "$HUMAN_TOKEN_FILE" ]]; then
  echo "[FF-5] FAIL: human token file not found ($HUMAN_TOKEN_FILE) — run human-token.sh first" >&2
  exit 1
fi
if [[ ! -f "$AGENT_TOKEN_FILE" ]]; then
  echo "[FF-5] FAIL: agent token file not found ($AGENT_TOKEN_FILE) — run agent-token.sh first" >&2
  exit 1
fi

HUMAN_TOKEN=$(cat "$HUMAN_TOKEN_FILE")
AGENT_TOKEN=$(cat "$AGENT_TOKEN_FILE")

PORT="${KEYCLOAK_PORT:-8180}"
REALM="${KEYCLOAK_REALM:-choros}"
EXPECTED_ISS="http://localhost:${PORT}/realms/${REALM}"

check_token() {
  local LABEL="$1"
  local TOKEN="$2"
  local EXPECTED_ACTOR_TYPE="$3"

  # base64-decode the payload (second part of the JWT)
  PAYLOAD=$(echo "$TOKEN" | cut -d'.' -f2 | python3 -c "
import sys, base64, json
raw = sys.stdin.read().strip()
# Add padding
padded = raw + '=' * ((4 - len(raw) % 4) % 4)
decoded = base64.urlsafe_b64decode(padded)
print(decoded.decode('utf-8'))
")

  HEADER_RAW=$(echo "$TOKEN" | cut -d'.' -f1 | python3 -c "
import sys, base64, json
raw = sys.stdin.read().strip()
padded = raw + '=' * ((4 - len(raw) % 4) % 4)
decoded = base64.urlsafe_b64decode(padded)
print(decoded.decode('utf-8'))
")

  FAIL=0

  # 1. iss
  ISS=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('iss',''))")
  if [[ "$ISS" != "$EXPECTED_ISS" ]]; then
    echo "  [$LABEL] FAIL: iss='$ISS', expected '$EXPECTED_ISS'" >&2
    FAIL=1
  else
    echo "  [$LABEL] OK iss='$ISS'"
  fi

  # 2. aud contains 'choros-api'
  AUD_OK=$(echo "$PAYLOAD" | python3 -c "
import json,sys
d=json.load(sys.stdin)
aud=d.get('aud',[])
if isinstance(aud,str): aud=[aud]
print('yes' if 'choros-api' in aud else 'no')
")
  if [[ "$AUD_OK" != "yes" ]]; then
    AUD_VAL=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('aud',''))")
    echo "  [$LABEL] FAIL: aud does not contain 'choros-api' (got: $AUD_VAL)" >&2
    FAIL=1
  else
    echo "  [$LABEL] OK aud contains 'choros-api'"
  fi

  # 3. sub non-empty
  SUB=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sub',''))")
  if [[ -z "$SUB" ]]; then
    echo "  [$LABEL] FAIL: sub is empty" >&2
    FAIL=1
  else
    echo "  [$LABEL] OK sub='$SUB'"
  fi

  # 4. preferred_username non-empty
  PUNAME=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('preferred_username',''))")
  if [[ -z "$PUNAME" ]]; then
    echo "  [$LABEL] FAIL: preferred_username is empty" >&2
    FAIL=1
  else
    echo "  [$LABEL] OK preferred_username='$PUNAME'"
  fi

  # 5. actor_type matches expected
  ACTOR_TYPE=$(echo "$PAYLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('actor_type',''))")
  if [[ "$ACTOR_TYPE" != "$EXPECTED_ACTOR_TYPE" ]]; then
    echo "  [$LABEL] FAIL: actor_type='$ACTOR_TYPE', expected '$EXPECTED_ACTOR_TYPE'" >&2
    FAIL=1
  else
    echo "  [$LABEL] OK actor_type='$ACTOR_TYPE'"
  fi

  # 6. alg = RS256 (or ES256)
  ALG=$(echo "$HEADER_RAW" | python3 -c "import json,sys; print(json.load(sys.stdin).get('alg',''))")
  if [[ "$ALG" != "RS256" && "$ALG" != "ES256" ]]; then
    echo "  [$LABEL] FAIL: alg='$ALG', expected RS256 or ES256" >&2
    FAIL=1
  else
    echo "  [$LABEL] OK alg='$ALG'"
  fi

  return $FAIL
}

FAIL=0

echo "--- Human token (e-kravtsova) ---"
if ! check_token "human" "$HUMAN_TOKEN" "human"; then
  FAIL=1
fi

echo "--- Agent token (agent-orchestrator) ---"
if ! check_token "agent" "$AGENT_TOKEN" "agent"; then
  FAIL=1
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-5] FAIL: JWT claims contract violations found." >&2
  exit 1
fi

echo "[FF-5] PASS: all JWT claims contract assertions passed."
