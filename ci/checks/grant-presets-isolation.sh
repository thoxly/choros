#!/usr/bin/env bash
# T-0135 · grant-presets isolation fitness checks.
#
# AC-09 — DICT_PRESETS is exported from src/http/grants.ts and consumed
#          by registerDictionariesRoute (no duplicate definition).
# AC-10 — PRESETS in ra-data.jsx is synced: same preset ids as DICT_PRESETS,
#          same count.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GRANTS_TS="${PROJECT_ROOT}/src/http/grants.ts"
RA_DATA="${PROJECT_ROOT}/web/src/screens/rights/ra-data.jsx"
ERRORS=0

echo "[T-0135] grant-presets-isolation: checking DICT_PRESETS export + ra-data.jsx sync"

for f in "${GRANTS_TS}" "${RA_DATA}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: required file ${f} does not exist"
    exit 1
  fi
done

# ---- AC-09a: DICT_PRESETS is exported from grants.ts -----------------------
before=${ERRORS}
if ! grep -qE 'export\s+(const\s+)?DICT_PRESETS|export.*DICT_PRESETS' "${GRANTS_TS}"; then
  echo "FAIL (AC-09a): grants.ts does not export DICT_PRESETS"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-09a): DICT_PRESETS exported from grants.ts"
fi

# ---- AC-09b: registerDictionariesRoute references DICT_PRESETS -------------
before=${ERRORS}
if ! awk '/export function registerDictionariesRoute/,/^}/' "${GRANTS_TS}" | grep -q 'DICT_PRESETS'; then
  echo "FAIL (AC-09b): registerDictionariesRoute does not reference DICT_PRESETS"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-09b): registerDictionariesRoute references DICT_PRESETS"
fi

# ---- AC-09c: no duplicate PRESETS definition outside DICT_PRESETS in grants.ts ----
# Count lines matching "const PRESETS" or "PRESETS =" that are NOT DICT_PRESETS.
before=${ERRORS}
dup_count=$(grep -cE '(^|[^_A-Z])PRESETS\s*=' "${GRANTS_TS}" | grep -v 'DICT_PRESETS' || true)
# Simple approach: count non-DICT_ preset declarations
non_dict=$(grep -cE '(^const|export const)\s+PRESETS\s*=' "${GRANTS_TS}" 2>/dev/null || true)
non_dict=${non_dict:-0}
if [[ "${non_dict}" -gt 0 ]]; then
  echo "FAIL (AC-09c): grants.ts contains a non-DICT_PRESETS PRESETS declaration (possible duplicate)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-09c): no duplicate PRESETS declaration in grants.ts"
fi

# ---- AC-10: ra-data.jsx PRESETS ids match DICT_PRESETS ids in grants.ts ----
# Extract preset ids from grants.ts (lines like: id: "p-...")
before=${ERRORS}
grants_ids=$(grep -oE 'id:\s*"p-[a-z0-9-]+"' "${GRANTS_TS}" | grep -oE '"p-[a-z0-9-]+"' | tr -d '"' | sort || true)
ra_ids=$(grep -oE "id:\s*['\"]p-[a-z0-9-]+['\"]" "${RA_DATA}" | grep -oE "p-[a-z0-9-]+" | sort || true)

grants_count=$(echo "${grants_ids}" | grep -c 'p-' 2>/dev/null || true)
grants_count=${grants_count:-0}
ra_count=$(echo "${ra_ids}" | grep -c 'p-' 2>/dev/null || true)
ra_count=${ra_count:-0}

if [[ "${grants_count}" -eq 0 ]]; then
  echo "FAIL (AC-10): could not extract preset ids from grants.ts — no 'id': 'p-*' patterns found"
  ERRORS=$((ERRORS + 1))
elif [[ "${ra_count}" -eq 0 ]]; then
  echo "FAIL (AC-10): could not extract preset ids from ra-data.jsx — no id: 'p-*' patterns found"
  ERRORS=$((ERRORS + 1))
elif [[ "${grants_count}" -ne "${ra_count}" ]]; then
  echo "FAIL (AC-10): preset count mismatch: grants.ts=${grants_count}, ra-data.jsx=${ra_count}"
  echo "  grants.ts ids: ${grants_ids}"
  echo "  ra-data.jsx ids: ${ra_ids}"
  ERRORS=$((ERRORS + 1))
elif [[ "${grants_ids}" != "${ra_ids}" ]]; then
  echo "FAIL (AC-10): preset ids differ between grants.ts and ra-data.jsx"
  echo "  in grants.ts only: $(comm -23 <(echo "${grants_ids}") <(echo "${ra_ids}") || true)"
  echo "  in ra-data.jsx only: $(comm -13 <(echo "${grants_ids}") <(echo "${ra_ids}") || true)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-10): ra-data.jsx PRESETS ids match DICT_PRESETS ids (count=${grants_count})"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: grant-presets-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: grant-presets-isolation — all checks green"
exit 0
