#!/usr/bin/env bash
# T-0206
# T-0128 · connector-isolation — static fitness for the connector/integration STUB.
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# pure-core module src/core/connector.ts. Mirrors effect-resource-isolation.sh /
# notification-isolation.sh. Distinguishes grep rc=1 (no match) from rc>=2 (error),
# and ignores comment lines so prose explaining a ban passes (lesson T-0143).
#
#  FF-CONN-1 — No parallel connector-ACL / visibility surface (one authority mechanism =
#              effect-grant T-0034). Banned tokens: _acl, connector_visibility,
#              connectorRights, connectorAcl in non-comment code.
#  FF-CONN-2 — Pure-core / no live effects: connector.ts imports no
#              pg/fs/net/http(s)/fetch/child_process (state via injected ConnectorWritePort;
#              the Postgres DAO lives in src/core/postgres/pgConnectorStore.ts).
#  FF-CONN-3 — Custody not redeclared: validateSecretHandleShape / redactHandle are
#              IMPORTED from secret-handle-validator.ts, not redeclared.
#  FF-CONN-4 — Seam without driver: NO class `implements ConnectorDriverPort` anywhere
#              under src/ (day-1 there is no driver and no real external call).
#  FF-CONN-5 — Closed-kind single source of truth: the kind set in the migration CHECK
#              and the isConnectorKind union match exactly (no string widening).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/connector.ts"
DAO="${PROJECT_ROOT}/src/core/postgres/pgConnectorStore.ts"
MIGRATION="${PROJECT_ROOT}/migrations/054_connector.sql"
SRC_DIR="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0206/T-0128] connector-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# grep wrapper: returns matches, treats rc=1 (no match) as clean, rc>=2 as a hard error.
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -nE "${pattern}" "${file}" | grep -vE ":[[:space:]]*(//|\*)")"
  rc=$?
  set -e
  # grep -v exits 1 when it filters everything out (no surviving lines) — that is clean.
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---- FF-CONN-1: no parallel connector-ACL / visibility surface -------------
PARALLEL_AUTHORITY_TOKENS=(
  "_acl"
  "connector_visibility"
  "connectorRights"
  "connectorAcl"
)
before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  matches="$(grep_noncomment "${token}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FF-CONN-1]: connector.ts references parallel-authority token '${token}' in non-comment code:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CONN-1]: no parallel-authority tokens (one mechanism = effect-grant T-0034)"
fi

# ---- FF-CONN-2: no forbidden pg/fs/net/http(s)/fetch/child_process ---------
FORBIDDEN_IMPORTS=(
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"]net['\"]"
  "from.*['\"].*node:http['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"].*node:https['\"]"
  "from.*['\"]https['\"]"
  "from.*['\"].*node:child_process['\"]"
  "require.*['\"](pg|fs|net|http|https|child_process)['\"]"
)
before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [FF-CONN-2]: connector.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
# Also ban a bare fetch( call (no comment) — no live external call from core.
fetch_calls="$(grep_noncomment "fetch\(" "${MODULE}")"
if [[ -n "${fetch_calls}" ]]; then
  echo "FAIL [FF-CONN-2]: connector.ts contains a fetch( call (no live external call allowed):"
  echo "${fetch_calls}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CONN-2]: pure-core (no pg/fs/net/http/fetch; DAO → pgConnectorStore.ts)"
fi

# ---- FF-CONN-3: custody imported, not redeclared ---------------------------
before=${ERRORS}
redeclared="$(grep -nE '^(export )?function (validateSecretHandleShape|redactHandle)' "${MODULE}" || true)"
if [[ -n "${redeclared}" ]]; then
  echo "FAIL [FF-CONN-3]: connector.ts redeclares a custody primitive (must import from secret-handle-validator):"
  echo "${redeclared}"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "from ['\"].*secret-handle-validator" "${MODULE}"; then
  echo "FAIL [FF-CONN-3]: connector.ts does not import from secret-handle-validator (custody must be reused)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CONN-3]: custody (validateSecretHandleShape/redactHandle) imported, not redeclared"
fi

# ---- FF-CONN-4: seam without driver (no implements ConnectorDriverPort) -----
before=${ERRORS}
# Search across src/ for any class implementing the driver port (the type decl itself
# uses 'interface ConnectorDriverPort', not 'implements', so it is not matched).
set +e
driver_impl="$(grep -rnE "implements[[:space:]].*ConnectorDriverPort" "${SRC_DIR}")"
rc=$?
set -e
if [[ ${rc} -ge 2 ]]; then
  echo "ERROR: grep failed (rc=${rc}) scanning for ConnectorDriverPort implementations"
  exit 2
fi
if [[ -n "${driver_impl}" ]]; then
  echo "FAIL [FF-CONN-4]: a class implements ConnectorDriverPort (day-1 driver is OUT OF SCOPE):"
  echo "${driver_impl}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CONN-4]: no ConnectorDriverPort implementation (seam only, no driver)"
fi

# ---- FF-CONN-5: closed-kind single source of truth -------------------------
# The migration CHECK and the isConnectorKind union must enumerate the same set.
before=${ERRORS}
if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL [FF-CONN-5]: ${MIGRATION} does not exist"
  ERRORS=$((ERRORS + 1))
else
  # Extract the kind tokens from the migration CHECK(kind IN (...)) clause.
  mig_kinds="$(grep -oE "kind IN \([^)]*\)" "${MIGRATION}" \
    | grep -oE "'[a-z0-9_]+'" | tr -d "'" | sort -u | tr '\n' ' ')"
  # Extract the kind tokens from the isConnectorKind union (v === "..." comparisons).
  ts_kinds="$(grep -A4 "function isConnectorKind" "${MODULE}" \
    | grep -oE '"[a-z0-9_]+"' | tr -d '"' | sort -u | tr '\n' ' ')"
  if [[ -z "${mig_kinds}" ]]; then
    echo "FAIL [FF-CONN-5]: could not extract kind set from migration CHECK"
    ERRORS=$((ERRORS + 1))
  elif [[ "${mig_kinds}" != "${ts_kinds}" ]]; then
    echo "FAIL [FF-CONN-5]: kind set mismatch — migration: [${mig_kinds}] vs isConnectorKind: [${ts_kinds}]"
    ERRORS=$((ERRORS + 1))
  fi
fi
# DAO must also keep the custody/authz boundary: a real DAO is expected to exist.
if [[ ! -f "${DAO}" ]]; then
  echo "FAIL [FF-CONN-5]: ${DAO} does not exist (DAO required for cross-tenant RLS test)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CONN-5]: closed-kind set matches (migration CHECK == isConnectorKind union)"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: connector-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: connector-isolation — all checks green (FF-CONN-1..5)"
exit 0
