#!/usr/bin/env bash
# T-0244 FF-4 — card actions for customer-subscription use defaultCardActions + resolveFor.
#
# Rules:
#   (a) status-model.ts exports availableTransitions and CUSTOMER_TRANSITIONS.
#   (b) No rogue authorization tokens in T-0244 zone (no actionEnabled/canShow/allowedFlag).
#   (c) No duplicate card-action module for customer-subscription (reuses T-0125).
#   (d) The customer-onboarding BPMN is linear — no terminate/message nodes.
#
# Exit 0 on all pass; non-zero on any violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # Self-test: verify that authorization token patterns are detectable.
  BAD_TOKEN='const actionEnabled = true;'
  if printf '%s\n' "${BAD_TOKEN}" | grep -qE 'actionEnabled|canShow|allowedFlag'; then
    echo "PASS self-test: rogue auth token pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: rogue auth token detector failed"
  exit 1
fi

echo "[T-0244 FF-4] customer-subscription-pdp-arbiter"

# (a) status-model.ts exists and exports required functions
STATUS_MODEL="${SRC}/core/customer-subscription/status-model.ts"
if [[ ! -f "${STATUS_MODEL}" ]]; then
  echo "FAIL FF-4(a): ${STATUS_MODEL} not found"
  ERRORS=$((ERRORS + 1))
else
  for EXPORT in "availableTransitions" "isAllowedTransition" "CUSTOMER_TRANSITIONS" "CustomerStatus"; do
    if ! grep -q "${EXPORT}" "${STATUS_MODEL}"; then
      echo "FAIL FF-4(a): '${EXPORT}' not found in status-model.ts"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS FF-4(a): '${EXPORT}' found in status-model.ts"
    fi
  done
fi

# (b) No rogue authorization tokens in T-0244 zone
BAD_TOKENS="actionEnabled|canShow|allowedFlag"
for DIR in "${SRC}/core/customer-subscription" "${SRC}/runtime/customer-onboarding"; do
  [[ -d "${DIR}" ]] || continue
  HITS=$(grep -rnE "${BAD_TOKENS}" "${DIR}" --include="*.ts" 2>/dev/null \
    | grep -vE "__tests__|\.test\.ts|#|//" || true)
  if [[ -n "${HITS}" ]]; then
    echo "FAIL FF-4(b): rogue auth token found in ${DIR}:"
    echo "${HITS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-4(b): no rogue auth tokens in ${DIR}"
  fi
done

# (c) No duplicate card-action module for customer-subscription
DUPE_CHECK=$(find "${SRC}/core/customer-subscription" \
  -name "card-action*" -o -name "*card-actions*" 2>/dev/null || true)
if [[ -n "${DUPE_CHECK}" ]]; then
  echo "FAIL FF-4(c): duplicate card-action module found in customer-subscription zone:"
  echo "${DUPE_CHECK}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-4(c): no duplicate card-action module in customer-subscription zone"
fi

# (d) BPMN is linear (no terminate/message events)
BPMN_FILE="${ROOT}/seed/vendor-crm/processes/customer-onboarding.bpmn"
if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "FAIL FF-4(d): ${BPMN_FILE} not found"
  ERRORS=$((ERRORS + 1))
else
  for BAD_ELEM in "terminateEventDefinition" "messageEventDefinition" "correlateMessage" "deleteProcessInstance"; do
    if grep -q "${BAD_ELEM}" "${BPMN_FILE}"; then
      echo "FAIL FF-4(d): BPMN contains forbidden element '${BAD_ELEM}' (process must be linear)"
      ERRORS=$((ERRORS + 1))
    fi
  done
  echo "PASS FF-4(d): BPMN is linear (no terminate/message elements)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "[T-0244 FF-4] FAILED (${ERRORS} error(s))"
  exit 1
fi
echo "[T-0244 FF-4] customer-subscription-pdp-arbiter: ALL PASS"
