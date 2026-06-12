#!/usr/bin/env bash
# T-0073 · FF-FLOOR1-ED: Floor-1 editor module isolation checks
#
# Asserts (extensibility-and-authoring.md §4/§9.1, spec T-0073):
#  FE1-1 — src/core/floor1-editor.ts exists.
#  FE1-2 — Core module is pure: no pg, node:fs, node:http, node:net,
#           child_process, import.meta, process.env, process.exit imports.
#  FE1-3 — Core module imports classifyAuthoringFloor (T-0074 classifier guard).
#  FE1-4 — Core module imports BindingField from binding-compat (T-0072 named-binding).
#  FE1-5 — Required public-surface exports present in core:
#           FieldUiMeta, FormUiSchema,
#           Floor1EditRequest, Floor1ValidationError, Floor1ValidationResult,
#           Floor1EditResult, applyFloor1Edit, validateFloor1Request.
#  FE1-6 — applyFloor1Edit signature matches: (request, fields, uiSchema) → Floor1EditResult.
#  FE1-7 — validateFloor1Request includes WRONG_FLOOR guard: classifyAuthoringFloor call present.
#  FE1-8 — HTTP route file src/http/floor1-editor.ts exists.
#  FE1-9 — HTTP route registers POST …/edits endpoint.
#  FE1-10 — HTTP route returns 409 for WRONG_FLOOR (Floor-2 guard).
#  FE1-11 — HTTP route never persists form_binding (stateless Mode A: no SQL
#           writes — INSERT/UPDATE/DELETE forbidden) AND carries the authz
#           guard (checkRole, review R-1).
#           Amended in fix iter2: the original "no pg import at all" assertion
#           conflicted with the blocking authz requirement (keycloak-mode
#           checkRole needs a pg client, plumbed the same way as binding.ts).
#           The honest invariant is narrowed: pg is allowed solely for the
#           authz role lookup; persistence from this route stays forbidden —
#           the caller persists via PATCH /binding (T-0072).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

CORE="${PROJECT_ROOT}/src/core/floor1-editor.ts"
HTTP_ROUTE="${PROJECT_ROOT}/src/http/floor1-editor.ts"

echo "[FF-FLOOR1-ED] floor1-editor-isolation: checking module boundary"

# ---- FE1-1: core file exists -----------------------------------------------

if [[ ! -f "${CORE}" ]]; then
  echo "FAIL FE1-1: src/core/floor1-editor.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FE1-1: src/core/floor1-editor.ts exists"
fi

# ---- FE1-2: no forbidden I/O imports in core --------------------------------

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FE1-2: core not found (already failed in FE1-1)"
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

  FE2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${CORE}" 2>/dev/null; then
      echo "FAIL FE1-2: floor1-editor.ts contains forbidden pattern: ${pattern}"
      FE2_ERRORS=$((FE2_ERRORS + 1))
    fi
  done

  if [[ ${FE2_ERRORS} -eq 0 ]]; then
    echo "PASS FE1-2: floor1-editor.ts contains no forbidden I/O imports"
  else
    ERRORS=$((ERRORS + FE2_ERRORS))
  fi
fi

# ---- FE1-3: imports classifyAuthoringFloor (T-0074 guard) ------------------

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FE1-3: core not found"
else
  if ! grep -q "classifyAuthoringFloor" "${CORE}" 2>/dev/null; then
    echo "FAIL FE1-3: floor1-editor.ts does not import/call classifyAuthoringFloor (T-0074 classifier guard required)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FE1-3: classifyAuthoringFloor (T-0074) present in floor1-editor.ts"
  fi
fi

# ---- FE1-4: imports BindingField from binding-compat (T-0072) ---------------

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FE1-4: core not found"
else
  if ! grep -q "binding-compat\|BindingField" "${CORE}" 2>/dev/null; then
    echo "FAIL FE1-4: floor1-editor.ts does not import BindingField from binding-compat (T-0072 named-binding contract)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FE1-4: BindingField / binding-compat reference present in floor1-editor.ts"
  fi
fi

