#!/usr/bin/env bash
# T-0439 — dmn-launch-wiring
#
# Static assertion: both process-launch call-sites import and call
# preComputeGatewayVariable from dmn-gateway before startInstance.
#
# Checks:
#   DLW-1  src/http/records.ts     imports preComputeGatewayVariable from dmn-gateway
#   DLW-2  src/http/records.ts     calls   preComputeGatewayVariable (invocation, not just import)
#   DLW-3  src/http/process-start.ts imports preComputeGatewayVariable from dmn-gateway
#   DLW-4  src/http/process-start.ts calls   preComputeGatewayVariable
#
# These checks ensure neither call-site accidentally drops the wiring during
# future refactors (grep-rule mirrors architect requirement in T-0439 spec).
#
# EXIT CODES:
#   0 — all four checks green (PASS)
#   1 — one or more checks failed (FAIL)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RECORDS="${PROJECT_ROOT}/src/http/records.ts"
PROCESS_START="${PROJECT_ROOT}/src/http/process-start.ts"

ERRORS=0

echo "[T-0439] dmn-launch-wiring: checking preComputeGatewayVariable wired at both launch call-sites"

# ---- DLW-1: records.ts imports preComputeGatewayVariable --------------------
echo ""
echo "[DLW-1] records.ts imports preComputeGatewayVariable from dmn-gateway"
if grep -qE "preComputeGatewayVariable" "${RECORDS}" && grep -qE "from.*dmn-gateway" "${RECORDS}"; then
  echo "PASS [DLW-1]: records.ts imports preComputeGatewayVariable from dmn-gateway"
else
  echo "FAIL [DLW-1]: records.ts does NOT import preComputeGatewayVariable from dmn-gateway"
  ERRORS=$((ERRORS + 1))
fi

# ---- DLW-2: records.ts calls preComputeGatewayVariable ----------------------
echo ""
echo "[DLW-2] records.ts calls preComputeGatewayVariable (invocation)"
if grep -qE "await preComputeGatewayVariable\s*\(" "${RECORDS}"; then
  echo "PASS [DLW-2]: records.ts calls preComputeGatewayVariable"
else
  echo "FAIL [DLW-2]: records.ts does NOT call preComputeGatewayVariable"
  ERRORS=$((ERRORS + 1))
fi

# ---- DLW-3: process-start.ts imports preComputeGatewayVariable --------------
echo ""
echo "[DLW-3] process-start.ts imports preComputeGatewayVariable from dmn-gateway"
if grep -qE "preComputeGatewayVariable" "${PROCESS_START}" && grep -qE "from.*dmn-gateway" "${PROCESS_START}"; then
  echo "PASS [DLW-3]: process-start.ts imports preComputeGatewayVariable from dmn-gateway"
else
  echo "FAIL [DLW-3]: process-start.ts does NOT import preComputeGatewayVariable from dmn-gateway"
  ERRORS=$((ERRORS + 1))
fi

# ---- DLW-4: process-start.ts calls preComputeGatewayVariable ----------------
echo ""
echo "[DLW-4] process-start.ts calls preComputeGatewayVariable (invocation)"
if grep -qE "await preComputeGatewayVariable\s*\(" "${PROCESS_START}"; then
  echo "PASS [DLW-4]: process-start.ts calls preComputeGatewayVariable"
else
  echo "FAIL [DLW-4]: process-start.ts does NOT call preComputeGatewayVariable"
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: dmn-launch-wiring found ${ERRORS} violation(s) (T-0439)"
  exit 1
fi

echo "PASS: dmn-launch-wiring — all checks green (T-0439)"
exit 0
