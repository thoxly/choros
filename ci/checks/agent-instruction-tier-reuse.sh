#!/usr/bin/env bash
# FF-COMP-3 (T-0123) — versioning REUSES T-0087 verbatim (NF-1).
#
#   * 057 tier CHECK contains EXACTLY 'draft'/'published' (the 049 contract)
#   * 057 attaches the trigger: EXECUTE FUNCTION choros.tier_published_locked()
#   * cross-check: that function is DEFINED in migrations/049_tier.sql
#   * NO authoring_draft/authoring_published literal in any T-0123 artifact
#     (the stale 044 PDP-seam tiers must not reappear)
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/057_agent_instruction.sql"
MIG049="${ROOT}/migrations/049_tier.sql"
ERRORS=0

# Artifacts that belong to T-0123 (must not carry stale tier literals).
T0123_ARTIFACTS=(
  "${MIG}"
  "${ROOT}/src/core/agent-instruction.ts"
  "${ROOT}/src/db/agent-instruction-store.ts"
)

if [[ "${1:-}" == "--self-test" ]]; then
  if printf "tier IN ('draft','published')\n" | grep -qE "tier IN \('draft', ?'published'\)"; then
    echo "PASS self-test: tier-CHECK regex matches the 049 contract literal"
    exit 0
  fi
  echo "FAIL self-test: tier-CHECK regex did not match a valid contract literal"
  exit 1
fi

echo "[FF-COMP-3] agent-instruction-tier-reuse: versioning = T-0087 as-is"

if [[ ! -f "${MIG}" ]]; then
  echo "FAIL FF-COMP-3: ${MIG} does not exist"
  exit 1
fi

# 1. tier CHECK exactly draft/published (049 contract).
if grep -qE "tier IN \('draft', ?'published'\)" "${MIG}"; then
  echo "PASS FF-COMP-3: tier CHECK IN ('draft','published') present"
else
  echo "FAIL FF-COMP-3: tier CHECK IN ('draft','published') not found in 057"
  ERRORS=$((ERRORS + 1))
fi

# 2. trigger reuses the 049 function.
if grep -qE "EXECUTE FUNCTION choros\.tier_published_locked\(\)" "${MIG}"; then
  echo "PASS FF-COMP-3: 057 attaches EXECUTE FUNCTION choros.tier_published_locked()"
else
  echo "FAIL FF-COMP-3: 057 does not attach the tier_published_locked trigger"
  ERRORS=$((ERRORS + 1))
fi

# 3. cross-check: the function is DEFINED in 049 (not redefined by T-0123).
if [[ -f "${MIG049}" ]] && grep -qiE "CREATE (OR REPLACE )?FUNCTION choros\.tier_published_locked" "${MIG049}"; then
  echo "PASS FF-COMP-3: choros.tier_published_locked() is defined in 049_tier.sql"
else
  echo "FAIL FF-COMP-3: choros.tier_published_locked() not found defined in 049_tier.sql"
  ERRORS=$((ERRORS + 1))
fi
# 057 must NOT redefine the function (reuse, not a parallel mechanism).
if grep -qiE "CREATE (OR REPLACE )?FUNCTION choros\.tier_published_locked" "${MIG}"; then
  echo "FAIL FF-COMP-3: 057 redefines tier_published_locked (must reuse 049's, not redeclare)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-COMP-3: 057 does not redefine the trigger function"
fi

# 4. no stale 044 tier literals in any T-0123 artifact.
for f in "${T0123_ARTIFACTS[@]}"; do
  [[ -f "${f}" ]] || continue
  if grep -qE "authoring_draft|authoring_published" "${f}"; then
    echo "FAIL FF-COMP-3: stale tier literal authoring_draft/authoring_published in ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS FF-COMP-3: no stale authoring_* tier literals in T-0123 artifacts"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-tier-reuse found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-tier-reuse — all checks green"
exit 0
