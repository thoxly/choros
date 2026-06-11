#!/usr/bin/env bash
# FF-6 (static-now, AC-20): fail-fast config validation.
# - CHOROS_AUTH_MODE=keycloak without KEYCLOAK_URL/KC_ISSUER → assertKeycloakConfig throws (exit 1)
# - CHOROS_AUTH_MODE=keycloak with KEYCLOAK_URL set → no throw (exit 0)
# - CHOROS_AUTH_MODE=dev (default) → assertKeycloakConfig is a no-op (exit 0)
#
# Requires tsc build to be present (dist/ must exist).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "[FF-6] Checking assertKeycloakConfig fail-fast (AC-20)..."

FAIL=0

# Ensure build exists
if [[ ! -f "${ROOT}/dist/http/auth.js" ]]; then
  echo "  Building tsc first..."
  cd "${ROOT}" && npm run build > /dev/null 2>&1
fi

cd "${ROOT}"

# Test 1: keycloak mode without KEYCLOAK_URL or KC_ISSUER → must throw
RESULT=$(CHOROS_AUTH_MODE=keycloak node --input-type=module <<'EOF' 2>&1; echo "exit:$?"
import { assertKeycloakConfig } from './dist/http/auth.js';
try {
  assertKeycloakConfig();
  console.log('no-throw');
} catch (e) {
  console.log('threw:' + e.message);
}
EOF
)
if echo "$RESULT" | grep -q "threw:"; then
  echo "  [OK] keycloak mode without KEYCLOAK_URL throws error (fail-fast confirmed)"
else
  echo "  FAIL: assertKeycloakConfig did NOT throw in keycloak mode without KEYCLOAK_URL" >&2
  echo "  Output: $RESULT" >&2
  FAIL=1
fi

# Test 2: keycloak mode WITH KEYCLOAK_URL → must NOT throw
RESULT2=$(CHOROS_AUTH_MODE=keycloak KEYCLOAK_URL=http://keycloak:8180 node --input-type=module <<'EOF' 2>&1; echo "exit:$?"
import { assertKeycloakConfig } from './dist/http/auth.js';
try {
  assertKeycloakConfig();
  console.log('no-throw');
} catch (e) {
  console.log('threw:' + e.message);
}
EOF
)
if echo "$RESULT2" | grep -q "no-throw"; then
  echo "  [OK] keycloak mode WITH KEYCLOAK_URL does not throw"
else
  echo "  FAIL: assertKeycloakConfig threw when KEYCLOAK_URL is set" >&2
  echo "  Output: $RESULT2" >&2
  FAIL=1
fi

# Test 3: keycloak mode with KC_ISSUER override → must NOT throw
RESULT3=$(CHOROS_AUTH_MODE=keycloak KC_ISSUER=http://keycloak:8180/realms/choros node --input-type=module <<'EOF' 2>&1; echo "exit:$?"
import { assertKeycloakConfig } from './dist/http/auth.js';
try {
  assertKeycloakConfig();
  console.log('no-throw');
} catch (e) {
  console.log('threw:' + e.message);
}
EOF
)
if echo "$RESULT3" | grep -q "no-throw"; then
  echo "  [OK] keycloak mode with KC_ISSUER override does not throw"
else
  echo "  FAIL: assertKeycloakConfig threw when KC_ISSUER is set" >&2
  echo "  Output: $RESULT3" >&2
  FAIL=1
fi

# Test 4: dev mode (default) → no-op
RESULT4=$(node --input-type=module <<'EOF' 2>&1; echo "exit:$?"
import { assertKeycloakConfig } from './dist/http/auth.js';
try {
  assertKeycloakConfig();
  console.log('no-throw');
} catch (e) {
  console.log('threw:' + e.message);
}
EOF
)
if echo "$RESULT4" | grep -q "no-throw"; then
  echo "  [OK] dev mode (default): assertKeycloakConfig is no-op"
else
  echo "  FAIL: assertKeycloakConfig threw in dev mode (should be no-op)" >&2
  echo "  Output: $RESULT4" >&2
  FAIL=1
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-6] FAIL: fail-fast config validation not working correctly." >&2
  exit 1
fi

echo "[FF-6] PASS: assertKeycloakConfig fail-fast working correctly."
