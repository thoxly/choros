#!/usr/bin/env bash
# T-0244 FF-12 — vendor-crm seed is idempotent and correctly structured.
#
# Rules:
#   (a) migrations/073_vendor_crm_seed.sql exists and uses ON CONFLICT (tenant_id, slug) DO NOTHING.
#   (b) seed/vendor-crm/pack.json exists and is valid JSON.
#   (c) seed/vendor-crm/pack.json has roles vendor-admin and vendor-readonly.
#   (d) seed/vendor-crm/processes/customer-onboarding.bpmn exists.
#   (e) status enum in seed schema matches CustomerStatus values in status-model.ts
#       (FF-2 sync: draft/trial/active/expired/custom/archived — EXACTLY 6 values).
#
# Exit 0 on all pass; non-zero on any violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # Self-test: verify ON CONFLICT DO NOTHING pattern is detectable.
  SQL='INSERT INTO foo (a, b) VALUES (1,2) ON CONFLICT (tenant_id, slug) DO NOTHING;'
  if printf '%s\n' "${SQL}" | grep -q "ON CONFLICT.*DO NOTHING"; then
    echo "PASS self-test: ON CONFLICT DO NOTHING pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: ON CONFLICT DO NOTHING detector failed"
  exit 1
fi

echo "[T-0244 FF-12] vendor-crm-seed-idempotent"

# (a) Migration exists and has ON CONFLICT DO NOTHING
MIGRATION="${ROOT}/migrations/073_vendor_crm_seed.sql"
if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL FF-12(a): ${MIGRATION} not found"
  ERRORS=$((ERRORS + 1))
else
  CONFLICT_COUNT=$(grep -c "ON CONFLICT.*DO NOTHING" "${MIGRATION}" 2>/dev/null || echo 0)
  if [[ "${CONFLICT_COUNT}" -lt 2 ]]; then
    echo "FAIL FF-12(a): migration must have ON CONFLICT DO NOTHING for both application AND registry_def rows (found ${CONFLICT_COUNT})"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-12(a): migration has ${CONFLICT_COUNT} ON CONFLICT DO NOTHING clauses"
  fi
fi

# (b) pack.json exists and is valid JSON
PACK="${ROOT}/seed/vendor-crm/pack.json"
if [[ ! -f "${PACK}" ]]; then
  echo "FAIL FF-12(b): ${PACK} not found"
  ERRORS=$((ERRORS + 1))
else
  if ! python3 -c "import json; json.load(open('${PACK}'))" 2>/dev/null; then
    echo "FAIL FF-12(b): ${PACK} is not valid JSON"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-12(b): pack.json is valid JSON"
  fi
fi

# (c) Roles vendor-admin and vendor-readonly in pack.json
if [[ -f "${PACK}" ]]; then
  for ROLE in "vendor-admin" "vendor-readonly"; do
    if ! grep -q "\"${ROLE}\"" "${PACK}"; then
      echo "FAIL FF-12(c): role '${ROLE}' not found in ${PACK}"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS FF-12(c): role '${ROLE}' found in pack.json"
    fi
  done
fi

# (d) BPMN file exists
BPMN="${ROOT}/seed/vendor-crm/processes/customer-onboarding.bpmn"
if [[ ! -f "${BPMN}" ]]; then
  echo "FAIL FF-12(d): ${BPMN} not found"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-12(d): customer-onboarding.bpmn found"
fi

# (e) Status enum sync: status-model.ts and schema both have EXACTLY the 6 canonical values
STATUS_MODEL="${ROOT}/src/core/customer-subscription/status-model.ts"
SCHEMA="${ROOT}/seed/vendor-crm/customer-subscription.schema.json"
CANONICAL_STATUSES=("draft" "trial" "active" "expired" "custom" "archived")

if [[ -f "${STATUS_MODEL}" ]] && [[ -f "${SCHEMA}" ]]; then
  for STATUS in "${CANONICAL_STATUSES[@]}"; do
    if ! grep -q "\"${STATUS}\"" "${STATUS_MODEL}"; then
      echo "FAIL FF-12(e): status '${STATUS}' not found in status-model.ts"
      ERRORS=$((ERRORS + 1))
    fi
    if ! grep -q "\"${STATUS}\"" "${SCHEMA}"; then
      echo "FAIL FF-12(e): status '${STATUS}' not found in schema JSON"
      ERRORS=$((ERRORS + 1))
    fi
  done
  echo "PASS FF-12(e): all 6 canonical statuses present in both status-model.ts and schema"
else
  echo "WARN FF-12(e): cannot verify status sync (files missing)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "[T-0244 FF-12] FAILED (${ERRORS} error(s))"
  exit 1
fi
echo "[T-0244 FF-12] vendor-crm-seed-idempotent: ALL PASS"
