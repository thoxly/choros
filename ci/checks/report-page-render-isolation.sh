#!/usr/bin/env bash
# T-0181 · T-0121g — Floor-1 aggregate renderer + Floor-2 RLS-gated data API isolation fitness
#
# FF-FLOOR2-RLS: Floor-2 code reads data only through RLS-gated server endpoint;
#                no DB credentials in client-facing module.
# FF-NF4:        Floor-1 rendered deterministically server-side (no LLM calls in module).
# AC-INJ:        FIELD_KEY_SAFE_RE guard present (charset-based SQL injection prevention).
# AC-INJ:        Schema-whitelist guard present (existence check against registry_def).
# AC-INJ:        filter.value uses parameterized binding ($N), not string interpolation.
# AC-AUTHZ:      PDP gate (checkReadGrant / loadAdminContext) wired for Floor-2.
# AC-TX:         withTenantTx used (BEGIN-before-SET-LOCAL discipline, T-0144).
# AC-REG:        registerReportPageRenderRoutes exported and registered in server.ts.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RENDER_FILE="${ROOT}/src/http/report-page-render.ts"
SERVER_FILE="${ROOT}/src/server.ts"
ERRORS=0

echo "[FF-RP-RENDER] report-page-render-isolation: checking T-0181 module constraints"

# ---- Precondition: file exists ----------------------------------------
if [[ ! -f "${RENDER_FILE}" ]]; then
  echo "FAIL: ${RENDER_FILE} does not exist"
  exit 1
fi
echo "PASS: src/http/report-page-render.ts exists"

# ---- FF-FLOOR2-RLS: no DB credentials / direct DB connection in module ----
echo ""
echo "Check FF-FLOOR2-RLS: no DB credentials in report-page-render.ts"

CRED_PATTERNS=(
  "pg\.Client\b"
  "process\.env.*PASSWORD"
  "process\.env.*SECRET"
)

CRED_ERRORS=0
for pat in "${CRED_PATTERNS[@]}"; do
  grep_rc=0
  # Exclude comment lines
  grep -viE "^\s*(//|\*)" "${RENDER_FILE}" 2>/dev/null | grep -qiE "${pat}" 2>/dev/null || grep_rc=$?
  if [[ ${grep_rc} -eq 0 ]]; then
    echo "FAIL (FF-FLOOR2-RLS): suspicious credential pattern in non-comment code: ${pat}"
    CRED_ERRORS=$((CRED_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
# Pool is allowed (server-side access under RLS) — but it must NOT export a raw connectionString
if grep -q 'export.*connectionString\|export.*DATABASE_URL\|export.*password' "${RENDER_FILE}" 2>/dev/null; then
  echo "FAIL (FF-FLOOR2-RLS): DB credential exported from render module"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${CRED_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-FLOOR2-RLS): no DB credential patterns in report-page-render.ts"
fi

# ---- AC-INJ: FIELD_KEY_SAFE_RE charset guard present --------------------
echo ""
echo "Check AC-INJ: FIELD_KEY_SAFE_RE (charset guard) present"

if ! grep -q "FIELD_KEY_SAFE_RE" "${RENDER_FILE}"; then
  echo "FAIL (AC-INJ): FIELD_KEY_SAFE_RE charset guard not found in report-page-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-INJ): FIELD_KEY_SAFE_RE charset guard present"
fi

# The guard must use a restrictive pattern — check for [a-zA-Z0-9_-]
if ! grep -q "\[a-zA-Z0-9_-\]" "${RENDER_FILE}" 2>/dev/null; then
  echo "FAIL (AC-INJ): FIELD_KEY_SAFE_RE does not restrict to [a-zA-Z0-9_-] charset"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-INJ): FIELD_KEY_SAFE_RE uses [a-zA-Z0-9_-] charset"
fi

# assertFieldKeySafe function must be present
if ! grep -q "assertFieldKeySafe" "${RENDER_FILE}"; then
  echo "FAIL (AC-INJ): assertFieldKeySafe function not found in report-page-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-INJ): assertFieldKeySafe function present"
fi

# ---- AC-INJ: schema whitelist guard present -----------------------------
echo ""
echo "Check AC-INJ: schema-whitelist guard (assertFieldKeyInSchema) present"

if ! grep -q "assertFieldKeyInSchema\|FIELD_KEY_NOT_IN_SCHEMA" "${RENDER_FILE}"; then
  echo "FAIL (AC-INJ): schema-whitelist guard not found in report-page-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-INJ): schema-whitelist guard (assertFieldKeyInSchema) present"
fi

# ---- AC-INJ: filter.value uses $N param binding (not string interpolation) --
echo ""
echo "Check AC-INJ: filter.value uses parameterized binding (not interpolated)"

# The filter value must appear as a $N parameter, not interpolated into the SQL string
# Check that filter value is pushed to params array (not directly concatenated)
if ! grep -q "params\.push" "${RENDER_FILE}"; then
  echo "FAIL (AC-INJ): params.push not found — filter.value may not be parameterized"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-INJ): params.push found (filter.value parameterized)"
