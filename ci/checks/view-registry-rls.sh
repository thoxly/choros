#!/usr/bin/env bash
# T-0581 (view registry) · FF-VR-2 — list_view carries the T-0013 tenant-table
# contract: tenant_id-leading PK, ENABLE+FORCE RLS, default-DENY policy,
# registered in known_tenant_tables.txt (mirrors registry-defs-pdp-isolation.sh /
# cross-tenant-fitness.sh style — this check is the MIGRATION-shape half; the
# LIVE RLS proof runs generically via cross_tenant.test.ts + schema.test.ts,
# both of which now iterate 'list_view' because it is in known_tenant_tables.txt).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MIGRATION="$(ls "${ROOT}"/migrations/*_list_view_registry.sql 2>/dev/null | head -1 || true)"
KNOWN_TABLES="${ROOT}/ci/checks/known_tenant_tables.txt"

ERRORS=0

echo "[FF-VR-2] view-registry-rls: checking T-0581 tenant-table contract"

if [[ -z "${MIGRATION}" || ! -f "${MIGRATION}" ]]; then
  echo "FAIL (FF-VR-2): no migrations/*_list_view_registry.sql file found"
  exit 1
fi
echo "  using migration: $(basename "${MIGRATION}")"

if grep -qE 'PRIMARY KEY \(tenant_id, id\)' "${MIGRATION}"; then
  echo "PASS (FF-VR-2a): tenant_id-leading composite PK present"
else
  echo "FAIL (FF-VR-2a): tenant_id-leading composite PK not found in ${MIGRATION}"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE 'ENABLE ROW LEVEL SECURITY' "${MIGRATION}" && grep -qE 'FORCE\s+ROW LEVEL SECURITY' "${MIGRATION}"; then
  echo "PASS (FF-VR-2b): ENABLE + FORCE ROW LEVEL SECURITY present"
else
  echo "FAIL (FF-VR-2b): ENABLE+FORCE ROW LEVEL SECURITY not both found in ${MIGRATION}"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE "CREATE POLICY list_view_tenant_isolation" "${MIGRATION}" \
  && grep -qE "current_setting\('choros\.tenant_id'" "${MIGRATION}"; then
  echo "PASS (FF-VR-2c): default-DENY tenant-isolation policy present"
else
  echo "FAIL (FF-VR-2c): list_view_tenant_isolation policy (current_setting-based) not found"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE "GRANT SELECT, INSERT, UPDATE, DELETE ON choros\.list_view TO choros_app" "${MIGRATION}"; then
  echo "PASS (FF-VR-2d): choros_app DML GRANT present"
else
  echo "FAIL (FF-VR-2d): choros_app GRANT not found in ${MIGRATION}"
  ERRORS=$((ERRORS + 1))
fi

if [[ -f "${KNOWN_TABLES}" ]] && grep -qxE 'list_view' "${KNOWN_TABLES}"; then
  echo "PASS (FF-VR-2e): 'list_view' registered in known_tenant_tables.txt"
else
  echo "FAIL (FF-VR-2e): 'list_view' not found in ${KNOWN_TABLES}"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: view-registry-rls found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: view-registry-rls — list_view carries the full T-0013 tenant-table contract"
exit 0
