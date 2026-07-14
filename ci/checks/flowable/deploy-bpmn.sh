#!/usr/bin/env bash
# T-0058 · FF-FL-2 (live): Deploy smoke BPMN via REST, assert HTTP 201.
# POST /flowable-rest/service/repository/deployments with multipart/form-data.
# Prints the deployment ID on success.
# Exit 0 on HTTP 201, exit 1 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
BPMN_FILE="${ROOT}/config/flowable/processes/choros-smoke.bpmn20.xml"
DEPLOY_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service/repository/deployments"
TMP_BODY="$(mktemp)"

echo "[FF-FL-2] Deploying smoke BPMN to Flowable at ${DEPLOY_URL} ..."

if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "[FF-FL-2] FAIL: BPMN file not found: ${BPMN_FILE}" >&2
  rm -f "${TMP_BODY}"
  exit 1
fi

HTTP_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -F "deployment=@${BPMN_FILE}" \
  "${DEPLOY_URL}" 2>/dev/null)

BODY=$(cat "${TMP_BODY}")
rm -f "${TMP_BODY}"

if [[ "${HTTP_CODE}" == "201" ]]; then
  DEPLOY_ID=$(echo "${BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "[FF-FL-2] PASS: BPMN deployed (HTTP 201), deployment ID: ${DEPLOY_ID}"
  exit 0
else
  echo "[FF-FL-2] FAIL: expected HTTP 201, got ${HTTP_CODE}" >&2
  echo "Response body: ${BODY}" >&2
  exit 1
fi
