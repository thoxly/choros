#!/usr/bin/env bash
# T-0721 (D-064, P1 из T-0714 — security/PDP) · process-detail-read-gate —
# FF-INST-VIS-1: GET /api/processes/:id CALLS the injected READ-visibility
# resolver before serving DETAIL fields (variables/history/completedBy*).
#
# THE DEFECT this closes (T-0714 §3 P1): the DETAIL route used to serve
# Flowable's raw variables/history to ANY tenant member, gated ONLY by
# tenant-membership — a side-door around field-visibility (T-0081) /
# READ-PDP (T-0570), which already gate the SAME business values on the
# record plane. Mirrors start-route-isolation.sh's methodology (static grep
# over the two owning modules, comment-line-aware, --self-test proves the
# detector fires).
#
#  FF-INST-VIS-1a — src/http/processes.ts imports `isInstanceDetailVisible`
#           from ./process-projection.js (the predicate), not a local copy.
#  FF-INST-VIS-1b — the GET /api/processes/:id route handler (the tail of
#           processes.ts starting at its route-registration line) references
#           BOTH `resolveReadVisibility` and `isInstanceDetailVisible` in
#           non-comment code — the gate is actually wired into the handler,
#           not merely imported-and-unused.
#  FF-INST-VIS-1c — the `isInstanceDetailVisible(` call appears BEFORE the
#           `fetchInstanceHistoryDetail(` call in the DETAIL handler tail
#           (source order proxy for "the gate runs before the sensitive
#           fields are composed" — the same static-order heuristic every
#           isolation check in this repo uses, no AST parse).
#  FF-INST-VIS-1d — a denied instance falls through to the SAME
#           `HttpError(404, "NOT_FOUND", ...)` the route already throws for
#           an unmatched id (honest-404, records.ts precedent) — i.e. no
#           SECOND distinct error shape was invented for the denial.
#
# SELF-TEST (`--self-test`): plants a violation (a handler with NO gate call)
# in a temp file and asserts the predicate fires, so a broken check turns CI
# red immediately (FF-SELFTEST convention, mirrors start-route-isolation.sh).
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
# --self-test: plant a violation (gate-free DETAIL handler), assert it fires.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/inst-vis-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # GOOD fixture: gate wired, correct order, honest-404 fallthrough.
  cat > "$TMP" <<'EOF'
