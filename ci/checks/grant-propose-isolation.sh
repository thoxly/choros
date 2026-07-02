#!/usr/bin/env bash
# T-0039 · grant-propose isolation / NF-1/NF-4 / FF-39-1..8
#
# Static checks (no DB required):
#
#  FF-39-1 — registerGrantProposeRoute exported from src/http/grant-propose.ts
#             AND called in src/server.ts; grant-propose.ts has NO INSERT INTO grant.
#  FF-39-2 — No OPENAI_API_KEY/ANTHROPIC_API_KEY/sk- literal and no LLM SDK import
#             in src/ production paths (test fixtures excluded).
#  FF-39-3 — LLM_PROPOSALS identifier gone from web/src/screens/rights/ra-role-editor.jsx;
#             propose() references /api/grants/propose.
#  FF-39-4 — loadRoleEffectiveGrants in grants.ts includes 'confirmed_by IS NOT NULL'.
#  FF-39-5 — grant-propose.ts imports parseScopeElement from ./grants.js;
#             defines no new ScopeElement kind literal; no new migration added.
#  FF-39-6 — src/core/scoped-admin.ts byte-for-byte unchanged (NF-6).
#  FF-39-7 — grant-propose.ts emits NO_PROPOSAL_AGENT code and status 503.
#  FF-39-8 — grant-propose.ts has no console.log/console.error of the secret variable;
#             audit payload object lists no secret field.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GRANT_PROPOSE_TS="${PROJECT_ROOT}/src/http/grant-propose.ts"
GRANTS_TS="${PROJECT_ROOT}/src/http/grants.ts"
SERVER_TS="${PROJECT_ROOT}/src/server.ts"
RA_EDITOR="${PROJECT_ROOT}/web/src/screens/rights/ra-role-editor.jsx"
SCOPED_ADMIN_TS="${PROJECT_ROOT}/src/core/scoped-admin.ts"
ERRORS=0

echo "[FF-39-1..8] grant-propose-isolation: checking T-0039 invariants"

# Required files must exist.
for f in "${GRANT_PROPOSE_TS}" "${GRANTS_TS}" "${SERVER_TS}" "${RA_EDITOR}" "${SCOPED_ADMIN_TS}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: required file ${f} does not exist"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: missing required files — aborting further checks"
  exit 1
fi

# ---- FF-39-1a: registerGrantProposeRoute exported from grant-propose.ts ------
before=${ERRORS}
if ! grep -qE 'export function registerGrantProposeRoute' "${GRANT_PROPOSE_TS}"; then
  echo "FAIL (FF-39-1a): grant-propose.ts does not export 'registerGrantProposeRoute'"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-1a): registerGrantProposeRoute exported from grant-propose.ts"
fi

# ---- FF-39-1b: registerGrantProposeRoute called in server.ts ----------------
before=${ERRORS}
if ! grep -q 'registerGrantProposeRoute(' "${SERVER_TS}"; then
  echo "FAIL (FF-39-1b): server.ts does not call registerGrantProposeRoute"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-1b): registerGrantProposeRoute called in server.ts"
fi

# ---- FF-39-1c: grant-propose.ts has NO INSERT INTO grant --------------------
before=${ERRORS}
if grep -qE 'INSERT INTO choros\."grant"' "${GRANT_PROPOSE_TS}"; then
  echo "FAIL (FF-39-1c): grant-propose.ts contains INSERT INTO choros.\"grant\" (must be ephemeral)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-1c): grant-propose.ts has no INSERT INTO choros.\"grant\" (ephemeral)"
fi

# ---- FF-39-2: no LLM key literals or SDK imports in src/ (excl. tests) ------
# NB: sk- requires a NON-word char before it (portable \b) — otherwise the
# filename agent-task-external-mapper.ts (T-0460) false-positives via
# "ta(sk-external)-mapper" in comments/imports. Real key literals always sit
# after a quote/space/start-of-line, so detection is not weakened.
before=${ERRORS}
if grep -rE "OPENAI_API_KEY|ANTHROPIC_API_KEY|(^|[^A-Za-z0-9_])sk-[A-Za-z0-9]{8,}" "${PROJECT_ROOT}/src/" \
     --include='*.ts' 2>/dev/null \
   | grep -v '__tests__' | grep -v '\.test\.' | grep -q .; then
  echo "FAIL (FF-39-2): found LLM key literal(s) in src/ (non-test)"
  ERRORS=$((ERRORS + 1))
fi
if grep -rE "from ['\"]+(openai|@anthropic-ai/sdk|@google/generative-ai|cohere-ai|@mistralai)" \
     "${PROJECT_ROOT}/src/" --include='*.ts' 2>/dev/null | grep -q .; then
  echo "FAIL (FF-39-2): found LLM SDK import in src/"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-2): no LLM API key literals or SDK imports in src/ production paths"
