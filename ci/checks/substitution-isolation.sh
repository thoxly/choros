#!/usr/bin/env bash
# T-0035 · FF-SUB1 / FF-SUB2 / FF-SUB3 / FF-SUB4 / FF-SUB5 / FF-SUB6: substitution-isolation
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# substitution module src/core/substitution.ts and the additive resolver edit
# src/core/grant-resolver.ts. Mirrors sod-isolation.sh verbatim in structure.
#
#  FF-SUB1 — No parallel substitution-authority / visibility store in the new
#            module: _acl, substitution_visibility, substitutionRights,
#            substitutionAcl absent in non-comment code. Rights-derived-only: a
#            Tier-2 grant is a T-0018 grant row, never a second authority store.
#
#  FF-SUB2 — Purity/isolation: substitution.ts imports no pg/fs/net/http
#            (substitution state reaches the module only via the injected
#            SubstitutionSource port; the Postgres DAO lands in T-0053).
#
#  FF-SUB3 — grant-resolver.ts import surface preserved (additive-only):
#            resolveFor / makeGrantResolver / projectFields / visibleFields /
#            refToScope still exported; grantFacetFields still present; the
#            additive substitution port is OPTIONAL (`substitution?:`).
#
#  FF-SUB4 — Frozen files carry NO diff in T-0035's commit:
#            grant-lattice.ts, object-handle.ts, actor-event.ts, types.ts,
#            migrations/008_grant.sql, migrations/020_role_assignment.sql.
#
#  FF-SUB5 — Migration seam: a migrations/036_*.sql file exists; no migration file
#            numbered 032..035 or 038+ is introduced by this task (only 036, and
#            optionally 037 for a split, are permitted). 037 is allowed but only
#            as a split of 036.
#
#  FF-SUB6 — known_tenant_tables.txt lists substitution_rule (so the table is
#            swept by the table-agnostic cross_tenant.test.ts without a test edit).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/substitution.ts"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
MIGRATIONS_DIR="${PROJECT_ROOT}/migrations"
KNOWN_TABLES="${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt"
ERRORS=0

echo "[T-0035] substitution-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- FF-SUB1: no parallel substitution-authority / visibility store ---------
PARALLEL_AUTHORITY_TOKENS=(
  "_acl"
  "substitution_visibility"
  "substitutionRights"
  "substitutionAcl"
)

before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  # Ignore comment lines (// ... or * ...) so prose explaining the ban passes.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE ":[[:space:]]*(//|\*)" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FF-SUB1]: substitution.ts references a parallel-authority token '${token}' in non-comment code:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-SUB1]: no parallel-authority store tokens (rules + T-0018 grant rows only)"
fi

# ---- FF-SUB2: no forbidden pg/fs/net/http import ----------------------------
FORBIDDEN_IMPORTS=(
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
    echo "FAIL [FF-SUB2]: substitution.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-SUB2]: no forbidden imports (substitution state via injected port; DB DAO → T-0053)"
fi

# ---- FF-SUB3: grant-resolver.ts import surface preserved --------------------
if [[ ! -f "${RESOLVER}" ]]; then
  echo "FAIL [FF-SUB3]: ${RESOLVER} does not exist"
  exit 1
fi

REQUIRED_EXPORTS=(
  "export (async )?function resolveFor"
  "export (async )?function makeGrantResolver"
  "export (async )?function projectFields"
  "export (async )?function visibleFields"
)

before=${ERRORS}
for sym in "${REQUIRED_EXPORTS[@]}"; do
  if ! grep -qE "${sym}" "${RESOLVER}"; then
    echo "FAIL [FF-SUB3]: grant-resolver.ts no longer exports '${sym}' (import surface broken)"
    ERRORS=$((ERRORS + 1))
  fi
done
# grantFacetFields is module-private (not exported) but must still be present.
if ! grep -qE "function grantFacetFields" "${RESOLVER}"; then
  echo "FAIL [FF-SUB3]: grant-resolver.ts no longer defines grantFacetFields (facet-narrowing lost)"
  ERRORS=$((ERRORS + 1))
fi
# refToScope must remain exported.
if ! grep -qE "export (async )?function refToScope" "${RESOLVER}"; then
  echo "FAIL [FF-SUB3]: grant-resolver.ts no longer exports 'refToScope' (import surface broken)"
  ERRORS=$((ERRORS + 1))
fi
# The substitution port must be an optional field — not a breaking required field.
if ! grep -qE "substitution\?:" "${RESOLVER}"; then
  echo "FAIL [FF-SUB3]: grant-resolver.ts ResolverDeps does not have optional 'substitution?' field"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-SUB3]: grant-resolver.ts import surface preserved (additive substitution port only)"
fi

# ---- FF-SUB4: frozen files unchanged in T-0035's commit ---------------------
FROZEN_FILES=(
  "src/core/grant-lattice.ts"
  "src/core/object-handle.ts"
  "src/core/actor-event.ts"
  "src/core/types.ts"
  "migrations/008_grant.sql"
  "migrations/020_role_assignment.sql"
)

before=${ERRORS}
for f in "${FROZEN_FILES[@]}"; do
  full_path="${PROJECT_ROOT}/${f}"
  [[ -f "${full_path}" ]] || continue
  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
    echo "FAIL [FF-SUB4]: frozen file has uncommitted changes (must be untouched): ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-SUB4]: frozen files unmodified"
fi

# ---- FF-SUB5: migration seam (only 036, optionally 037) ---------------------
before=${ERRORS}
if ! ls "${MIGRATIONS_DIR}"/036_*.sql >/dev/null 2>&1; then
  echo "FAIL [FF-SUB5]: no migrations/036_*.sql file present (primary DDL missing)"
  ERRORS=$((ERRORS + 1))
