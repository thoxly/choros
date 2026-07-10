#!/usr/bin/env bash
# T-0722 (D-064, P2 из T-0714 — security/PDP) · process-list-tenant-scope-additive —
# FF-INST-VIS-4: the LIST READ-visibility filter is a DOPOLNITELNYY (additional)
# `AND` applied ON TOP of the existing tenant-scope, NEVER a replacement for it.
#
# THE INVARIANT: `listInstanceProjections` (process-projection.ts) is the ONE
# tenant boundary (SET LOCAL choros.tenant_id + explicit `WHERE tenant_id`) —
# filterProjectionsByReadVisibility must be called on its OUTPUT (narrowing an
# ALREADY tenant-scoped array), never used AS the tenant fetch, and its own
# batched ancestry lookup must itself stay tenant-scoped. Mirrors
# process-detail-single-resolver.sh's methodology (grep for a forbidden
# pattern / a required ordering, --self-test convention).
#
#  FF-INST-VIS-4a — in the LIST route handler, `listInstanceProjections(`
#           appears BEFORE `filterProjectionsByReadVisibility(` (source-order
#           proxy for "the filter narrows an already tenant-scoped result",
#           same heuristic every ordering check in this repo uses).
#  FF-INST-VIS-4b — `loadRecordRowAncestryBatch` (the batched ancestry SELECT
#           backing the LIST filter, src/http/process-projection.ts) is
#           itself tenant-scoped: it runs through `withTenant(` and its SQL
#           carries an explicit `tenant_id = $1` guard — not a bare
#           unscoped SELECT.
#  FF-INST-VIS-4c — process-projection.ts does not import
#           `isNarrowerOrEqual`/`isEffective` directly (no second authority
#           path introduced by the LIST filter — mirrors FF-INST-VIS-2b,
#           re-asserted here because this task adds a SECOND call site
#           consuming isRecordReadable).
#
# SELF-TEST (`--self-test`): plants violations (filter called without a
# preceding tenant-scoped fetch; an ancestry query missing tenant_id) and
# asserts the predicates fire.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DISPLAY_MODULE="${PROJECT_ROOT}/src/http/processes.ts"
PROJECTION_MODULE="${PROJECT_ROOT}/src/http/process-projection.ts"
ERRORS=0

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
# --self-test
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/list-tenant-scope-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # GOOD fixture: tenant-scoped fetch FIRST, filter narrows it after.
  cat > "$TMP" <<'EOF'
const projections = await listInstanceProjections(startDeps.pool, tenantId);
let visibleProjections = projections;
if (startDeps.resolveReadVisibility) {
  visibleProjections = await filterProjectionsByReadVisibility(startDeps.pool, tenantId, projections, grants, ancestry, gateNowMs);
}
EOF
  list_line=$(grep -n 'listInstanceProjections(' "$TMP" | head -1 | cut -d: -f1)
  filter_line=$(grep -n 'filterProjectionsByReadVisibility(' "$TMP" | head -1 | cut -d: -f1)
  if [[ -z "${list_line}" || -z "${filter_line}" || "${list_line}" -ge "${filter_line}" ]]; then
    echo "SELF-TEST FAIL: GOOD fixture's tenant-scope-before-filter ordering not detected — check is broken"; exit 2
  fi

  # BAD fixture A: filter called with NO preceding tenant-scoped fetch in the window.
  cat > "$TMP" <<'EOF'
async function suspiciousHandler(startDeps: unknown) {
  return filterProjectionsByReadVisibility(startDeps.pool, tenantId, someProjections, grants, ancestry, gateNowMs);
}
EOF
  if [[ -n "$(grep -n 'listInstanceProjections(' "$TMP" || true)" ]]; then
    echo "SELF-TEST FAIL: BAD fixture A unexpectedly contains listInstanceProjections( — fixture is wrong"; exit 2
  fi

  # GOOD fixture (ancestry query): tenant-scoped, withTenant + explicit tenant_id.
  cat > "$TMP" <<'EOF'
