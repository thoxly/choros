#!/usr/bin/env bash
# T-0722 (D-064, P2 из T-0714 — security/PDP) · process-list-display-plane-isolation —
# FF-INST-VIS-3: GET /api/processes (LIST) CALLS the batched READ-visibility
# filter before serving the `instances[]` array, AND the display plane
# src/http/processes.ts still does not import `pg`/`src/db/*` directly.
#
# THE DEFECT this closes (T-0714 §3 P2): LIST used to serve every tenant
# instance's definitionName/step/recordId to any tenant member, gated ONLY by
# tenant-membership — an enumeration/existence side-channel around the same
# READ-PDP (T-0570) that DETAIL (T-0721, FF-INST-VIS-1) already closed for
# variables/history. Mirrors process-detail-read-gate.sh's methodology
# (static grep over the owning module, comment-line-aware, --self-test proves
# the detector fires) but scoped to the LIST route + a dedicated re-assertion
# of the display-plane-isolation invariant (FF-7-3, start-route-isolation.sh)
# specifically over the NEW LIST-gate code this task adds.
#
#  FF-INST-VIS-3a — src/http/processes.ts imports `filterProjectionsByReadVisibility`
#           from ./process-projection.js (the batched predicate), not a local
#           re-implementation.
#  FF-INST-VIS-3b — the GET /api/processes route handler (the LIST route,
#           distinct from the ":id" DETAIL route) references BOTH
#           `resolveReadVisibility` and `filterProjectionsByReadVisibility` in
#           non-comment code — the gate is actually wired into the LIST
#           handler, not merely imported-and-unused (and not ONLY wired into
#           the pre-existing DETAIL handler).
#  FF-INST-VIS-3c — the `filterProjectionsByReadVisibility(` call appears
#           BEFORE the `overlayDetailLiveSteps(` call in the LIST handler
#           (source-order proxy for "the gate runs before the live-engine
#           overlay is spent on a soon-to-be-dropped instance" — never worse
#           than DETAIL's ordering discipline).
#  FF-INST-VIS-3d — processes.ts still does NOT import `pg` or `src/db/*`
#           directly (re-assert FF-7-3 specifically for this task's diff —
#           does not rely SOLELY on the pre-existing generic check staying
#           green by omission).
#
# SELF-TEST (`--self-test`): plants violations (a gate-free LIST handler, a
# `pg` import) in temp files and asserts the predicates fire.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DISPLAY_MODULE="${PROJECT_ROOT}/src/http/processes.ts"
ERRORS=0

# grep wrapper: returns matches on NON-comment code lines (lesson T-0143).
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -vE '^[[:space:]]*(//|\*|/\*)' "${file}" | grep -nE "${pattern}")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---------------------------------------------------------------------------
# --self-test: plant violations, assert the predicates detect them.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/list-vis-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # GOOD fixture: LIST gate wired, correct order, no pg import.
  cat > "$TMP" <<'EOF'
