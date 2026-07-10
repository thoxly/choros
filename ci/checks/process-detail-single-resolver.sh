#!/usr/bin/env bash
# T-0721 (D-064, P1 из T-0714 — security/PDP) · process-detail-single-resolver —
# FF-INST-VIS-2: the instance DETAIL read-visibility gate has ONE authority
# path — isRecordReadable (src/core/read-visibility.ts) fed by the SAME
# getGrantsForSubject + loadTenantOrgAncestry → makeResourceAncestryOracle
# composition records.ts's resolveReadVisibility already uses (T-0570). No
# bespoke grant math, no direct grant-table query, no second copy of the
# containment predicate. Mirrors single-resolver.sh's methodology (grep for a
# forbidden second entry-point) + start-route-isolation.sh's --self-test
# convention.
#
#  FF-INST-VIS-2a — process-projection.ts imports `isRecordReadable` from
#           ../core/read-visibility.js (the ONE containment predicate) — not a
#           locally re-implemented `isXxxReadable`/`isXxxVisible` function.
#  FF-INST-VIS-2b — none of the three T-0721 process modules
#           (processes.ts, process-projection.ts, process-start.ts) imports
#           the LOWER-level lattice math (`isNarrowerOrEqual`, `isEffective`)
#           directly from grant-lattice.ts — only read-visibility.ts is
#           allowed to call those (NF-5, mirrors read-visibility.ts's own
#           doc-comment contract).
#  FF-INST-VIS-2c — none of the three modules issues a raw SQL query against
#           the grant table (`choros."grant"` / `choros.grant`) — grant
#           resolution goes ONLY through the injected resolver
#           (getGrantsForSubject), never a bespoke SELECT.
#  FF-INST-VIS-2d — server.ts's processes-routes wiring block (anchored at
#           the "T-0721 (D-064, P1 из T-0714" marker comment) calls
#           getGrantsForSubject(, loadTenantOrgAncestry(, and
#           makeResourceAncestryOracle( within the SAME nearby window — i.e.
#           it REUSES records.ts's factory, not a parallel composition.
#
# SELF-TEST (`--self-test`): plants a violation (a bespoke grant SELECT) in a
# temp file and asserts the predicate fires.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROCESSES_MODULE="${PROJECT_ROOT}/src/http/processes.ts"
PROJECTION_MODULE="${PROJECT_ROOT}/src/http/process-projection.ts"
START_MODULE="${PROJECT_ROOT}/src/http/process-start.ts"
SERVER_MODULE="${PROJECT_ROOT}/src/server.ts"
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
  TMP="$(mktemp /tmp/inst-vis-single-resolver-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # GOOD fixture: uses ONLY isRecordReadable, no lower-level math, no bespoke SQL.
  cat > "$TMP" <<'EOF'
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
async function loadRecordRowAncestry(pool, tenantId, recordId) {
  const res = await client.query(`SELECT r.id, r.registry_id, rd.application_id FROM choros.record r JOIN choros.registry_def rd ON true WHERE r.tenant_id = $1 AND r.id = $2`, [tenantId, recordId]);
  return res.rows[0] ?? null;
}
EOF
  if [[ -n "$(grep_noncomment 'isNarrowerOrEqual|isEffective' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: GOOD fixture wrongly flagged for lower-level math — check is broken"; exit 2
  fi
  if [[ -n "$(grep_noncomment 'FROM[[:space:]]+choros\."?grant"?[[:space:]]' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: GOOD fixture wrongly flagged for a bespoke grant-table SELECT — check is broken"; exit 2
  fi

  # BAD fixture A: imports the lower-level lattice math directly (second authority path).
  cat > "$TMP" <<'EOF'
import { isNarrowerOrEqual, isEffective } from "../core/grant-lattice.js";
EOF
  if [[ -z "$(grep_noncomment 'isNarrowerOrEqual|isEffective' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: lower-level lattice math import not detected — check is broken"; exit 2
  fi

  # BAD fixture B: a bespoke raw SQL grant-table query (bypasses getGrantsForSubject).
  cat > "$TMP" <<'EOF'
const res = await client.query(`SELECT * FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
EOF
  if [[ -z "$(grep_noncomment 'FROM[[:space:]]+choros\."?grant"?[[:space:]]' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: bespoke grant-table SELECT not detected — check is broken"; exit 2
  fi

  echo "SELF-TEST PASS: process-detail-single-resolver predicates detect planted violations"
  exit 0
fi

echo "[T-0721] process-detail-single-resolver: checking for a second authority path around isRecordReadable"

for f in "${PROCESSES_MODULE}" "${PROJECTION_MODULE}" "${START_MODULE}" "${SERVER_MODULE}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${f} does not exist"; exit 1
  fi
done

# ---- FF-INST-VIS-2a: process-projection.ts imports the ONE predicate ---------
before=${ERRORS}
if ! grep -qE "isRecordReadable" "${PROJECTION_MODULE}"; then
  echo "FAIL [FF-INST-VIS-2a]: process-projection.ts does not import/use isRecordReadable"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "from ['\"]\.\./core/read-visibility\.js['\"]" "${PROJECTION_MODULE}"; then
  echo "FAIL [FF-INST-VIS-2a]: process-projection.ts does not import from ../core/read-visibility.js"
  ERRORS=$((ERRORS + 1))
fi
# No LOCAL re-implementation of the predicate under a different name
# (e.g. a hand-rolled isXxxReadable/isXxxVisible that duplicates the math
# instead of calling isRecordReadable).
LOCAL_REDEF="$(grep_noncomment '^(export )?(async )?function is[A-Za-z]*(Readable|Visible)\(' "${PROJECTION_MODULE}" | grep -v 'isInstanceDetailVisible' || true)"
if [[ -n "${LOCAL_REDEF}" ]]; then
  echo "FAIL [FF-INST-VIS-2a]: a second readable/visible predicate is locally defined in process-projection.ts:"
  echo "${LOCAL_REDEF}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-2a]: process-projection.ts reuses isRecordReadable, no local re-implementation"
fi

# ---- FF-INST-VIS-2b: no direct lower-level lattice math outside read-visibility.ts ---
before=${ERRORS}
for f in "${PROCESSES_MODULE}" "${PROJECTION_MODULE}" "${START_MODULE}"; do
  hit="$(grep_noncomment 'isNarrowerOrEqual|isEffective' "${f}" || true)"
  if [[ -n "${hit}" ]]; then
    echo "FAIL [FF-INST-VIS-2b]: $(basename "${f}") imports/calls lattice math directly (second authority path):"
    echo "${hit}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-2b]: no direct isNarrowerOrEqual/isEffective use outside read-visibility.ts"
fi

# ---- FF-INST-VIS-2c: no bespoke raw SQL grant-table query --------------------
before=${ERRORS}
for f in "${PROCESSES_MODULE}" "${PROJECTION_MODULE}" "${START_MODULE}"; do
  hit="$(grep_noncomment 'FROM[[:space:]]+choros\."?grant"?[[:space:]]' "${f}" || true)"
  if [[ -n "${hit}" ]]; then
    echo "FAIL [FF-INST-VIS-2c]: $(basename "${f}") issues a raw SQL query against the grant table:"
    echo "${hit}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-2c]: no bespoke grant-table SELECT in the T-0721 process modules"
fi

# ---- FF-INST-VIS-2d: server.ts wiring REUSES records.ts's factory ------------
before=${ERRORS}
MARKER_LINE=$(grep -n 'T-0721 (D-064, P1 из T-0714' "${SERVER_MODULE}" | head -1 | cut -d: -f1 || true)
if [[ -z "${MARKER_LINE}" ]]; then
  echo "FAIL [FF-INST-VIS-2d]: server.ts has no T-0721 wiring marker comment"
  ERRORS=$((ERRORS + 1))
else
  WINDOW_FILE="$(mktemp)"
  sed -n "${MARKER_LINE},$((MARKER_LINE + 25))p" "${SERVER_MODULE}" > "${WINDOW_FILE}"
  for fn in 'getGrantsForSubject\(' 'loadTenantOrgAncestry\(' 'makeResourceAncestryOracle\('; do
    if ! grep -qE "${fn}" "${WINDOW_FILE}"; then
      echo "FAIL [FF-INST-VIS-2d]: server.ts's T-0721 wiring window does not call ${fn} (not reusing records.ts's factory)"
      ERRORS=$((ERRORS + 1))
    fi
  done
  rm -f "${WINDOW_FILE}"
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-INST-VIS-2d]: server.ts's processes-routes resolveReadVisibility reuses getGrantsForSubject + loadTenantOrgAncestry + makeResourceAncestryOracle"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: process-detail-single-resolver found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: process-detail-single-resolver (FF-INST-VIS-2) clean"
