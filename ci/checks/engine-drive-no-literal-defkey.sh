#!/usr/bin/env bash
# T-0571 [W1/шов] BUG-014 — FF-1: no literal "task-approve" on the engine-drive
# completion/matching path (ADR-T0571-engine-drive-seam.md §4 FF-1).
#
# RATIONALE: the root cause of BUG-014 was process-projection.ts unconditionally
# proposing/matching the ТЭЛ-specific BPMN node name "task-approve" for the BASE
# (process.started) waiting task of ANY process, then matching the engine's active
# user-tasks against that literal string. For a GENERIC process whose author named
# the first user-task anything else, the match never succeeds and the engine step is
# silently never completed (a false 200-ok). The T-0571 fix resolves the base step's
# target engine task by INSTANCE IDENTITY (the active user-task of that instanceId),
# never by string-equality against the literal "task-approve".
#
# WHAT THIS CHECKS (two independent detectors, both must pass):
#   1. reconcileInstanceEngineDrive's body (process-projection.ts) must NOT contain a
#      strict-equality comparison of `taskDefinitionKey` against the literal string
#      "task-approve" (single/double/backtick-quoted) — the pattern BUG-014's root
#      cause used (`t.taskDefinitionKey === args.approvedTaskDefKey` is FINE — that
#      compares against a caller-supplied value, never a hardcoded literal; a literal
#      comparison like `t.taskDefinitionKey === "task-approve"` is what this forbids).
#   2. listInstanceInboxTasks's BASE (process.started) row construction must NOT
#      assign `taskDefKey: "task-approve"` — the base row must carry the
#      resolve-by-instance signal (null) instead of a ТЭЛ literal.
#
# EXIT: 0 if neither forbidden pattern is present in src/http/process-projection.ts;
# 1 otherwise (with a diagnostic pointing at the offending line).
#
# --self-test: verifies the detector logic itself against synthetic known-bad /
# known-good fixture files (mirrors candidategroups-role-slug-linter.sh's pattern).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PROJECT_ROOT:="$(cd "${SCRIPT_DIR}/../.." && pwd)"}"

# Regex (POSIX ERE, portable across GNU/BSD grep): matches
#   taskDefinitionKey === "task-approve"
#   taskDefinitionKey === 'task-approve'
#   taskDefinitionKey === `task-approve`
# tolerating surrounding whitespace around the operator.
LITERAL_MATCH_RE='taskDefinitionKey[[:space:]]*===[[:space:]]*["'"'"'`]task-approve["'"'"'`]'

# Regex for the base-row-assigns-literal pattern:
#   taskDefKey: "task-approve"
#   taskDefKey:"task-approve"
BASE_ROW_LITERAL_RE='taskDefKey[[:space:]]*:[[:space:]]*["'"'"'`]task-approve["'"'"'`]'

check_file() {
  local target="$1"
  local errors=0

  if [[ ! -f "${target}" ]]; then
    echo "FAIL [FF-1]: target file not found: ${target}" >&2
    return 1
  fi

  if grep -nE "${LITERAL_MATCH_RE}" "${target}" >/dev/null 2>&1; then
    echo "FAIL [FF-1]: literal defKey match \"task-approve\" found in ${target}:" >&2
    grep -nE "${LITERAL_MATCH_RE}" "${target}" >&2
    errors=$((errors + 1))
  fi

  if grep -nE "${BASE_ROW_LITERAL_RE}" "${target}" >/dev/null 2>&1; then
    echo "FAIL [FF-1]: base row assigns literal taskDefKey \"task-approve\" in ${target}:" >&2
    grep -nE "${BASE_ROW_LITERAL_RE}" "${target}" >&2
    errors=$((errors + 1))
  fi

  return $((errors > 0 ? 1 : 0))
}

# ---------------------------------------------------------------------------
# Self-test mode.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[engine-drive-no-literal-defkey] --self-test"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  # ---- known-bad fixture #1: literal match comparison ----
  BAD1="${TMPDIR_ST}/bad1.ts"
  cat > "${BAD1}" <<'TSFIX'
export function reconcileInstanceEngineDrive() {
  const match = tasksResult.tasks.find((t) => t.taskDefinitionKey === "task-approve");
  return match;
}
TSFIX
  if check_file "${BAD1}" >/dev/null 2>&1; then
    echo "FAIL self-test: detector passed on known-bad fixture #1 (literal match) — should have failed"
    exit 1
  else
    echo "PASS self-test: detector correctly rejected a literal taskDefinitionKey===\"task-approve\" match"
  fi

  # ---- known-bad fixture #2: base row literal assignment ----
  BAD2="${TMPDIR_ST}/bad2.ts"
  cat > "${BAD2}" <<'TSFIX'
tasks.push({
  id: row.id,
  taskDefKey: "task-approve",
});
TSFIX
  if check_file "${BAD2}" >/dev/null 2>&1; then
    echo "FAIL self-test: detector passed on known-bad fixture #2 (base row literal) — should have failed"
    exit 1
  else
    echo "PASS self-test: detector correctly rejected a base row literal taskDefKey assignment"
  fi

  # ---- known-good fixture: resolve-by-instance + caller-supplied comparison ----
  GOOD="${TMPDIR_ST}/good.ts"
  cat > "${GOOD}" <<'TSFIX'
export function reconcileInstanceEngineDrive(args) {
  // resolve-by-instance: match against the CALLER's value, never a literal.
  const match = tasksResult.tasks.find((t) => t.taskDefinitionKey === args.approvedTaskDefKey);
  return match;
}
function listInstanceInboxTasks() {
  tasks.push({
    id: row.id,
    taskDefKey: null,
  });
}
TSFIX
  if ! check_file "${GOOD}" >/dev/null 2>&1; then
    echo "FAIL self-test: detector failed on a known-good fixture (resolve-by-instance) — should have passed"
    exit 1
  else
    echo "PASS self-test: detector correctly accepted resolve-by-instance code (no literal)"
  fi

  echo "PASS self-test: all engine-drive-no-literal-defkey detectors functional"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
TARGET="${PROJECT_ROOT}/src/http/process-projection.ts"

echo "[T-0571 FF-1] engine-drive-no-literal-defkey: checking ${TARGET#"${PROJECT_ROOT}/"}"

if check_file "${TARGET}"; then
  echo "PASS [FF-1]: no literal \"task-approve\" defKey match/assignment on the engine-drive path"
  exit 0
else
  echo ""
  echo "FAIL [FF-1]: engine-drive-no-literal-defkey found forbidden literal(s) — see above."
  echo "      BUG-014's root cause was matching/assigning the ТЭЛ-specific literal"
  echo "      \"task-approve\" on a process-agnostic path. The base step must resolve its"
  echo "      target engine task by INSTANCE IDENTITY (T-0571 §2.1), never by string"
  echo "      equality against this literal."
  exit 1
fi
