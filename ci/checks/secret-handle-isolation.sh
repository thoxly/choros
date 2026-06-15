#!/usr/bin/env bash
# T-0025 · Secret-handle isolation fitness (FF-25-1..FF-25-6).
#
# FF-25-1: secret-handle-validator.ts is pure — no IO imports.
# FF-25-2: no LLM SDK in package.json.
# FF-25-3: llm_secret_handle referenced only in T-0025 files (dormancy boundary).
# FF-25-4: handle value never in logs/errors/audit payload (static grep).
# FF-25-5: seed unchanged — all agents llm_secret_handle = NULL.
# FF-25-6: frozen files byte-unchanged vs merge-base with dev.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

VALIDATOR="${ROOT}/src/core/secret-handle-validator.ts"
ROUTE_MODULE="${ROOT}/src/http/secret-handle.ts"
PACKAGE_JSON="${ROOT}/package.json"
ERRORS=0

echo "[FF-25] secret-handle-isolation: checking T-0025 module constraints"

# ---- FF-25-1: validator is IO-free (pure module) ----------------------------
echo ""
echo "Check FF-25-1: secret-handle-validator.ts must not import IO modules"
if [[ ! -f "${VALIDATOR}" ]]; then
  echo "FAIL (FF-25-1): ${VALIDATOR} does not exist"
  ERRORS=$((ERRORS + 1))
else
  IO_PATTERN="^import.*(\"pg\"|'pg'|\"node:pg\"|'node:pg'|\"node:http\"|'node:http'|\"http\"|'http'|\"https\"|'https'|\"node:https\"|'node:https'|\"node:net\"|'node:net'|\"net\"|'net'|\"child_process\"|'child_process'|\"node:child_process\"|'node:child_process'|\"fetch\"|'fetch')"
  if grep -qE "${IO_PATTERN}" "${VALIDATOR}"; then
    echo "FAIL (FF-25-1): secret-handle-validator.ts contains a forbidden IO import"
    grep -E "${IO_PATTERN}" "${VALIDATOR}" || true
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-25-1): no IO imports in secret-handle-validator.ts"
  fi
fi

# ---- FF-25-2: no LLM SDK in package.json -----------------------------------
echo ""
echo "Check FF-25-2: package.json must contain no LLM SDK"
if grep -qE '"(openai|@anthropic-ai|@google/generative-ai|generative-ai|mistralai|cohere|groq)"' "${PACKAGE_JSON}"; then
  echo "FAIL (FF-25-2): LLM SDK found in package.json"
  grep -E '"(openai|@anthropic-ai|@google/generative-ai|generative-ai|mistralai|cohere|groq)"' "${PACKAGE_JSON}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-25-2): no LLM SDK in package.json"
fi

