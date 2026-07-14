#!/usr/bin/env bash
# T-0279 · FF-1 — ТЭЛ linear BPMN Flowable smoke test (ADR T-0278 §2.1, FF-1)
#
# Tests:
#   1. Deploy config/flowable/processes/tel-linear.bpmn20.xml → assert HTTP 201.
#   2. Start a process instance (processDefinitionKey=telLinear) → assert HTTP 201.
#
# Out of scope (B/C/D tasks):
#   - UserTask completion (user-task claim/approve — tasks B/D).
#   - External-task worker wiring for tel-intake (day-1 DORMANT/stub — tasks B/D).
#   Full U1→U5 click-through covered by deploy-acceptance E2E (task E).
#
# Mirrors ci/checks/flowable/customer-onboarding-smoke.sh pattern exactly.
# Exit 0 only if both assertions pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
PROCESS_KEY="telLinear"
BPMN_FILE="${ROOT}/config/flowable/processes/tel-linear.bpmn20.xml"
BASE_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service"
ERRORS=0
TMP_BODY="$(mktemp)"

cleanup() { rm -f "${TMP_BODY}"; }
trap cleanup EXIT

echo "[T-0279 FF-1] tel-linear-smoke: deploy + startInstance"

# ---------------------------------------------------------------------------
# Pre-check: BPMN file exists
# ---------------------------------------------------------------------------
if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "FAIL [FF-1]: BPMN file not found: ${BPMN_FILE}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Deploy tel-linear.bpmn20.xml → HTTP 201
# ---------------------------------------------------------------------------
echo "[FF-1] Step 1: Deploy ${BPMN_FILE} ..."
DEPLOY_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -F "deployment=@${BPMN_FILE}" \
  "${BASE_URL}/repository/deployments" 2>/dev/null)
DEPLOY_BODY=$(cat "${TMP_BODY}")

if [[ "${DEPLOY_CODE}" == "201" ]]; then
  DEPLOY_ID=$(echo "${DEPLOY_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "  PASS: BPMN deployed (HTTP 201), deployment ID: ${DEPLOY_ID}"
else
  echo "  FAIL: deploy expected HTTP 201, got ${DEPLOY_CODE}" >&2
  echo "  Response: ${DEPLOY_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Step 2: Start process instance (key=telLinear) → HTTP 201
# ---------------------------------------------------------------------------
echo "[FF-1] Step 2: Start process instance (key=${PROCESS_KEY}) ..."
START_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"processDefinitionKey\":\"${PROCESS_KEY}\"}" \
  "${BASE_URL}/runtime/process-instances" 2>/dev/null)
START_BODY=$(cat "${TMP_BODY}")

if [[ "${START_CODE}" == "201" ]]; then
  INSTANCE_ID=$(echo "${START_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "  PASS: instance started (HTTP 201), instance ID: ${INSTANCE_ID}"
else
  echo "  FAIL: start-instance expected HTTP 201, got ${START_CODE}" >&2
  echo "  Response: ${START_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "[T-0279 FF-1] FAIL: tel-linear-smoke found ${ERRORS} failure(s)"
  exit 1
fi

echo ""
echo "[T-0279 FF-1] PASS: tel-linear deploy + startInstance green"
exit 0
