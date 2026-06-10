#!/usr/bin/env bash
# FF-14: docs/environments.md updated with KEYCLOAK_PORT, KEYCLOAK_MGMT_PORT, KEYCLOAK_REALM,
#        CHOROS_AUTH_MODE, choros-api.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "[FF-14] Checking docs/environments.md for required Keycloak documentation..."

REQUIRED_TERMS=(
  "KEYCLOAK_PORT"
  "KEYCLOAK_MGMT_PORT"
  "KEYCLOAK_REALM"
  "CHOROS_AUTH_MODE"
  "choros-api"
)

FAIL=0
for TERM in "${REQUIRED_TERMS[@]}"; do
  if ! grep -q "$TERM" docs/environments.md 2>/dev/null; then
    echo "ERROR: '$TERM' not found in docs/environments.md" >&2
    FAIL=1
  else
    echo "  [OK] '$TERM' found"
  fi
done

# Also check for a note on adding users/agents
if ! grep -iE "добавить пользователя|добавить агент|add.*user|add.*agent|как добавить" docs/environments.md > /dev/null 2>&1; then
  echo "ERROR: no note on how to add users/agents found in docs/environments.md" >&2
  FAIL=1
else
  echo "  [OK] note on adding users/agents found"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-14] FAIL." >&2
  exit 1
fi

echo "[FF-14] PASS: all required Keycloak vars and docs present in docs/environments.md."
