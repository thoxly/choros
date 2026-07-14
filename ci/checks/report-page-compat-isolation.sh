#!/usr/bin/env bash
# T-0176 · FF-COMPAT-PURE: report-page-compat module isolation checks
#
# Asserts (ADR T-0121 §3/§8, spec T-0176 FR-5/FR-6/FR-8):
#  RPC-1 — src/core/report-page-compat.ts exists.
#  RPC-2 — Module is pure: no pg, node:fs, node:http, node:net, child_process,
#           import.meta, process.env, process.exit imports.
#  RPC-3 — ADR-reference comment mentions T-0072 checkBindingCompat
#           (prецедентная ссылка — NF-1 ADR §3, один контрол плейн согласованности).
#  RPC-4 — All required public-surface exports present:
#           DepKind, PageDep, DepViolation, DepCompatResult,
#           checkReportPageDepFields, classifyReportPageFloor.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

MODULE="${PROJECT_ROOT}/src/core/report-page-compat.ts"

echo "[FF-COMPAT-PURE] report-page-compat-isolation: checking module boundary"

# ---- RPC-1: file exists ----------------------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL RPC-1: src/core/report-page-compat.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS RPC-1: src/core/report-page-compat.ts exists"
fi

# ---- RPC-2: no forbidden I/O imports ---------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP RPC-2: module not found (already failed in RPC-1)"
else
  FORBIDDEN_PATTERNS=(
    "from.*['\"]pg['\"]"
    "from.*['\"]node:fs['\"]"
    "from.*['\"]node:http['\"]"
    "from.*['\"]node:net['\"]"
    "from.*['\"]node:child_process['\"]"
    "child_process"
    "import\.meta"
    "process\.env"
    "process\.exit"
  )

  RPC2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL RPC-2: report-page-compat.ts contains forbidden pattern: ${pattern}"
      RPC2_ERRORS=$((RPC2_ERRORS + 1))
    fi
  done

  if [[ ${RPC2_ERRORS} -eq 0 ]]; then
    echo "PASS RPC-2: report-page-compat.ts contains no forbidden I/O imports"
  else
    ERRORS=$((ERRORS + RPC2_ERRORS))
  fi
fi

# ---- RPC-3: ADR reference to T-0072 / checkBindingCompat ------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP RPC-3: module not found"
else
  if ! grep -q "checkBindingCompat" "${MODULE}" 2>/dev/null; then
    echo "FAIL RPC-3: report-page-compat.ts missing ADR reference to 'checkBindingCompat' (T-0072 precedent, NF-1)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS RPC-3: ADR reference to checkBindingCompat (T-0072) present"
  fi
fi

# ---- RPC-4: required public-surface exports --------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP RPC-4: module not found"
else
  RPC4_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*DepKind"
    "export.*PageDep"
    "export.*DepViolation"
    "export.*DepCompatResult"
    "export.*function checkReportPageDepFields"
    "export.*function classifyReportPageFloor"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL RPC-4: report-page-compat.ts missing export matching: ${pattern}"
      RPC4_ERRORS=$((RPC4_ERRORS + 1))
    fi
  done

  if [[ ${RPC4_ERRORS} -eq 0 ]]; then
    echo "PASS RPC-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + RPC4_ERRORS))
  fi
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: report-page-compat-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: report-page-compat-isolation — all checks green [FF-COMPAT-PURE]"
exit 0
