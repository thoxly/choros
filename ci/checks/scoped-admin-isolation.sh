#!/usr/bin/env bash
# T-0029 · scoped-admin isolation / no-second-subsystem (FF-8/9/10/11/16/17).
#
# Modeled on grant-resolver-isolation.sh. Asserts, statically (today's npm run
# fitness, no DB), the architecture invariants of the scoped-admin task:
#
#  FF-8  (AC-8):  no second authority subsystem — the checker introduces no
#                 admin-specific table/flag/role-kind/ACL store; admin authority
#                 is expressed ONLY as grant rows on mgmt_object:*.
#  FF-9  (AC-9):  no new scope algebra — scoped-admin.ts IMPORTS validateNarrowing
#                 / isNarrowerOrEqual from grant-lattice.ts and defines no new
#                 ScopeElement kind and no parallel containment function.
#  FF-10 (AC-10): pure / IO-free — the checker module imports no pg/fs/net/http.
#  FF-11 (AC-11): grant-resolver.ts AND grant-lattice.ts are byte-for-byte
#                 unedited by this task (read-path / lattice core untouched).
#  FF-16 (AC-16): vacuous tenant-table coherence — migration 026 issues NO
#                 CREATE TABLE (mgmt-grants ride the registered `grant` table) and
#                 known_tenant_tables.txt is unchanged.
#  FF-17 (AC-17): migration numbering ≥ 026, additive, T-0013 invariants on DDL
#                 (vacuous: no DDL → no RLS to assert; the no-DDL check enforces it).
#  AC-12 static:  the 026 seed declares exactly 17 mgmt-grants + 1 genesis
#                 assignment + 1 genesis employee (the static count half).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/scoped-admin.ts"
MIGRATION="${PROJECT_ROOT}/migrations/026_genesis_owner_seed.sql"
ERRORS=0

echo "[FF-8/9/10/11/16/17] scoped-admin-isolation: checking module + migration boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi
if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL: ${MIGRATION} does not exist"
  exit 1
fi

# ---- FF-10: no forbidden IO imports in the pure checker --------------------
FORBIDDEN_IMPORTS=(
  "jobStore"
  "from.*['\"].*node:http['\"]"
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"]net['\"]"
  "require.*['\"](pg|fs|net|http)['\"]"
)
before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL (FF-10): scoped-admin.ts contains a forbidden IO import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-10): pure checker — no DB/net/fs/http imports"
fi

# ---- FF-9: imports the lattice primitives (no parallel algebra) ------------
before=${ERRORS}
for sym in "validateNarrowing" "isNarrowerOrEqual"; do
  if ! grep -Eq "${sym}" "${MODULE}"; then
    echo "FAIL (FF-9): scoped-admin.ts does not import/use '${sym}' from grant-lattice.ts"
    ERRORS=$((ERRORS + 1))
  fi
done
# Must import from grant-lattice (the single source of subset math).
if ! grep -Eq "from\s+['\"]\./grant-lattice\.js['\"]" "${MODULE}"; then
  echo "FAIL (FF-9): scoped-admin.ts does not import from ./grant-lattice.js"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-9): reuses lattice primitives (no new scope algebra)"
fi

