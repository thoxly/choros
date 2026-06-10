#!/usr/bin/env bash
# T-0032 · FF-SOD1 / FF-SOD2 / FF-SOD3 / FF-SOD4: sod-isolation
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# SoD module src/core/sod.ts (+ the optional store src/core/actor-event-store.ts)
# and the additive resolver edit src/core/grant-resolver.ts. Mirrors
# effect-resource-isolation.sh verbatim in structure.
#
#  SOD-ISO1 (FF-SOD2) — No parallel SoD-authority / visibility store in the new
#            module: _acl, sod_visibility, sodRights, sodAcl absent in non-comment
#            code. Rights-derived-only: decisions derive from sod_constraint
#            declarations + T-0018 grant rows + the actor_event ledger — no second
#            authority subsystem.
#
#  SOD-ISO2 (FF-SOD1) — Purity/isolation: sod.ts (and the store module) import no
#            pg/fs/net/http (SoD state reaches the module only via the injected
#            SodSource / ActorEventReader / ActorEventWriter ports; the Postgres
#            DAO lands in T-0053).
#
#  SOD-ISO3 (FF-SOD3) — grant-resolver.ts import surface preserved (FE-W23-0008):
#            resolveFor / makeGrantResolver / projectFields / visibleFields /
#            refToScope still exported; grantFacetFields still present; the
#            additive sod port is OPTIONAL (`sod?:`).
#
#  SOD-ISO4 (FF-SOD4) — Frozen files carry NO diff in T-0032's commit:
#            grant-lattice.ts, object-handle.ts, actor-event.ts, migrations/008_grant.sql.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/sod.ts"
STORE="${PROJECT_ROOT}/src/core/actor-event-store.ts"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
ERRORS=0

echo "[T-0032] sod-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- SOD-ISO1: no parallel SoD-authority / visibility store -----------------
# These tokens indicate a second authority subsystem (banned by NF-5 / AC-18).
PARALLEL_AUTHORITY_TOKENS=(
  "_acl"
  "sod_visibility"
  "sodRights"
  "sodAcl"
)

# Scan both the decision module and the store (if split).
SCAN_FILES=("${MODULE}")
[[ -f "${STORE}" ]] && SCAN_FILES+=("${STORE}")

before=${ERRORS}
for f in "${SCAN_FILES[@]}"; do
  for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
    # Ignore comment lines (// ... or * ...) so prose explaining the ban passes.
    matches=$(grep -nE "${token}" "${f}" | grep -vE ":[[:space:]]*(//|\*)" || true)
    if [[ -n "${matches}" ]]; then
      echo "FAIL [SOD-ISO1]: $(basename "${f}") references a parallel-authority token '${token}' in non-comment code:"
      echo "${matches}"
      ERRORS=$((ERRORS + 1))
    fi
  done
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [SOD-ISO1]: no parallel-authority store tokens in non-comment code (declarations + grant rows + ledger only)"
fi

# ---- SOD-ISO2: no forbidden pg/fs/net/http import ---------------------------
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
for f in "${SCAN_FILES[@]}"; do
  for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
    if grep -Eq "${pattern}" "${f}"; then
      echo "FAIL [SOD-ISO2]: $(basename "${f}") contains a forbidden import matching: ${pattern}"
      ERRORS=$((ERRORS + 1))
    fi
  done
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [SOD-ISO2]: no forbidden imports (SoD state via injected ports; DB DAO → T-0053)"
fi

# ---- SOD-ISO3: grant-resolver.ts import surface preserved (FE-W23-0008) ------
if [[ ! -f "${RESOLVER}" ]]; then
  echo "FAIL [SOD-ISO3]: ${RESOLVER} does not exist"
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
    echo "FAIL [SOD-ISO3]: grant-resolver.ts no longer exports '${sym}' (import surface broken)"
    ERRORS=$((ERRORS + 1))
  fi
done
# grantFacetFields is module-private (not exported) but must still be present.
if ! grep -qE "function grantFacetFields" "${RESOLVER}"; then
  echo "FAIL [SOD-ISO3]: grant-resolver.ts no longer defines grantFacetFields (facet-narrowing lost)"
  ERRORS=$((ERRORS + 1))
fi
# refToScope must remain exported.
if ! grep -qE "export (async )?function refToScope" "${RESOLVER}"; then
  echo "FAIL [SOD-ISO3]: grant-resolver.ts no longer exports 'refToScope' (import surface broken)"
  ERRORS=$((ERRORS + 1))
fi
# The sod port must be an optional field — not a breaking required field.
if ! grep -qE "sod\?:" "${RESOLVER}"; then
  echo "FAIL [SOD-ISO3]: grant-resolver.ts ResolverDeps does not have optional 'sod?' field"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [SOD-ISO3]: grant-resolver.ts import surface preserved (additive sod port only)"
fi

# ---- SOD-ISO4: frozen files unchanged in T-0032's commit --------------------
FROZEN_FILES=(
  "src/core/grant-lattice.ts"
  "src/core/object-handle.ts"
  "src/core/actor-event.ts"
  "migrations/008_grant.sql"
)

before=${ERRORS}
for f in "${FROZEN_FILES[@]}"; do
  # Uncommitted working-tree changes to a frozen file are a violation. (In CI the
  # diff is against the merge base; locally this catches a stray edit before commit.)
  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
    echo "FAIL [SOD-ISO4]: frozen file has uncommitted changes (must be untouched): ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [SOD-ISO4]: frozen files (grant-lattice.ts, object-handle.ts, actor-event.ts, 008_grant.sql) unmodified"
fi

# ---- Result -----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: sod-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: sod-isolation — all checks green (FF-SOD1/SOD2/SOD3/SOD4)"
exit 0
