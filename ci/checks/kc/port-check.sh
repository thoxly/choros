#!/usr/bin/env bash
# FF-13: KEYCLOAK_PORT default in docker-compose.yml is 8180 (not 5432, 55432, or 3000).
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "[FF-13] Checking KEYCLOAK_PORT default is 8180..."

FAIL=0

# (a) 8180 default present
if ! grep -E 'KEYCLOAK_PORT:-8180' docker-compose.yml > /dev/null 2>&1; then
  echo "ERROR: KEYCLOAK_PORT default of 8180 not found in docker-compose.yml" >&2
  FAIL=1
else
  echo "  [OK] KEYCLOAK_PORT:-8180 found in docker-compose.yml"
fi

# (b) No disallowed defaults for keycloak port
if grep -E ':-5432|:-55432|:-3000' docker-compose.yml | grep -i keycloak > /dev/null 2>&1; then
  echo "ERROR: KEYCLOAK_PORT uses a disallowed default (5432/55432/3000)" >&2
  FAIL=1
else
  echo "  [OK] No disallowed port defaults for keycloak"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-13] FAIL." >&2
  exit 1
fi

echo "[FF-13] PASS: KEYCLOAK_PORT default is 8180."
