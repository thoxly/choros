#!/usr/bin/env bash
# T-0575 [W1/деТЭЛ] BUG-015 — FF-1 (ADR-T0575-detel-primitives.md §5, FF-1):
# both call sites of appendProcessStarted (process-start.ts, records.ts) must
# prokidyvat the LIVE engine's resolved role/label — never call it bare.
#
# RATIONALE: the root cause of BUG-015 was that appendProcessStarted (already
# parameterized with OPTIONAL approverRole/step/taskName, defaulting to the ТЭЛ
# constants) was ALWAYS invoked WITHOUT these fields by both call sites — the
# base (process.started) task therefore ALWAYS carried the process-agnostic ТЭЛ
# literals (role-approver / Согласование / Согласовать заявку) regardless of
# what the process's OWN BPMN user-task actually declared. The fix reads
# flowable.getActiveUserTasks(instanceId) BEFORE calling appendProcessStarted
# and threads candidateGroups[0]/name through — the config-primitive default
# (resolveDefaultApproverRole/Step/TaskName) applies ONLY when the engine call
# is absent/empty, never unconditionally.
#
# WHAT THIS CHECKS (two independent detectors, both must pass):
#   1. process-start.ts calls appendProcessStarted with at least one of
#      approverRole/step/taskName threaded (not a bare call carrying only
#      instanceId/procKey/actor/nowMs/tenantId/recordId).
#   2. records.ts calls appendProcessStarted with the same threading.
#   3. Both files call flowable.getActiveUserTasks — the resolve-from-engine
#      read that MUST happen before the projection write (structural presence
#      check; the semantic ordering is proven live by
#      ci/checks/db/detel-base-task-role.db.test.ts, FF-2).
#
# This is a STATIC (grep-only) structural check — it does NOT prove the VALUES
# threaded through are actually the live engine's (that is FF-2's live-DB job).
# It proves the CALL SITES no longer omit the fields entirely — the exact
# regression class BUG-015 was.
#
# EXIT: 0 if both call sites thread approverRole/step/taskName AND call
# getActiveUserTasks; 1 otherwise (with a diagnostic pointing at the file).
#
# --self-test: verifies the detector logic against synthetic known-bad/good
# fixtures (mirrors engine-drive-no-literal-defkey.sh's pattern).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PROJECT_ROOT:="$(cd "${SCRIPT_DIR}/../.." && pwd)"}"

# ---------------------------------------------------------------------------
# check_file <path> — both detectors against one file.
# ---------------------------------------------------------------------------
check_file() {
  local target="$1"
  local errors=0

  if [[ ! -f "${target}" ]]; then
    echo "FAIL [FF-1]: target file not found: ${target}" >&2
    return 1
  fi

  # Detector A: appendProcessStarted must be called with at least one of
  # approverRole / step / taskName somewhere in the file (call-site threading).
  # A bare "no threading at all" file has appendProcessStarted( present but
  # none of the three field names anywhere near it.
  if ! grep -q "appendProcessStarted(" "${target}"; then
    echo "FAIL [FF-1]: ${target} does not call appendProcessStarted at all" >&2
    return 1
  fi
  if ! grep -qE "approverRole[[:space:]]*:|step[[:space:]]*:|taskName[[:space:]]*:" "${target}"; then
    echo "FAIL [FF-1]: ${target} calls appendProcessStarted but never threads approverRole/step/taskName (BUG-015 bare-call regression)" >&2
    errors=$((errors + 1))
  fi

  # Detector B: the file must read the live engine's active user-task(s)
  # (getActiveUserTasks) — the resolve-from-engine source appendProcessStarted's
  # threaded fields must come from.
  if ! grep -q "getActiveUserTasks(" "${target}"; then
    echo "FAIL [FF-1]: ${target} never calls flowable.getActiveUserTasks — no engine-read source for the threaded role/label" >&2
    errors=$((errors + 1))
  fi

  return $((errors > 0 ? 1 : 0))
}