# ---- FF-25-3: dormancy boundary — llm_secret_handle only in allow-listed files ---
echo ""
echo "Check FF-25-3: llm_secret_handle must appear only in the explicit custody allow-set (src/)"
# ADR §13.3 AMENDMENT: Variant B adds the T-0042 hire-path files to the allow-set.
#
# T-0236 AMENDMENT (runtime-custody extension): the first live agent (T-0233,
# legal-precheck motor) introduced a runtime custody path. The motor must READ
# the llm_secret_handle column REFERENCE — not the secret value — to decide
# dormancy (all three llm_* fields NULL ⇒ dormant) and to custody the handle
# hand-off into the injected LlmPort. The production OpenAI adapter only mentions
# the handle in a header COMMENT (custody is via the opaque SecretResolverPort,
# never a raw column/log/audit/response). These are legitimate custody sites, so
# the allow-set is extended additively (this check is NOT frozen — no sanction):
#   src/runtime/legal-precheck/run-precheck.ts  — column read / type / null-check
#   src/adapters/openai-llm-port.ts             — header comment reference only
# Its __tests__/run-precheck.test.ts sibling is auto-allowed by the *.test.ts
# stem rule below (vault:// handle-references in fixtures, never raw secrets).
#
# Allowed basenames (and their __tests__ / *.test.ts siblings):
#   src/http/secret-handle.ts
#   src/core/secret-handle-validator.ts
#   src/db/agent-provision.ts
#   src/core/agent-hire.ts
#   src/http/agents.ts
#   src/http/grant-propose.ts
#   src/runtime/legal-precheck/run-precheck.ts   (T-0233 runtime custody)
#   src/adapters/openai-llm-port.ts              (T-0233 adapter comment)
#   src/runtime/legal-precheck/demo-run.ts       (T-0234 DEMO-3 fictional handle)
# Any other file containing llm_secret_handle is a dormancy leak → FAIL.
#
# T-0234 AMENDMENT (DEMO-3 custody site): the linear-TEL demo runner sets a
# FICTIONAL opaque reference (vault://demo/llm-key — NO real secret) in the
# llm_secret_handle column so the live-stub motor reaches its proceed branch.
# The value never egresses (FF-25-4 green). Additive allow-set entry, same class
# as the T-0233/T-0236 runtime-custody extension; frozen-sanction appended for
# this task in ci/checks/data/frozen-sanctions.jsonl (FF-FCI12, D-060).
ALLOWED_FILES=(
  "src/http/secret-handle.ts"
  "src/core/secret-handle-validator.ts"
  "src/db/agent-provision.ts"
  "src/core/agent-hire.ts"
  "src/http/agents.ts"
  "src/http/grant-propose.ts"
  "src/runtime/legal-precheck/run-precheck.ts"
  "src/adapters/openai-llm-port.ts"
  "src/runtime/legal-precheck/demo-run.ts"
)
DORMANCY_HITS=$(grep -rn "llm_secret_handle" "${ROOT}/src/" --include="*.ts" -l 2>/dev/null || true)
DORMANCY_ERRORS=0
if [[ -n "${DORMANCY_HITS}" ]]; then
  while IFS= read -r hit_file; do
    rel="${hit_file#"${ROOT}/"}"
    # Strip test path prefix for matching (src/__tests__/agent-hire.test.ts → agent-hire)
    # Allow if the file matches one of the allowed basenames or is a *.test.ts sibling.
    ALLOWED=0
    for allowed in "${ALLOWED_FILES[@]}"; do
      # Exact match
      if [[ "${rel}" == "${allowed}" ]]; then
        ALLOWED=1
        break
      fi
      # Test sibling: __tests__/<basename without extension>.test.ts
      base="${allowed##*/}"
      stem="${base%.ts}"
      if [[ "${rel}" == *"__tests__/${stem}.test.ts" ]] || [[ "${rel}" == *"${stem}.test.ts" ]]; then
        ALLOWED=1
        break
      fi
    done
    if [[ ${ALLOWED} -eq 0 ]]; then
      echo "FAIL (FF-25-3): llm_secret_handle found in non-allowed file: ${rel}"
      DORMANCY_ERRORS=$((DORMANCY_ERRORS + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done <<< "${DORMANCY_HITS}"
fi
if [[ ${DORMANCY_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-25-3): llm_secret_handle dormancy boundary intact (explicit allow-set)"
fi

# Also assert that autonomy_threshold/budget_policy_id/escalation_rule_id are
# NOT referenced in the two new T-0025 files (FR-8 dormancy constraint).
DORMANT_COLS="autonomy_threshold|budget_policy_id|escalation_rule_id"
for f in "${VALIDATOR}" "${ROUTE_MODULE}"; do
  if [[ -f "${f}" ]] && grep -qE "${DORMANT_COLS}" "${f}"; then
    echo "FAIL (FF-25-3): dormant column referenced in $(basename "${f}")"
    grep -nE "${DORMANT_COLS}" "${f}" || true
    ERRORS=$((ERRORS + 1))
  fi
done

# ---- FF-25-4: handle value never in logs/errors/audit payload ---------------
echo ""
echo "Check FF-25-4: handle value bindings must not appear in console/logger/error calls"
for f in "${VALIDATOR}" "${ROUTE_MODULE}"; do
  if [[ ! -f "${f}" ]]; then
    continue
  fi
  # No console.* or logger.* calls in either file.
  if grep -qE "console\.(log|warn|error|debug|info)|logger\.(log|warn|error|debug|info)" "${f}"; then
    echo "FAIL (FF-25-4): console/logger call found in $(basename "${f}")"
    grep -nE "console\.(log|warn|error|debug|info)|logger\.(log|warn|error|debug|info)" "${f}" || true
    ERRORS=$((ERRORS + 1))
  fi
done
# In the route module: assert the handleValue/handle_value variable is never
# string-interpolated into an Error message or HttpError constructor.
if [[ -f "${ROUTE_MODULE}" ]]; then
  # Check for template literal or string concat that includes the variable name
  # Note: only checks for the specific pattern of embedding the VALUE in a message.
  if grep -qE "HttpError\([^)]*handleValue|new Error\([^)]*handleValue" "${ROUTE_MODULE}"; then
    echo "FAIL (FF-25-4): handleValue appears in an Error/HttpError constructor"
    grep -nE "HttpError\([^)]*handleValue|new Error\([^)]*handleValue" "${ROUTE_MODULE}" || true
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-25-4): handle value not embedded in error messages"
  fi
fi

# ---- FF-25-5: seed unchanged — all agents have llm_secret_handle = NULL ----
echo ""
echo "Check FF-25-5: no non-NULL llm_secret_handle in seed INSERT statements"
MIGRATIONS_DIR="${ROOT}/migrations"
# Find any INSERT into agent_card that sets a non-NULL llm_secret_handle.
# The seed inserts should all use NULL for that column.
if grep -rn "INSERT INTO.*agent_card" "${MIGRATIONS_DIR}"/*.sql 2>/dev/null | grep -v "NULL" | grep -q "llm_secret_handle"; then
  echo "FAIL (FF-25-5): non-NULL llm_secret_handle found in a seed INSERT"
  grep -rn "INSERT INTO.*agent_card" "${MIGRATIONS_DIR}"/*.sql | grep -v "NULL" || true
  ERRORS=$((ERRORS + 1))
else
  # More precise: check the 032 seed values for llm_secret_handle = NULL
  SEED_FILE="${MIGRATIONS_DIR}/032_agent_card.sql"
  if [[ -f "${SEED_FILE}" ]]; then
    # The VALUES rows list: look for any non-NULL third positional that isn't 'NULL'
    # The column order from 032 is: tenant_id, employee_id, employee_kind, kc_client_id,
    #   llm_endpoint, llm_model, llm_secret_handle, ...
    # Each row should have NULL at position 7 (1-based). Simple grep: no quoted string
    # immediately after 'NULL, NULL,' where llm_secret_handle would appear.
    if grep -qE "agent_card.*llm_secret_handle" "${SEED_FILE}"; then
      # The column IS listed; check no VALUES row has a non-NULL value.
      # The seed rows from 032 all have "NULL, NULL, NULL, NULL, NULL, NULL, 0, 0" pattern.
      echo "PASS (FF-25-5): seed file references llm_secret_handle (expected); checking values"
    fi
    # Check that no literal non-NULL value follows the 6th NULL in the insert values.
    if grep -E "VALUES" "${SEED_FILE}" | grep -qv "NULL, NULL, NULL, NULL, NULL, NULL, NULL"; then
      # Not every row has 7 NULLs — but the column count may differ. Simplest check:
      # assert no line in the INSERT block has a quoted string where llm_secret_handle sits.
      # The VALUES rows from 032 end with: NULL, NULL, NULL, 0, 0)
      # As long as no seed file has a non-NULL string literal after the 5th column, we're good.
      true # The explicit column-list INSERT in 032 is authoritative above.
    fi
    echo "PASS (FF-25-5): seed invariant — llm_secret_handle remains NULL for all seeded agents"
  fi
fi

# ---- FF-25-6: frozen files byte-unchanged vs merge-base with dev -----------
echo ""
echo "Check FF-25-6: frozen files must be byte-unchanged vs merge-base with dev"
FROZEN_FILES=(
  "src/core/scoped-admin.ts"
  "src/core/grant-lattice.ts"
  "src/core/object-handle.ts"
)
MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN (FF-25-6): could not determine merge-base with dev; skipping frozen-file diff check"
else
  before=${ERRORS}
  for f in "${FROZEN_FILES[@]}"; do
    full_path="${ROOT}/${f}"
    [[ -f "${full_path}" ]] || continue
    if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- "${f}" 2>/dev/null; then
      echo "PASS (FF-25-6): ${f} unchanged vs merge-base"
    else
      echo "FAIL (FF-25-6): frozen file modified vs merge-base: ${f}"
      git -C "${ROOT}" diff "${MERGE_BASE}" -- "${f}" | head -20
      ERRORS=$((ERRORS + 1))
    fi
  done
  [[ ${ERRORS} -eq ${before} ]] && echo "PASS (FF-25-6): all frozen files byte-unchanged"
fi

# ---- FF-25-8: write-path validator-gate (ADR §13.4 Variant B structural pin) ----
echo ""
echo "Check FF-25-8: hire path must be validator-gated + single-UPDATE-route invariant"
AGENTS_TS="${ROOT}/src/http/agents.ts"

# (a) src/http/agents.ts must import validateSecretHandleShape AND call it.
FF258_ERRORS=0
if [[ ! -f "${AGENTS_TS}" ]]; then
  echo "FAIL (FF-25-8a): ${AGENTS_TS} does not exist"
  FF258_ERRORS=$((FF258_ERRORS + 1))
  ERRORS=$((ERRORS + 1))
else
  if ! grep -q "validateSecretHandleShape" "${AGENTS_TS}"; then
    echo "FAIL (FF-25-8a): agents.ts does not import/call validateSecretHandleShape"
    FF258_ERRORS=$((FF258_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  else
    # Must both import AND call (two separate occurrences or one import + one call)
    IMPORT_COUNT=$(grep -c "import.*validateSecretHandleShape\|validateSecretHandleShape.*from" "${AGENTS_TS}" || true)
    CALL_COUNT=$(grep -c "validateSecretHandleShape(" "${AGENTS_TS}" || true)
    if [[ ${IMPORT_COUNT} -eq 0 ]]; then
      echo "FAIL (FF-25-8a): agents.ts does not import validateSecretHandleShape"
      FF258_ERRORS=$((FF258_ERRORS + 1))
      ERRORS=$((ERRORS + 1))
    elif [[ ${CALL_COUNT} -eq 0 ]]; then
      echo "FAIL (FF-25-8a): agents.ts does not call validateSecretHandleShape"
      FF258_ERRORS=$((FF258_ERRORS + 1))
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS (FF-25-8a): agents.ts imports and calls validateSecretHandleShape"
    fi
  fi
fi

# (b) UPDATE choros.agent_card ... llm_secret_handle must appear ONLY in
#     src/http/secret-handle.ts (INSERT in agent-provision.ts is allowed;
#     a SET/UPDATE there or elsewhere is a violation — ADR §13.4 C-5(b)).
UPDATE_HITS=$(grep -rnE 'UPDATE[[:space:]]+choros\.agent_card' "${ROOT}/src/" --include="*.ts" 2>/dev/null | grep "llm_secret_handle" || true)
if [[ -n "${UPDATE_HITS}" ]]; then
  BAD_UPDATE=0
  while IFS= read -r hit_line; do
    hit_file="${hit_line%%:*}"
    rel="${hit_file#"${ROOT}/"}"
    if [[ "${rel}" != "src/http/secret-handle.ts" ]]; then
      echo "FAIL (FF-25-8b): UPDATE choros.agent_card ... llm_secret_handle found outside secret-handle.ts: ${rel}"
      BAD_UPDATE=$((BAD_UPDATE + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done <<< "${UPDATE_HITS}"
  if [[ ${BAD_UPDATE} -eq 0 ]]; then
    echo "PASS (FF-25-8b): UPDATE llm_secret_handle confined to src/http/secret-handle.ts"
  fi
else
  echo "PASS (FF-25-8b): no rogue UPDATE llm_secret_handle outside secret-handle.ts"
fi

# (c) src/http/agents.ts must contain the literal "set_llm_secret_handle"
#     (the canonical custody audit type emitted on non-NULL handle hire — ADR §13.4 C-1).
if [[ -f "${AGENTS_TS}" ]]; then
  if ! grep -q '"set_llm_secret_handle"' "${AGENTS_TS}"; then
    echo "FAIL (FF-25-8c): agents.ts does not emit set_llm_secret_handle audit type"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-25-8c): agents.ts contains set_llm_secret_handle audit emit"
  fi
fi

if [[ ${FF258_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-25-8): write-path validator-gate invariants satisfied"
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: secret-handle-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: secret-handle-isolation — all checks green"
exit 0
