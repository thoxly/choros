#!/usr/bin/env bash
# T-0034 · FF-ER9 / FF-ER12 / FF-ER13: effect-resource-isolation
#
# Three static assertions (grep / boundary analysis — no runtime, no DB) over
# the new external-effect-resources module src/core/effect-resource.ts and
# the additive resolver edit src/core/grant-resolver.ts:
#
#  ER-ISO1 — No parallel effect-ACL / visibility store in the new module:
#            _acl, effect_visibility, effectRights, effectAcl absent (FF-ER9 §1).
#            Rights-derived-only: access decisions derive from T-0018 grant rows
#            only; no second authority subsystem.
#
#  ER-ISO2 — Purity/isolation: effect-resource.ts imports no pg/fs/net/http
#            (effect-resource state reaches the module only via the injected
#            EffectSource port; the Postgres DAO lands in T-0053). Mirror of
#            grant-resolver-isolation.sh Check 1 and data-classification-isolation.sh
#            DC9 (FF-ER9 §2).
#
#  ER-ISO3 — grant-resolver.ts import surface preserved (FE-W23-0008, FF-ER12):
#            the public exports resolveFor / makeGrantResolver / projectFields /
#            visibleFields / grantFacetFields are still present; the additive
#            effects port is optional. No existing field on ResolverDeps is removed.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/effect-resource.ts"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
ERRORS=0

echo "[T-0034] effect-resource-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- ER-ISO1: no parallel effect-ACL / visibility store ----------------
# These tokens indicate a second authority subsystem (banned by FR-1/FR-8/AC-12).
PARALLEL_AUTHORITY_TOKENS=(
  "_acl"
  "effect_visibility"
  "effectRights"
  "effectAcl"
)

before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  # Ignore comment lines (// ... or * ...) so prose explaining the ban passes.
  # grep -n output format: "<lineno>:<content>" — strip lines that are comments.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE ":[[:space:]]*(//|\*)" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [ER-ISO1]: effect-resource.ts references a parallel-authority token '${token}' in non-comment code:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [ER-ISO1]: no parallel-authority store tokens in non-comment code (grant rows only)"
fi

# ---- ER-ISO2: no forbidden pg/fs/net/http import -----------------------
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
    echo "FAIL [ER-ISO2]: effect-resource.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [ER-ISO2]: no forbidden imports (effect state via injected EffectSource port; DB DAO → T-0053)"
fi

# ---- ER-ISO3: grant-resolver.ts import surface preserved (FE-W23-0008) -----
if [[ ! -f "${RESOLVER}" ]]; then
  echo "FAIL [ER-ISO3]: ${RESOLVER} does not exist"
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
    echo "FAIL [ER-ISO3]: grant-resolver.ts no longer exports '${sym}' (import surface broken)"
    ERRORS=$((ERRORS + 1))
  fi
done
# grantFacetFields is module-private (not exported) but must still be present.
if ! grep -qE "function grantFacetFields" "${RESOLVER}"; then
  echo "FAIL [ER-ISO3]: grant-resolver.ts no longer defines grantFacetFields (facet-narrowing lost)"
  ERRORS=$((ERRORS + 1))
fi
# refToScope must remain exported (AC-14).
if ! grep -qE "export (async )?function refToScope" "${RESOLVER}"; then
  echo "FAIL [ER-ISO3]: grant-resolver.ts no longer exports 'refToScope' (import surface broken)"
  ERRORS=$((ERRORS + 1))
fi
# The effects port must be an optional field — not a breaking required field.
if ! grep -qE "effects\?:" "${RESOLVER}"; then
  echo "FAIL [ER-ISO3]: grant-resolver.ts ResolverDeps does not have optional 'effects?' field"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [ER-ISO3]: grant-resolver.ts import surface preserved (additive effects port only)"
fi

# ---- Result -------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: effect-resource-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: effect-resource-isolation — all checks green (FF-ER9/ER-ISO1/ER-ISO2/ER-ISO3)"
exit 0
