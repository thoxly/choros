#!/usr/bin/env bash
# T-0022 · FF-13 (AC-18) + FF-17 (AC-22) — static guards over the role migrations.
#
# AC-18: this task adds EXACTLY migrations/019_role.sql, 020_role_assignment.sql,
#        021_grant_role_fk.sql and NO file numbered 017 or 018 (reserved for
#        T-0033 / T-0019 on parallel branches).
# AC-22: no second role/principal table or person-bound-grant fork in 019–021
#        (no person_grant / agent_role / human_role): roles are ONE table and
#        both employee kinds (human/agent) bind through the single role_assignment.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations"
ERRORS=0

echo "[FF-13/FF-17] role-migration-set: static guards over migrations 019–021"

# ---- AC-18a: the three required files exist --------------------------------
for f in 019_role.sql 020_role_assignment.sql 021_grant_role_fk.sql; do
  if [[ -f "${MIG}/${f}" ]]; then
    echo "PASS: migrations/${f} present"
  else
    echo "FAIL (AC-18): migrations/${f} missing"
    ERRORS=$((ERRORS + 1))
  fi
done

# ---- AC-18b: NO file numbered 017 or 018 on this branch --------------------
# (Those numbers are reserved for T-0033 / T-0019; the orchestrator merges them.)
reserved=$(find "${MIG}" -maxdepth 1 -type f \( -name '017_*.sql' -o -name '018_*.sql' \) 2>/dev/null || true)
if [[ -n "${reserved}" ]]; then
  echo "FAIL (AC-18): reserved migration number present on this branch:"
  echo "${reserved}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no 017/018 migration on this branch (reserved for T-0033/T-0019)"
fi

# ---- AC-22: no second role/principal table in 019–021 ----------------------
# A divergent principal or a human/agent grant fork would split the single-role
# model. Scan CREATE TABLE statements in the three files for forbidden names.
FORBIDDEN_TABLES=(
  "person_grant"
  "agent_role"
  "human_role"
  "user_grant"
  "agent_grant"
)
before=${ERRORS}
for f in 019_role.sql 020_role_assignment.sql 021_grant_role_fk.sql; do
  [[ -f "${MIG}/${f}" ]] || continue
  # Only CREATE TABLE lines define a new table; ignore comments/prose.
  creates=$(grep -iE '^\s*CREATE\s+TABLE' "${MIG}/${f}" || true)
  for t in "${FORBIDDEN_TABLES[@]}"; do
    if echo "${creates}" | grep -iqE "\b${t}\b"; then
      echo "FAIL (AC-22): migrations/${f} creates a forbidden second-principal table '${t}'"
      ERRORS=$((ERRORS + 1))
    fi
  done
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS: no second role/principal table (single role + single role_assignment)"
fi

# ---- AC-22b: 019 defines exactly one table (role), 020 exactly one (role_assignment)
count_019=$(grep -icE '^\s*CREATE\s+TABLE' "${MIG}/019_role.sql" || true)
count_020=$(grep -icE '^\s*CREATE\s+TABLE' "${MIG}/020_role_assignment.sql" || true)
if [[ "${count_019}" == "1" && "${count_020}" == "1" ]]; then
  echo "PASS: 019 creates 1 table, 020 creates 1 table (no fork)"
else
  echo "FAIL (AC-22): unexpected CREATE TABLE count (019=${count_019}, 020=${count_020}; expected 1/1)"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: role-migration-set found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: role-migration-set — all checks green"
exit 0
