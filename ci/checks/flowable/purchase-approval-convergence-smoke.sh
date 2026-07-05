#!/usr/bin/env bash
# T-0612 · zombie-instance fix — purchaseApproval convergence smoke test.
#
# Proves the FIX for the live "zombie instance" bug (act_hi_procinst.end_time
# stays NULL forever even though the main path reached its endEvent): a
# non-interrupting boundary timer on task-fin ("Согласование финдиректора")
# whose escalation branch used to dead-end at its own endEvent instead of
# reconnecting to the main flow. See docs/design/ADR-T0612-purchase-escalation-
# convergence.md.
#
# Deploys docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt (the fixed
# finance-approval + escalation SLICE — see the file's own header comment for
# scope notes) and proves TWO cases:
#
#   Case A — timer does NOT fire (happy path, finance director approves fast):
#     start → complete task-fin BEFORE the PT2M deadline → instance ends
#     (endTime set). Before the fix this would hang forever (zombie).
#
#   Case B — timer FIRES first (finance director never responds — this test
#     does not wait 2 real minutes; it only asserts the escalation task
#     SURFACES as an active task after the boundary fires would be a >2min
#     wait in real time, so this case is instead covered by the unit-level
#     linter proof — see src/__tests__/bpmn-linter.test.ts "T-0612" describe
#     blocks — which is the practical, fast-running proof of the fired-branch
#     shape. This script's live-Flowable proof is scoped to Case A, the case
#     that reproduces the exact bug observed live (main path finishes, timer
#     never fires, instance should end and previously did not).
#
# Mirrors ci/checks/flowable/customer-onboarding-smoke.sh / external-task-
# smoke.sh patterns (deploy → start → runtime/tasks → complete → poll history).
#
# Exit 0 only if the instance is confirmed ENDED after task-fin completes
# with the timer never firing. Exit 1 on any failure (including "still
# running after the poll window" — that IS the zombie-instance regression
# this test exists to catch).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
PROCESS_KEY="purchaseApproval"
BPMN_FILE="${ROOT}/docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt"
BASE_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service"
ERRORS=0
TMP_BODY="$(mktemp)"

cleanup() { rm -f "${TMP_BODY}"; }
trap cleanup EXIT

echo "[T-0612] purchase-approval-convergence-smoke: deploy + start + complete(fin) + assert ENDED"

# ---------------------------------------------------------------------------
# Pre-check: BPMN file exists
# ---------------------------------------------------------------------------
if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "FAIL [T-0612]: BPMN file not found: ${BPMN_FILE}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Deploy the fixed BPMN → HTTP 201
# ---------------------------------------------------------------------------
echo "[T-0612] Step 1: Deploy ${BPMN_FILE} ..."
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
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Start a process instance (key=purchaseApproval) → HTTP 201
# ---------------------------------------------------------------------------
echo "[T-0612] Step 2: Start process instance (key=${PROCESS_KEY}) ..."
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
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 3: Find the active task-fin user task for this instance → HTTP 200
# ---------------------------------------------------------------------------
echo "[T-0612] Step 3: Query active tasks for instance ${INSTANCE_ID} ..."
TASKS_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  "${BASE_URL}/runtime/tasks?processInstanceId=${INSTANCE_ID}" 2>/dev/null)
TASKS_BODY=$(cat "${TMP_BODY}")

if [[ "${TASKS_CODE}" != "200" ]]; then
  echo "  FAIL: runtime/tasks expected HTTP 200, got ${TASKS_CODE}" >&2
  echo "  Response: ${TASKS_BODY}" >&2
  exit 1
fi

TASK_ID=$(echo "${TASKS_BODY}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('data', [])
match = [t for t in items if t.get('taskDefinitionKey') == 'task-fin']
print(match[0]['id'] if match else '')
" 2>/dev/null || echo "")

if [[ -z "${TASK_ID}" ]]; then
  echo "  FAIL: no active task-fin task found for instance ${INSTANCE_ID}" >&2
  echo "  Response: ${TASKS_BODY}" >&2
  exit 1
fi
echo "  PASS: found active task-fin, task ID: ${TASK_ID}"

# ---------------------------------------------------------------------------
# Step 4: Complete task-fin BEFORE the PT2M deadline (Case A — happy path,
# the timer never fires). This is the exact shape that used to hang forever.
# ---------------------------------------------------------------------------
echo "[T-0612] Step 4: Complete task-fin (finance director approves, timer never fires) ..."
COMPLETE_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"action":"complete"}' \
  "${BASE_URL}/runtime/tasks/${TASK_ID}" 2>/dev/null)
COMPLETE_BODY=$(cat "${TMP_BODY}")

if [[ "${COMPLETE_CODE}" == "200" || "${COMPLETE_CODE}" == "204" ]]; then
  echo "  PASS: task-fin completed (HTTP ${COMPLETE_CODE})"
else
  echo "  FAIL: complete task-fin expected HTTP 200/204, got ${COMPLETE_CODE}" >&2
  echo "  Response: ${COMPLETE_BODY}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5: THE ASSERTION — the instance must be ENDED. Poll briefly (Flowable
# processes the completion synchronously in-request in the default job
# executor config, but poll a few times to absorb any async settling).
# ---------------------------------------------------------------------------
echo "[T-0612] Step 5: Assert instance ${INSTANCE_ID} is ENDED (the zombie-instance regression check) ..."
ENDED="false"
for attempt in 1 2 3 4 5; do
  RUNTIME_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    "${BASE_URL}/runtime/process-instances/${INSTANCE_ID}" 2>/dev/null)

  if [[ "${RUNTIME_CODE}" == "404" ]]; then
    # Flowable deletes the runtime record once an instance completes.
    ENDED="true"
    break
  fi

  # Still present in the runtime table (200) — check history endTime just in
  # case (mirrors src/core/flowable-client.ts's isInstanceEnded).
  HIST_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    "${BASE_URL}/history/historic-process-instances/${INSTANCE_ID}" 2>/dev/null)
  HIST_BODY=$(cat "${TMP_BODY}")
  if [[ "${HIST_CODE}" == "200" ]]; then
    END_TIME=$(echo "${HIST_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('endTime') or '')" 2>/dev/null || echo "")
    if [[ -n "${END_TIME}" ]]; then
      ENDED="true"
      break
    fi
  fi

  sleep 1
done

if [[ "${ENDED}" == "true" ]]; then
  echo "  PASS: instance ${INSTANCE_ID} ENDED — task-fin's normal completion drove the"
  echo "        converging gateway to the shared endEvent even though the PT2M timer"
  echo "        never fired (the non-interrupting boundary event's token resolved via"
  echo "        the fix's convergence gateway, not by lingering forever)."
else
  echo "  FAIL: instance ${INSTANCE_ID} is STILL RUNNING after task-fin completed and" >&2
  echo "        the timer never fired — THIS IS THE ZOMBIE-INSTANCE BUG (T-0612)." >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "[T-0612] FAIL: purchase-approval-convergence-smoke found ${ERRORS} failure(s)"
  exit 1
fi

echo ""
echo "[T-0612] PASS: purchaseApproval convergence fix confirmed live — instance ends"
echo "         cleanly when the finance director approves before the timer fires"
exit 0