async function loadRecordRowAncestryBatch(pool, tenantId, recordIds) {
  return withTenant(pool, tenantId, async (client) => {
    const res = await client.query(`SELECT r.id, r.registry_id, rd.application_id FROM choros.record r JOIN choros.registry_def rd ON true WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`, [tenantId, recordIds]);
    return res.rows;
  });
}
EOF
  if [[ -z "$(grep_noncomment 'withTenant\(' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: GOOD ancestry fixture's withTenant( call not detected — check is broken"; exit 2
  fi
  if [[ -z "$(grep_noncomment 'tenant_id[[:space:]]*=[[:space:]]*\$1' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: GOOD ancestry fixture's explicit tenant_id guard not detected — check is broken"; exit 2
  fi

  # BAD fixture B (ancestry query): no tenant_id guard at all — unscoped SELECT.
  cat > "$TMP" <<'EOF'
async function loadRecordRowAncestryBatch(pool, tenantId, recordIds) {
  const res = await pool.query(`SELECT r.id, r.registry_id, rd.application_id FROM choros.record r JOIN choros.registry_def rd ON true WHERE r.id = ANY($1::uuid[])`, [recordIds]);
  return res.rows;
}
EOF
  if [[ -n "$(grep_noncomment 'tenant_id[[:space:]]*=[[:space:]]*\$1' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: BAD ancestry fixture wrongly flagged as tenant-scoped — check is broken"; exit 2
  fi

  echo "SELF-TEST PASS: process-list-tenant-scope-additive predicates detect the planted violations"
  exit 0
fi

echo "[T-0722] process-list-tenant-scope-additive: checking the LIST READ-visibility filter is additive within tenant-scope"

for f in "${DISPLAY_MODULE}" "${PROJECTION_MODULE}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${f} does not exist"; exit 1
  fi
done

# ---- FF-INST-VIS-4a: listInstanceProjections( precedes filterProjectionsByReadVisibility( ----
before=${ERRORS}
LIST_LINE=$(grep -n '"/api/processes"' "${DISPLAY_MODULE}" | head -1 | cut -d: -f1 || true)
DETAIL_LINE=$(grep -n '"/api/processes/:id"' "${DISPLAY_MODULE}" | head -1 | cut -d: -f1 || true)
if [[ -z "${LIST_LINE}" || -z "${DETAIL_LINE}" ]]; then
  echo "FAIL [FF-INST-VIS-4a]: could not bound the LIST handler window (route registration not found)"
  ERRORS=$((ERRORS + 1))
else
  LIST_LEN=$((DETAIL_LINE - LIST_LINE))
  WINDOW_FILE="$(mktemp)"
  tail -n "+${LIST_LINE}" "${DISPLAY_MODULE}" | head -n "${LIST_LEN}" > "${WINDOW_FILE}"
  fetch_line=$(grep -n 'listInstanceProjections(' "${WINDOW_FILE}" | head -1 | cut -d: -f1 || true)
  filter_line=$(grep -n 'filterProjectionsByReadVisibility(' "${WINDOW_FILE}" | head -1 | cut -d: -f1 || true)
  if [[ -z "${fetch_line}" ]]; then
    echo "FAIL [FF-INST-VIS-4a]: LIST handler never calls listInstanceProjections( — no tenant-scoped fetch to narrow"
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -z "${filter_line}" ]]; then
    echo "FAIL [FF-INST-VIS-4a]: LIST handler never calls filterProjectionsByReadVisibility("
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -n "${fetch_line}" && -n "${filter_line}" && "${fetch_line}" -ge "${filter_line}" ]]; then
    echo "FAIL [FF-INST-VIS-4a]: filterProjectionsByReadVisibility( is called BEFORE listInstanceProjections( — filter would not be narrowing a tenant-scoped result"
    ERRORS=$((ERRORS + 1))
  fi
  rm -f "${WINDOW_FILE}"
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-4a]: filterProjectionsByReadVisibility( narrows the ALREADY tenant-scoped listInstanceProjections( result"
fi

# ---- FF-INST-VIS-4b: the batched ancestry query is itself tenant-scoped -------
before=${ERRORS}
FN_LINE=$(grep -n 'function loadRecordRowAncestryBatch' "${PROJECTION_MODULE}" | head -1 | cut -d: -f1 || true)
if [[ -z "${FN_LINE}" ]]; then
  echo "FAIL [FF-INST-VIS-4b]: loadRecordRowAncestryBatch not found in process-projection.ts"
  ERRORS=$((ERRORS + 1))
else
  WINDOW_FILE="$(mktemp)"
  sed -n "${FN_LINE},$((FN_LINE + 20))p" "${PROJECTION_MODULE}" > "${WINDOW_FILE}"
  if [[ -z "$(grep_noncomment 'withTenant\(' "${WINDOW_FILE}")" ]]; then
    echo "FAIL [FF-INST-VIS-4b]: loadRecordRowAncestryBatch does not run through withTenant("
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -z "$(grep_noncomment 'tenant_id[[:space:]]*=[[:space:]]*\$1' "${WINDOW_FILE}")" ]]; then
    echo "FAIL [FF-INST-VIS-4b]: loadRecordRowAncestryBatch's SQL has no explicit tenant_id = \$1 guard"
    ERRORS=$((ERRORS + 1))
  fi
  rm -f "${WINDOW_FILE}"
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-4b]: loadRecordRowAncestryBatch is tenant-scoped (withTenant + explicit tenant_id guard)"
fi

# ---- FF-INST-VIS-4c: no second authority path introduced by the LIST filter --
before=${ERRORS}
hit="$(grep_noncomment 'isNarrowerOrEqual|isEffective' "${PROJECTION_MODULE}" || true)"
if [[ -n "${hit}" ]]; then
  echo "FAIL [FF-INST-VIS-4c]: process-projection.ts imports/calls lattice math directly (second authority path):"
  echo "${hit}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-4c]: no direct isNarrowerOrEqual/isEffective use in process-projection.ts (single authority path held)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: process-list-tenant-scope-additive found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: process-list-tenant-scope-additive (FF-INST-VIS-4) clean"
