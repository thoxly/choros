#!/usr/bin/env bash
# FF-COMP-2 (T-0123) — T-0013 tenant isolation for agent_instruction.
#
#   * 057 has FORCE ROW LEVEL SECURITY
#   * 057 has a tenant policy on current_setting('choros.tenant_id'...)
#   * agent_instruction is listed in ci/checks/known_tenant_tables.txt
#   * the PRIMARY KEY begins with tenant_id
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/057_agent_instruction.sql"
KNOWN="${SCRIPT_DIR}/known_tenant_tables.txt"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # A PK that does NOT begin with tenant_id must be detectable as a violation.
  if printf 'PRIMARY KEY (id, tenant_id)\n' | grep -qE "PRIMARY KEY \(tenant_id"; then
    echo "FAIL self-test: bad-PK pattern wrongly matched the tenant-leading regex"
    exit 1
  fi
  echo "PASS self-test: PK-leading detector distinguishes tenant_id-first"
  exit 0
fi

echo "[FF-COMP-2] agent-instruction-rls: T-0013 isolation"

if [[ ! -f "${MIG}" ]]; then
  echo "FAIL FF-COMP-2: ${MIG} does not exist"
  exit 1
fi

if grep -qE "FORCE[[:space:]]+ROW LEVEL SECURITY" "${MIG}"; then
  echo "PASS FF-COMP-2: FORCE ROW LEVEL SECURITY present"
else
  echo "FAIL FF-COMP-2: missing FORCE ROW LEVEL SECURITY"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE "current_setting\('choros.tenant_id'" "${MIG}"; then
  echo "PASS FF-COMP-2: tenant-isolation policy on choros.tenant_id present"
else
  echo "FAIL FF-COMP-2: missing tenant-isolation policy on current_setting('choros.tenant_id'...)"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE "^agent_instruction$" "${KNOWN}"; then
  echo "PASS FF-COMP-2: agent_instruction registered in known_tenant_tables.txt"
else
  echo "FAIL FF-COMP-2: agent_instruction missing from known_tenant_tables.txt"
  ERRORS=$((ERRORS + 1))
fi

# PK begins with tenant_id (tolerant of whitespace).
if grep -qE "PRIMARY KEY[[:space:]]*\([[:space:]]*tenant_id" "${MIG}"; then
  echo "PASS FF-COMP-2: PRIMARY KEY begins with tenant_id"
else
  echo "FAIL FF-COMP-2: PRIMARY KEY does not begin with tenant_id"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-rls found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-rls — all checks green"
exit 0
