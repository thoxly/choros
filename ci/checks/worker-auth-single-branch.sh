#!/usr/bin/env bash
# FF-3 (static-now, AC-17): Single branching point on CHOROS_AUTH_MODE.
# - CHOROS_AUTH_MODE must appear in at most 2 production files (auth.ts + optional server.ts)
#   Test files are excluded — they set env vars to control UUT, not branching points.
# - externalWorker.ts must NOT contain CHOROS_AUTH_MODE
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "[FF-3] Checking CHOROS_AUTH_MODE single-branching invariant..."

FAIL=0

# Count distinct production files (exclude __tests__) containing CHOROS_AUTH_MODE
FILE_COUNT=$(grep -rlE 'CHOROS_AUTH_MODE' "${ROOT}/src/" --exclude-dir='__tests__' | wc -l | tr -d ' ')
if [[ "$FILE_COUNT" -le 2 ]]; then
  echo "  [OK] CHOROS_AUTH_MODE in ≤ 2 production files (excl. __tests__): ${FILE_COUNT}"
else
  echo "  FAIL: CHOROS_AUTH_MODE found in ${FILE_COUNT} production files (must be ≤ 2: auth.ts + optional server.ts)" >&2
  grep -rlE 'CHOROS_AUTH_MODE' "${ROOT}/src/" --exclude-dir='__tests__' >&2 || true
  FAIL=1
fi

# externalWorker.ts must NOT contain CHOROS_AUTH_MODE
if grep -q 'CHOROS_AUTH_MODE' "${ROOT}/src/http/externalWorker.ts" 2>/dev/null; then
  echo "  FAIL: externalWorker.ts must NOT contain CHOROS_AUTH_MODE (branching must be in auth.ts)" >&2
  FAIL=1
else
  echo "  [OK] externalWorker.ts does not contain CHOROS_AUTH_MODE"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-3] FAIL: single-branching invariant violated." >&2
  exit 1
fi

echo "[FF-3] PASS: CHOROS_AUTH_MODE single-branching invariant satisfied (${FILE_COUNT} file(s) ≤ 2)."
