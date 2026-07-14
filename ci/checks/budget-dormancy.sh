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
# ADDITIVE THAW (T-0574 sanction, 2026-07-02; same class as T-0233/T-0236):
#   T-0477 shipped spend ACCOUNTING (append-only spend_ledger recording — no
#   ceilings, no reservations; migration 107). Those files are allowlisted below
#   (FF-BUD-10 ALLOWED_FILES). The dormancy invariant this check protects is
#   Stage-2 ENFORCEMENT staying dormant, so a new assertion FF-BUD-10b pins it:
#   allowlisted accounting files must NOT reference the enforcement table
#   choros.reservation in SQL. (agent_budget was never dormancy-gated — the
#   assistant reads its ceiling for display, see src/http/assistant.ts fetchBudget.)
#   Any NEW file referencing reservation/spend_ledger outside the allowlist
#   still fails FF-BUD-10.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0023] budget-dormancy: checking day-1 dormancy of reservation + spend_ledger"

# T-0477 spend-accounting surface (accounting only — авторизованный append-only
# учёт LLM-трат; enforcement-таблицы остаются спящими, см. FF-BUD-10b ниже).
ALLOWED_FILES=(
  "src/db/spend-ledger-dao.ts"
  "src/adapters/spend-tracking-llm-port.ts"
  "src/http/spend.ts"
  "src/http/assistant.ts"
  "src/db/operational-analytics-dao.ts"
)

allowed_grep_filter() {
  # Build a grep -v -E pattern that drops hits in allowlisted files.
  local pat=""
  for f in "${ALLOWED_FILES[@]}"; do
    pat="${pat:+${pat}|}${f}"
  done
  grep -vE "^${SRC%/src}/(${pat}):" || true
}

# Search src/ for any .ts file referencing the two dormant tables,
# excluding __tests__/ (migration fitness tests live there and are allowed)
# and the T-0477 accounting allowlist above.
HITS=$(grep -rnE '\b(reservation|spend_ledger)\b' "${SRC}" \
  --include="*.ts" 2>/dev/null \
  | grep -vE "/__tests__/" \
  | allowed_grep_filter || true)

if [[ -n "${HITS}" ]]; then
  echo "FAIL [FF-BUD-10]: reservation or spend_ledger referenced by Choros runtime code outside the T-0477 accounting allowlist (must be dormant day-1):"
  echo "${HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-BUD-10]: reservation and spend_ledger dormant outside the T-0477 accounting allowlist"
fi

# FF-BUD-10b: the allowlisted accounting files must stay ACCOUNTING-ONLY —
# no SQL reference to the Stage-2 enforcement table choros.reservation.
# Schema-qualified names are matched (that is how all SQL in these DAOs
# addresses tables). agent_budget is intentionally NOT gated (never was).
ENFORCEMENT_HITS=""
for f in "${ALLOWED_FILES[@]}"; do
  abs="${PROJECT_ROOT}/${f}"
  [[ -f "${abs}" ]] || continue
  h=$(grep -nE 'choros\.reservation\b' "${abs}" || true)
  if [[ -n "${h}" ]]; then
    ENFORCEMENT_HITS="${ENFORCEMENT_HITS}${f}: ${h}"$'\n'
  fi
done

if [[ -n "${ENFORCEMENT_HITS}" ]]; then
  echo "FAIL [FF-BUD-10b]: allowlisted accounting file references the ENFORCEMENT table choros.reservation — Stage-2 enforcement must stay dormant:"
  echo "${ENFORCEMENT_HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-BUD-10b]: allowlisted accounting files reference no enforcement table (accounting-only holds)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: budget-dormancy found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: budget-dormancy — all checks green (FF-BUD-10, FF-BUD-10b)"
exit 0
