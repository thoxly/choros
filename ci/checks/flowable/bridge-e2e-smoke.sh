#!/usr/bin/env bash
# T-0067 · FF-T0067-14..16 (live E2E): External-task bridge smoke.
#
# Full bridge cycle:
#   1. Deploy choros-smoke.bpmn20.xml  → assert HTTP 201
#   2. Start process instance           → assert HTTP 201, capture instanceId
#   3. runBridgeOnce (bridge-smoke-runner) → job appears in JobStore
#   4. Outbox dispatch via makeExternalTaskDeliver → completeTask in Flowable
#   5. Verify process instance completed
#   6. Idempotency check: second runBridgeOnce → 0 new jobs (AC-17)
#   7. FF-G3 check: flowable-bridge-contract.sh exits 0 (AC-18)
#
# Invoked by: npm run fitness:flowable:bridge
# Exit 0 on full round-trip pass; exit 1 on any failure.
#
# Requirements:
#   - Flowable + Postgres already running (wait-ready.sh called first)
#   - dist/ compiled (npm run build)
#   - DATABASE_URL pointing to isolated Postgres
#   - FLOWABLE_PORT / FLOWABLE_BASE_URL set (default: 18085 for isolation)
#   - BRIDGE_TENANT_ID: UUID of tenant (genesis owner or test tenant)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-18085}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
PROCESS_KEY="chorosSmoke"
TOPIC="${BRIDGE_TOPIC:-smoke-topic}"
WORKER_ID="${BRIDGE_WORKER_ID:-choros-bridge-smoke}"
BPMN_FILE="${ROOT}/config/flowable/processes/choros-smoke.bpmn20.xml"
BASE_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service"

ERRORS=0
TMP_BODY="$(mktemp)"
cleanup() { rm -f "${TMP_BODY}"; }
trap cleanup EXIT

export FLOWABLE_BASE_URL="${BASE_URL}"
export BRIDGE_TOPICS="${TOPIC}"
export BRIDGE_WORKER_ID="${WORKER_ID}"

echo "[FF-T0067-14] T-0067 bridge E2E smoke ..."

# ---------------------------------------------------------------------------
# Step 1: Deploy BPMN (AC-16)
# ---------------------------------------------------------------------------
echo ""
echo "=== Step 1: Deploy smoke BPMN ==="
if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "FAIL: BPMN file not found: ${BPMN_FILE}" >&2
  exit 1
fi

DEPLOY_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -F "deployment=@${BPMN_FILE}" \
  "${BASE_URL}/repository/deployments" 2>/dev/null)
DEPLOY_BODY=$(cat "${TMP_BODY}")

if [[ "${DEPLOY_CODE}" == "201" ]]; then
  DEPLOY_ID=$(echo "${DEPLOY_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "  PASS: BPMN deployed (HTTP 201), deploymentId: ${DEPLOY_ID}"
else
  echo "  FAIL: deploy expected HTTP 201, got ${DEPLOY_CODE}" >&2
  echo "  Response: ${DEPLOY_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Step 2: Start process instance (AC-16)
# ---------------------------------------------------------------------------
echo ""
echo "=== Step 2: Start process instance ==="
START_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"processDefinitionKey\":\"${PROCESS_KEY}\",\"variables\":[{\"name\":\"approved\",\"value\":true,\"type\":\"boolean\"}]}" \
  "${BASE_URL}/runtime/process-instances" 2>/dev/null)
START_BODY=$(cat "${TMP_BODY}")

if [[ "${START_CODE}" == "201" ]]; then
  INSTANCE_ID=$(echo "${START_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "  PASS: instance started (HTTP 201), instanceId: ${INSTANCE_ID}"
  export BRIDGE_INSTANCE_ID="${INSTANCE_ID}"
else
  echo "  FAIL: start-instance expected HTTP 201, got ${START_CODE}" >&2
  echo "  Response: ${START_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "[FF-T0067-14] FAIL: cannot continue without a running instance"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 3: Bridge smoke runner — runBridgeOnce + deliver (AC-16, AC-17, AC-18)
# ---------------------------------------------------------------------------
echo ""
echo "=== Step 3: Bridge smoke runner (runBridgeOnce + deliver + complete) ==="

# Wait briefly for Flowable to reach the external-task node
sleep 1

# Determine BRIDGE_TENANT_ID if not set: query genesis tenant from Postgres
if [[ -z "${BRIDGE_TENANT_ID:-}" ]]; then
  echo "  INFO: BRIDGE_TENANT_ID not set — querying genesis tenant from Postgres"
  # Query the genesis tenant (first tenant created by migration 026)
  BRIDGE_TENANT_ID=$(psql "${DATABASE_URL}" -t -c \
    "SELECT id FROM choros.tenant ORDER BY created_at ASC LIMIT 1;" 2>/dev/null \
    | tr -d ' \n' || echo "")
  if [[ -z "${BRIDGE_TENANT_ID}" ]]; then
    echo "  FAIL: Could not resolve BRIDGE_TENANT_ID from Postgres" >&2
    ERRORS=$((ERRORS + 1))
    exit 1
  fi
  export BRIDGE_TENANT_ID
  echo "  INFO: using tenant ${BRIDGE_TENANT_ID}"
fi

# Build dist first
echo "  INFO: building TypeScript ..."
npm --prefix "${ROOT}" run build 2>&1 | tail -3

# Run the bridge smoke runner
echo "  INFO: running bridge-smoke-runner ..."
if node "${ROOT}/dist/bridge-smoke-runner.js"; then
  echo "  PASS: bridge-smoke-runner completed successfully"
else
  echo "  FAIL: bridge-smoke-runner exited non-zero" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Step 4: FF-G3 check — bridge contract stays compliant (AC-18)
# ---------------------------------------------------------------------------
echo ""
echo "=== Step 4: FF-G3 — bridge contract check (AC-18) ==="
if bash "${SCRIPT_DIR}/../flowable-bridge-contract.sh"; then
  echo "  PASS: flowable-bridge-contract.sh green"
else
  echo "  FAIL: flowable-bridge-contract.sh failed" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "[FF-T0067-14] FAIL: bridge E2E smoke found ${ERRORS} failure(s)"
  exit 1
fi
echo "[FF-T0067-14] PASS: bridge E2E smoke green (AC-16..AC-18)"
exit 0
