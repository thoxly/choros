#!/usr/bin/env bash
# T-0074 · FF-FLOOR-AUTH: authoring-floor-classifier module isolation checks
#
# Asserts (extensibility-and-authoring.md §4/§9.2, spec T-0074):
#  AFC-1 — src/core/authoring-floor-classifier.ts exists.
#  AFC-2 — Module is pure: no pg, node:fs, node:http, node:net, child_process,
#           import.meta, process.env, process.exit imports.
#  AFC-3 — ADR-reference comment mentions T-0176 classifyReportPageFloor
#           (precedent link — NF-1: one control-plane classifier per edit kind).
#  AFC-4 — All required public-surface exports present:
#           FormEditKind, Floor1EditKind, Floor2EditKind,
#           FormEditChange, AuthoringFloorResult,
#           FLOOR1_EDIT_KINDS, FLOOR2_EDIT_KINDS,
#           classifyAuthoringFloor.
#  AFC-5 — FLOOR1_EDIT_KINDS and FLOOR2_EDIT_KINDS are declared as ReadonlySet
#           (machine-readable boundary — T-0073 / T-0078 consumers).
#  AFC-6 — classifyAuthoringFloor accepts FormEditChange and returns
#           AuthoringFloorResult (signature check via grep).
#  AFC-7 — Vocab is closed (§9.2): unknown kinds fall back to Floor-2
#           (fallback branch must be present in implementation).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

MODULE="${PROJECT_ROOT}/src/core/authoring-floor-classifier.ts"

echo "[FF-FLOOR-AUTH] authoring-floor-isolation: checking module boundary"

# ---- AFC-1: file exists ----------------------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL AFC-1: src/core/authoring-floor-classifier.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS AFC-1: src/core/authoring-floor-classifier.ts exists"
fi

# ---- AFC-2: no forbidden I/O imports ---------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP AFC-2: module not found (already failed in AFC-1)"
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

  AFC2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL AFC-2: authoring-floor-classifier.ts contains forbidden pattern: ${pattern}"
      AFC2_ERRORS=$((AFC2_ERRORS + 1))
    fi
  done

  if [[ ${AFC2_ERRORS} -eq 0 ]]; then
    echo "PASS AFC-2: authoring-floor-classifier.ts contains no forbidden I/O imports"
  else
    ERRORS=$((ERRORS + AFC2_ERRORS))
  fi
fi

# ---- AFC-3: ADR reference to T-0176 / classifyReportPageFloor --------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP AFC-3: module not found"
else
  if ! grep -q "classifyReportPageFloor\|T-0176" "${MODULE}" 2>/dev/null; then
    echo "FAIL AFC-3: authoring-floor-classifier.ts missing ADR reference to 'classifyReportPageFloor' / T-0176 (precedent NF-1)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS AFC-3: ADR reference to classifyReportPageFloor (T-0176) present"
  fi
fi

# ---- AFC-4: required public-surface exports present ------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP AFC-4: module not found"
else
  AFC4_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*FormEditKind"
    "export.*Floor1EditKind"
    "export.*Floor2EditKind"
    "export.*FormEditChange"
    "export.*AuthoringFloorResult"
    "export.*FLOOR1_EDIT_KINDS"
    "export.*FLOOR2_EDIT_KINDS"
    "export.*function classifyAuthoringFloor"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL AFC-4: authoring-floor-classifier.ts missing export matching: ${pattern}"
      AFC4_ERRORS=$((AFC4_ERRORS + 1))
    fi
  done

  if [[ ${AFC4_ERRORS} -eq 0 ]]; then
    echo "PASS AFC-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + AFC4_ERRORS))
  fi
fi

# ---- AFC-5: ReadonlySet for machine-readable vocab boundaries --------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP AFC-5: module not found"
else
  AFC5_ERRORS=0
  if ! grep -q "ReadonlySet.*Floor1EditKind\|ReadonlySet<Floor1EditKind>" "${MODULE}" 2>/dev/null; then
    echo "FAIL AFC-5: FLOOR1_EDIT_KINDS not typed as ReadonlySet<Floor1EditKind>"
    AFC5_ERRORS=$((AFC5_ERRORS + 1))
  fi
  if ! grep -q "ReadonlySet.*Floor2EditKind\|ReadonlySet<Floor2EditKind>" "${MODULE}" 2>/dev/null; then
    echo "FAIL AFC-5: FLOOR2_EDIT_KINDS not typed as ReadonlySet<Floor2EditKind>"
    AFC5_ERRORS=$((AFC5_ERRORS + 1))
  fi
  if [[ ${AFC5_ERRORS} -eq 0 ]]; then
    echo "PASS AFC-5: FLOOR1_EDIT_KINDS and FLOOR2_EDIT_KINDS typed as ReadonlySet"
  else
    ERRORS=$((ERRORS + AFC5_ERRORS))
  fi
fi

# ---- AFC-6: classifyAuthoringFloor signature — accepts FormEditChange, returns AuthoringFloorResult --

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP AFC-6: module not found"
else
  if ! grep -Eq "function classifyAuthoringFloor\(change: FormEditChange\).*AuthoringFloorResult" "${MODULE}" 2>/dev/null; then
    echo "FAIL AFC-6: classifyAuthoringFloor signature mismatch — expected (change: FormEditChange): AuthoringFloorResult"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS AFC-6: classifyAuthoringFloor signature correct"
  fi
fi

# ---- AFC-7: fallback branch for unknown kinds (closed vocab §9.2) ----------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP AFC-7: module not found"
else
  # The fallback must include "unknown kinds default to Floor-2" or similar text
  if ! grep -Eq "unknown kinds default to Floor-2|unknown.*Floor-2|default.*Floor-2|defaults to Floor-2" "${MODULE}" 2>/dev/null; then
    echo "FAIL AFC-7: classifyAuthoringFloor missing fallback branch for unknown kinds (§9.2 closed vocab)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS AFC-7: fallback branch for unknown kinds → Floor-2 present"
  fi
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: authoring-floor-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: authoring-floor-isolation — all checks green [FF-FLOOR-AUTH]"
exit 0
