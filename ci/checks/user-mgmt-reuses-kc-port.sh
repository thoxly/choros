#!/usr/bin/env bash
# FF-583-8 (T-0583, ADR-T0583-user-mgmt §5/N5): user-mgmt.ts REUSES the existing
# KeycloakUserPort — it must NOT contain its own KC-admin HTTP calls (no second
# KC-integration module), and the T-0619 reader-grant helper must be the SAME
# shared implementation imported by both rights-intents.ts and user-mgmt.ts.
#
# (a) src/http/user-mgmt.ts has no literal '/admin/realms' (no direct KC HTTP call).
# (b) src/http/user-mgmt.ts imports KeycloakUserPort from ../keycloak/admin-port.js.
# (c) src/core/reader-grant.ts exists and exports ensureReaderRoleAndAssignHuman.
# (d) BOTH src/http/rights-intents.ts and src/http/user-mgmt.ts import
#     ensureReaderRoleAndAssignHuman from ../core/reader-grant.js (one shared impl).
# (e) src/http/rights-intents.ts no longer DEFINES ensureReaderRoleAndAssignHuman
#     itself (it must be an import, not a redeclaration — proves the extraction).

set -euo pipefail

FAIL=0

USER_MGMT="src/http/user-mgmt.ts"
READER_GRANT="src/core/reader-grant.ts"
RIGHTS_INTENTS="src/http/rights-intents.ts"

if [ ! -f "$USER_MGMT" ]; then
  echo "FAIL FF-583-8: $USER_MGMT not found" >&2
  exit 1
fi

# (a) no literal '/admin/realms' KC HTTP path in user-mgmt.ts
if grep -q "/admin/realms" "$USER_MGMT"; then
  echo "FAIL FF-583-8: $USER_MGMT contains a literal '/admin/realms' — it must not make its own KC HTTP calls" >&2
  FAIL=1
fi

# (b) imports KeycloakUserPort from the existing admin-port module
if ! grep -q "KeycloakUserPort" "$USER_MGMT" || ! grep -q "keycloak/admin-port" "$USER_MGMT"; then
  echo "FAIL FF-583-8: $USER_MGMT does not import KeycloakUserPort from ../keycloak/admin-port.js" >&2
  FAIL=1
fi

# (c) shared reader-grant module exists and exports the helper
if [ ! -f "$READER_GRANT" ]; then
  echo "FAIL FF-583-8: $READER_GRANT not found (shared hire-flow reader-grant helper)" >&2
  FAIL=1
else
  if ! grep -q "export async function ensureReaderRoleAndAssignHuman" "$READER_GRANT"; then
    echo "FAIL FF-583-8: $READER_GRANT does not export ensureReaderRoleAndAssignHuman" >&2
    FAIL=1
  fi
fi

# (d) both callers import from the shared module
if ! grep -q "ensureReaderRoleAndAssignHuman.*core/reader-grant" "$USER_MGMT"; then
  echo "FAIL FF-583-8: $USER_MGMT does not import ensureReaderRoleAndAssignHuman from core/reader-grant.js" >&2
  FAIL=1
fi
if [ -f "$RIGHTS_INTENTS" ]; then
  if ! grep -q "ensureReaderRoleAndAssignHuman.*core/reader-grant" "$RIGHTS_INTENTS"; then
    echo "FAIL FF-583-8: $RIGHTS_INTENTS does not import ensureReaderRoleAndAssignHuman from core/reader-grant.js" >&2
    FAIL=1
  fi
  # (e) rights-intents.ts must NOT redeclare the function itself.
  if grep -qE "^\s*(async\s+)?function\s+ensureReaderRoleAndAssignHuman" "$RIGHTS_INTENTS"; then
    echo "FAIL FF-583-8: $RIGHTS_INTENTS still DEFINES ensureReaderRoleAndAssignHuman (extraction incomplete — two implementations exist)" >&2
    FAIL=1
  fi
else
  echo "FAIL FF-583-8: $RIGHTS_INTENTS not found" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS FF-583-8: user-mgmt.ts reuses KeycloakUserPort (no own KC HTTP calls); reader-grant helper is a single shared implementation"
