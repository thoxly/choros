#!/usr/bin/env bash
# T-0612/T-0661 · purchaseApproval convergence + concurrent-token-race smoke test.
#
# Proves the FIX for BOTH completion orders found live in the "Закупки"
# (purchase approval) case's finance-director-approval slice. See
# docs/design/ADR-T0612-purchase-escalation-convergence.md (§1-§7 for T-0612,
# §8 addendum for T-0661) and docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt
# (the D5 fix artifact: an embedded sub-process with task-fin's non-interrupting
# boundary timer escalating to task-esc, both converging into gw-fin-converge,
# which flows to a SCOPE-LOCAL terminateEndEvent).
#
# Deploys the fix artifact and proves THREE completion orders:
#
#   Case A — timer NEVER fires (T-0612's original bug, "happy path"): the
#     finance director approves task-fin before the deadline. Before T-0612's
#     fix this hung forever (act_hi_procinst.end_time stayed NULL) because the
#     still-armed, non-interrupting boundary timer's token was never resolved.
#     Assertion: instance ENDED after completing task-fin alone.
#
#   Case B — timer FIRES, task-fin completed FIRST (T-0661's bug): once the
#     boundary timer fires, a non-interrupting boundary event spawns a SECOND,
#     independent token — task-esc surfaces as an active task WHILE task-fin
#     is still open (both open at once). Before T-0661's fix (converging
#     gateway → plain endEvent) this hung forever: an uncontrolled XOR-merge
#     passes each token through independently, so BOTH tasks had to complete.
#     The D5 fix routes convergence into a scope-local terminateEndEvent, so
#     completing task-fin extinguishes the still-parked task-esc token.
#     Assertion: BOTH task-fin and task-esc are open after the timer fires;
#     instance ENDED after completing ONLY task-fin (task-esc's token killed
#     by the scope-local terminate).
#
#   Case C — timer FIRES, task-esc completed FIRST (symmetric order — the
#     owner steps in for the silent director before the director gets to it):
#     same setup as Case B, but task-esc is completed first this time.
#     Assertion: instance ENDED after completing ONLY task-esc (task-fin's
#     token killed by the scope-local terminate).
#
# FIN_DEADLINE (env, default PT2M — the real case value): overrides the boundary
# timer's deadline (both the native <timeDuration> body and the informational
# choros:timerDeadline attribute) via a literal PT2M -> ${FIN_DEADLINE} text
# substitution on a TEMP COPY of the fix artifact — the artifact under
# docs/design/ is never modified on disk. Case A always deploys the ORIGINAL,
# unmodified artifact (PT2M — task-fin completes almost immediately, well
# before any deadline, so the override does not matter for Case A). Cases B/C
# deploy the (possibly overridden) variant and WAIT for the deadline to
# actually elapse before asserting both tasks are open — set
# FIN_DEADLINE=PT5S to exercise B/C in seconds instead of two real minutes:
#
#   FIN_DEADLINE=PT5S bash ci/checks/flowable/purchase-approval-convergence-smoke.sh
#
# Mirrors ci/checks/flowable/customer-onboarding-smoke.sh / external-task-
# smoke.sh patterns (deploy → start → runtime/tasks → complete → poll history).
#
# NOT wired into any package.json script (standalone — see ADR §4/§8.5). The
# live run needs a reachable Flowable (:8082) — deferred fitness rows
# T-0612-LIVE / T-0661-LIVE-A/B/C in the ADR name this script as their ci_check;
# this session could not reach the stand, so this script is authored/wired but
# NOT executed against a live Flowable this session (see FRICTION in pr-handoff).
#
# Exit 0 only if ALL THREE cases assert ENDED as described above. Exit 1 on
# any failure (including "still running after the poll window" — that IS the
# zombie/hang regression this test exists to catch, for whichever case it
# occurs in).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
PROCESS_KEY="purchaseApproval"
BPMN_FILE="${ROOT}/docs/design/T-0612-purchaseApproval-fixed.bpmn20.xml.txt"
BASE_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service"
FIN_DEADLINE="${FIN_DEADLINE:-PT2M}"
ERRORS=0
TMP_BODY="$(mktemp)"
TMP_BPMN_OVERRIDE="$(mktemp --suffix=.bpmn20.xml.txt 2>/dev/null || mktemp)"

cleanup() { rm -f "${TMP_BODY}" "${TMP_BPMN_OVERRIDE}"; }
trap cleanup EXIT

echo "[T-0612/T-0661] purchase-approval-convergence-smoke: deploy + 3 completion orders"
echo "  FIN_DEADLINE override for Cases B/C: ${FIN_DEADLINE}"

# ---------------------------------------------------------------------------
# Pre-check: BPMN file exists
# ---------------------------------------------------------------------------
if [[ ! -f "${BPMN_FILE}" ]]; then
  echo "FAIL: BPMN file not found: ${BPMN_FILE}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# ISO-8601 duration (PnDTnHnMnS subset, matching this artifact's authored
