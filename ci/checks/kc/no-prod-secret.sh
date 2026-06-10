#!/usr/bin/env bash
# FF-11: No prod credential in TS source; DEV ONLY label in realm JSON; compose uses ${VAR:-default} form.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "[FF-11] Checking no prod credentials committed..."

FAIL=0

# (a) Dev credential literals must NOT appear in TS source files
DEV_CRED_PATTERNS=(
  "choros_kc_dev_pw"
  "dev-pw-"
  "dev-secret"
  "choros-api-dev-secret"
  "agent-orchestrator-dev-secret"
)
for PATTERN in "${DEV_CRED_PATTERNS[@]}"; do
  if grep -r "$PATTERN" src/ 2>/dev/null | grep -v "^src/.*:.*//"; then
    echo "ERROR: dev credential pattern '$PATTERN' found in src/ — credentials belong only in compose and realm JSON" >&2
    FAIL=1
  fi
done

# (b) Realm JSON must have DEV ONLY label
if ! grep -i "DEV ONLY\|dev-only\|dev only" config/keycloak/realm-choros.json > /dev/null 2>&1; then
  echo "ERROR: config/keycloak/realm-choros.json is missing a 'DEV ONLY' label/comment" >&2
  FAIL=1
else
  echo "  [OK] DEV ONLY label present in realm JSON"
fi

# (c) Compose KEYCLOAK_ADMIN_PASSWORD must use \${VAR:-default} form, not a literal password
if grep "KEYCLOAK_ADMIN_PASSWORD" docker-compose.yml | grep -v '\${.*:-.*}' > /dev/null 2>&1; then
  echo "ERROR: KEYCLOAK_ADMIN_PASSWORD in docker-compose.yml is not in \${VAR:-default} form" >&2
  FAIL=1
else
  echo "  [OK] KEYCLOAK_ADMIN_PASSWORD uses \${VAR:-default} form in docker-compose.yml"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-11] FAIL: credential hygiene check failed." >&2
  exit 1
fi

echo "[FF-11] PASS: no prod credentials in TS source; realm JSON labeled; compose uses env-var form."