# ---- FF-9b: no parallel containment function / new ScopeElement kind -------
# A divergent containment fn or a new lattice element would split the algebra.
PARALLEL_ALGEBRA_TOKENS=(
  "function isNarrower"        # any locally-defined narrowing fn
  "function validateNarrow"    # any local re-impl of the gate
  "function atomIsNarrower"
  "kind: \"hierarchy\""        # a smell for a new scope-kind literal
)
before=${ERRORS}
for token in "${PARALLEL_ALGEBRA_TOKENS[@]}"; do
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*(//|\*)" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL (FF-9b): scoped-admin.ts defines a parallel-algebra token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-9b): no parallel containment fn / new ScopeElement kind"
fi

# ---- FF-8: no second authority subsystem -----------------------------------
# Admin authority = grant rows on mgmt_object:* ONLY. No admin-specific store.
PARALLEL_AUTHORITY_TOKENS=(
  "admin_table"
  "adminRole"
  "isAdminFlag"
  "_acl"
  "adminAcl"
  "admin_flag"
)
before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*(//|\*)" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL (FF-8): scoped-admin.ts references a parallel-authority token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-8): no parallel-authority store (mgmt_object grant rows only)"
fi

# ---- FF-11: frozen files unchanged (additive-only) -------------------------
FROZEN_FILES=(
  "src/core/grant-resolver.ts"
  "src/core/grant-lattice.ts"
  "src/core/object-handle.ts"
)
before=${ERRORS}
for f in "${FROZEN_FILES[@]}"; do
  full_path="${PROJECT_ROOT}/${f}"
  [[ -f "${full_path}" ]] || continue
  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
    echo "FAIL (FF-11): frozen file has uncommitted changes (must be additive): ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-11): grant-resolver.ts / grant-lattice.ts / object-handle.ts unmodified"
fi

# ---- FF-16 + FF-17: migration is INSERT-only, additive, numbered ≥ 026 -----
before=${ERRORS}
# No DDL of any kind (no new table, no ALTER — mgmt-grants ride existing tables).
if grep -iqE '^\s*(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+POLICY)' "${MIGRATION}"; then
  echo "FAIL (FF-16/17): 026 migration contains DDL (must be INSERT-only, no new table):"
  grep -inE '^\s*(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+POLICY)' "${MIGRATION}"
  ERRORS=$((ERRORS + 1))
fi
# known_tenant_tables.txt unchanged (no new tenant table to register).
if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "ci/checks/known_tenant_tables.txt" 2>/dev/null; then
  echo "FAIL (FF-16): known_tenant_tables.txt changed — but 026 adds no new tenant table"
  ERRORS=$((ERRORS + 1))
fi
# Every ON CONFLICT clause is DO NOTHING (idempotent seed).
if grep -iqE 'ON\s+CONFLICT' "${MIGRATION}" && \
   [[ "$(grep -icE 'ON\s+CONFLICT\s+DO\s+NOTHING' "${MIGRATION}")" != "$(grep -icE 'ON\s+CONFLICT' "${MIGRATION}")" ]]; then
  echo "FAIL (FF-17): not every ON CONFLICT in 026 is DO NOTHING (idempotency)"
  ERRORS=$((ERRORS + 1))
fi
# Numbering ≥ 026 (the filename itself is 026_*; assert no edit to prior migration via name).
case "$(basename "${MIGRATION}")" in
  0[0-2][0-5]_*) echo "FAIL (FF-17): migration numbered < 026"; ERRORS=$((ERRORS + 1)) ;;
esac
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-16/17): INSERT-only, no new table, idempotent, numbered ≥ 026"
fi

# ---- AC-12 static: declared seed counts ------------------------------------
before=${ERRORS}
# Strip comment lines (-- ...) so prose mentioning these literals doesn't count.
SQL_ONLY="$(grep -vE '^\s*--' "${MIGRATION}")"
# 17 mgmt-grants: count rows whose resource_type is a mgmt_object kind in the
# grant INSERT (each VALUES tuple carries exactly one 'mgmt_object:' literal).
mgmt_grant_rows=$(echo "${SQL_ONLY}" | grep -oE "'mgmt_object:(role|agent|process|grant)'" | wc -l | tr -d ' ')
if [[ "${mgmt_grant_rows}" != "17" ]]; then
  echo "FAIL (AC-12): expected 17 mgmt-grant rows in 026, found ${mgmt_grant_rows}"
  ERRORS=$((ERRORS + 1))
fi
# Exactly one genesis assignment (source 'genesis').
genesis_ra=$(echo "${SQL_ONLY}" | grep -coE "'genesis'" || true)
if [[ "${genesis_ra}" != "1" ]]; then
  echo "FAIL (AC-12/13): expected exactly 1 'genesis' source assignment in 026, found ${genesis_ra}"
  ERRORS=$((ERRORS + 1))
fi
# Exactly one genesis employee (slug 'e-owner').
owner_emp=$(echo "${SQL_ONLY}" | grep -coE "'e-owner'" || true)
if [[ "${owner_emp}" != "1" ]]; then
  echo "FAIL (AC-12): expected exactly 1 'e-owner' employee in 026, found ${owner_emp}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (AC-12): 026 declares 17 mgmt-grants + 1 genesis assignment + 1 genesis employee"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: scoped-admin-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: scoped-admin-isolation — all checks green"
exit 0
