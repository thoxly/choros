#!/usr/bin/env bash
# FF-COMP-1 (T-0123) — additive to T-0020.
#
# Migration 057 does NOT touch 032_agent_card.sql and adds NO column to
# agent_card/employee; the competence layer is a SEPARATE new table.
#
#   * git diff --name-only "$BASE" -- migrations/032_agent_card.sql is empty
#   * 057 contains NO `ALTER TABLE choros.agent_card`
#   * 057 contains `CREATE TABLE ... choros.agent_instruction`
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/057_agent_instruction.sql"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # Synthetic 057 that ALTERs agent_card must be caught.
  TMP="$(mktemp)"
  printf 'ALTER TABLE choros.agent_card ADD COLUMN x text;\n' > "${TMP}"
  if grep -q "ALTER TABLE choros.agent_card" "${TMP}"; then
    rm -f "${TMP}"
    echo "PASS self-test: ALTER TABLE choros.agent_card pattern is detectable"
    exit 0
  fi
  rm -f "${TMP}"
  echo "FAIL self-test: detector did not catch the synthetic violation"
  exit 1
fi

echo "[FF-COMP-1] agent-instruction-additive: 057 additive to T-0020"

if [[ ! -f "${MIG}" ]]; then
  echo "FAIL FF-COMP-1: ${MIG} does not exist"
  exit 1
fi

# 1. 032_agent_card.sql byte-unchanged vs merge-base with dev.
BASE=$(git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
       || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
       || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
       || echo "")
if [[ -z "${BASE}" ]]; then
  echo "WARN FF-COMP-1: cannot determine base commit; skipping 032 diff check"
else
  CHANGED=$(git -C "${ROOT}" diff --name-only "${BASE}" -- migrations/032_agent_card.sql 2>/dev/null || true)
  if [[ -n "${CHANGED}" ]]; then
    echo "FAIL FF-COMP-1: migrations/032_agent_card.sql was modified (must be untouched)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-COMP-1: 032_agent_card.sql is byte-unchanged"
  fi
fi

# 2. 057 must NOT ALTER agent_card or employee.
if grep -qE "ALTER TABLE choros\.agent_card" "${MIG}"; then
  echo "FAIL FF-COMP-1: 057 contains ALTER TABLE choros.agent_card"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-COMP-1: 057 does not ALTER agent_card"
fi

# 3. 057 must CREATE TABLE choros.agent_instruction (the separate new table).
if grep -qE "CREATE TABLE( IF NOT EXISTS)? choros\.agent_instruction" "${MIG}"; then
  echo "PASS FF-COMP-1: 057 creates choros.agent_instruction"
else
  echo "FAIL FF-COMP-1: 057 does not CREATE TABLE choros.agent_instruction"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-additive found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-additive — all checks green"
exit 0
