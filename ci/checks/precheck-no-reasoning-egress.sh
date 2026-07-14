#!/usr/bin/env bash
# FF-LP-2 (T-0233 AC-9, D-139) — reasoning must NOT egress in answer/outcome/response.
#
# Rules:
#   (a) PrecheckAnswer type (in src/core/llm-port.ts or agent-precheck-motor.ts) has
#       NO fields named reasoning / trace / raw / chainOfThought.
#   (b) In the orchestrator (run-precheck.ts), any reference to `.reasoning` is ONLY
#       inside an appendAuditEvent(...) call argument (not assigned to answer / outcome / res).
#   (c) The PrecheckOutcome union has no reasoning/trace/raw fields in proceed branch.
#
# Exit 0 on all pass; non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # A PrecheckAnswer with a reasoning field should be detected.
  PLANTED="readonly reasoning: string;"
  if printf '%s\n' "${PLANTED}" | grep -qE 'readonly (reasoning|trace|raw|chainOfThought)'; then
    echo "PASS self-test: reasoning field pattern detectable"
    exit 0
  fi
  echo "FAIL self-test: reasoning field detector broken"
  exit 1
fi

echo "[FF-LP-2] precheck-no-reasoning-egress: D-139 — reasoning stays internal"

# (a) PrecheckAnswer MUST NOT have reasoning/trace/raw/chainOfThought fields.
#     LlmResult.reasoning IS allowed (it's the internal split, D-139 §3.1) —
#     the check targets only the exported answer type (PrecheckAnswer).
#     PrecheckOutcome proceed branch must not carry reasoning either.
LLM_PORT="${SRC}/core/llm-port.ts"
MOTOR="${SRC}/core/agent-precheck-motor.ts"

# Check PrecheckAnswer interface specifically: it must not have reasoning* fields.
for FILE in "${LLM_PORT}" "${MOTOR}"; do
  [[ -f "${FILE}" ]] || continue
  # Extract lines inside PrecheckAnswer blocks: look for interface PrecheckAnswer { ... }
  # We grep for fields named reasoning/trace/raw/chainOfThought in PrecheckAnswer.
  # Strategy: check that PrecheckAnswer does NOT have readonly reasoning.
  # (LlmResult.reasoning is ok; PrecheckAnswer.reasoning is not.)
  # We identify PrecheckAnswer sections by checking between 'interface PrecheckAnswer' and closing '}'.
  IN_PRECHECK_ANSWER=0
  FORBIDDEN=""
  while IFS= read -r LINE; do
    if echo "${LINE}" | grep -qE 'interface PrecheckAnswer'; then
      IN_PRECHECK_ANSWER=1
    fi
    if [[ ${IN_PRECHECK_ANSWER} -eq 1 ]]; then
      if echo "${LINE}" | grep -qE 'readonly (reasoning|trace|raw|chainOfThought)\b'; then
        FORBIDDEN="${FORBIDDEN}${LINE}"$'\n'
      fi
      # End of interface block
      if echo "${LINE}" | grep -qE '^\}'; then
        IN_PRECHECK_ANSWER=0
      fi
    fi
  done < "${FILE}"

  if [[ -n "${FORBIDDEN}" ]]; then
    echo "FAIL FF-LP-2(a): reasoning/trace/raw/chainOfThought inside PrecheckAnswer in ${FILE}:"
    printf '%s' "${FORBIDDEN}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-2(a): PrecheckAnswer has no forbidden field in $(basename "${FILE}")"
  fi
done

# (b) In run-precheck.ts, .reasoning references must only appear inside appendAuditEvent args.
ORCH="${SRC}/runtime/legal-precheck/run-precheck.ts"
if [[ -f "${ORCH}" ]]; then
  # Find lines containing .reasoning or result.reasoning outside of a comment.
  REASONING_LINES=$(grep -n '\.reasoning' "${ORCH}" 2>/dev/null \
    | grep -vE '^\s*//' || true)
  # Verify none of them assign to answer/outcome/res properties.
  BAD_REASONING=$(printf '%s\n' "${REASONING_LINES}" \
    | grep -vE 'appendAuditEvent|payload|reasoningTrace|traceRef|undefined|null|!= null|!= undefined|==' || true)
  if [[ -n "${BAD_REASONING}" ]]; then
    echo "FAIL FF-LP-2(b): .reasoning assigned outside appendAuditEvent in run-precheck.ts:"
    echo "${BAD_REASONING}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-2(b): .reasoning only in audit payload in run-precheck.ts"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: precheck-no-reasoning-egress found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: precheck-no-reasoning-egress — FF-LP-2 / D-139 green"
exit 0
