#!/usr/bin/env bash
# FF-A5: Single resolution chokepoint
#
# Asserts that resolveHandle is the ONLY export mapping handle → record fields.
# Fails if any second "resolve"-like function or a .data getter is exported from
# src/core/object-handle.ts.
#
# Grep for: exported functions whose names contain "Resolve" or "resolve" (other
# than the canonical resolveHandle on HandleResolver) that return record fields.
# Also asserts: no exported getter named data/fields/payload on any type.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/object-handle.ts"
ERRORS=0

echo "[FF-A5] single-resolver: checking for second resolver entry-points"

# ---- Check 1: no additional exported *resolve* functions ----------------

# Allow: resolveHandle (inside HandleResolver interface) and denyAllResolver (export const)
# Deny: any additional top-level `export function *resolve*` or `export function *Resolve*`
EXTRA_RESOLVERS=$(grep -nE "^export (async )?function .*[Rr]esolve" "${MODULE}" \
  || true)

if [[ -n "${EXTRA_RESOLVERS}" ]]; then
  echo "FAIL: extra resolve-like top-level function exports found in object-handle.ts:"
  echo "${EXTRA_RESOLVERS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no extra exported resolve functions"
fi

# ---- Check 2: no exported getter/property returning record fields ------

# Patterns that indicate a second field-accessor on an exported type
FORBIDDEN_ACCESSOR_PATTERNS=(
  "get data\(\)"
  "get fields\(\)"
  "get payload\(\)"
  "get view\(\)"
  "\.data:"
  "\.fields:"
  "\.payload:"
  "\.view:"
)

for pattern in "${FORBIDDEN_ACCESSOR_PATTERNS[@]}"; do
  # Ignore lines that are clearly inside comments or are the NOTE comment
  matches=$(grep -n "${pattern}" "${MODULE}" \
    | grep -v "^\s*//" \
    | grep -v "NOTE:" \
    | grep -v "intentionally" \
    | grep -v "denied.*reason" \
    || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL: possible payload accessor found matching '${pattern}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: no payload accessor patterns found"
fi

# ---- Check 3: HandleResolver interface has exactly one method: resolveHandle ---

RESOLVER_METHODS=$(grep -cE "^\s+resolveHandle\(" "${MODULE}" || true)
EXTRA_METHODS=$(grep -E "^\s+[a-zA-Z]+Handle\(" "${MODULE}" \
  | grep -v "resolveHandle" \
  || true)

if [[ -n "${EXTRA_METHODS}" ]]; then
  echo "FAIL: HandleResolver has extra handle-related methods:"
  echo "${EXTRA_METHODS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: HandleResolver exposes only resolveHandle (count=${RESOLVER_METHODS})"
fi

# ---- Result ------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: single-resolver found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: single-resolver — all checks green"
exit 0
