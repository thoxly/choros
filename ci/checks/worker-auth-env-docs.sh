#!/usr/bin/env bash
# FF-8 (static-now, AC-21): docs/environments.md documents T-0060 env vars.
# Checks: KEYCLOAK_URL, KEYCLOAK_AUDIENCE, JWKS_CACHE_TTL_MS (≥ 3 matches).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "[FF-8] Checking docs/environments.md for T-0060 env vars (AC-21)..."

FAIL=0
DOC="${ROOT}/docs/environments.md"

if [[ ! -f "$DOC" ]]; then
  echo "  FAIL: docs/environments.md not found" >&2
  exit 1
fi

# Count occurrences of required vars
COUNT=$(grep -cE 'KEYCLOAK_URL|KEYCLOAK_AUDIENCE|JWKS_CACHE_TTL_MS' "$DOC" || echo 0)

if [[ "$COUNT" -ge 3 ]]; then
  echo "  [OK] docs/environments.md contains ${COUNT} references to required T-0060 env vars (≥ 3)"
else
  echo "  FAIL: docs/environments.md contains only ${COUNT} references (need ≥ 3: KEYCLOAK_URL, KEYCLOAK_AUDIENCE, JWKS_CACHE_TTL_MS)" >&2
  FAIL=1
fi

# Check each individually for clarity
for VAR in KEYCLOAK_URL KEYCLOAK_AUDIENCE JWKS_CACHE_TTL_MS; do
  if grep -q "$VAR" "$DOC"; then
    echo "  [OK] $VAR found in docs/environments.md"
  else
    echo "  FAIL: $VAR NOT found in docs/environments.md" >&2
    FAIL=1
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-8] FAIL: T-0060 env vars missing from docs/environments.md." >&2
  exit 1
fi

echo "[FF-8] PASS: all T-0060 env vars documented in docs/environments.md (${COUNT} references)."
