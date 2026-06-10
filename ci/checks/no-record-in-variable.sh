#!/usr/bin/env bash
# FF-A4: No record payload may sit in a process variable
#
# Asserts:
#  1. The ObjectHandle interface in src/core/object-handle.ts does NOT expose
#     readonly data / fields / payload / view / snapshot members.
#  2. The compile-time type-check fixture exists and has @ts-expect-error
#     assertions covering data/fields/payload/view.
#
# Engine variable-write call-site enforcement activates with T-0027/T-0028;
# this check covers the structural half (no payload accessor on the ObjectHandle
# interface specifically).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/object-handle.ts"
ERRORS=0

echo "[FF-A4] no-record-in-variable: checking ObjectHandle has no payload member"

# ---- Check 1: ObjectHandle interface must NOT declare data/fields/payload/view ----
# Use python3 for reliable interface-block extraction (avoids shell brace-counting pitfalls)

INTERFACE_CHECK=$(python3 - "${MODULE}" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    src = f.read()

# Find the ObjectHandle interface block
m = re.search(r'export interface ObjectHandle\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}', src, re.DOTALL)
if not m:
    print("MISSING_INTERFACE")
    sys.exit(0)

block = m.group(1)
forbidden = ['data', 'fields', 'payload', 'view', 'snapshot']
found = []
for name in forbidden:
    # Match "readonly <name>:" or "<name>?:" or "<name>:" as a property declaration
    if re.search(r'\breadonly\s+' + name + r'\s*[?:]', block):
        found.append(name)
    elif re.search(r'\b' + name + r'\s*\??\s*:', block):
        found.append(name)

if found:
    print("FORBIDDEN:" + ",".join(found))
else:
    print("OK")
PYEOF
)

if [[ "${INTERFACE_CHECK}" == "MISSING_INTERFACE" ]]; then
  echo "FAIL: ObjectHandle interface not found in ${MODULE}"
  ERRORS=$((ERRORS + 1))
elif [[ "${INTERFACE_CHECK}" == OK ]]; then
  echo "PASS: ObjectHandle interface has no payload-carrying member declarations"
else
  FORBIDDEN_MEMBERS="${INTERFACE_CHECK#FORBIDDEN:}"
  echo "FAIL: ObjectHandle interface declares forbidden member(s): ${FORBIDDEN_MEMBERS}"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: type-check fixture exists (compile-time proof of no payload accessor) ----

FIXTURE="${PROJECT_ROOT}/src/__tests__/object-handle.type-check.ts"
if [[ ! -f "${FIXTURE}" ]]; then
  echo "FAIL: compile-time type-check fixture missing: src/__tests__/object-handle.type-check.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: compile-time type-check fixture exists"
  # Verify it has @ts-expect-error annotations
  if ! grep -q "@ts-expect-error" "${FIXTURE}"; then
    echo "FAIL: type-check fixture missing @ts-expect-error assertions"
    ERRORS=$((ERRORS + 1))
  else
    # Check that it covers data/fields/payload/view
    FIX_ERRORS=0
    for member in data fields payload view; do
      if ! grep -q "void h\.${member}" "${FIXTURE}"; then
        echo "FAIL: type-check fixture does not assert h.${member} is invalid"
        FIX_ERRORS=$((FIX_ERRORS + 1))
      fi
    done
    ERRORS=$((ERRORS + FIX_ERRORS))
    if [[ ${FIX_ERRORS} -eq 0 ]]; then
      echo "PASS: type-check fixture covers data/fields/payload/view with @ts-expect-error"
    fi
  fi
fi

# ---- Result ------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: no-record-in-variable found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: no-record-in-variable — all checks green"
exit 0
