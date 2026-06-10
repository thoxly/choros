#!/usr/bin/env bash
# FF-10: CHOROS_AUTH_MODE env var is read in src/http/auth.ts; default is 'dev'.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "[FF-10] Checking CHOROS_AUTH_MODE seam in source..."

FAIL=0

# (a) CHOROS_AUTH_MODE is read in src/http/auth.ts
if ! grep -r "CHOROS_AUTH_MODE" src/http/auth.ts > /dev/null 2>&1; then
  echo "ERROR: CHOROS_AUTH_MODE not found in src/http/auth.ts" >&2
  FAIL=1
else
  echo "  [OK] CHOROS_AUTH_MODE found in src/http/auth.ts"
fi

# (b) The default 'dev' fallback is present in the same file
if ! grep -E "CHOROS_AUTH_MODE.*['\"]dev['\"]|['\"]dev['\"].*CHOROS_AUTH_MODE" src/http/auth.ts > /dev/null 2>&1; then
  echo "ERROR: default 'dev' fallback for CHOROS_AUTH_MODE not found in src/http/auth.ts" >&2
  FAIL=1
else
  echo "  [OK] default 'dev' fallback confirmed in src/http/auth.ts"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-10] FAIL." >&2
  exit 1
fi

echo "[FF-10] PASS: CHOROS_AUTH_MODE seam is present with 'dev' default."
