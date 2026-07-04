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
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ERRORS=0

echo "[FF-K-1] kanban-registry-no-fork: checking T-0582 does not fork the view registry"

resolve_base_ref() {
  git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
    || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

BASE_REF="$(resolve_base_ref)"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN (FF-K-1): cannot determine base ref — skipping diff-scoped checks"
  exit 0
fi

# ---- (a) no new *_view*.sql migration in this task's diff ------------------
NEW_MIGRATIONS="$(git -C "${ROOT}" diff --name-only --diff-filter=A "${BASE_REF}" -- migrations/ 2>/dev/null || true)"
NEW_MIGRATIONS="${NEW_MIGRATIONS}
$(git -C "${ROOT}" ls-files --others --exclude-standard -- migrations/ 2>/dev/null || true)"
NEW_VIEW_MIGRATIONS="$(echo "${NEW_MIGRATIONS}" | grep -iE '_view.*\.sql$' || true)"
if [[ -n "${NEW_VIEW_MIGRATIONS}" ]]; then
  echo "FAIL (FF-K-1a): new *_view*.sql migration(s) found — kanban must need ZERO migrations:"
  echo "${NEW_VIEW_MIGRATIONS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-K-1a): no new *_view*.sql migration added by this task"
fi

# ---- (b) no second views-CRUD router registration --------------------------
NEW_FILES="$(git -C "${ROOT}" diff --name-only --diff-filter=A "${BASE_REF}" -- src/ 2>/dev/null || true)"
NEW_FILES="${NEW_FILES}
$(git -C "${ROOT}" ls-files --others --exclude-standard -- src/ 2>/dev/null || true)"
SECOND_ROUTER_HITS=""
while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  [[ "${f}" == "src/http/list-views.ts" ]] && continue
  full="${ROOT}/${f}"
  [[ -f "${full}" ]] || continue
  if grep -qE 'router\.register\([^)]*["'"'"']\/api\/[a-zA-Z_-]*views?[a-zA-Z_-]*["'"'"']' "${full}"; then
    SECOND_ROUTER_HITS="${SECOND_ROUTER_HITS}${f}
"
  fi
done <<< "${NEW_FILES}"
if [[ -n "${SECOND_ROUTER_HITS}" ]]; then
  echo "FAIL (FF-K-1b): a second views-CRUD router registration was found outside list-views.ts:"
  echo "${SECOND_ROUTER_HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-K-1b): no second /api/*view* router registered by this task"
fi

# ---- (d) FF-K-4: no new `FROM choros.record` SELECT anywhere in this task's
# diff — kanban must read cards ONLY via the existing GET /api/records (never
# a second direct SQL path bypassing READ-PDP/field-visibility).
RECORD_SELECT_HITS=""
while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  full="${ROOT}/${f}"
  [[ -f "${full}" ]] || continue
  if grep -qiE 'FROM[[:space:]]+choros\.record\b' "${full}"; then
    RECORD_SELECT_HITS="${RECORD_SELECT_HITS}${f}
"
  fi
done <<< "${NEW_FILES}"
if [[ -n "${RECORD_SELECT_HITS}" ]]; then
  echo "FAIL (FF-K-4): a new 'FROM choros.record' SELECT was found in this task's diff:"
  echo "${RECORD_SELECT_HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-K-4): no new 'FROM choros.record' SELECT added by this task"
fi

# ---- (c) list-views.ts CRUD contract file is byte-unchanged -----------------
LIST_VIEWS="${ROOT}/src/http/list-views.ts"
if [[ -f "${LIST_VIEWS}" ]]; then
  DIFF_OUT="$(git -C "${ROOT}" diff "${BASE_REF}" -- src/http/list-views.ts 2>/dev/null || true)"
  if [[ -n "${DIFF_OUT}" ]]; then
    echo "FAIL (FF-K-1c): src/http/list-views.ts was modified by this task — NF-1 requires it stay unchanged:"
    echo "${DIFF_OUT}" | head -20
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-K-1c): src/http/list-views.ts is unchanged (CRUD contract untouched)"
  fi
else
  echo "FAIL (FF-K-1c): ${LIST_VIEWS} does not exist"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: kanban-registry-no-fork found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: kanban-registry-no-fork — kanban adds zero migrations/routers, list-views.ts untouched"
exit 0
