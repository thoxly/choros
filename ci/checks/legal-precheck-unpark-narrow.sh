#!/usr/bin/env bash
# FF-LP-4 (T-0233 AC-11/NF-4) — agent_instruction reads in runtime are a STRICT SUBSET
# of src/runtime/legal-precheck/.
#
# Assertion: every runtime reference to agent_instruction (or agent-instruction) outside
# of the authoring/test allowlist is ONLY under src/runtime/legal-precheck/.
# Any hit under src/core/engine, src/worker, src/adapters, src/bridge-*, or other
# src/runtime/** paths → FAIL.
#
# This check is additive to (and complements) the existing FF-COMP-6 check
# (agent-instruction-runtime-dormant.sh) — that check uses an ALLOWED_RE that now
# includes src/runtime/legal-precheck/. This check asserts the POSITIVE claim:
# the only runtime path that reads agent_instruction IS src/runtime/legal-precheck/.
#
# Supports --self-test with a negative probe (hit in src/worker/ → FAIL correctly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

# Files/paths that are ALLOWED to reference agent_instruction (authoring + allowlist).
# Tests and the runtime legal-precheck path are allowed.
ALLOWED_RE='src/db/agent-instruction-store\.ts|src/core/agent-instruction\.ts|src/http/artifacts\.ts|src/runtime/legal-precheck/|__tests__|\.test\.ts'

if [[ "${1:-}" == "--self-test" ]]; then
  # Negative self-test: a hit in src/worker/ must be detected as a violation.
  TMP_DIR=$(mktemp -d)
  TMP_WORKER="${TMP_DIR}/src/worker"
  mkdir -p "${TMP_WORKER}"
  printf 'import { readPublished } from "../../db/agent-instruction-store.js";\n' \
    > "${TMP_WORKER}/bad-runtime.ts"

  # Check if this planted violation would be caught.
  PLANTED_HITS=$(grep -rlE "agent_instruction|agent-instruction" "${TMP_DIR}/src" 2>/dev/null \
    | grep -vE "${ALLOWED_RE}" || true)

  rm -rf "${TMP_DIR}"

  if [[ -n "${PLANTED_HITS}" ]]; then
    echo "PASS self-test: planted violation in src/worker/ correctly detected"
    exit 0
  fi
  echo "FAIL self-test: planted violation was NOT detected — the check is broken"
  exit 1
fi

echo "[FF-LP-4] legal-precheck-unpark-narrow: agent_instruction runtime reads ⊆ src/runtime/legal-precheck/"

# Runtime paths that must be checked (same set as FF-COMP-6).
RUNTIME_PATHS=(
  "${SRC}/core/engine"
  "${SRC}/worker"
  "${SRC}/bridge-runner.ts"
  "${SRC}/bridge-smoke-runner.ts"
  "${SRC}/adapters"
  "${SRC}/runtime"
)

for P in "${RUNTIME_PATHS[@]}"; do
  [[ -e "${P}" ]] || continue
  HITS=$(grep -rlE "agent_instruction|agent-instruction" "${P}" 2>/dev/null \
    | grep -vE "${ALLOWED_RE}" || true)
  if [[ -n "${HITS}" ]]; then
    echo "FAIL FF-LP-4: agent_instruction read outside allowed paths:"
    echo "${HITS}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS FF-LP-4: agent_instruction runtime reads are confined to src/runtime/legal-precheck/"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: legal-precheck-unpark-narrow found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: legal-precheck-unpark-narrow — FF-LP-4 / AC-11/NF-4 green"
exit 0