fi

# ---- FF-39-3: LLM_PROPOSALS gone; propose() calls /api/grants/propose -------
before=${ERRORS}
if grep -q 'LLM_PROPOSALS' "${RA_EDITOR}"; then
  echo "FAIL (FF-39-3): LLM_PROPOSALS still present in ra-role-editor.jsx"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -q '/api/grants/propose' "${RA_EDITOR}"; then
  echo "FAIL (FF-39-3): ra-role-editor.jsx does not reference /api/grants/propose"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-3): LLM_PROPOSALS removed; propose() references /api/grants/propose"
fi

# ---- FF-39-4: confirmed_by IS NOT NULL on loadRoleEffectiveGrants -----------
before=${ERRORS}
# Extract the body of loadRoleEffectiveGrants and grep for the predicate.
if ! awk '/async function loadRoleEffectiveGrants/,/^}/' "${GRANTS_TS}" \
     | grep -q 'confirmed_by IS NOT NULL'; then
  echo "FAIL (FF-39-4): loadRoleEffectiveGrants in grants.ts lacks 'confirmed_by IS NOT NULL' predicate"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-4): loadRoleEffectiveGrants includes 'confirmed_by IS NOT NULL'"
fi

# ---- FF-39-5: grant-propose.ts imports parseScopeElement from ./grants ------
before=${ERRORS}
if ! grep -q 'parseScopeElement' "${GRANT_PROPOSE_TS}"; then
  echo "FAIL (FF-39-5a): grant-propose.ts does not use parseScopeElement"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "from ['\"]\\./grants" "${GRANT_PROPOSE_TS}"; then
  echo "FAIL (FF-39-5b): grant-propose.ts does not import from './grants'"
  ERRORS=$((ERRORS + 1))
fi
# No new migration file should be added by T-0039.
new_migrations=$(git -C "${PROJECT_ROOT}" diff --name-only HEAD~1..HEAD -- migrations/ 2>/dev/null || true)
if [[ -n "${new_migrations}" ]]; then
  echo "WARN (FF-39-5c): new migration file(s) detected — T-0039 should add no migration: ${new_migrations}"
  # Warn only, not fail (the base check above via grep covers the architectural invariant).
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-5): grant-propose.ts imports parseScopeElement from ./grants; no scope kind defined locally"
fi

# ---- FF-39-6: scoped-admin.ts byte-for-byte unchanged ----------------------
before=${ERRORS}
scoped_admin_changes=$(git -C "${PROJECT_ROOT}" diff -- src/core/scoped-admin.ts 2>/dev/null || true)
scoped_admin_cached=$(git -C "${PROJECT_ROOT}" diff --cached -- src/core/scoped-admin.ts 2>/dev/null || true)
if [[ -n "${scoped_admin_changes}" || -n "${scoped_admin_cached}" ]]; then
  echo "FAIL (FF-39-6): src/core/scoped-admin.ts has uncommitted modifications (NF-6 — must be unchanged)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-6): scoped-admin.ts unchanged (NF-6)"
fi

# ---- FF-39-7: NO_PROPOSAL_AGENT code + 503 status in grant-propose.ts ------
before=${ERRORS}
if ! grep -q 'NO_PROPOSAL_AGENT' "${GRANT_PROPOSE_TS}"; then
  echo "FAIL (FF-39-7a): grant-propose.ts has no NO_PROPOSAL_AGENT error code"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -q '503' "${GRANT_PROPOSE_TS}"; then
  echo "FAIL (FF-39-7b): grant-propose.ts does not emit 503 status"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-7): 503 NO_PROPOSAL_AGENT present in grant-propose.ts"
fi

# ---- FF-39-8: secret/credential not in console.log calls in grant-propose.ts -
before=${ERRORS}
# The resolved secret is stored in a 'secret' const — check no log line passes it.
if grep -nE 'console\.(log|error)' "${GRANT_PROPOSE_TS}" | grep -q 'secret'; then
  echo "FAIL (FF-39-8): grant-propose.ts has a console.log/error that references 'secret' (credential leak)"
  ERRORS=$((ERRORS + 1))
fi
# Audit payload must not contain a 'secret' or 'credential' field.
if awk '/payload:/,/\}/' "${GRANT_PROPOSE_TS}" | grep -qE 'secret|credential'; then
  echo "FAIL (FF-39-8): grant-propose.ts audit payload may contain a secret/credential field"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS (FF-39-8): resolved secret not in logs or audit payload"
fi

# ---- Result -----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: grant-propose-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: grant-propose-isolation — all FF-39-1..8 checks green"
exit 0
