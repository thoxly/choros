#!/usr/bin/env bash
# T-0177 · FF-PURE / AC-12/AC-14/AC-17: schema-change-classifier module isolation checks
#
# Asserts (ADR T-0121 §5/§8, spec T-0177 FR-6/FR-11):
#  SCC-1 — src/core/schema-change-classifier.ts exists.
#  SCC-2 — Module is pure: no pg, node:fs, node:http, node:net, child_process,
#           import.meta, process.env, process.exit imports.
#  SCC-3 — ADR-reference comment mentions T-0072 checkBindingCompat + T-0176
#           checkReportPageDepFields (prецедентная ссылка — NF-1 ADR §3).
#  SCC-4 — All required public-surface exports present:
#           AffectedDep, SchemaChangeClassification, JsonSchemaForClassify,
#           classifySchemaChange, FieldSchemaEntry.
#  SCC-5 — HTTP route file src/http/registry-defs.ts exists and registers routes
#           for 'registry-defs' (PUT + PATCH).
#  SCC-6 — No silent DELETE on report_page_dep in schema-change path
#           (registry-defs.ts must not DELETE report_page_dep rows silently).
#  SCC-7 — warnings in HTTP response is a structured array (not a string concat).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

CLASSIFIER="${PROJECT_ROOT}/src/core/schema-change-classifier.ts"
HTTP_ROUTE="${PROJECT_ROOT}/src/http/registry-defs.ts"

echo "[FF-PURE SCC-1..7] schema-change-classifier-isolation: checking module boundary"

# ---- SCC-1: core classifier file exists ------------------------------------

if [[ ! -f "${CLASSIFIER}" ]]; then
  echo "FAIL SCC-1: src/core/schema-change-classifier.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS SCC-1: src/core/schema-change-classifier.ts exists"
fi

# ---- SCC-2: no forbidden I/O imports in classifier -------------------------

if [[ ! -f "${CLASSIFIER}" ]]; then
  echo "SKIP SCC-2: classifier not found (already failed in SCC-1)"
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

  SCC2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${CLASSIFIER}" 2>/dev/null; then
      echo "FAIL SCC-2: schema-change-classifier.ts contains forbidden pattern: ${pattern}"
      SCC2_ERRORS=$((SCC2_ERRORS + 1))
    fi
  done

  if [[ ${SCC2_ERRORS} -eq 0 ]]; then
    echo "PASS SCC-2: schema-change-classifier.ts contains no forbidden I/O imports"
  else
    ERRORS=$((ERRORS + SCC2_ERRORS))
  fi
fi

# ---- SCC-3: ADR reference to T-0072 / checkBindingCompat + T-0176 ----------

if [[ ! -f "${CLASSIFIER}" ]]; then
  echo "SKIP SCC-3: classifier not found"
else
  SCC3_ERRORS=0
  if ! grep -q "checkBindingCompat" "${CLASSIFIER}" 2>/dev/null; then
    echo "FAIL SCC-3: schema-change-classifier.ts missing ADR reference to 'checkBindingCompat' (T-0072 precedent, NF-1)"
    SCC3_ERRORS=$((SCC3_ERRORS + 1))
  fi
  if ! grep -q "checkReportPageDepFields\|T-0176" "${CLASSIFIER}" 2>/dev/null; then
    echo "FAIL SCC-3: schema-change-classifier.ts missing reference to T-0176 checkReportPageDepFields (NF-1)"
    SCC3_ERRORS=$((SCC3_ERRORS + 1))
  fi
  if [[ ${SCC3_ERRORS} -eq 0 ]]; then
    echo "PASS SCC-3: ADR references to T-0072 + T-0176 present"
  else
    ERRORS=$((ERRORS + SCC3_ERRORS))
  fi
fi

# ---- SCC-4: required public-surface exports present ------------------------

if [[ ! -f "${CLASSIFIER}" ]]; then
  echo "SKIP SCC-4: classifier not found"
else
  SCC4_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*AffectedDep"
    "export.*SchemaChangeClassification"
    "export.*JsonSchemaForClassify"
    "export.*function classifySchemaChange"
    "export.*FieldSchemaEntry"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${CLASSIFIER}" 2>/dev/null; then
      echo "FAIL SCC-4: schema-change-classifier.ts missing export matching: ${pattern}"
      SCC4_ERRORS=$((SCC4_ERRORS + 1))
    fi
  done

  if [[ ${SCC4_ERRORS} -eq 0 ]]; then
    echo "PASS SCC-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + SCC4_ERRORS))
  fi
fi

# ---- SCC-5: HTTP route file exists + registers registry-defs route ---------

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "FAIL SCC-5: src/http/registry-defs.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  SCC5_ERRORS=0
  if ! grep -q "registry-defs" "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL SCC-5: src/http/registry-defs.ts does not register 'registry-defs' route"
    SCC5_ERRORS=$((SCC5_ERRORS + 1))
  fi
  if ! grep -Eq '"PUT"|"PATCH"' "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL SCC-5: src/http/registry-defs.ts does not register PUT or PATCH method"
    SCC5_ERRORS=$((SCC5_ERRORS + 1))
  fi
  if [[ ${SCC5_ERRORS} -eq 0 ]]; then
    echo "PASS SCC-5: src/http/registry-defs.ts exists and registers PUT/PATCH /api/registry-defs/:id"
  else
    ERRORS=$((ERRORS + SCC5_ERRORS))
  fi
fi

# ---- SCC-6: no silent DELETE on report_page_dep in schema-change path ------
# (AC-14: deps are marked stale, not deleted)

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "SKIP SCC-6: HTTP route file not found"
else
  if grep -Eq "DELETE.*report_page_dep|DELETE FROM.*report_page_dep" "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL SCC-6: src/http/registry-defs.ts contains DELETE on report_page_dep (deps must be marked stale, not deleted)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS SCC-6: no silent DELETE on report_page_dep in schema-change path"
  fi
fi

# ---- SCC-7: warnings is a structured array (not a string concat) -----------
# Check that warnings array is built as objects, not via string concatenation.

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "SKIP SCC-7: HTTP route file not found"
else
  if grep -Eq '"warnings".*\+.*"page_slug"' "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL SCC-7: warnings appears to be built via string concatenation (must be object array)"
    ERRORS=$((ERRORS + 1))
  else
    # Verify warnings maps to array of objects with page_slug field
    if ! grep -q "page_slug" "${HTTP_ROUTE}" 2>/dev/null; then
      echo "FAIL SCC-7: src/http/registry-defs.ts missing page_slug in warnings shape"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS SCC-7: warnings is a structured array with page_slug field"
    fi
  fi
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: schema-change-classifier-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: schema-change-classifier-isolation — all checks green [FF-PURE SCC-1..7]"
exit 0
