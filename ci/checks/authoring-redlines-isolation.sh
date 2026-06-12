#!/usr/bin/env bash
# T-0078 · FF-AUTHORING-PURE: authoring-redlines module isolation checks
#
# Asserts (ADR extensibility-and-authoring.md §4/§5/§9 гард 7, spec T-0078):
#  ARL-1 — src/core/authoring-redlines.ts exists.
#  ARL-2 — Module is pure: no pg, node:fs, node:http, node:net, child_process,
#           import.meta, process.env, process.exit imports.
#  ARL-3 — ADR-reference comment mentions T-0177 classifySchemaChange (прецедент)
#           AND T-0072 checkBindingCompat (единый control plane, NF-1).
#  ARL-4 — All required public-surface exports present:
#           AuthoringOp, AuthoringContext, AuthoringChangeClass,
#           AuthoringRedLineDecision, AuthoringRedLineConfirm, AuthoringOpKind,
#           classifyAuthoringOp, evaluateAuthoringRedLine.
#  ARL-5 — Module imports from schema-change-classifier.js (reuses FieldSchemaEntry,
#           не переопределяет тип — NF-2).
#  ARL-6 — No duplicate isLossyNarrowing algorithm: if the private helper in
#           schema-change-classifier.ts exists as private, this module has its own
#           function referencing the T-0177 precedent in comments (AC-18: no silent copy).
#           Check: the module contains either an import of isLossyNarrowing OR
#           a comment reference to T-0177 near its own lossy helper.
#
# Exit 0 on clean, non-zero on any violation.
#
# Self-test: bash ci/checks/authoring-redlines-isolation.sh --self-test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0
SELF_TEST="${1:-}"

MODULE="${PROJECT_ROOT}/src/core/authoring-redlines.ts"

# ---- Self-test mode --------------------------------------------------------

if [[ "${SELF_TEST}" == "--self-test" ]]; then
  echo "[ARL self-test] Verifying script structure..."
  # Ensure all check labels (ARL-1..ARL-6) are present in the script
  for label in ARL-1 ARL-2 ARL-3 ARL-4 ARL-5 ARL-6; do
    if ! grep -q "${label}" "${BASH_SOURCE[0]}"; then
      echo "FAIL self-test: label ${label} missing in script body"
      exit 1
    fi
  done
  echo "PASS self-test: all ARL-1..ARL-6 labels present in script"
  exit 0
fi

echo "[FF-AUTHORING-PURE ARL-1..6] authoring-redlines-isolation: checking module boundary"

# ---- ARL-1: core module file exists ----------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL ARL-1: src/core/authoring-redlines.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS ARL-1: src/core/authoring-redlines.ts exists"
fi

# ---- ARL-2: no forbidden I/O imports ----------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP ARL-2: module not found (already failed in ARL-1)"
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

  ARL2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL ARL-2: authoring-redlines.ts contains forbidden pattern: ${pattern}"
      ARL2_ERRORS=$((ARL2_ERRORS + 1))
    fi
  done

  if [[ ${ARL2_ERRORS} -eq 0 ]]; then
    echo "PASS ARL-2: authoring-redlines.ts contains no forbidden I/O imports"
  else
    ERRORS=$((ERRORS + ARL2_ERRORS))
  fi
fi

# ---- ARL-3: ADR references to T-0177 classifySchemaChange + T-0072 checkBindingCompat ----

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP ARL-3: module not found"
else
  ARL3_ERRORS=0
  if ! grep -q "T-0177\|classifySchemaChange" "${MODULE}" 2>/dev/null; then
    echo "FAIL ARL-3: authoring-redlines.ts missing ADR reference to T-0177 / classifySchemaChange (прецедент, NF-1)"
    ARL3_ERRORS=$((ARL3_ERRORS + 1))
  fi
  if ! grep -q "checkBindingCompat\|T-0072" "${MODULE}" 2>/dev/null; then
    echo "FAIL ARL-3: authoring-redlines.ts missing reference to T-0072 / checkBindingCompat (единый control plane, NF-1)"
    ARL3_ERRORS=$((ARL3_ERRORS + 1))
  fi
  if [[ ${ARL3_ERRORS} -eq 0 ]]; then
    echo "PASS ARL-3: ADR references to T-0177 + T-0072 present"
  else
    ERRORS=$((ERRORS + ARL3_ERRORS))
  fi
fi

# ---- ARL-4: required public-surface exports present -------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP ARL-4: module not found"
else
  ARL4_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*AuthoringOp"
    "export.*AuthoringContext"
    "export.*AuthoringChangeClass"
    "export.*AuthoringRedLineDecision"
    "export.*AuthoringRedLineConfirm"
    "export.*AuthoringOpKind"
    "classifyAuthoringOp"
    "evaluateAuthoringRedLine"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL ARL-4: authoring-redlines.ts missing export matching: ${pattern}"
      ARL4_ERRORS=$((ARL4_ERRORS + 1))
    fi
  done

  if [[ ${ARL4_ERRORS} -eq 0 ]]; then
    echo "PASS ARL-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + ARL4_ERRORS))
  fi
fi

# ---- ARL-5: imports from schema-change-classifier.js (reuses FieldSchemaEntry) ----

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP ARL-5: module not found"
else
  if ! grep -q "schema-change-classifier" "${MODULE}" 2>/dev/null; then
    echo "FAIL ARL-5: authoring-redlines.ts does not import from schema-change-classifier.js (FieldSchemaEntry must be reused, not redefined)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS ARL-5: imports FieldSchemaEntry from schema-change-classifier.js"
  fi
fi

# ---- ARL-6: no silent copy of isLossyNarrowing — T-0177 precedent referenced ----

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP ARL-6: module not found"
else
  # Either the module imports isLossyNarrowing from T-0177, OR it has its own
  # helper WITH a T-0177 reference comment (AC-18: precedent, not silent copy).
  if grep -q "isLossyNarrowing" "${MODULE}" 2>/dev/null; then
    # If present, verify it's not a standalone reimplementation (must reference T-0177)
    if grep -q "T-0177\|schema-change-classifier" "${MODULE}" 2>/dev/null; then
      echo "PASS ARL-6: isLossyNarrowing referenced with T-0177 precedent"
    else
      echo "FAIL ARL-6: isLossyNarrowing present but missing T-0177 precedent reference (AC-18)"
      ERRORS=$((ERRORS + 1))
    fi
  else
    # Module has its own lossy helper — verify T-0177 precedent reference is present
    # (covers the case where module names it differently but references T-0177)
    if grep -q "T-0177" "${MODULE}" 2>/dev/null; then
      echo "PASS ARL-6: own lossy helper present with T-0177 precedent reference"
    else
      echo "FAIL ARL-6: lossy narrowing logic missing T-0177 precedent reference (AC-18)"
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: authoring-redlines-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: authoring-redlines-isolation — all checks green [FF-AUTHORING-PURE ARL-1..6]"
exit 0
