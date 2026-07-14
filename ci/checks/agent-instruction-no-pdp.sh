#!/usr/bin/env bash
# FF-COMP-5 (T-0123) — rights are NOT extended (AC-8): the grant-resolver stays
# frozen and never reads the competence instruction (capability-not-text).
#
#   * src/core/grant-resolver.ts is byte-unchanged vs merge-base with dev
#   * neither grant-resolver.ts nor grant-lattice.ts references
#     agent_instruction / agent-instruction
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RESOLVER="${ROOT}/src/core/grant-resolver.ts"
LATTICE="${ROOT}/src/core/grant-lattice.ts"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  if printf 'import x from "./agent-instruction.js"\n' | grep -qE "agent_instruction|agent-instruction"; then
    echo "PASS self-test: agent-instruction reference pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: reference detector failed"
  exit 1
fi

echo "[FF-COMP-5] agent-instruction-no-pdp: grant-resolver frozen, no instruction read"

# 1. grant-resolver.ts byte-unchanged vs base.
BASE=$(git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
       || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
       || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
       || echo "")
if [[ -z "${BASE}" ]]; then
  echo "WARN FF-COMP-5: cannot determine base commit; skipping frozen diff check"
else
  CHANGED=$(git -C "${ROOT}" diff --name-only "${BASE}" -- src/core/grant-resolver.ts 2>/dev/null || true)
  if [[ -n "${CHANGED}" ]]; then
    echo "FAIL FF-COMP-5: src/core/grant-resolver.ts was modified (must stay frozen)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-COMP-5: grant-resolver.ts is byte-unchanged"
  fi
fi

# 2. no instruction reference in the PDP core.
for f in "${RESOLVER}" "${LATTICE}"; do
  [[ -f "${f}" ]] || continue
  if grep -qE "agent_instruction|agent-instruction" "${f}"; then
    echo "FAIL FF-COMP-5: ${f} references agent_instruction (PDP must not read the competence text)"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS FF-COMP-5: grant-resolver/grant-lattice do not reference agent_instruction"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-no-pdp found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-no-pdp — all checks green"
exit 0
