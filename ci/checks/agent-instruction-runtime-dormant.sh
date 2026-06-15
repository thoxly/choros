#!/usr/bin/env bash
# FF-COMP-6 (T-0123) — runtime-dormant (AC-11).
#
# Day-1 NO runtime response-formation path reads agent_instruction. Reading it is
# allowed ONLY in the authoring DAO, the pure-core type/changelog module, the
# audit/promote registration (artifacts.ts CONFIG_TABLES), and tests.
#
# Rule (ADR §4 FF-COMP-6):
#   * any hit of agent_instruction under the runtime engine/worker paths → FAIL
#   * in src/http a hit is allowed ONLY in artifacts.ts (CONFIG_TABLES registration)
#     and dedicated authoring routes — never in a response-forming handler
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

# Runtime paths that must stay dormant (the agent's answer-formation surface).
# Directories that do not exist yet are simply skipped (day-1 the engine is unbuilt).
RUNTIME_PATHS=(
  "${SRC}/core/engine"
  "${SRC}/worker"
  "${SRC}/bridge-runner.ts"
  "${SRC}/bridge-smoke-runner.ts"
  "${SRC}/adapters"
)

# Files anywhere that ARE allowed to reference agent_instruction (authoring surface).
# T-0233 FF-LP-4: src/runtime/legal-precheck/ is the ONLY runtime path allowed to read
# agent_instruction (narrow unpark — the only live skill gate at day-1).
ALLOWED_RE='src/db/agent-instruction-store\.ts|src/core/agent-instruction\.ts|src/http/artifacts\.ts|src/runtime/legal-precheck/|__tests__|\.test\.ts'

if [[ "${1:-}" == "--self-test" ]]; then
  if printf 'SELECT * FROM choros.agent_instruction\n' | grep -qE "agent_instruction"; then
    echo "PASS self-test: agent_instruction read pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: read detector failed"
  exit 1
fi

echo "[FF-COMP-6] agent-instruction-runtime-dormant: no runtime read of agent_instruction"

# 1. Runtime engine/worker paths — any hit fails.
for p in "${RUNTIME_PATHS[@]}"; do
  [[ -e "${p}" ]] || continue
  HITS=$(grep -rlE "agent_instruction|agent-instruction" "${p}" 2>/dev/null || true)
  if [[ -n "${HITS}" ]]; then
    echo "FAIL FF-COMP-6: runtime path reads agent_instruction:"
    echo "${HITS}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS FF-COMP-6: no engine/worker/bridge runtime path reads agent_instruction"
fi

# 2. src/http — allowed only in artifacts.ts / authoring routes (allowlist).
if [[ -d "${SRC}/http" ]]; then
  HTTP_HITS=$(grep -rlE "agent_instruction|agent-instruction" "${SRC}/http" 2>/dev/null || true)
  BAD_HTTP=0
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    if printf '%s' "${f}" | grep -qE "${ALLOWED_RE}"; then
      continue
    fi
    echo "FAIL FF-COMP-6: response-forming http handler reads agent_instruction: ${f}"
    BAD_HTTP=$((BAD_HTTP + 1))
  done <<< "${HTTP_HITS}"
  if [[ ${BAD_HTTP} -eq 0 ]]; then
    echo "PASS FF-COMP-6: http reads of agent_instruction are confined to the allowlist"
  else
    ERRORS=$((ERRORS + BAD_HTTP))
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-runtime-dormant found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-runtime-dormant — all checks green"
exit 0
