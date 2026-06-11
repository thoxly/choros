#!/usr/bin/env bash
# T-0041 · FF-EP1 .. FF-EP7: egress-policy-isolation
#
# Static fitness assertions (grep / file-presence — no runtime, no DB) for the
# schema-only, schema-dormant egress_policy axis (E4.8). The runtime cross-tenant
# isolation ACs (AC-2..AC-8, AC-10, AC-15) are proven by the DB test suite
# (ci/checks/db/cross_tenant.test.ts, fitness:db); this script owns the static
# ones (AC-1, AC-9, AC-11, AC-12, AC-13, AC-14, AC-16, NF-2, NF-7).
#
#  FF-EP1 (AC-1) — migrations/038_egress_policy.sql exists and creates
#         choros.egress_policy with PK (tenant_id, id), the (tenant_id, class,
#         allowed_endpoint) UNIQUE constraint, the class CHECK over the closed
#         DataClass set, and ENABLE+FORCE RLS.
#
#  FF-EP2 (AC-9) — ci/checks/known_tenant_tables.txt lists egress_policy
#         (so the cross-tenant CI suite iterates it without a test-source edit).
#
#  FF-EP3 (AC-11 / NF-7) — schema dormancy: no Choros runtime code reads
#         egress_policy on day-1. grep over src/ for 'egress_policy', excluding
#         __tests__/, returns ZERO matches (the only src/ reference allowed is the
#         compile-time type-check fixture under src/__tests__/).
#
#  FF-EP4 (AC-12 / NF-5) — migration seam: T-0041 adds ONLY files numbered 038
#         (039 reserve, unused); no migrations/03[2-7]_*.sql or 04*+ file exists.
#
#  FF-EP5 (AC-14 / FR-4) — deny-by-default: migration 038 seeds NO catch-all
#         "allow all" row (no INSERT with class/endpoint wildcards). The dormant
#         table starts empty for every tenant.
#
#  FF-EP6 (NF-2) — no parallel egress-policy store: no hardcoded egress allowlist
#         (egressPolicy / egress_allow / allowedEndpoint list) in src/ outside the
#         migration and tests. The DB table is the single source of truth.
#
#  FF-EP7 (AC-16) — the class↔DataClass type contract fixture exists under
#         src/__tests__/ and imports DataClass from data-classification.ts (the
#         compile-time assertion tsc --noEmit enforces).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIGRATION="${PROJECT_ROOT}/migrations/038_egress_policy.sql"
KNOWN_TABLES="${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt"
TYPECHECK="${PROJECT_ROOT}/src/__tests__/egress-policy.type-check.ts"
SRC="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0041] egress-policy-isolation: checking egress_policy axis"

# ---- FF-EP1: migration exists and has the required DDL --------------------
if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL [FF-EP1]: ${MIGRATION} does not exist"
  exit 1
fi
before=${ERRORS}
grep -qE "CREATE TABLE( IF NOT EXISTS)? +choros\.egress_policy" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: no CREATE TABLE choros.egress_policy"; ERRORS=$((ERRORS + 1)); }
grep -qE "PRIMARY KEY +\(tenant_id, *id\)" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: no PK (tenant_id, id)"; ERRORS=$((ERRORS + 1)); }
grep -qE "UNIQUE +\(tenant_id, *class, *allowed_endpoint\)" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: no UNIQUE (tenant_id, class, allowed_endpoint)"; ERRORS=$((ERRORS + 1)); }
grep -qE "class IN \('public', *'internal', *'confidential', *'restricted'\)" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: class CHECK does not enumerate the closed DataClass set"; ERRORS=$((ERRORS + 1)); }
grep -qE "ENABLE ROW LEVEL SECURITY" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: no ENABLE ROW LEVEL SECURITY"; ERRORS=$((ERRORS + 1)); }
grep -qE "FORCE ROW LEVEL SECURITY" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: no FORCE ROW LEVEL SECURITY"; ERRORS=$((ERRORS + 1)); }
grep -qE "GRANT SELECT, INSERT, UPDATE, DELETE ON choros\.egress_policy TO choros_app" "${MIGRATION}" \
  || { echo "FAIL [FF-EP1]: no choros_app DML grant"; ERRORS=$((ERRORS + 1)); }
[[ ${ERRORS} -eq ${before} ]] && echo "PASS [FF-EP1]: migration 038 has the required egress_policy DDL"

