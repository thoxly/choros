#!/usr/bin/env bash
# FF-5 (static-now, AC-19): Public API surface unchanged.
# - DEV_USER_HEADER exported from src/http/auth.ts
# - registerExternalWorkerRoutes / registerAuthRoutes / createServer exported with same arity
# - router.ts not modified relative to origin/dev baseline
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "[FF-5] Checking public API surface invariants (AC-19)..."

FAIL=0

# Check DEV_USER_HEADER export
if grep -qE 'export.*DEV_USER_HEADER' "${ROOT}/src/http/auth.ts" 2>/dev/null; then
  echo "  [OK] DEV_USER_HEADER exported from src/http/auth.ts"
else
  echo "  FAIL: DEV_USER_HEADER not exported from src/http/auth.ts" >&2
  FAIL=1
fi

# Check registerExternalWorkerRoutes export
if grep -qE 'export.*function.*registerExternalWorkerRoutes' "${ROOT}/src/http/externalWorker.ts" 2>/dev/null; then
  echo "  [OK] registerExternalWorkerRoutes exported"
else
  echo "  FAIL: registerExternalWorkerRoutes not exported from src/http/externalWorker.ts" >&2
  FAIL=1
fi

# Check registerAuthRoutes export
if grep -qE 'export.*function.*registerAuthRoutes' "${ROOT}/src/http/auth.ts" 2>/dev/null; then
  echo "  [OK] registerAuthRoutes exported"
else
  echo "  FAIL: registerAuthRoutes not exported from src/http/auth.ts" >&2
  FAIL=1
fi

# Check createServer export
if grep -qE 'export.*function.*createServer' "${ROOT}/src/server.ts" 2>/dev/null; then
  echo "  [OK] createServer exported from src/server.ts"
else
  echo "  FAIL: createServer not exported from src/server.ts" >&2
  FAIL=1
fi

# Check router.ts not modified relative to origin/dev
cd "${ROOT}"
if git diff --quiet origin/dev -- src/http/router.ts 2>/dev/null; then
  echo "  [OK] src/http/router.ts unchanged relative to origin/dev"
else
  # If origin/dev doesn't exist (local worktree), check against HEAD of base
  if git diff --quiet HEAD -- src/http/router.ts 2>/dev/null; then
    echo "  [OK] src/http/router.ts unchanged in this branch"
  else
    echo "  FAIL: src/http/router.ts has been modified (must not be touched, AC-19)" >&2
    FAIL=1
  fi
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-5] FAIL: public API surface invariant violated." >&2
  exit 1
fi

echo "[FF-5] PASS: all public API surface checks passed."
