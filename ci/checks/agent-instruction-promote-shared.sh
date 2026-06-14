#!/usr/bin/env bash
# FF-COMP-4 (T-0123) — promote is the SHARED T-0087 mechanism, not a new one (NF-1/NF-3).
#
#   * agent_instruction is registered in CONFIG_TABLES (src/http/artifacts.ts)
#   * the DAO has NO own `SET tier = 'published'` / `tier='published'`
#   * NO new promote audit type agent.instruction.promoted anywhere in src/
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARTIFACTS="${ROOT}/src/http/artifacts.ts"
DAO="${ROOT}/src/db/agent-instruction-store.ts"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  if printf "tier='published'\n" | grep -qE "SET tier = 'published'|tier='published'"; then
    echo "PASS self-test: own-promote pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: own-promote detector failed"
  exit 1
fi

echo "[FF-COMP-4] agent-instruction-promote-shared: promote = shared T-0087"

# 1. registered in CONFIG_TABLES.
if grep -qE '"agent_instruction"' "${ARTIFACTS}"; then
  echo "PASS FF-COMP-4: agent_instruction registered in artifacts.ts CONFIG_TABLES"
else
  echo "FAIL FF-COMP-4: agent_instruction not present in src/http/artifacts.ts (CONFIG_TABLES)"
  ERRORS=$((ERRORS + 1))
fi

# 2. DAO has no own publish-write.
if [[ -f "${DAO}" ]]; then
  # Strip line comments / jsdoc prose so the documented BAN does not self-trip.
  DAO_CODE="$(sed -E 's|//.*$||; s|^[[:space:]]*\*.*$||' "${DAO}")"
  if printf '%s' "${DAO_CODE}" | grep -qE "SET tier = 'published'|tier='published'|tier = 'published'"; then
    echo "FAIL FF-COMP-4: DAO assigns tier='published' (must go through promoteTier only)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-COMP-4: DAO never writes tier='published'"
  fi
else
  echo "FAIL FF-COMP-4: ${DAO} does not exist"
  ERRORS=$((ERRORS + 1))
fi

# 3. no new promote audit type anywhere in src/.
if grep -rqE "agent\.instruction\.promoted" "${ROOT}/src"; then
  echo "FAIL FF-COMP-4: a new promote audit type agent.instruction.promoted exists in src/"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-COMP-4: no parallel agent.instruction.promoted audit type"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-promote-shared found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-promote-shared — all checks green"
exit 0