# ---- FF-EP2: known_tenant_tables.txt lists egress_policy ------------------
before=${ERRORS}
if grep -qxE "egress_policy" "${KNOWN_TABLES}"; then
  echo "PASS [FF-EP2]: egress_policy listed in known_tenant_tables.txt"
else
  echo "FAIL [FF-EP2]: egress_policy missing from known_tenant_tables.txt"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-EP3: schema dormancy — no runtime read of egress_policy -----------
# grep src/ for 'egress_policy' excluding the compile-time fixture under
# __tests__/ AND comment lines (//, *, /* — JSDoc seam prose naming the future
# table is not a read; AC-11 bans an import/query, not a mention).
before=${ERRORS}
DORMANCY_HITS=$(grep -rn "egress_policy" "${SRC}" \
  --include="*.ts" 2>/dev/null \
  | grep -vE "/__tests__/" \
  | grep -vE ":[[:space:]]*([0-9]+:)?[[:space:]]*(//|\*|/\*)" || true)
if [[ -n "${DORMANCY_HITS}" ]]; then
  echo "FAIL [FF-EP3]: egress_policy referenced by Choros runtime code (must be dormant):"
  echo "${DORMANCY_HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-EP3]: egress_policy is schema-dormant (no src/ runtime read)"
fi

# ---- FF-EP4: migration seam — only 038 (039 reserve), none 032-037/040+ ---
before=${ERRORS}
STRAY=$(ls "${PROJECT_ROOT}/migrations" 2>/dev/null \
  | grep -E "^(03[2-7]|0[4-9][0-9]|[1-9][0-9]{2})_.*\.sql$" || true)
if [[ -n "${STRAY}" ]]; then
  echo "FAIL [FF-EP4]: migration outside the 038/039 seam present:"
  echo "${STRAY}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-EP4]: migration seam clean (only 038/039 may be added by T-0041)"
fi

# ---- FF-EP5: deny-by-default — no catch-all seed row in migration 038 -----
before=${ERRORS}
if grep -qiE "INSERT +INTO +choros\.egress_policy" "${MIGRATION}"; then
  # A seed row is allowed only if it is NOT a catch-all (no wildcard class/endpoint).
  if grep -iE "INSERT +INTO +choros\.egress_policy" "${MIGRATION}" | grep -qiE "'\*'|allow.?all|%|ANY"; then
    echo "FAIL [FF-EP5]: migration 038 seeds a catch-all 'allow all' egress row"
    ERRORS=$((ERRORS + 1))
  fi
fi
[[ ${ERRORS} -eq ${before} ]] && echo "PASS [FF-EP5]: no catch-all 'allow all' seed (deny-by-default holds)"

# ---- FF-EP6: no parallel egress-policy store in src/ ----------------------
before=${ERRORS}
PARALLEL_TOKENS=(
  "egressPolicy"
  "egress_allow"
  "allowedEndpoints"
  "EGRESS_ALLOWLIST"
)
for token in "${PARALLEL_TOKENS[@]}"; do
  HITS=$(grep -rn "${token}" "${SRC}" --include="*.ts" 2>/dev/null \
    | grep -vE "/__tests__/" \
    | grep -vE "^\s*[0-9]*:?\s*(//|\*)" || true)
  if [[ -n "${HITS}" ]]; then
    echo "FAIL [FF-EP6]: parallel egress-policy store token '${token}' in src/:"
    echo "${HITS}"
    ERRORS=$((ERRORS + 1))
  fi
done
[[ ${ERRORS} -eq ${before} ]] && echo "PASS [FF-EP6]: no parallel egress-policy store (DB table is sole source of truth)"

# ---- FF-EP7: class↔DataClass type contract fixture exists -----------------
before=${ERRORS}
if [[ ! -f "${TYPECHECK}" ]]; then
  echo "FAIL [FF-EP7]: ${TYPECHECK} (class↔DataClass type contract) does not exist"
  ERRORS=$((ERRORS + 1))
elif ! grep -qE "import +type +\{ *DataClass *\} +from +['\"]\.\./core/data-classification" "${TYPECHECK}"; then
  echo "FAIL [FF-EP7]: type-check fixture does not import DataClass from data-classification"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-EP7]: class↔DataClass type contract fixture present (tsc --noEmit enforces)"
fi

# ---- Result ---------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: egress-policy-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: egress-policy-isolation — all checks green (FF-EP1..FF-EP7)"
exit 0