import { isInstanceDetailVisible } from "./process-projection.js";
router.register("GET", "/api/processes/:id", withAuth(async (req, res, params) => {
  if (match) {
    let detailVisible = true;
    if (startDeps.resolveReadVisibility) {
      const { grants, ancestry } = await startDeps.resolveReadVisibility(actorSlug, tenantId, gateNowMs);
      detailVisible = await isInstanceDetailVisible(startDeps.pool, tenantId, match.recordId, grants, ancestry, gateNowMs);
    }
    if (detailVisible) {
      const detail = await fetchInstanceHistoryDetail(startDeps.flowable, match.inst, tenantId, startDeps.resolveActorsDisplay);
      res.end(JSON.stringify(detail));
      return;
    }
  }
  throw new HttpError(404, "NOT_FOUND", "instance not found");
}));
EOF
  if [[ -z "$(grep_noncomment 'isInstanceDetailVisible' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: predicate call not detected on a GOOD fixture — check is broken"; exit 2
  fi
  gate_line=$(grep -n 'isInstanceDetailVisible(startDeps' "$TMP" | head -1 | cut -d: -f1)
  fetch_line=$(grep -n 'fetchInstanceHistoryDetail(' "$TMP" | head -1 | cut -d: -f1)
  if [[ -z "${gate_line}" || -z "${fetch_line}" || "${gate_line}" -ge "${fetch_line}" ]]; then
    echo "SELF-TEST FAIL: GOOD fixture's gate-before-fetch ordering not detected — check is broken"; exit 2
  fi

  # BAD fixture: DETAIL handler with NO gate call at all (the pre-T-0721 shape).
  cat > "$TMP" <<'EOF'
router.register("GET", "/api/processes/:id", withAuth(async (req, res, params) => {
  if (match) {
    const detail = await fetchInstanceHistoryDetail(startDeps.flowable, match.inst, tenantId, startDeps.resolveActorsDisplay);
    res.end(JSON.stringify(detail));
    return;
  }
  throw new HttpError(404, "NOT_FOUND", "instance not found");
}));
EOF
  if [[ -n "$(grep_noncomment 'isInstanceDetailVisible' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: predicate wrongly detected on the BAD (gate-free) fixture — check is broken"; exit 2
  fi
  echo "SELF-TEST PASS: process-detail-read-gate predicates detect the planted violation"
  exit 0
fi

echo "[T-0721] process-detail-read-gate: checking GET /api/processes/:id calls the READ-visibility resolver"

if [[ ! -f "${DISPLAY_MODULE}" ]]; then
  echo "FAIL: ${DISPLAY_MODULE} does not exist"; exit 1
fi

# ---- FF-INST-VIS-1a: imports the predicate, not a local re-implementation ----
before=${ERRORS}
if ! grep -qE "isInstanceDetailVisible" "${DISPLAY_MODULE}"; then
  echo "FAIL [FF-INST-VIS-1a]: processes.ts does not import/reference isInstanceDetailVisible"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "from ['\"]\./process-projection\.js['\"]" "${DISPLAY_MODULE}"; then
  echo "FAIL [FF-INST-VIS-1a]: processes.ts does not import from ./process-projection.js"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-1a]: isInstanceDetailVisible imported from process-projection.js"
fi

# ---- FF-INST-VIS-1b/c: the DETAIL handler tail wires the gate, in order -------
before=${ERRORS}
DETAIL_LINE=$(grep -n '"/api/processes/:id"' "${DISPLAY_MODULE}" | head -1 | cut -d: -f1 || true)
if [[ -z "${DETAIL_LINE}" ]]; then
  echo "FAIL [FF-INST-VIS-1b]: no GET /api/processes/:id route registration found"
  ERRORS=$((ERRORS + 1))
else
  TAIL_FILE="$(mktemp)"
  tail -n "+${DETAIL_LINE}" "${DISPLAY_MODULE}" > "${TAIL_FILE}"
  resolver_ref="$(grep_noncomment 'resolveReadVisibility' "${TAIL_FILE}")"
  predicate_ref="$(grep_noncomment 'isInstanceDetailVisible\(' "${TAIL_FILE}")"
  if [[ -z "${resolver_ref}" ]]; then
    echo "FAIL [FF-INST-VIS-1b]: DETAIL handler never references resolveReadVisibility"
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -z "${predicate_ref}" ]]; then
    echo "FAIL [FF-INST-VIS-1b]: DETAIL handler never calls isInstanceDetailVisible("
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -n "${resolver_ref}" && -n "${predicate_ref}" ]]; then
    gate_line=$(grep -n 'isInstanceDetailVisible(' "${TAIL_FILE}" | head -1 | cut -d: -f1)
    fetch_line=$(grep -n 'fetchInstanceHistoryDetail(' "${TAIL_FILE}" | head -1 | cut -d: -f1 || true)
    if [[ -n "${fetch_line}" && "${gate_line}" -ge "${fetch_line}" ]]; then
      echo "FAIL [FF-INST-VIS-1c]: isInstanceDetailVisible( is not called BEFORE fetchInstanceHistoryDetail( in the DETAIL handler"
      ERRORS=$((ERRORS + 1))
    fi
  fi
  rm -f "${TAIL_FILE}"
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-1b/c]: DETAIL handler wires resolveReadVisibility → isInstanceDetailVisible BEFORE fetchInstanceHistoryDetail"
fi

# ---- FF-INST-VIS-1d: denial falls through to the SAME honest-404 shape -------
before=${ERRORS}
NOT_FOUND_COUNT=$(grep_noncomment 'HttpError\(404, "NOT_FOUND", "instance not found"\)' "${DISPLAY_MODULE}" | wc -l | tr -d ' ')
if [[ "${NOT_FOUND_COUNT}" -lt 1 ]]; then
  echo "FAIL [FF-INST-VIS-1d]: no HttpError(404, \"NOT_FOUND\", \"instance not found\") found — denial has no honest-404 fallthrough"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-INST-VIS-1d]: honest-404 fallthrough present (${NOT_FOUND_COUNT} site(s), shared by not-found AND denied)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: process-detail-read-gate found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: process-detail-read-gate (FF-INST-VIS-1) clean"
