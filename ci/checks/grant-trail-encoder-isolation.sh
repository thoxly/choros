#!/usr/bin/env bash
# T-0031 · Encoder isolation fitness (FF-0031-01..04 / AC-09..AC-11).
#
# Check-1 (FF-0031-01): audit-grant-encoder.ts has no IO imports
#   (pg, fetch, http, https, net, child_process).
# Check-2 (FF-0031-02): grant-lattice.ts is NOT edited by T-0031
#   (no new exports, no mutations relative to merge-base with dev).
# Check-3 (FF-0031-03): audit-grant-encoder.ts imports GrantAuditEvent from grant-lattice.ts.
# Check-4 (FF-0031-04): encoder test file calls appendAuditEvent (seam demo).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENCODER="${ROOT}/src/core/audit-grant-encoder.ts"
LATTICE="${ROOT}/src/core/grant-lattice.ts"
ENCODER_TEST="${ROOT}/src/__tests__/audit-grant-encoder.test.ts"
ERRORS=0

echo "[FF-0031] grant-trail-encoder-isolation: checking encoder module constraints"

# ---- Check-1 (FF-0031-01): no IO imports in encoder -------------------------
echo ""
echo "Check-1 (FF-0031-01): audit-grant-encoder.ts must not import pg/fetch/http/https/net/child_process"
if grep -qE "^import.*['\"]pg['\"]|['\"]node:pg['\"]|['\"]fetch['\"]|['\"]node:http['\"]|['\"]http['\"]|['\"]https['\"]|['\"]node:https['\"]|['\"]net['\"]|['\"]node:net['\"]|['\"]child_process['\"]|['\"]node:child_process['\"]" "${ENCODER}"; then
  echo "FAIL: audit-grant-encoder.ts contains a forbidden IO import (pg/fetch/http/https/net/child_process)"
  grep -E "^import.*['\"]pg['\"]|['\"]node:pg['\"]|['\"]fetch['\"]|['\"]node:http['\"]|['\"]http['\"]|['\"]https['\"]|['\"]node:https['\"]|['\"]net['\"]|['\"]node:net['\"]|['\"]child_process['\"]|['\"]node:child_process['\"]" "${ENCODER}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no IO imports in audit-grant-encoder.ts"
fi

# ---- Check-2 (FF-0031-02): grant-lattice.ts is unchanged by T-0031 ----------
echo ""
echo "Check-2 (FF-0031-02): grant-lattice.ts must be unchanged relative to merge-base with dev"
# Dynamically find the merge-base with dev (not hardcoded sha — lesson T-0040).
MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN: could not determine merge-base with dev (branch 'dev' not found or not reachable); skipping diff check"
else
  if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- src/core/grant-lattice.ts; then
    echo "PASS: grant-lattice.ts is unchanged relative to merge-base with dev"
  else
    echo "FAIL: grant-lattice.ts has been modified relative to merge-base with dev"
    git -C "${ROOT}" diff "${MERGE_BASE}" -- src/core/grant-lattice.ts | head -40
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-3 (FF-0031-03): encoder imports GrantAuditEvent from grant-lattice --
echo ""
echo "Check-3 (FF-0031-03): audit-grant-encoder.ts must import GrantAuditEvent from grant-lattice"
if grep -qE "import.*GrantAuditEvent.*grant-lattice" "${ENCODER}"; then
  echo "PASS: GrantAuditEvent imported from grant-lattice in audit-grant-encoder.ts"
else
  echo "FAIL: audit-grant-encoder.ts does not import GrantAuditEvent from grant-lattice.ts"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-4 (FF-0031-04): encoder test shows appendAuditEvent seam ----------
echo ""
echo "Check-4 (FF-0031-04): encoder test must reference appendAuditEvent (T-0030 seam demo)"
if [[ ! -f "${ENCODER_TEST}" ]]; then
  echo "FAIL: encoder test file not found at ${ENCODER_TEST}"
  ERRORS=$((ERRORS + 1))
elif grep -q "appendAuditEvent" "${ENCODER_TEST}"; then
  echo "PASS: appendAuditEvent seam call found in encoder test"
else
  echo "FAIL: encoder test does not call appendAuditEvent (required by AC-11)"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: grant-trail-encoder-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: grant-trail-encoder-isolation — all checks green"
exit 0
