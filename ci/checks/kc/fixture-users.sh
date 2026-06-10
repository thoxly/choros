#!/usr/bin/env bash
# FF-7: All 7 human users from org.ts fixture are present in the realm JSON.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

REALM_FILE="config/keycloak/realm-choros.json"
EXPECTED_USERS=(
  "e-kravtsova"
  "e-mironov"
  "e-larina"
  "e-orlov"
  "e-savina"
  "e-petrov"
  "e-belov"
)

echo "[FF-7] Checking all 7 human users are present in realm JSON..."

FAIL=0
for USER in "${EXPECTED_USERS[@]}"; do
  FOUND=$(python3 -c "
import json, sys
data = json.load(open('$REALM_FILE'))
users = [u.get('username', '') for u in data.get('users', [])]
print('yes' if '$USER' in users else 'no')
")
  if [[ "$FOUND" == "yes" ]]; then
    echo "  [OK] $USER"
  else
    echo "  [FAIL] $USER not found in realm JSON" >&2
    FAIL=1
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-7] FAIL: one or more fixture users missing from realm JSON." >&2
  exit 1
fi

echo "[FF-7] PASS: all 7 human users present in realm JSON."
