#!/usr/bin/env bash
# T-0033 · FF-DC8 / FF-DC9 / FF-DC10 / FF-DC17: data-classification-isolation
#
# Five static assertions (grep / boundary analysis — no runtime, no DB) over the
# new value-aware-masking module src/core/data-classification.ts and the additive
# resolver edit src/core/grant-resolver.ts:
#
#  DC8  — No parallel field-ACL / field-visibility store in the new module: no
#         _acl / field_visibility / record_rights / fieldVisibility token. The
#         masking decision derives ONLY from T-0018 grant rows (clearance) +
#         data_classification (rights-derived-only, FR-8/AC-8).
#
#  DC9  — Purity/isolation: data-classification.ts imports no pg/fs/net/http
#         (classification reaches the module only via the injected
#         ClassificationSource port; the Postgres DAO lands in T-0053). Mirror of
#         grant-resolver-isolation.sh Check 1.
#
#  DC10 — Guarded reclassification (structural): no direct-write accessor to the
#         class column (mutate*/write*/persist*Classification) appears outside the
#         gateway path. Reclassification is a transition/approve op routed through
#         resolveFor + evaluateReclassification — there is NO raw-write edge to
#         data_classification.class (analogue of mutation-gateway-isolation.sh
#         G1/G6).
#
#  DC17 — grant-resolver.ts import surface preserved (FE-W23-0008): the public
#         exports resolveFor / makeGrantResolver / projectFields / visibleFields /
#         grantFacetFields are still present; the masking fold is additive-only.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/data-classification.ts"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
SRC="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0033] data-classification-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- DC8: no parallel field-ACL / field-visibility store ----------------
PARALLEL_AUTHORITY_TOKENS=(
  "field_visibility"
  "record_rights"
  "_acl"
  "recordAcl"
  "fieldVisibility"
)

before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  # Ignore comment lines (// ...) so prose explaining the ban passes.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*//" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [DC8]: data-classification.ts references a parallel-authority token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DC8]: no parallel-authority store tokens (grant-rows + data_classification only)"
fi

# ---- DC9: no forbidden pg/fs/net/http/crypto import + no process.env -----
# T-0118 (FF-T118-1 / AC-7): the keyed `hash` digest is HMAC-SHA256, but the
# crypto lives in the IMPURE port src/core/keyed-digest.ts — never in this pure
# core. The bound digest *function* is threaded in via MaskContext. So the
# import ban is EXTENDED with node:crypto/crypto, and a process.env read ban is
# added: the secret is read ONLY at the composition root (src/main.ts), never
# here. Green ⇒ core purity preserved (C-4).
FORBIDDEN_IMPORTS=(
  "from.*['\"].*node:http['\"]"
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"].*node:crypto['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"]net['\"]"
  "from.*['\"]crypto['\"]"
  "require.*['\"](pg|fs|net|http|crypto|node:crypto)['\"]"
)

before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [DC9]: data-classification.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
# process.env must never be read in the pure core (the secret boundary is main.ts).
# Ignore comment lines (// ...) so prose naming process.env in the ban passes.
ENV_MATCHES=$(grep -nE "process\.env" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*(//|\*)" || true)
if [[ -n "${ENV_MATCHES}" ]]; then
  echo "FAIL [DC9]: data-classification.ts reads process.env (secret boundary is src/main.ts, not the pure core):"
  echo "${ENV_MATCHES}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DC9]: no forbidden imports (no pg/fs/net/http/crypto; no process.env; keyed digest via injected port)"
fi

# ---- DC10: no direct-write accessor to data_classification.class --------
# A mutate*/write*/persist*Classification accessor outside the gateway path
# would be a raw-write edge bypassing the transition/approve op-check.
SCAN_FILES=$(find "${SRC}" -name "*.ts" ! -path "*/node_modules/*" 2>/dev/null)
FORBIDDEN_WRITE_PATTERNS=(
  "mutateClassification"
  "writeClassification"
  "persistClassification"
  "setClassificationClass"
  "updateClassificationClass"
)

before=${ERRORS}
for pattern in "${FORBIDDEN_WRITE_PATTERNS[@]}"; do
  MATCHES=$(echo "${SCAN_FILES}" | xargs grep -l "${pattern}" 2>/dev/null || true)
  if [[ -n "${MATCHES}" ]]; then
    echo "FAIL [DC10]: direct class-write accessor '${pattern}' found (must route through resolveFor):"
    echo "${MATCHES}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DC10]: no direct-write accessor to data_classification.class (reclass routes through gateway)"
fi

# ---- DC17: grant-resolver.ts import surface preserved (FE-W23-0008) -----
if [[ ! -f "${RESOLVER}" ]]; then
  echo "FAIL [DC17]: ${RESOLVER} does not exist"
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
    echo "FAIL [DC17]: grant-resolver.ts no longer exports '${sym}' (import surface broken)"
    ERRORS=$((ERRORS + 1))
  fi
done
# grantFacetFields is module-private (not exported) but must still be present.
if ! grep -qE "function grantFacetFields" "${RESOLVER}"; then
  echo "FAIL [DC17]: grant-resolver.ts no longer defines grantFacetFields (facet-narrowing lost)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DC17]: grant-resolver.ts import surface preserved (additive-only masking fold)"
fi

# ---- Result -------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: data-classification-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: data-classification-isolation — all checks green (FF-DC8/9/10/17)"
exit 0
