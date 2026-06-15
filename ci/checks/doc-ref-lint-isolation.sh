#!/usr/bin/env bash
# T-0238 · T-0134b · FF-LINT-PURE: doc-ref-lint module isolation checks
#
# Asserts (ADR T-0134 §8):
#  DRL-1 — src/core/doc-ref-lint.ts exists.
#  DRL-2 — Module is pure: no pg, node:fs, node:http, node:net, node:child_process,
#           child_process, import.meta, process.env, process.exit imports.
#  DRL-3 — ADR-reference comment mentions checkReportPageDepFields (T-0121 precedent)
#           and checkBindingCompat (T-0072 precedent) — one control plane (NF-6).
#  DRL-4 — All required public-surface exports present:
#           DocRefKind, DocRef, LiveSnapshot, DocRefViolation, DocLintResult,
#           checkDocRefs.
#
# Mirrors report-page-compat-isolation.sh (T-0176 · FF-COMPAT-PURE).
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

MODULE="${PROJECT_ROOT}/src/core/doc-ref-lint.ts"

echo "[FF-LINT-PURE] doc-ref-lint-isolation: checking module boundary"

# --self-test mode
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[self-test] doc-ref-lint-isolation.sh --self-test: script reachable and parseable"
  exit 0
fi

# ---- DRL-1: file exists ----------------------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL DRL-1: src/core/doc-ref-lint.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS DRL-1: src/core/doc-ref-lint.ts exists"
fi

# ---- DRL-2: no forbidden I/O imports ---------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRL-2: module not found (already failed in DRL-1)"
else
  FORBIDDEN_PATTERNS=(
    "from.*['\"]pg['\"]"
    "from.*['\"]node:fs['\"]"
    "from.*['\"]node:http['\"]"
    "from.*['\"]node:net['\"]"
    "from.*['\"]node:child_process['\"]"
    "from.*['\"]fs['\"]"
    "from.*['\"]http['\"]"
    "from.*['\"]net['\"]"
    "child_process"
    "import\.meta"
    "process\.env"
    "process\.exit"
    "require\("
  )

  DRL2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL DRL-2: doc-ref-lint.ts contains forbidden pattern: ${pattern}"
      DRL2_ERRORS=$((DRL2_ERRORS + 1))
    fi
  done

  if [[ ${DRL2_ERRORS} -eq 0 ]]; then
    echo "PASS DRL-2: doc-ref-lint.ts contains no forbidden I/O imports (FF-LINT-PURE)"
  else
    ERRORS=$((ERRORS + DRL2_ERRORS))
  fi
fi

# ---- DRL-3: ADR reference to T-0121 checkReportPageDepFields and T-0072 ---

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRL-3: module not found"
else
  DRL3_ERRORS=0

  if ! grep -q "checkReportPageDepFields" "${MODULE}" 2>/dev/null; then
    echo "FAIL DRL-3: doc-ref-lint.ts missing ADR reference to 'checkReportPageDepFields' (T-0121 precedent, NF-6)"
    DRL3_ERRORS=$((DRL3_ERRORS + 1))
  else
    echo "PASS DRL-3a: ADR reference to checkReportPageDepFields (T-0121) present"
  fi

  if ! grep -q "checkBindingCompat" "${MODULE}" 2>/dev/null; then
    echo "FAIL DRL-3: doc-ref-lint.ts missing ADR reference to 'checkBindingCompat' (T-0072 precedent, NF-6)"
    DRL3_ERRORS=$((DRL3_ERRORS + 1))
  else
    echo "PASS DRL-3b: ADR reference to checkBindingCompat (T-0072) present"
  fi

  ERRORS=$((ERRORS + DRL3_ERRORS))
fi

# ---- DRL-4: required public-surface exports --------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRL-4: module not found"
else
  DRL4_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*DocRefKind"
    "export.*DocRef"
    "export.*LiveSnapshot"
    "export.*DocRefViolation"
    "export.*DocLintResult"
    "export.*function checkDocRefs"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL DRL-4: doc-ref-lint.ts missing export matching: ${pattern}"
      DRL4_ERRORS=$((DRL4_ERRORS + 1))
    else
      echo "PASS DRL-4: '${pattern}' found"
    fi
  done

  if [[ ${DRL4_ERRORS} -eq 0 ]]; then
    echo "PASS DRL-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + DRL4_ERRORS))
  fi
fi

# ---- Result ----------------------------------------------------------------

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: doc-ref-lint-isolation found ${ERRORS} violation(s) [FF-LINT-PURE]"
  exit 1
fi

echo "PASS: doc-ref-lint-isolation — all checks green [FF-LINT-PURE]"
exit 0