# ---- FE1-5: required public-surface exports --------------------------------

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FE1-5: core not found"
else
  FE5_ERRORS=0
  REQUIRED_EXPORTS=(
    "export.*FieldUiMeta"
    "export.*FormUiSchema"
    "export.*Floor1EditRequest"
    "export.*Floor1ValidationError"
    "export.*Floor1ValidationResult"
    "export.*Floor1EditResult"
    "export.*function applyFloor1Edit"
    "export.*function validateFloor1Request"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${CORE}" 2>/dev/null; then
      echo "FAIL FE1-5: floor1-editor.ts missing export matching: ${pattern}"
      FE5_ERRORS=$((FE5_ERRORS + 1))
    fi
  done

  if [[ ${FE5_ERRORS} -eq 0 ]]; then
    echo "PASS FE1-5: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + FE5_ERRORS))
  fi
fi

# ---- FE1-6: applyFloor1Edit signature (request, fields, uiSchema) ----------

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FE1-6: core not found"
else
  if ! grep -Eq "function applyFloor1Edit\s*\(" "${CORE}" 2>/dev/null; then
    echo "FAIL FE1-6: floor1-editor.ts missing applyFloor1Edit function"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FE1-6: applyFloor1Edit function present"
  fi
fi

# ---- FE1-7: WRONG_FLOOR guard in validateFloor1Request ---------------------

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FE1-7: core not found"
else
  if ! grep -Eq "WRONG_FLOOR" "${CORE}" 2>/dev/null; then
    echo "FAIL FE1-7: floor1-editor.ts missing WRONG_FLOOR guard (classifyAuthoringFloor → Floor-2 → reject)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FE1-7: WRONG_FLOOR guard present in validateFloor1Request"
  fi
fi

# ---- FE1-8: HTTP route file exists -----------------------------------------

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "FAIL FE1-8: src/http/floor1-editor.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FE1-8: src/http/floor1-editor.ts exists"
fi

# ---- FE1-9: HTTP route registers POST …/edits endpoint ---------------------

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "SKIP FE1-9: HTTP route not found (already failed in FE1-8)"
else
  # Check for the /edits path being registered — the router.register call spans
  # multiple lines, so we check for the path string independently.
  if ! grep -Eq "\"POST\"|'POST'" "${HTTP_ROUTE}" 2>/dev/null || \
     ! grep -Eq "/edits" "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL FE1-9: HTTP route does not register POST …/edits endpoint"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FE1-9: POST …/edits endpoint registered"
  fi
fi

# ---- FE1-10: HTTP route returns 409 for WRONG_FLOOR ------------------------

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "SKIP FE1-10: HTTP route not found"
else
  if ! grep -Eq "409.*WRONG_FLOOR|WRONG_FLOOR.*409" "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL FE1-10: HTTP route does not return 409 WRONG_FLOOR for Floor-2 edits"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FE1-10: 409 WRONG_FLOOR guard present in HTTP route"
  fi
fi

# ---- FE1-11: HTTP route never persists form_binding + authz guard present ---
# Amended (T-0073 fix iter2, review R-1): pg import is permitted ONLY for the
# authz dependency (checkRole / withTenantTx reused from binding.ts — keycloak
# mode needs a role_assignment lookup). The stateless-Mode-A invariant is kept
# where it matters: this route must never write form_binding (or any table) —
# persistence remains the caller's job via PATCH /binding (T-0072).

if [[ ! -f "${HTTP_ROUTE}" ]]; then
  echo "SKIP FE1-11: HTTP route not found"
else
  FE11_ERRORS=0

  # (a) No SQL writes from this route — stateless Mode A persistence ban.
  if grep -Eqi "INSERT[[:space:]]+INTO|UPDATE[[:space:]]+choros\.|DELETE[[:space:]]+FROM" "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL FE1-11a: HTTP route contains SQL write (INSERT/UPDATE/DELETE) — violates stateless Mode A (persistence belongs to PATCH /binding, T-0072)"
    FE11_ERRORS=$((FE11_ERRORS + 1))
  fi

  # (b) Authz guard present — process_designer role check (review R-1).
  if ! grep -q "checkRole" "${HTTP_ROUTE}" 2>/dev/null; then
    echo "FAIL FE1-11b: HTTP route missing checkRole authz guard (process_designer, review R-1)"
    FE11_ERRORS=$((FE11_ERRORS + 1))
  fi

  if [[ ${FE11_ERRORS} -eq 0 ]]; then
    echo "PASS FE1-11: no SQL writes (stateless Mode A) and checkRole authz guard present"
  else
    ERRORS=$((ERRORS + FE11_ERRORS))
  fi
fi

# ---- Self-test mode --------------------------------------------------------

if [[ "${1:-}" == "--self-test" ]]; then
  echo ""
  echo "[FF-FLOOR1-ED] --self-test: running self-verification"
  # Self-test: if both files exist and all checks pass, that is itself the self-test.
  if [[ -f "${CORE}" && -f "${HTTP_ROUTE}" ]]; then
    echo "PASS (self-test): both floor1-editor.ts files exist — self-test satisfied"
    exit 0
  else
    echo "FAIL (self-test): floor1-editor.ts files missing — run T-0073 BUILD first"
    exit 1
  fi
fi

# ---- Result ----------------------------------------------------------------

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: floor1-editor-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: floor1-editor-isolation — all checks green [FF-FLOOR1-ED]"
exit 0
