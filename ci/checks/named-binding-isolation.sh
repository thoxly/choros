#!/usr/bin/env bash
# T-0072 · FF-NB-1..FF-NB-6: named-binding module isolation checks
#
# Asserts:
#  NB-1 — form_binding is listed in ci/checks/known_tenant_tables.txt (AC-2 / NF-3).
#  NB-2 — migration 045_form_binding.sql exists and contains ENABLE RLS / FORCE RLS /
#          tenant-isolation policy / GRANT DML choros_app / dev-seed (AC-1 / FR-7).
#  NB-3 — src/core/binding-compat.ts is a pure module: no pg, node:fs, node:http,
#          node:net, child_process, import.meta, process.env imports (AC-5 / NF-2).
#  NB-4 — LintViolationType in bpmn-linter.ts includes "binding_mismatch" (AC-12 / FR-4).
#  NB-5 — bpmn-xml-parser.ts is byte-unmodified (frozen tokenizer — ADR §5).
#  NB-6 — binding-compat.ts exports all required public-surface symbols (AC-12 / ADR §6):
#          BindingField, BindingViolationType, BindingViolation, BindingCompatResult,
#          checkBindingCompat, KEY_RE, MAX_KEY_LEN, validateBindingFields.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

echo "[FF-NB-1..6] named-binding-isolation: checking module boundary"

# ---- NB-1: form_binding in known_tenant_tables.txt -------------------------

KNOWN_TABLES="${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt"
if ! grep -q "^form_binding$" "${KNOWN_TABLES}" 2>/dev/null; then
  echo "FAIL NB-1: 'form_binding' not found in known_tenant_tables.txt"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS NB-1: form_binding in known_tenant_tables.txt"
fi

# ---- NB-2: migration 045 — RLS + policy + grant + dev-seed -----------------

MIGRATION="${PROJECT_ROOT}/migrations/045_form_binding.sql"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL NB-2: migrations/045_form_binding.sql does not exist"
  ERRORS=$((ERRORS + 1))
else
  NB2_ERRORS=0

  for pattern in \
    "ENABLE.*ROW LEVEL SECURITY" \
    "FORCE.*ROW LEVEL SECURITY" \
    "current_setting.*choros.tenant_id" \
    "GRANT.*choros_app" \
    "ON CONFLICT DO NOTHING"
  do
    if ! grep -Eiq "${pattern}" "${MIGRATION}"; then
      echo "FAIL NB-2: 045_form_binding.sql missing pattern: ${pattern}"
      NB2_ERRORS=$((NB2_ERRORS + 1))
    fi
  done

  if [[ ${NB2_ERRORS} -eq 0 ]]; then
    echo "PASS NB-2: 045_form_binding.sql has RLS + policy + grant + dev-seed"
  else
    ERRORS=$((ERRORS + NB2_ERRORS))
  fi
fi

# ---- NB-3: binding-compat.ts — pure module (no forbidden imports) ----------

COMPAT_MODULE="${PROJECT_ROOT}/src/core/binding-compat.ts"

if [[ ! -f "${COMPAT_MODULE}" ]]; then
  echo "FAIL NB-3: src/core/binding-compat.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  FORBIDDEN_COMPAT=(
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

  NB3_ERRORS=0
  for pattern in "${FORBIDDEN_COMPAT[@]}"; do
    if grep -Eq "${pattern}" "${COMPAT_MODULE}" 2>/dev/null; then
      echo "FAIL NB-3: binding-compat.ts contains forbidden pattern: ${pattern}"
      NB3_ERRORS=$((NB3_ERRORS + 1))
    fi
  done

  if [[ ${NB3_ERRORS} -eq 0 ]]; then
    echo "PASS NB-3: binding-compat.ts contains no forbidden I/O imports"
  else
    ERRORS=$((ERRORS + NB3_ERRORS))
  fi
fi

# ---- NB-4: bpmn-linter.ts exports binding_mismatch in LintViolationType ----

LINTER_MODULE="${PROJECT_ROOT}/src/core/bpmn-linter.ts"

if ! grep -q '"binding_mismatch"' "${LINTER_MODULE}" 2>/dev/null; then
  echo "FAIL NB-4: 'binding_mismatch' not found in bpmn-linter.ts LintViolationType"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS NB-4: bpmn-linter.ts includes 'binding_mismatch' in LintViolationType"
fi

# ---- NB-5: bpmn-xml-parser.ts is byte-unmodified (frozen) ------------------

PARSER_FILE="src/core/bpmn-xml-parser.ts"
if git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${PARSER_FILE}" 2>/dev/null; then
  echo "PASS NB-5: bpmn-xml-parser.ts is unmodified (frozen tokenizer intact)"
else
  echo "FAIL NB-5: bpmn-xml-parser.ts has uncommitted changes — frozen file must not be edited"
  ERRORS=$((ERRORS + 1))
fi

# ---- NB-6: binding-compat.ts exports required public-surface symbols -------

if [[ ! -f "${COMPAT_MODULE}" ]]; then
  echo "SKIP NB-6: binding-compat.ts not found (already failed in NB-3)"
else
  NB6_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*BindingField"
    "export.*BindingViolationType"
    "export.*BindingViolation"
    "export.*BindingCompatResult"
    "export.*function checkBindingCompat"
    "export.*KEY_RE"
    "export.*MAX_KEY_LEN"
    "export.*function validateBindingFields"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${COMPAT_MODULE}" 2>/dev/null; then
      echo "FAIL NB-6: binding-compat.ts missing export matching: ${pattern}"
      NB6_ERRORS=$((NB6_ERRORS + 1))
    fi
  done

  if [[ ${NB6_ERRORS} -eq 0 ]]; then
    echo "PASS NB-6: all required public-surface exports present in binding-compat.ts"
  else
    ERRORS=$((ERRORS + NB6_ERRORS))
  fi
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: named-binding-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: named-binding-isolation — all checks green"
exit 0
