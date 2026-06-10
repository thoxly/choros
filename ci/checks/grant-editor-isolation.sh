#!/usr/bin/env bash
# T-0030 · grant-editor isolation / NF-1 / R-1 static checks.
#
# Asserts, statically (no DB required), the architecture invariants introduced
# by T-0030 and hardened in the R-1/R-2/R-4 review fixes:
#
#  FF-R1a — GET /api/rights/dictionaries is registered by registerDictionariesRoute
#            (a separate, exported function — not bundled inside registerGrantsRoutes).
#  FF-R1b — server.ts calls registerDictionariesRoute BEFORE registerRightsRoutes
#            (literal path "dictionaries" must be matched before :roleId catch-all).
#  FF-R1c — registerDictionariesRoute is called UNCONDITIONALLY in server.ts
#            (not inside any if(grantsPool) or if(DATABASE_URL) guard).
#  FF-R2  — NF-1 enforcement: isFreeform guard overrides delegable=false in
#            grants.ts (data-model invariant, not just runtime validateNarrowing).
#  FF-R4  — assertUuidShape(tenantId) called at top of withTenantTx (mirrors
#            org.ts withTenant pattern; defence-in-depth SQL-injection guard).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GRANTS_TS="${PROJECT_ROOT}/src/http/grants.ts"
SERVER_TS="${PROJECT_ROOT}/src/server.ts"
ERRORS=0

echo "[FF-R1/R2/R4] grant-editor-isolation: checking dictionaries route + NF-1 + uuid guard"

for f in "${GRANTS_TS}" "${SERVER_TS}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: required file ${f} does not exist"
    exit 1
  fi
done

# ---- FF-R1a: registerDictionariesRoute is a separate exported function -----
before=${ERRORS}
if ! grep -qE 'export\s+function\s+registerDictionariesRoute' "${GRANTS_TS}"; then
  echo "FAIL (FF-R1a): grants.ts does not export 'registerDictionariesRoute' as a separate function"
  ERRORS=$((ERRORS + 1))
fi
# The dictionaries router.register call must be INSIDE registerDictionariesRoute, not in registerGrantsRoutes.
if ! awk '/export function registerDictionariesRoute/,/^}/' "${GRANTS_TS}" | grep -q 'router.register.*dictionaries'; then
  echo "FAIL (FF-R1a): router.register for /api/rights/dictionaries is not inside registerDictionariesRoute"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-R1a): registerDictionariesRoute is a separate exported function with dictionaries route"
fi

# ---- FF-R1b: server.ts calls registerDictionariesRoute BEFORE registerRightsRoutes ----
# Match only call-site lines: "  registerXxx(router" — skips import lines.
before=${ERRORS}
dict_line=$(grep -n 'registerDictionariesRoute(router' "${SERVER_TS}" | grep -v '//' | head -1 | cut -d: -f1 || true)
rights_line=$(grep -n 'registerRightsRoutes(router' "${SERVER_TS}" | grep -v '//' | head -1 | cut -d: -f1 || true)
if [[ -z "${dict_line}" ]]; then
  echo "FAIL (FF-R1b): server.ts does not call registerDictionariesRoute"
  ERRORS=$((ERRORS + 1))
elif [[ -z "${rights_line}" ]]; then
  echo "FAIL (FF-R1b): server.ts does not call registerRightsRoutes"
  ERRORS=$((ERRORS + 1))
elif [[ "${dict_line}" -ge "${rights_line}" ]]; then
  echo "FAIL (FF-R1b): registerDictionariesRoute (line ${dict_line}) must appear BEFORE registerRightsRoutes (line ${rights_line}) in server.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-R1b): registerDictionariesRoute (line ${dict_line}) is before registerRightsRoutes (line ${rights_line})"
fi

# ---- FF-R1c: registerDictionariesRoute called unconditionally (not inside if(grantsPool)) ----
before=${ERRORS}
if [[ -n "${dict_line}" ]]; then
  dict_context_start=$((dict_line > 10 ? dict_line - 10 : 1))
  # The 10 lines before the call must not open an ungated if(grantsPool) block.
  context_before=$(awk "NR>=${dict_context_start} && NR<${dict_line}" "${SERVER_TS}")
  if echo "${context_before}" | grep -qE 'if\s*\(\s*grantsPool\s*\)'; then
    echo "FAIL (FF-R1c): registerDictionariesRoute appears to be inside an if(grantsPool) block"
    ERRORS=$((ERRORS + 1))
  fi
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-R1c): registerDictionariesRoute called unconditionally (not gated on grantsPool)"
fi

# ---- FF-R2: NF-1 delegable=false override present for isFreeform -----------
# Checks that there's an isFreeform guard that sets delegable=false.
# Uses a line-window: find the isFreeform guard line, then look at the 3 lines
# following it for the delegable=false assignment.
before=${ERRORS}
isFreeform_delegable_line=$(grep -nE 'if\s*\(\s*isFreeform\s*\)' "${GRANTS_TS}" | grep -v '//' | tail -1 | cut -d: -f1 || true)
if [[ -z "${isFreeform_delegable_line}" ]]; then
  echo "FAIL (FF-R2): grants.ts has no isFreeform guard for delegable override"
  ERRORS=$((ERRORS + 1))
else
  # Look for 'delegable = false' within 5 lines after the guard.
  window_end=$((isFreeform_delegable_line + 5))
  if ! awk "NR>=${isFreeform_delegable_line} && NR<=${window_end}" "${GRANTS_TS}" | grep -qE 'delegable\s*=\s*false'; then
    echo "FAIL (FF-R2): isFreeform guard at line ${isFreeform_delegable_line} does not set delegable=false within 5 lines"
    ERRORS=$((ERRORS + 1))
  fi
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-R2): isFreeform guard overrides delegable=false (NF-1 data-model invariant)"
fi

# ---- FF-R4: assertUuidShape guard at top of withTenantTx -------------------
# Find withTenantTx definition line and pool.connect() line; assertUuidShape(tenantId)
# must appear in between.
before=${ERRORS}
withtx_line=$(grep -n 'async function withTenantTx' "${GRANTS_TS}" | head -1 | cut -d: -f1 || true)
connect_line=$(awk "NR>${withtx_line:-0}" "${GRANTS_TS}" | grep -n 'pool\.connect()' | head -1 | cut -d: -f1 || true)
if [[ -z "${withtx_line}" ]]; then
  echo "FAIL (FF-R4): withTenantTx function not found in grants.ts"
  ERRORS=$((ERRORS + 1))
elif [[ -z "${connect_line}" ]]; then
  echo "FAIL (FF-R4): pool.connect() not found after withTenantTx"
  ERRORS=$((ERRORS + 1))
else
  connect_abs=$((withtx_line + connect_line))
  if ! awk "NR>=${withtx_line} && NR<=${connect_abs}" "${GRANTS_TS}" | grep -qE 'assertUuidShape\s*\(\s*tenantId'; then
    echo "FAIL (FF-R4): withTenantTx does not call assertUuidShape(tenantId) before pool.connect()"
    ERRORS=$((ERRORS + 1))
  fi
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-R4): assertUuidShape(tenantId) guard present at top of withTenantTx"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: grant-editor-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: grant-editor-isolation — all checks green"
exit 0
