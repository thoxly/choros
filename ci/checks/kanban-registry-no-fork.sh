#!/usr/bin/env bash
# T-0582 (kanban view) · FF-K-1 — kanban does NOT fork the view registry.
#
# THE CONTRACT (ADR/spec FR-1/NF-1/AC-11): kanban is a SECOND `type` value on
# the EXISTING choros.list_view row + a new case branch in the EXISTING
# validateViewConfig dispatcher — never a second tenant-table/CRUD-router/
# migration of its own. This mirrors view-registry-type-open.sh's DDL-openness
# check but from the kanban side: kanban must ADD NOTHING structural.
#
# Checks (task-diff scoped, so pre-existing unrelated migrations/routers never
# trip this):
#   (a) no NEW migration file matching *_view*.sql was added by this task's
#       diff (kanban needs ZERO migrations — spec: "DDL-миграция не нужна").
#   (b) no NEW HTTP router registration for a second views-CRUD endpoint
#       (grep for router.register(...,"/api/*view*") OUTSIDE list-views.ts).
#   (c) src/http/list-views.ts is UNCHANGED by this task's diff (NF-1: "её
#       CRUD-роуты… не меняются") — a byte-identical CRUD contract.
#
# Exit 0 on clean, non-zero on any violation. --self-test builds a throwaway
# git repo (base commit + a "task" commit on top) and exercises run_checks
# against a clean tree and a violating tree, asserting each fires correctly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

