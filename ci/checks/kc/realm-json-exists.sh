#!/usr/bin/env bash
# FF-6: Realm JSON committed at config/keycloak/realm-choros.json, valid JSON, not gitignored.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

REALM_FILE="config/keycloak/realm-choros.json"

echo "[FF-6] Checking realm JSON exists and is valid..."

# 1. File exists
if [[ ! -f "$REALM_FILE" ]]; then
  echo "ERROR: $REALM_FILE does not exist" >&2
  exit 1
fi

# 2. Valid JSON
if ! python3 -c "import json,sys; json.load(open('$REALM_FILE'))" 2>/dev/null; then
  echo "ERROR: $REALM_FILE is not valid JSON" >&2
  exit 1
fi

# 3. Not gitignored
if git check-ignore -q "$REALM_FILE" 2>/dev/null; then
  echo "ERROR: $REALM_FILE is gitignored — it must be committed" >&2
  exit 1
fi

echo "[FF-6] PASS: realm JSON exists, is valid JSON, and is not gitignored."