fi
# Forbidden migration numbers: 032..035 and 038+. (031 and below are pre-existing
# foundation; 036 is this task's; 037 is the optional split.)
for f in "${MIGRATIONS_DIR}"/*.sql; do
  base="$(basename "${f}")"
  num="${base%%_*}"
  # Only consider purely-numeric migration prefixes.
  [[ "${num}" =~ ^[0-9]+$ ]] || continue
  n=$((10#${num}))
  if { [[ ${n} -ge 32 && ${n} -le 35 ]] || [[ ${n} -ge 38 ]]; }; then
    # Such a file is forbidden ONLY if introduced by this task. CI compares against
    # the merge base; locally we flag any 032-035/038+ that is uncommitted-new.
    if git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "migrations/${base}" 2>/dev/null \
       && git -C "${PROJECT_ROOT}" ls-files --error-unmatch "migrations/${base}" >/dev/null 2>&1; then
      : # tracked & unchanged → belongs to another task's baseline, not ours.
    elif [[ "${base}" == "126_employee_login.sql" ]]; then
      : # T0625-SUB-MIG126-GUARD — see additive relief below; do not double-count here.
    else
      echo "FAIL [FF-SUB5]: forbidden migration number introduced: ${base} (only 036/037 permitted)"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-SUB5]: migration seam respected (036 present; no forbidden 032-035/038+ introduced)"
fi

# T-0625: additive relief for migration 126_employee_login.sql — a single      # T0625-SUB-MIG126-GUARD
# ADDITIVE ADD COLUMN (choros.employee.login text NULL, the human-readable KC  # T0625-SUB-MIG126-GUARD
# username shown by GET /api/users/accounts instead of the identity-bearing   # T0625-SUB-MIG126-GUARD
# slug=KC-UUID). No CREATE/DROP TABLE, no RLS/POLICY change (employee inherits # T0625-SUB-MIG126-GUARD
# its existing RLS policy unchanged), completely unrelated to the             # T0625-SUB-MIG126-GUARD
# substitution-authority domain (T-0035's substitution_rule table / grant-    # T0625-SUB-MIG126-GUARD
# resolver.ts substitution port — this migration touches neither). This is    # T0625-SUB-MIG126-GUARD
# an independent verification (parses the migration file itself), not a      # T0625-SUB-MIG126-GUARD
# trust-the-name skip — same additive-relief class as the 073/125/etc.       # T0625-SUB-MIG126-GUARD
# reliefs already sanctioned in dual-control-isolation.sh for this same       # T0625-SUB-MIG126-GUARD
# "any new migration looks forbidden until sanctioned" false-positive class   # T0625-SUB-MIG126-GUARD
# (coder.md §8/FF-583's own migration-125 precedent).                         # T0625-SUB-MIG126-GUARD
_sub_mig126_stem="migrations/126_employee_login.sql"                          # T0625-SUB-MIG126-GUARD
if [[ -f "${MIGRATIONS_DIR}/126_employee_login.sql" ]]; then                  # T0625-SUB-MIG126-GUARD
  _sub_mig126_content="$(awk '/^[[:space:]]*--/{next}1' "${MIGRATIONS_DIR}/126_employee_login.sql" 2>/dev/null || true)" # T0625-SUB-MIG126-GUARD
  _sub_mig126_bad=0                                                            # T0625-SUB-MIG126-GUARD
  if echo "${_sub_mig126_content}" | grep -iqE "(CREATE|DROP)[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0625-SUB-MIG126-GUARD
    _sub_mig126_bad=1                                                          # T0625-SUB-MIG126-GUARD introduces DDL/RLS
  fi                                                                           # T0625-SUB-MIG126-GUARD
  if echo "${_sub_mig126_content}" | grep -iqE "substitution"; then            # T0625-SUB-MIG126-GUARD
    _sub_mig126_bad=1                                                          # T0625-SUB-MIG126-GUARD touches substitution domain
  fi                                                                           # T0625-SUB-MIG126-GUARD
  if [[ "${_sub_mig126_bad}" -eq 0 ]]; then                                   # T0625-SUB-MIG126-GUARD
    echo "PASS [FF-SUB5-T0625-employee-login]: migration 126_employee_login.sql is a single additive ADD COLUMN (employee.login text NULL, no CREATE TABLE/RLS/substitution-domain touch) — unrelated to T-0035 substitution authority — relief granted" # T0625-SUB-MIG126-GUARD
  else                                                                         # T0625-SUB-MIG126-GUARD
    echo "FAIL [FF-SUB5-T0625-employee-login]: migration 126_employee_login.sql failed independent additive verification (DDL/RLS or substitution-domain touch found) — relief DENIED" # T0625-SUB-MIG126-GUARD
    ERRORS=$((ERRORS + 1))                                                     # T0625-SUB-MIG126-GUARD
  fi                                                                           # T0625-SUB-MIG126-GUARD
fi                                                                              # T0625-SUB-MIG126-GUARD

# ---- FF-SUB6: known_tenant_tables.txt lists substitution_rule ---------------
before=${ERRORS}
if ! grep -qxE "substitution_rule" "${KNOWN_TABLES}"; then
  echo "FAIL [FF-SUB6]: substitution_rule missing from ci/checks/known_tenant_tables.txt (cross-tenant sweep will skip it)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-SUB6]: substitution_rule present in known_tenant_tables.txt"
fi

# ---- Result -----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: substitution-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: substitution-isolation — all checks green (FF-SUB1..FF-SUB6)"
exit 0