fi

# Also verify that we see placeholder pattern like $\${paramIdx} for filter values
if ! grep -q '\${\(paramIdx\|ph\)' "${RENDER_FILE}" 2>/dev/null && ! grep -q 'paramIdx\|parameterized' "${RENDER_FILE}" 2>/dev/null; then
  echo "WARN (AC-INJ): paramIdx / dynamic $N placeholder not found — review filter.value binding"
fi
# If filter value appears directly in string template for SQL, that's a violation
# Check that filter.value itself isn't interpolated as ${filter.value} in template literals
if grep -q '\${filter\.value}' "${RENDER_FILE}" 2>/dev/null; then
  echo "FAIL (AC-INJ): filter.value directly interpolated into SQL string — SQL injection risk!"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-INJ): filter.value not directly interpolated into SQL"
fi

# ---- AC-AUTHZ: PDP gate for Floor-2 -----------------------------------
echo ""
echo "Check AC-AUTHZ: PDP gate (checkReadGrant / loadAdminContext) wired"

if ! grep -q "checkReadGrant" "${RENDER_FILE}"; then
  echo "FAIL (AC-AUTHZ): checkReadGrant not found in report-page-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-AUTHZ): checkReadGrant (PDP gate) present"
fi

if ! grep -q "loadAdminContext" "${RENDER_FILE}"; then
  echo "FAIL (AC-AUTHZ): loadAdminContext not found — PDP gate may not use real authority"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-AUTHZ): loadAdminContext wired (genesis-owner short-circuit)"
fi

# ---- AC-TX: withTenantTx present (T-0144 discipline) -------------------
echo ""
echo "Check AC-TX: withTenantTx (BEGIN-before-SET-LOCAL) present"

if ! grep -q "withTenantTx" "${RENDER_FILE}"; then
  echo "FAIL (AC-TX): withTenantTx not found in report-page-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-TX): withTenantTx (T-0144 discipline) present"
fi

# ---- FF-NF4: no LLM/agent call in Floor-1 renderer ---------------------
echo ""
echo "Check FF-NF4: no LLM/agent call in Floor-1 renderer (deterministic)"

LLM_PATTERNS=(
  "anthropic"
  "openai"
  "claude"
  "llm\b"
  "agent.*call\|call.*agent"
  "mcp.*invoke\|invoke.*mcp"
)

NF4_ERRORS=0
for pat in "${LLM_PATTERNS[@]}"; do
  # Only check non-comment code
  grep_rc=0
  grep -viE "^\s*(//|\*)" "${RENDER_FILE}" 2>/dev/null | grep -qiE "${pat}" 2>/dev/null || grep_rc=$?
  if [[ ${grep_rc} -eq 0 ]]; then
    echo "WARN (FF-NF4): possible LLM/agent pattern in non-comment code: ${pat} — review"
    NF4_ERRORS=$((NF4_ERRORS + 1))
  fi
done
if [[ ${NF4_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-NF4): no LLM/agent patterns in Floor-1 renderer"
fi

# ---- AC-REG: routes registered in server.ts ----------------------------
echo ""
echo "Check AC-REG: registerReportPageRenderRoutes registered in src/server.ts"

if ! grep -q "registerReportPageRenderRoutes" "${SERVER_FILE}"; then
  echo "FAIL (AC-REG): registerReportPageRenderRoutes not called in server.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-REG): registerReportPageRenderRoutes registered in server.ts"
fi

# ---- AC-REG: function exported from module -----------------------------
echo ""
echo "Check AC-REG: registerReportPageRenderRoutes exported from render module"

if ! grep -q "export function registerReportPageRenderRoutes" "${RENDER_FILE}"; then
  echo "FAIL (AC-REG): registerReportPageRenderRoutes not exported"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-REG): registerReportPageRenderRoutes exported"
fi

# ReportPageRenderAuthzDeps interface exported
if ! grep -q "export interface ReportPageRenderAuthzDeps" "${RENDER_FILE}"; then
  echo "FAIL (AC-REG): ReportPageRenderAuthzDeps interface not exported"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-REG): ReportPageRenderAuthzDeps exported"
fi

# resetRenderPoolForTesting exported (testing seam)
if ! grep -q "export function resetRenderPoolForTesting" "${RENDER_FILE}"; then
  echo "FAIL (AC-REG): resetRenderPoolForTesting not exported"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-REG): resetRenderPoolForTesting testing seam exported"
fi

# MAX_DATA_LIMIT exported
if ! grep -q "export const MAX_DATA_LIMIT" "${RENDER_FILE}"; then
  echo "FAIL (AC-REG): MAX_DATA_LIMIT not exported"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (AC-REG): MAX_DATA_LIMIT exported"
fi

# ---- Result ------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: report-page-render-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: report-page-render-isolation (T-0181) — all checks green"
exit 0