import {
  filterProjectionsByReadVisibility,
} from "./process-projection.js";
router.register("GET", "/api/processes", withAuth(async (req, res) => {
  const projections = await listInstanceProjections(startDeps.pool, tenantId);
  let visibleProjections = projections;
  if (startDeps.resolveReadVisibility) {
    const { grants, ancestry } = await startDeps.resolveReadVisibility(actorSlug, tenantId, gateNowMs);
    visibleProjections = await filterProjectionsByReadVisibility(startDeps.pool, tenantId, projections, grants, ancestry, gateNowMs);
  }
  const display = await overlayDetailLiveSteps(startDeps.flowable, visibleProjections);
  res.end(JSON.stringify({ instances: display.map(projectionToInstance) }));
}));
EOF
  if [[ -z "$(grep_noncomment 'filterProjectionsByReadVisibility' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: predicate call not detected on a GOOD fixture — check is broken"; exit 2
  fi
  gate_line=$(grep -n 'filterProjectionsByReadVisibility(startDeps' "$TMP" | head -1 | cut -d: -f1)
  overlay_line=$(grep -n 'overlayDetailLiveSteps(' "$TMP" | head -1 | cut -d: -f1)
  if [[ -z "${gate_line}" || -z "${overlay_line}" || "${gate_line}" -ge "${overlay_line}" ]]; then
    echo "SELF-TEST FAIL: GOOD fixture's gate-before-overlay ordering not detected — check is broken"; exit 2
  fi
  if [[ -n "$(grep_noncomment "^import[[:space:]].*from[[:space:]]+['\"]pg['\"]" "$TMP")" ]]; then
    echo "SELF-TEST FAIL: GOOD fixture wrongly flagged for a pg import — check is broken"; exit 2
  fi

  # BAD fixture A: LIST handler with NO gate call at all (pre-T-0722 shape).
  cat > "$TMP" <<'EOF'
router.register("GET", "/api/processes", withAuth(async (req, res) => {
  const projections = await listInstanceProjections(startDeps.pool, tenantId);
  const display = await overlayDetailLiveSteps(startDeps.flowable, projections);
  res.end(JSON.stringify({ instances: display.map(projectionToInstance) }));
}));
EOF
  if [[ -n "$(grep_noncomment 'filterProjectionsByReadVisibility' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: predicate wrongly detected on the BAD (gate-free) fixture — check is broken"; exit 2
  fi

  # BAD fixture B: a direct `pg` import (display-plane violation).
  cat > "$TMP" <<'EOF'
import pg from "pg";
EOF
  if [[ -z "$(grep_noncomment "^import[[:space:]].*from[[:space:]]+['\"]pg['\"]" "$TMP")" ]]; then
    echo "SELF-TEST FAIL: pg import not detected — check is broken"; exit 2
  fi

  echo "SELF-TEST PASS: process-list-display-plane-isolation predicates detect the planted violations"
  exit 0
fi

echo "[T-0722] process-list-display-plane-isolation: checking GET /api/processes wires the READ-visibility filter, stays pg-free"

if [[ ! -f "${DISPLAY_MODULE}" ]]; then
  echo "FAIL: ${DISPLAY_MODULE} does not exist"; exit 1
fi

# ---- FF-INST-VIS-3a: imports the batched predicate, not a local re-implementation ----
before=${ERRORS}
if ! grep -qE "filterProjectionsByReadVisibility" "${DISPLAY_MODULE}"; then
  echo "FAIL [FF-INST-VIS-3a]: processes.ts does not import/reference filterProjectionsByReadVisibility"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "from ['\"]\./process-projection\.js['\"]" "${DISPLAY_MODULE}"; then
  echo "FAIL [FF-INST-VIS-3a]: processes.ts does not import from ./process-projection.js"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-3a]: filterProjectionsByReadVisibility imported from process-projection.js"
fi

# ---- FF-INST-VIS-3b/c: the LIST handler wires the gate, in order, BEFORE the overlay --
before=${ERRORS}
LIST_LINE=$(grep -n '"/api/processes"' "${DISPLAY_MODULE}" | head -1 | cut -d: -f1 || true)
DETAIL_LINE=$(grep -n '"/api/processes/:id"' "${DISPLAY_MODULE}" | head -1 | cut -d: -f1 || true)
if [[ -z "${LIST_LINE}" ]]; then
  echo "FAIL [FF-INST-VIS-3b]: no GET /api/processes route registration found"
  ERRORS=$((ERRORS + 1))
elif [[ -z "${DETAIL_LINE}" ]]; then
  echo "FAIL [FF-INST-VIS-3b]: no GET /api/processes/:id route registration found (window bound missing)"
  ERRORS=$((ERRORS + 1))
else
  # LIST handler body = the window from the LIST registration up to (excluding)
  # the DETAIL registration — the two routes are adjacent, LIST registered first.
  LIST_LEN=$((DETAIL_LINE - LIST_LINE))
  WINDOW_FILE="$(mktemp)"
  tail -n "+${LIST_LINE}" "${DISPLAY_MODULE}" | head -n "${LIST_LEN}" > "${WINDOW_FILE}"
  resolver_ref="$(grep_noncomment 'resolveReadVisibility' "${WINDOW_FILE}")"
  predicate_ref="$(grep_noncomment 'filterProjectionsByReadVisibility\(' "${WINDOW_FILE}")"
  if [[ -z "${resolver_ref}" ]]; then
    echo "FAIL [FF-INST-VIS-3b]: LIST handler never references resolveReadVisibility"
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -z "${predicate_ref}" ]]; then
    echo "FAIL [FF-INST-VIS-3b]: LIST handler never calls filterProjectionsByReadVisibility("
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -n "${resolver_ref}" && -n "${predicate_ref}" ]]; then
    gate_line=$(grep -n 'filterProjectionsByReadVisibility(' "${WINDOW_FILE}" | head -1 | cut -d: -f1)
    overlay_line=$(grep -n 'overlayDetailLiveSteps(' "${WINDOW_FILE}" | head -1 | cut -d: -f1 || true)
    if [[ -n "${overlay_line}" && "${gate_line}" -ge "${overlay_line}" ]]; then
      echo "FAIL [FF-INST-VIS-3c]: filterProjectionsByReadVisibility( is not called BEFORE overlayDetailLiveSteps( in the LIST handler"
      ERRORS=$((ERRORS + 1))
    fi
  fi
  rm -f "${WINDOW_FILE}"
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-3b/c]: LIST handler wires resolveReadVisibility → filterProjectionsByReadVisibility BEFORE overlayDetailLiveSteps"
fi

# ---- FF-INST-VIS-3d: display plane stays pg-free (re-assert FF-7-3 for this diff) ----
before=${ERRORS}
if grep_noncomment "^import[[:space:]].*from[[:space:]]+['\"]pg['\"]" "${DISPLAY_MODULE}" > /dev/null 2>&1 && \
   [[ -n "$(grep_noncomment "^import[[:space:]].*from[[:space:]]+['\"]pg['\"]" "${DISPLAY_MODULE}")" ]]; then
  echo "FAIL [FF-INST-VIS-3d]: processes.ts imports 'pg' directly (display plane must not)"
  ERRORS=$((ERRORS + 1))
fi
if [[ -n "$(grep_noncomment "from[[:space:]]+['\"]\.\./\.\./?db/" "${DISPLAY_MODULE}" 2>/dev/null || true)" ]]; then
  echo "FAIL [FF-INST-VIS-3d]: processes.ts imports from src/db/* (display plane must not)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-3d]: processes.ts remains pg/src-db-free (FF-7-3 held for the LIST-gate diff)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: process-list-display-plane-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: process-list-display-plane-isolation (FF-INST-VIS-3) clean"
