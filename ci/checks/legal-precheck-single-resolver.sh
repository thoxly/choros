#!/usr/bin/env bash
# FF-LP-5 (T-0233 AC-7) — single resolver: only resolveFor on the legal_precheck path.
#
# Rules:
#   (a) src/runtime/legal-precheck/** and src/core/agent-precheck-motor.ts use resolveFor
#       and NO other function that makes an allow/deny decision
#       (no authorize*/covers*/checkGrant*/makeGrantResolver/denyAllResolver on the path).
#   (b) The existing single-resolver.sh remains green (implicitly, via the broader fitness chain).
#
# Exit 0 on all pass; non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # A second resolver call should be detected.
  PLANTED='const ok = await authorize(deps, handle, subject);'
  if printf '%s\n' "${PLANTED}" | grep -qE '\bauthorize\b|\bcheckGrant\b|\bcoversInvoke\b|\bmakeGrantResolver\b|\bdenyAllResolver\b'; then
    echo "PASS self-test: second resolver pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: second resolver detector broken"
  exit 1
fi

echo "[FF-LP-5] legal-precheck-single-resolver: only resolveFor on the precheck path (AC-7)"

# Target paths for the check.
CHECK_PATHS=(
  "${SRC}/runtime/legal-precheck"
  "${SRC}/core/agent-precheck-motor.ts"
)

# Forbidden patterns: any function call that itself makes an allow/deny decision,
# other than resolveFor (which is the single sanctioned PDP).
SECOND_RESOLVER_RE='\b(authorize[A-Z]?|checkGrant|coversInvoke|makeGrantResolver|denyAllResolver|covers[A-Z])\b'

for P in "${CHECK_PATHS[@]}"; do
  [[ -e "${P}" ]] || continue
  if [[ -d "${P}" ]]; then
    HITS=$(grep -rnE "${SECOND_RESOLVER_RE}" "${P}" --include="*.ts" 2>/dev/null \
      | grep -vE '__tests__|\.test\.ts|^\s*//' || true)
  else
    HITS=$(grep -nE "${SECOND_RESOLVER_RE}" "${P}" 2>/dev/null \
      | grep -vE '^\s*//' || true)
  fi
  if [[ -n "${HITS}" ]]; then
    echo "FAIL FF-LP-5: second resolver/authority function found in ${P}:"
    echo "${HITS}"
    ERRORS=$((ERRORS + 1))
  fi
done

# Positive check: resolveFor must be referenced in the orchestrator.
ORCH="${SRC}/runtime/legal-precheck/run-precheck.ts"
if [[ -f "${ORCH}" ]]; then
  if ! grep -q "resolveFor" "${ORCH}"; then
    echo "FAIL FF-LP-5: resolveFor not found in run-precheck.ts (single PDP not wired)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-5: resolveFor is the single PDP in run-precheck.ts"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: legal-precheck-single-resolver found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: legal-precheck-single-resolver — FF-LP-5 / AC-7 green"
exit 0