# ---------------------------------------------------------------------------
# Self-test mode.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[detel-base-task-from-engine] --self-test"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  # ---- known-bad fixture #1: bare call, no threading, no engine read (the
  # exact pre-T-0575 regression shape) ----
  BAD1="${TMPDIR_ST}/bad1.ts"
  cat > "${BAD1}" <<'TSFIX'
async function start() {
  await appendProcessStarted(client, {
    instanceId: result.instanceId,
    procKey: processKey,
    actor,
    nowMs: Date.now(),
    tenantId,
  });
}
TSFIX
  if check_file "${BAD1}" >/dev/null 2>&1; then
    echo "FAIL self-test: detector passed on known-bad fixture #1 (bare call) — should have failed"
    exit 1
  else
    echo "PASS self-test: detector correctly rejected a bare appendProcessStarted call (no threading, no engine read)"
  fi

  # ---- known-bad fixture #2: threading present but NO engine read (fabricated
  # values, not actually sourced from the live engine) ----
  BAD2="${TMPDIR_ST}/bad2.ts"
  cat > "${BAD2}" <<'TSFIX'
async function start() {
  await appendProcessStarted(client, {
    instanceId: result.instanceId,
    procKey: processKey,
    actor,
    nowMs: Date.now(),
    approverRole: "some-made-up-role",
  });
}
TSFIX
  if check_file "${BAD2}" >/dev/null 2>&1; then
    echo "FAIL self-test: detector passed on known-bad fixture #2 (threading without engine read) — should have failed"
    exit 1
  else
    echo "PASS self-test: detector correctly rejected threading without a getActiveUserTasks engine read"
  fi

  # ---- known-good fixture: engine read + threading (the T-0575 fix shape) ----
  GOOD="${TMPDIR_ST}/good.ts"
  cat > "${GOOD}" <<'TSFIX'
async function start() {
  const tasksResult = await flowable.getActiveUserTasks(result.instanceId);
  const firstActiveTask = tasksResult.ok ? tasksResult.tasks[0] : undefined;
  await appendProcessStarted(client, {
    instanceId: result.instanceId,
    procKey: processKey,
    actor,
    nowMs: Date.now(),
    tenantId,
    approverRole: firstActiveTask?.candidateGroups[0],
    step: firstActiveTask?.name,
    taskName: firstActiveTask?.name,
  });
}
TSFIX
  if ! check_file "${GOOD}" >/dev/null 2>&1; then
    echo "FAIL self-test: detector failed on a known-good fixture (engine read + threading) — should have passed"
    exit 1
  else
    echo "PASS self-test: detector correctly accepted engine-read + threaded appendProcessStarted call"
  fi

  echo "PASS self-test: all detel-base-task-from-engine detectors functional"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
TARGET_START="${PROJECT_ROOT}/src/http/process-start.ts"
TARGET_RECORDS="${PROJECT_ROOT}/src/http/records.ts"

echo "[T-0575 FF-1] detel-base-task-from-engine: checking ${TARGET_START#"${PROJECT_ROOT}/"} + ${TARGET_RECORDS#"${PROJECT_ROOT}/"}"

ERRORS=0
if ! check_file "${TARGET_START}"; then
  ERRORS=$((ERRORS + 1))
fi
if ! check_file "${TARGET_RECORDS}"; then
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-1]: both appendProcessStarted call sites thread approverRole/step/taskName AND read the live engine (getActiveUserTasks)"
  exit 0
else
  echo ""
  echo "FAIL [FF-1]: detel-base-task-from-engine found ${ERRORS} violation(s) — see above."
  echo "      BUG-015's root cause was appendProcessStarted always called WITHOUT"
  echo "      approverRole/step/taskName, so the base task ALWAYS carried the ТЭЛ"
  echo "      constants regardless of the process's own BPMN. The fix threads the"
  echo "      live engine's candidateGroups[0]/name through both call sites."
  exit 1
fi
