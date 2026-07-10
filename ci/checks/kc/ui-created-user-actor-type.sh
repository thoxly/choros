#!/usr/bin/env bash
# T-0734 · FF-UP2 (live-kc) — a user created via the SAME admin-REST path the
# product UI uses (registrar service-account POST /users) gets a login token
# carrying actor_type. This is the behavioral proof that the declarative
# user-profile fix (config/keycloak/realm-choros.json components entry) makes
# UI-created accounts actually work instead of 401-ing on every request.
#
# Reproduces the exact T-0734 failure mode: before the fix KC 25 silently
# dropped the actor_type attribute on admin create -> token had no actor_type
# claim -> verifyClaims (src/http/auth.ts) 401. After the fix the attribute
# persists and the claim is present.
#
# Requires a live KC with the choros realm provisioned (same precondition as
# human-token.sh / jwt-claims.sh). Creates and deletes its own throwaway user.
set -euo pipefail

KC_PORT="${KEYCLOAK_PORT:-8180}"
REALM="${KEYCLOAK_REALM:-choros}"
KC="http://localhost:${KC_PORT}"
REG_CLIENT="${KC_REGISTRAR_CLIENT_ID:-choros-registrar}"
REG_SECRET="${KC_REGISTRAR_CLIENT_SECRET:-choros-registrar-dev-secret}"
API_CLIENT="choros-api"
API_SECRET="${CHOROS_API_SECRET:-choros-api-dev-secret}"

UNAME="t0734-fitness-$$-$(date +%s)"
PW="dev-pw-t0734-fitness"

echo "[FF-UP2] Creating a UI-style user via the registrar admin-REST path..."

REG_TOKEN=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d "client_id=$REG_CLIENT" -d "client_secret=$REG_SECRET" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
if [[ -z "$REG_TOKEN" ]]; then
  echo "[FF-UP2] FAIL: could not obtain registrar client_credentials token" >&2
  exit 1
fi

cleanup() {
  local uid
  uid=$(curl -s "$KC/admin/realms/$REALM/users?username=$UNAME&exact=true" \
    -H "Authorization: Bearer $REG_TOKEN" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if d else '')" 2>/dev/null || true)
  [[ -n "$uid" ]] && curl -s -o /dev/null -X DELETE "$KC/admin/realms/$REALM/users/$uid" \
    -H "Authorization: Bearer $REG_TOKEN" || true
}
trap cleanup EXIT

# Create via admin REST with actor_type=["human"] (exactly like createHumanUser;
# firstName/lastName included so the account is login-complete and ROPC succeeds).
CREATE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$KC/admin/realms/$REALM/users" \
  -H "Authorization: Bearer $REG_TOKEN" -H "Content-Type: application/json" \
  -d "{\"username\":\"$UNAME\",\"email\":\"$UNAME@choros.dev\",\"firstName\":\"Fitness\",\"lastName\":\"User\",\"enabled\":true,\"emailVerified\":true,\"attributes\":{\"actor_type\":[\"human\"]},\"credentials\":[{\"type\":\"password\",\"value\":\"$PW\",\"temporary\":false}]}")
if [[ "$CREATE_STATUS" != "201" ]]; then
  echo "[FF-UP2] FAIL: admin POST /users returned HTTP $CREATE_STATUS (expected 201)" >&2
  exit 1
fi

# The attribute must SURVIVE the admin write (regressed => "NONE").
ATTR=$(curl -s "$KC/admin/realms/$REALM/users?username=$UNAME&exact=true" \
  -H "Authorization: Bearer $REG_TOKEN" \
  | python3 -c "import json,sys; u=json.load(sys.stdin)[0]; a=u.get('attributes',{}); print((a.get('actor_type') or [''])[0])")
if [[ "$ATTR" != "human" ]]; then
  echo "[FF-UP2] FAIL: actor_type attribute did NOT persist on admin create (got '$ATTR')" >&2
  echo "         => user profile does not declare actor_type as managed (T-0734 regressed)." >&2
  exit 1
fi
echo "  [OK] actor_type attribute persisted on admin create"

# The token must carry the actor_type claim (what verifyClaims checks).
TOKEN=$(curl -s -X POST "$KC/realms/$REALM/protocol/openid-connect/token" \
  -d grant_type=password -d "client_id=$API_CLIENT" -d "client_secret=$API_SECRET" \
  -d "username=$UNAME" -d "password=$PW" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
if [[ -z "$TOKEN" ]]; then
  echo "[FF-UP2] FAIL: could not obtain a ROPC token for the created user" >&2
  exit 1
fi

CLAIM=$(echo "$TOKEN" | cut -d'.' -f2 | python3 -c "
import sys, base64, json
raw = sys.stdin.read().strip(); raw += '=' * ((4 - len(raw) % 4) % 4)
print(json.loads(base64.urlsafe_b64decode(raw)).get('actor_type', ''))
")
if [[ "$CLAIM" != "human" ]]; then
  echo "[FF-UP2] FAIL: token actor_type claim is '$CLAIM', expected 'human' — verifyClaims would 401" >&2
  exit 1
fi

echo "  [OK] token actor_type claim = 'human'"
echo "[FF-UP2] PASS: UI-created user carries actor_type in its token (no 401)."
