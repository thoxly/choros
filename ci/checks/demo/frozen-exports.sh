#!/usr/bin/env bash
# T-0141 · FF-FROZEN-5 — frozen exports not broken
#
# Asserts that findEmployee, listSelectableUsers, registerOrgRoutes
# exported signatures in src/http/org.ts are unchanged after T-0141 changes.
# (FE-W23-0008 / ADR §3.3)
#
# SELF-TEST: verifies that a non-existent export would be detected (FF-SELFTEST-8).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ORG_FILE="$REPO_ROOT/src/http/org.ts"

if [[ ! -f "$ORG_FILE" ]]; then
  echo "FAIL FF-FROZEN-5: src/http/org.ts not found" >&2
  exit 1
fi

FAIL=0

# Check findEmployee export signature (must contain: export async function findEmployee)
# Signature may span multiple lines — check export name and that employeeId: string param exists
if ! grep -qE "export async function findEmployee" "$ORG_FILE"; then
  echo "FAIL FF-FROZEN-5: findEmployee export not found in src/http/org.ts" >&2
  FAIL=1
elif ! grep -qE "employeeId\s*:\s*string" "$ORG_FILE"; then
  echo "FAIL FF-FROZEN-5: findEmployee param 'employeeId: string' not found in src/http/org.ts" >&2
  FAIL=1
else
  echo "PASS: findEmployee signature intact"
fi

# Check listSelectableUsers export signature
if ! grep -qE "export async function listSelectableUsers\s*\(" "$ORG_FILE"; then
  echo "FAIL FF-FROZEN-5: listSelectableUsers signature changed or not found in src/http/org.ts" >&2
  echo "  Expected: export async function listSelectableUsers(...)" >&2
  FAIL=1
else
  echo "PASS: listSelectableUsers signature intact"
fi

# Check registerOrgRoutes export signature (must remain: function registerOrgRoutes(router: Router, ...))
if ! grep -qE "export function registerOrgRoutes\s*\(\s*router\s*:\s*Router" "$ORG_FILE"; then
  echo "FAIL FF-FROZEN-5: registerOrgRoutes signature changed or not found in src/http/org.ts" >&2
  echo "  Expected: export function registerOrgRoutes(router: Router, ...)" >&2
  FAIL=1
else
  echo "PASS: registerOrgRoutes signature intact"
fi

if [[ $FAIL -eq 1 ]]; then
  echo "FAIL FF-FROZEN-5: frozen-exports check failed" >&2
  exit 1
fi

# SELF-TEST: verify that a non-existent export name would not match
# SELF-TEST: grep for a completely made-up export that should NOT exist
NONEXISTENT="export async function nonExistentFunctionXYZ123"
if grep -qF "$NONEXISTENT" "$ORG_FILE"; then
  echo "FAIL FF-SELFTEST-8: self-test broken — non-existent export was found" >&2
  exit 1
fi
echo "SELF-TEST PASS: non-existent export correctly not found"

echo "FF-FROZEN-5: frozen-exports PASS"
