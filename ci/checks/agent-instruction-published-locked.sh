#!/usr/bin/env bash
# FF-COMP-7 (T-0123) — published-lock fail-closed (AC-5).
#
# The writer (saveDraft) consults assertWritable from env-tier.ts BEFORE mutating,
# and NEVER bypasses the DB trigger: it does NOT set choros.promoting (that GUC is
# the promote service's privilege alone — only artifacts.ts::promoteTier sets it).
#
#   * src/db/agent-instruction-store.ts references assertWritable
#   * src/db/agent-instruction-store.ts does NOT reference choros.promoting
#
# Exit 0 clean, non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DAO="${ROOT}/src/db/agent-instruction-store.ts"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  if printf 'await c.query("SET LOCAL choros.promoting = 1")\n' | grep -qE "choros\.promoting"; then
    echo "PASS self-test: choros.promoting bypass pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: bypass detector failed"
  exit 1
fi

echo "[FF-COMP-7] agent-instruction-published-locked: fail-closed published-lock"

if [[ ! -f "${DAO}" ]]; then
  echo "FAIL FF-COMP-7: ${DAO} does not exist"
  exit 1
fi

if grep -q "assertWritable" "${DAO}"; then
  echo "PASS FF-COMP-7: DAO consults assertWritable before mutation"
else
  echo "FAIL FF-COMP-7: DAO does not call assertWritable (published-lock app-guard missing)"
  ERRORS=$((ERRORS + 1))
fi

# The DAO must NOT set choros.promoting (would bypass the fail-closed trigger).
# Strip comments first so the documented BAN does not self-trip.
DAO_CODE="$(sed -E 's|//.*$||; s|^[[:space:]]*\*.*$||' "${DAO}")"
if printf '%s' "${DAO_CODE}" | grep -qE "choros\.promoting"; then
  echo "FAIL FF-COMP-7: DAO sets choros.promoting (only promoteTier may unlock the trigger)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-COMP-7: DAO never sets choros.promoting (trigger not bypassed)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-instruction-published-locked found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-instruction-published-locked — all checks green"
exit 0
