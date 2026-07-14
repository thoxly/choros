#!/usr/bin/env bash
# FF-LP-1 (T-0233 AC-1) — LlmPort injectable: core owns the type, adapters own the impl.
#
# Rules:
#   (a) src/core/llm-port.ts exports LlmPort and dormantLlmPort.
#   (b) src/core/** and src/runtime/legal-precheck/** have NO SDK imports
#       (openai / @anthropic / fetch-to-provider / axios).
#   (c) runLegalPrecheck accepts `llm: LlmPort` in its deps (DI pattern).
#
# Exit 0 on all pass; non-zero on any violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # Positive self-test: "from \"openai\"" is detectable.
  PLANTED='import { OpenAI } from "openai";'
  if printf '%s\n' "${PLANTED}" | grep -qE 'from "(openai|@anthropic|axios)"'; then
    echo "PASS self-test: SDK import pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: SDK import detector failed"
  exit 1
fi

echo "[FF-LP-1] llm-port-injectable: LlmPort is a pure injectable type"

# (a) Core file exists and exports LlmPort + dormantLlmPort.
CORE_FILE="${SRC}/core/llm-port.ts"
if [[ ! -f "${CORE_FILE}" ]]; then
  echo "FAIL FF-LP-1(a): ${CORE_FILE} not found"
  ERRORS=$((ERRORS + 1))
else
  if ! grep -q "export interface LlmPort" "${CORE_FILE}"; then
    echo "FAIL FF-LP-1(a): LlmPort interface not exported from ${CORE_FILE}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-1(a): LlmPort exported from src/core/llm-port.ts"
  fi
  if ! grep -q "dormantLlmPort" "${CORE_FILE}"; then
    echo "FAIL FF-LP-1(a): dormantLlmPort not found in ${CORE_FILE}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-1(a): dormantLlmPort defined in src/core/llm-port.ts"
  fi
fi

# (b) No SDK imports in src/core/** or src/runtime/legal-precheck/**.
SDK_PATTERN='from "(openai|@anthropic|axios|node-fetch)"'
for DIR in "${SRC}/core" "${SRC}/runtime/legal-precheck"; do
  [[ -d "${DIR}" ]] || continue
  SDK_HITS=$(grep -rnE "${SDK_PATTERN}" "${DIR}" --include="*.ts" 2>/dev/null \
    | grep -vE "__tests__|\.test\.ts" || true)
  if [[ -n "${SDK_HITS}" ]]; then
    echo "FAIL FF-LP-1(b): SDK import found in ${DIR}:"
    echo "${SDK_HITS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-1(b): no SDK imports in ${DIR}"
  fi
done

# (c) runLegalPrecheck accepts llm: LlmPort in deps.
ORCH_FILE="${SRC}/runtime/legal-precheck/run-precheck.ts"
if [[ ! -f "${ORCH_FILE}" ]]; then
  echo "FAIL FF-LP-1(c): ${ORCH_FILE} not found"
  ERRORS=$((ERRORS + 1))
else
  if ! grep -q "llm:" "${ORCH_FILE}"; then
    echo "FAIL FF-LP-1(c): runLegalPrecheck deps does not contain 'llm:' field"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-1(c): runLegalPrecheck accepts llm port in deps"
  fi
  if ! grep -q "LlmPort" "${ORCH_FILE}"; then
    echo "FAIL FF-LP-1(c): LlmPort type not referenced in run-precheck.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-1(c): LlmPort type referenced in run-precheck.ts"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: llm-port-injectable found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: llm-port-injectable — FF-LP-1 green"
exit 0
