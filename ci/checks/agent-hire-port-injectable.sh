#!/usr/bin/env bash
# FF-HIRE-6: Keycloak port is injectable.
# (a) Both adapter files exist.
# (b) src/core/agent-hire.ts imports no pg / node:http / http module.
# (c) src/http/agents.ts accepts KeycloakAdminPort as a parameter.

set -euo pipefail

FAIL=0

# (a) Both adapter files must exist
for F in "src/keycloak/admin-port.ts" "src/keycloak/fake-admin-port.ts"; do
  if [ ! -f "$F" ]; then
    echo "FAIL FF-HIRE-6: $F not found" >&2
    FAIL=1
  fi
done

# (b) agent-hire.ts must not import pg / node:http / http
if [ -f "src/core/agent-hire.ts" ]; then
  BAD=$(grep -nE "from ['\"]((pg)|(node:http)|(http))['\"]" "src/core/agent-hire.ts" || true)
  if [ -n "$BAD" ]; then
    echo "FAIL FF-HIRE-6: src/core/agent-hire.ts imports pg/node:http/http (must be pure):" >&2
    echo "$BAD" >&2
    FAIL=1
  fi
else
  echo "FAIL FF-HIRE-6: src/core/agent-hire.ts not found" >&2
  FAIL=1
fi

# (c) agents.ts must reference KeycloakAdminPort (port is a route parameter)
if [ -f "src/http/agents.ts" ]; then
  COUNT=$(grep -c "KeycloakAdminPort" "src/http/agents.ts" || true)
  if [ "${COUNT:-0}" -lt 1 ]; then
    echo "FAIL FF-HIRE-6: KeycloakAdminPort not referenced in src/http/agents.ts" >&2
    FAIL=1
  fi
else
  echo "FAIL FF-HIRE-6: src/http/agents.ts not found" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS FF-HIRE-6: KC port is injectable (files exist, core is pure, port in route params)"