# shapes) -> whole seconds. Used to size the poll/wait window for Cases B/C
# so the script scales correctly whether FIN_DEADLINE is PT5S or the real PT2M.
# ---------------------------------------------------------------------------
iso8601_to_seconds() {
  local dur="$1"
  python3 -c "
import re, sys
d = sys.argv[1]
m = re.match(r'^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?\$', d)
if not m or not any(m.groups()):
    print(0)
else:
    days, hours, mins, secs = m.groups()
    total = (int(days or 0) * 86400) + (int(hours or 0) * 3600) + (int(mins or 0) * 60) + float(secs or 0)
    print(int(total) if total == int(total) else int(total) + 1)
" "${dur}"
}

# ---------------------------------------------------------------------------
# Shared helpers (deploy / start / find-task / complete-task / assert-ended)
# ---------------------------------------------------------------------------

deploy_bpmn() {
  # $1 = path to the BPMN file to deploy. Echoes the deployment id (or "?").
  local file="$1"
  local code
  code=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -X POST \
    -F "deployment=@${file}" \
    "${BASE_URL}/repository/deployments" 2>/dev/null)
  local body
  body="$(cat "${TMP_BODY}")"
  if [[ "${code}" != "201" ]]; then
    echo "  FAIL: deploy expected HTTP 201, got ${code}" >&2
    echo "  Response: ${body}" >&2
    return 1
  fi
  echo "${body}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?"
}

start_instance() {
  # Echoes the instance id (or "?").
  local code
  code=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"processDefinitionKey\":\"${PROCESS_KEY}\"}" \
    "${BASE_URL}/runtime/process-instances" 2>/dev/null)
  local body
  body="$(cat "${TMP_BODY}")"
  if [[ "${code}" != "201" ]]; then
    echo "  FAIL: start-instance expected HTTP 201, got ${code}" >&2
    echo "  Response: ${body}" >&2
    return 1
  fi
  echo "${body}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?"
}

# Echoes the task id for the given taskDefinitionKey among the instance's
# ACTIVE tasks, or "" if not (yet) present.
find_active_task() {
  local instance_id="$1"
  local task_def_key="$2"
  local code
  code=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    "${BASE_URL}/runtime/tasks?processInstanceId=${instance_id}" 2>/dev/null)
  if [[ "${code}" != "200" ]]; then
    echo ""
    return 0
  fi
  python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('data', [])
match = [t for t in items if t.get('taskDefinitionKey') == sys.argv[1]]
print(match[0]['id'] if match else '')
" "${task_def_key}" < "${TMP_BODY}" 2>/dev/null || echo ""
}

complete_task() {
  local task_id="$1"
  local code
  code=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"action":"complete"}' \
    "${BASE_URL}/runtime/tasks/${task_id}" 2>/dev/null)
  if [[ "${code}" != "200" && "${code}" != "204" ]]; then
    echo "  FAIL: complete task ${task_id} expected HTTP 200/204, got ${code}" >&2
    echo "  Response: $(cat "${TMP_BODY}")" >&2
    return 1
  fi
  return 0
}

# Polls up to ~$2 seconds (1s ticks, minimum 5 attempts) asserting the
# instance is ENDED (404 on runtime, or history endTime set). Echoes
# "true"/"false".
assert_ended() {
  local instance_id="$1"
  local max_wait="${2:-5}"
  local attempts=$(( max_wait > 5 ? max_wait : 5 ))
  local ended="false"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    local runtime_code
    runtime_code=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
      -u "${ADMIN_USER}:${ADMIN_PASS}" \
      "${BASE_URL}/runtime/process-instances/${instance_id}" 2>/dev/null)
    if [[ "${runtime_code}" == "404" ]]; then
      ended="true"
      break
    fi
    local hist_code
    hist_code=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
      -u "${ADMIN_USER}:${ADMIN_PASS}" \
      "${BASE_URL}/history/historic-process-instances/${instance_id}" 2>/dev/null)
    if [[ "${hist_code}" == "200" ]]; then
      local end_time
      end_time=$(python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('endTime') or '')" < "${TMP_BODY}" 2>/dev/null || echo "")
      if [[ -n "${end_time}" ]]; then
        ended="true"
        break
      fi
    fi
    sleep 1
  done
  echo "${ended}"
}

# ===========================================================================
# Case A — timer NEVER fires (T-0612): deploy the ORIGINAL, unmodified fix
# artifact (PT2M), complete task-fin almost immediately, assert ENDED.
# ===========================================================================
echo ""
echo "[Case A] timer NEVER fires — deploy original artifact, complete task-fin fast"
DEPLOY_ID_A=$(deploy_bpmn "${BPMN_FILE}") || ERRORS=$((ERRORS + 1))
echo "  deployed: ${DEPLOY_ID_A}"

INSTANCE_A=$(start_instance) || ERRORS=$((ERRORS + 1))
echo "  instance: ${INSTANCE_A}"

