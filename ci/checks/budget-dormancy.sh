#!/usr/bin/env bash
# T-0023 · FF-BUD-10 (AC-23): budget-dormancy static check
#
# Asserts that no Choros runtime code path (src/**/*.ts outside __tests__/migrations/)
# references `reservation` or `spend_ledger` in an enforcement context on day-1.
# Runtime enforcement at the agent call boundary is Stage-2 (E5.9 / FR-10).
#
# Rule: grep -rE '\b(reservation|spend_ledger)\b' src/ --include='*.ts'
#       filtered to exclude src/__tests__/  → must return ZERO matches.
#       Any hit = exit 1.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0023] budget-dormancy: checking day-1 dormancy of reservation + spend_ledger"

# Search src/ for any .ts file referencing the two dormant tables,
# excluding __tests__/ (migration fitness tests live there and are allowed).
HITS=$(grep -rnE '\b(reservation|spend_ledger)\b' "${SRC}" \
  --include="*.ts" 2>/dev/null \
  | grep -vE "/__tests__/" || true)

if [[ -n "${HITS}" ]]; then
  echo "FAIL [FF-BUD-10]: reservation or spend_ledger referenced by Choros runtime code (must be dormant day-1):"
  echo "${HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-BUD-10]: reservation and spend_ledger are schema-dormant (no src/ runtime read outside __tests__/)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: budget-dormancy found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: budget-dormancy — all checks green (FF-BUD-10)"
exit 0
