#!/usr/bin/env bash
# FF-COMP-8 (T-0123) — semantic changelog (AC-7).
#
# The outward changelog is a SemanticChange[] from diffInstruction — never a raw
# text-diff. The human-facing changelog must NOT serialize the full instruction_text:
# for the text field only the fact-of-change is reported (changed: true), never the body.
#
#   * diffInstruction exists in src/core/agent-instruction.ts
#   * the instruction_text branch of diffInstruction reports a change FLAG, not the
#     body (the SemanticChange union for instruction_text carries `changed`, not the
#     text value); the audit payload carries `changes`, not instructionText
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE="${ROOT}/src/core/agent-instruction.ts"
DAO="${ROOT}/src/db/agent-instruction-store.ts"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  if printf 'field: "instruction_text"; changed: true\n' | grep -qE "instruction_text.*changed"; then
    echo "PASS self-test: change-flag (not body) pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: change-flag detector failed"
  exit 1
fi

echo "[FF-COMP-8] agent-instruction-semantic-changelog: semantic, not raw text-diff"

if [[ ! -f "${CORE}" ]]; then
  echo "FAIL FF-COMP-8: ${CORE} does not exist"
  exit 1
fi

# 1. diffInstruction exists.
if grep -qE "function diffInstruction|diffInstruction\s*\(" "${CORE}"; then
  echo "PASS FF-COMP-8: diffInstruction present"
else
  echo "FAIL FF-COMP-8: diffInstruction not found in core"
  ERRORS=$((ERRORS + 1))
fi

# 2. the instruction_text change is reported as a FLAG (changed), not the body.
#    The SemanticChange variant for instruction_text must carry `changed`.
if grep -qE "instruction_text.*changed|changed.*instruction_text" "${CORE}"; then
  echo "PASS FF-COMP-8: instruction_text change is a flag (changed), not the body"
else
  echo "FAIL FF-COMP-8: instruction_text change does not use a change-flag (risk of leaking the body)"
  ERRORS=$((ERRORS + 1))
fi

# 3. the audit payload carries the semantic `changes`, not the raw instructionText.
if [[ -f "${DAO}" ]]; then
  if grep -qE "payload:.*changes|changes\s*}" "${DAO}"; then
    echo "PASS FF-COMP-8: draft audit payload carries the semantic changes set"
  else
    echo "FAIL FF-COMP-8: draft audit payload does not carry the semantic changes set"
    ERRORS=$((ERRORS + 1))
  fi
  # The audit encoders must NOT put the raw instructionText into the payload.
  DAO_CODE="$(sed -E 's|//.*$||; s|^[[:space:]]*\*.*$||' "${DAO}")"
  if printf '%s' "${DAO_CODE}" | grep -qE "payload:[^}]*instructionText|instruction_text:[[:space:]]*draft\.instructionText"; then
    echo "FAIL FF-COMP-8: an audit payload serializes the raw instruction_text body (AC-7 violation)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-COMP-8: no audit payload serializes the raw instruction_text body"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-semantic-changelog found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-semantic-changelog — all checks green"
exit 0