resolve_base_ref() {
  local root="$1"
  git -C "${root}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${root}" merge-base HEAD dev 2>/dev/null \
    || git -C "${root}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

# run_checks: runs all (a)/(b)/(d)/(c) detectors against ${1}=root, ${2}=base
# ref. Prints PASS/FAIL diagnostic lines, then echoes the total error count as
# its LAST line (callers must capture that line, never rely on $? — every
# branch below ends in `echo`, which always exits 0 under set -e).
run_checks() {
  local root="$1"
  local base_ref="$2"
  local errors=0

  # ---- (a) no new *_view*.sql migration in this task's diff ----------------
  local new_migrations new_view_migrations
  new_migrations="$(git -C "${root}" diff --name-only --diff-filter=A "${base_ref}" -- migrations/ 2>/dev/null || true)"
  new_migrations="${new_migrations}
$(git -C "${root}" ls-files --others --exclude-standard -- migrations/ 2>/dev/null || true)"
  new_view_migrations="$(echo "${new_migrations}" | grep -iE '_view.*\.sql$' || true)"
  if [[ -n "${new_view_migrations}" ]]; then
    echo "FAIL (FF-K-1a): new *_view*.sql migration(s) found — kanban must need ZERO migrations:"
    echo "${new_view_migrations}"
    errors=$((errors + 1))
  else
    echo "PASS (FF-K-1a): no new *_view*.sql migration added by this task"
  fi

  # ---- (b) no second views-CRUD router registration -------------------------
  local new_files second_router_hits
  new_files="$(git -C "${root}" diff --name-only --diff-filter=A "${base_ref}" -- src/ 2>/dev/null || true)"
  new_files="${new_files}
$(git -C "${root}" ls-files --others --exclude-standard -- src/ 2>/dev/null || true)"
  second_router_hits=""
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    [[ "${f}" == "src/http/list-views.ts" ]] && continue
    full="${root}/${f}"
    [[ -f "${full}" ]] || continue
    if grep -qE 'router\.register\([^)]*["'"'"']\/api\/[a-zA-Z_-]*views?[a-zA-Z_-]*["'"'"']' "${full}"; then
      second_router_hits="${second_router_hits}${f}
"
    fi
  done <<< "${new_files}"
  if [[ -n "${second_router_hits}" ]]; then
    echo "FAIL (FF-K-1b): a second views-CRUD router registration was found outside list-views.ts:"
    echo "${second_router_hits}"
    errors=$((errors + 1))
  else
    echo "PASS (FF-K-1b): no second /api/*view* router registered by this task"
  fi

  # ---- (d) FF-K-4: no new `FROM choros.record` SELECT anywhere in this
  # task's diff — kanban must read cards ONLY via the existing GET
  # /api/records (never a second direct SQL path bypassing READ-PDP/
  # field-visibility).
  local record_select_hits
  record_select_hits=""
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    full="${root}/${f}"
    [[ -f "${full}" ]] || continue
    if grep -qiE 'FROM[[:space:]]+choros\.record\b' "${full}"; then
      record_select_hits="${record_select_hits}${f}
"
    fi
  done <<< "${new_files}"
  if [[ -n "${record_select_hits}" ]]; then
    echo "FAIL (FF-K-4): a new 'FROM choros.record' SELECT was found in this task's diff:"
    echo "${record_select_hits}"
    errors=$((errors + 1))
  else
    echo "PASS (FF-K-4): no new 'FROM choros.record' SELECT added by this task"
  fi

  # ---- (c) list-views.ts CRUD contract file is byte-unchanged --------------
  local list_views diff_out
  list_views="${root}/src/http/list-views.ts"
  if [[ -f "${list_views}" ]]; then
    diff_out="$(git -C "${root}" diff "${base_ref}" -- src/http/list-views.ts 2>/dev/null || true)"
    if [[ -n "${diff_out}" ]]; then
      echo "FAIL (FF-K-1c): src/http/list-views.ts was modified by this task — NF-1 requires it stay unchanged:"
      echo "${diff_out}" | head -20
      errors=$((errors + 1))
    else
      echo "PASS (FF-K-1c): src/http/list-views.ts is unchanged (CRUD contract untouched)"
    fi
  else
    echo "FAIL (FF-K-1c): ${list_views} does not exist"
    errors=$((errors + 1))
  fi

  echo "${errors}"
}

self_test() {
  echo "[T-0582] kanban-registry-no-fork --self-test"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  git -C "${tmp}" init -q
  git -C "${tmp}" config user.email "selftest@example.com"
  git -C "${tmp}" config user.name "selftest"
  mkdir -p "${tmp}/src/http" "${tmp}/migrations"
  echo '// list-views CRUD router' > "${tmp}/src/http/list-views.ts"
  git -C "${tmp}" add -A
  git -C "${tmp}" commit -q -m "base"
  local base_ref
  base_ref="$(git -C "${tmp}" rev-parse HEAD)"

  # GOOD: no new migration, no second router, no direct SELECT, CRUD file untouched.
  mkdir -p "${tmp}/web/src/screens"
  echo 'export function KanbanBoard() { return null; }' > "${tmp}/web/src/screens/kanban-board.jsx"
  git -C "${tmp}" add -A
  git -C "${tmp}" commit -q -m "good task commit"
  local good_errors
  good_errors="$(run_checks "${tmp}" "${base_ref}" 2>/dev/null | tail -1)"
  git -C "${tmp}" reset -q --hard "${base_ref}"

  # BAD: new *_view*.sql migration + second router + direct record SELECT +
  # list-views.ts modified.
  echo 'CREATE TABLE choros.kanban_view (id uuid);' > "${tmp}/migrations/999_kanban_view.sql"
  mkdir -p "${tmp}/src/http"
  echo 'router.register("GET", "/api/kanban-views", handler);' > "${tmp}/src/http/kanban-views.ts"
  echo 'SELECT * FROM choros.record WHERE 1=1;' > "${tmp}/src/http/kanban-direct-read.ts"
  echo '// modified CRUD contract' >> "${tmp}/src/http/list-views.ts"
  git -C "${tmp}" add -A
  git -C "${tmp}" commit -q -m "bad task commit"
  local bad_errors
  bad_errors="$(run_checks "${tmp}" "${base_ref}" 2>/dev/null | tail -1)"

  if [[ "${good_errors}" -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD tree (${good_errors} violation(s))"
    return 1
  fi
  if [[ "${bad_errors}" -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD tree"
    return 1
  fi
  echo "SELF-TEST PASS: good tree clean (0 findings), bad tree flagged (${bad_errors} finding(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[FF-K-1] kanban-registry-no-fork: checking T-0582 does not fork the view registry"

BASE_REF="$(resolve_base_ref "${ROOT}")"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN (FF-K-1): cannot determine base ref — skipping diff-scoped checks"
  exit 0
fi

RUN_OUTPUT="$(run_checks "${ROOT}" "${BASE_REF}")"
echo "${RUN_OUTPUT}" | sed '$d'
ERRORS="$(echo "${RUN_OUTPUT}" | tail -1)"

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: kanban-registry-no-fork found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: kanban-registry-no-fork — kanban adds zero migrations/routers, list-views.ts untouched"
exit 0