TASK_FIN_A=$(find_active_task "${INSTANCE_A}" "task-fin")
if [[ -z "${TASK_FIN_A}" ]]; then
  echo "  FAIL [Case A]: no active task-fin found for instance ${INSTANCE_A}" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "  found active task-fin: ${TASK_FIN_A}"
  complete_task "${TASK_FIN_A}" || ERRORS=$((ERRORS + 1))
  echo "  completed task-fin (director approved before the deadline)"
  ENDED_A=$(assert_ended "${INSTANCE_A}" 5)
  if [[ "${ENDED_A}" == "true" ]]; then
    echo "  PASS [Case A]: instance ${INSTANCE_A} ENDED — timer never fired, no zombie."
  else
    echo "  FAIL [Case A]: instance ${INSTANCE_A} STILL RUNNING — T-0612 zombie regression." >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ===========================================================================
# Cases B & C — timer FIRES: deploy the (possibly FIN_DEADLINE-overridden)
# variant, start TWO fresh instances, wait for the deadline to elapse on
# both, confirm BOTH task-fin and task-esc are open, then complete task-fin
# first (Case B) / task-esc first (Case C) and assert ENDED each time.
# ===========================================================================
echo ""
echo "[Case B/C] preparing FIN_DEADLINE=${FIN_DEADLINE} variant (timer WILL fire)..."
sed "s/PT2M/${FIN_DEADLINE}/g" "${BPMN_FILE}" > "${TMP_BPMN_OVERRIDE}"
WAIT_SECONDS=$(iso8601_to_seconds "${FIN_DEADLINE}")
POLL_BUFFER=3
echo "  deadline in seconds: ${WAIT_SECONDS} (+${POLL_BUFFER}s buffer before polling for task-esc)"

DEPLOY_ID_BC=$(deploy_bpmn "${TMP_BPMN_OVERRIDE}") || ERRORS=$((ERRORS + 1))
echo "  deployed override variant: ${DEPLOY_ID_BC}"

run_fired_case() {
  # $1 = case label ("B" or "C"), $2 = "task-fin" | "task-esc" (completed FIRST)
  local label="$1"
  local first_task_key="$2"
  local second_task_key="task-esc"
  if [[ "${first_task_key}" == "task-esc" ]]; then
    second_task_key="task-fin"
  fi

  echo ""
  echo "[Case ${label}] timer FIRES, ${first_task_key} completed FIRST (${second_task_key} left parked, must be cancelled)"
  local instance_id
  instance_id=$(start_instance) || { ERRORS=$((ERRORS + 1)); return; }
  echo "  instance: ${instance_id}"

  # Wait for the deadline to elapse, then confirm BOTH tasks are open — the
  # concurrent-token proof this whole case exists to exercise.
  sleep "$(( WAIT_SECONDS + POLL_BUFFER ))"

  local task_fin_id task_esc_id
  task_fin_id=$(find_active_task "${instance_id}" "task-fin")
  task_esc_id=$(find_active_task "${instance_id}" "task-esc")
  if [[ -z "${task_fin_id}" || -z "${task_esc_id}" ]]; then
    echo "  FAIL [Case ${label}]: expected BOTH task-fin AND task-esc open after the timer fired" >&2
    echo "        (task-fin=${task_fin_id:-<none>}, task-esc=${task_esc_id:-<none>})" >&2
    echo "        — this is the pre-condition for the concurrent-token race; without it" >&2
    echo "        this case is not actually being exercised." >&2
    ERRORS=$((ERRORS + 1))
    return
  fi
  echo "  PASS: BOTH task-fin (${task_fin_id}) and task-esc (${task_esc_id}) are open — race confirmed."

  local first_task_id second_task_id
  if [[ "${first_task_key}" == "task-fin" ]]; then
    first_task_id="${task_fin_id}"
    second_task_id="${task_esc_id}"
  else
    first_task_id="${task_esc_id}"
    second_task_id="${task_fin_id}"
  fi

  complete_task "${first_task_id}" || { ERRORS=$((ERRORS + 1)); return; }
  echo "  completed ${first_task_key} (the FIRST resolution — should «добить» the process)"

  local ended
  ended=$(assert_ended "${instance_id}" 5)
  if [[ "${ended}" == "true" ]]; then
    echo "  PASS [Case ${label}]: instance ${instance_id} ENDED — parked ${second_task_key}'s token"
    echo "        was cancelled by the scope-local terminate (D5 fix), no double-close required."
  else
    echo "  FAIL [Case ${label}]: instance ${instance_id} STILL RUNNING after completing" >&2
    echo "        only ${first_task_key} — THIS IS THE T-0661 CONCURRENT-TOKEN HANG." >&2
    ERRORS=$((ERRORS + 1))
  fi
}

run_fired_case "B" "task-fin"
run_fired_case "C" "task-esc"

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "[T-0612/T-0661] FAIL: purchase-approval-convergence-smoke found ${ERRORS} failure(s)"
  exit 1
fi

echo "[T-0612/T-0661] PASS: all three completion orders confirmed live —"
echo "  Case A (timer never fires), Case B (task-fin resolves the race first),"
echo "  Case C (task-esc resolves the race first) — no zombie, no hang."
exit 0
