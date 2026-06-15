#!/usr/bin/env bash
# FF-LP-3 (T-0233 AC-4/AC-12) — no direct network call to LLM in core or orchestrator.
#
# Rules:
#   (a) src/core/llm-port.ts and src/core/agent-precheck-motor.ts have NO fetch/https.request/
#       new OpenAI/XMLHttpRequest calls (network is in adapters only).
#   (b) src/runtime/legal-precheck/run-precheck.ts has NO direct network call (delegates to port).
#   (c) dormantLlmPort throws LlmDormantError (verified by pattern, not runtime).
#
# Exit 0 on all pass; non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  PLANTED='const r = await fetch("https://api.openai.com/v1/chat/completions");'
  if printf '%s\n' "${PLANTED}" | grep -qE '(fetch\(|https\.request|new OpenAI|XMLHttpRequest)'; then
    echo "PASS self-test: network call pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: network call detector broken"
  exit 1
fi

echo "[FF-LP-3] precheck-no-network-in-core: no direct LLM network call in core/orchestrator"

# (a) Core files must not have fetch/https.request/new OpenAI.
CORE_FILES=(
  "${SRC}/core/llm-port.ts"
  "${SRC}/core/agent-precheck-motor.ts"
)
NET_PATTERN='(fetch\(|https\.request|new OpenAI\b|XMLHttpRequest)'

for FILE in "${CORE_FILES[@]}"; do
  [[ -f "${FILE}" ]] || continue
  NET_HITS=$(grep -nE "${NET_PATTERN}" "${FILE}" 2>/dev/null \
    | grep -vE '^\s*//' || true)
  if [[ -n "${NET_HITS}" ]]; then
    echo "FAIL FF-LP-3(a): direct network call in $(basename "${FILE}"):"
    echo "${NET_HITS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-3(a): no network call in $(basename "${FILE}")"
  fi
done

# (b) Orchestrator must not make direct network calls (only port.complete()).
ORCH="${SRC}/runtime/legal-precheck/run-precheck.ts"
if [[ -f "${ORCH}" ]]; then
  NET_HITS=$(grep -nE "${NET_PATTERN}" "${ORCH}" 2>/dev/null \
    | grep -vE '^\s*//' || true)
  if [[ -n "${NET_HITS}" ]]; then
    echo "FAIL FF-LP-3(b): direct network call in run-precheck.ts:"
    echo "${NET_HITS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-3(b): no direct network call in run-precheck.ts"
  fi
fi

# (c) dormantLlmPort must reference LlmDormantError throw.
LLM_PORT="${SRC}/core/llm-port.ts"
if [[ -f "${LLM_PORT}" ]]; then
  if ! grep -q "LlmDormantError" "${LLM_PORT}"; then
    echo "FAIL FF-LP-3(c): LlmDormantError not defined/thrown in llm-port.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-3(c): dormantLlmPort references LlmDormantError"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: precheck-no-network-in-core found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: precheck-no-network-in-core — FF-LP-3 / AC-4/AC-12 green"
exit 0
