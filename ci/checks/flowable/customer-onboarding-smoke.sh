#!/usr/bin/env bash
# T-0246 · FF-7 — Customer-onboarding Flowable smoke test (AC-8)
#
# Tests:
#   1. Deploy seed/vendor-crm/processes/customer-onboarding.bpmn → assert HTTP 201.
#   2. Start a process instance (processDefinitionKey=customer-onboarding) → assert HTTP 201.
#
# Out of scope (B-11 boundary):
#   - UserTask completion (no HTTP inbox endpoint yet).
#   - runIssueKey via Flowable HTTP path (no record-write REST, no completeTask).
#   Full UserTask→runIssueKey chain covered by vitest + fitness:db (AC-9).
#
# Mirrors ci/checks/flowable/smoke.sh pattern.
# Exit 0 only if both assertions pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
PROCESS_KEY="customer-onboarding"
BPMN_FILE="${ROOT}/seed/vendor-crm/processes/customer-onboarding.bpmn"
BASE_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service"
ERRORS=0
TMP_BODY="$(mktemp)"

cleanup() { rm -f "${TMP_BODY}"; }
trap cleanup EXIT

echo "[T-0246 FF-7] customer-onboarding-smoke: deploy + startInstance"

# ---------------------------------------------------------------------------
# Pre-check: BPMN file exists
# ---------------------------------------------------------------------------
if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "FAIL [FF-7]: BPMN file not found: ${BPMN_FILE}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Deploy customer-onboarding.bpmn → HTTP 201
# ---------------------------------------------------------------------------
echo "[FF-7] Step 1: Deploy ${BPMN_FILE} ..."
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
# Step 2: Start process instance (key=customer-onboarding) → HTTP 201
# ---------------------------------------------------------------------------
echo "[FF-7] Step 2: Start process instance (key=${PROCESS_KEY}) ..."
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
  echo "[T-0246 FF-7] FAIL: customer-onboarding-smoke found ${ERRORS} failure(s)"
  exit 1
fi

echo ""
echo "[T-0246 FF-7] PASS: customer-onboarding deploy + startInstance green"
exit 0
