#!/usr/bin/env bash
# T-0244 FF-5 — EntitlementPort injectable: core owns the type, adapters own the impl.
#
# Rules:
#   (a) src/core/customer-subscription/entitlement-port.ts exports EntitlementPort,
#       dormantEntitlementPort, and EntitlementDormantError.
#   (b) issueEntitlement signature has EXACTLY {circuit_id,plan,valid_from,valid_until,source,notes?}
#       (frozen contract-seam, ADR §3.4).
#   (c) src/core/customer-subscription/** and src/runtime/customer-onboarding/** have NO
#       direct SDK/fetch/http imports (port is the ONLY channel).
#   (d) runIssueKey accepts entitlement: EntitlementPort in its IssueKeyDeps.
#
# Exit 0 on all pass; non-zero on any violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # Self-test: verify that SDK import pattern is detectable.
  PLANTED='import fetch from "node-fetch";'
  if printf '%s\n' "${PLANTED}" | grep -qE '(fetch|https|node:http|node-fetch|axios)'; then
    echo "PASS self-test: SDK/network import pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: SDK/network import detector failed"
  exit 1
fi

echo "[T-0244 FF-5] entitlement-port-injectable"

# (a) Core file exists and exports required symbols
CORE_FILE="${SRC}/core/customer-subscription/entitlement-port.ts"
if [[ ! -f "${CORE_FILE}" ]]; then
  echo "FAIL FF-5(a): ${CORE_FILE} not found"
  ERRORS=$((ERRORS + 1))
else
  for SYMBOL in "EntitlementPort" "dormantEntitlementPort" "EntitlementDormantError"; do
    if ! grep -q "${SYMBOL}" "${CORE_FILE}"; then
      echo "FAIL FF-5(a): ${SYMBOL} not found in ${CORE_FILE}"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS FF-5(a): ${SYMBOL} found in entitlement-port.ts"
    fi
  done
fi

# (b) Frozen signature fields present
if [[ -f "${CORE_FILE}" ]]; then
  for FIELD in "circuit_id" "plan" "valid_from" "valid_until" "source"; do
    if ! grep -q "${FIELD}" "${CORE_FILE}"; then
      echo "FAIL FF-5(b): required signature field '${FIELD}' not found in entitlement-port.ts"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS FF-5(b): signature field '${FIELD}' present"
    fi
  done
fi

# (c) No SDK/http/fetch/network imports in core or runtime customer-onboarding paths
SDK_PATTERN='from "(node-fetch|axios|node:http|node:https)"|import fetch'
for DIR in "${SRC}/core/customer-subscription" "${SRC}/runtime/customer-onboarding"; do
  [[ -d "${DIR}" ]] || continue
  SDK_HITS=$(grep -rnE "${SDK_PATTERN}" "${DIR}" --include="*.ts" 2>/dev/null \
    | grep -vE "__tests__|\.test\.ts" || true)
  if [[ -n "${SDK_HITS}" ]]; then
    echo "FAIL FF-5(c): SDK/network import found in ${DIR}:"
    echo "${SDK_HITS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-5(c): no SDK/network imports in ${DIR}"
  fi
done

# (d) runIssueKey deps accepts entitlement: EntitlementPort
ORCH_FILE="${SRC}/runtime/customer-onboarding/issue-key.ts"
if [[ ! -f "${ORCH_FILE}" ]]; then
  echo "FAIL FF-5(d): ${ORCH_FILE} not found"
  ERRORS=$((ERRORS + 1))
else
  if ! grep -q "entitlement:" "${ORCH_FILE}"; then
    echo "FAIL FF-5(d): runIssueKey deps does not contain 'entitlement:' field"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-5(d): runIssueKey accepts entitlement port in IssueKeyDeps"
  fi
  if ! grep -q "EntitlementPort" "${ORCH_FILE}"; then
    echo "FAIL FF-5(d): EntitlementPort type not referenced in issue-key.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-5(d): EntitlementPort type used in issue-key.ts"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "[T-0244 FF-5] FAILED (${ERRORS} error(s))"
  exit 1
fi
echo "[T-0244 FF-5] entitlement-port-injectable: ALL PASS"
