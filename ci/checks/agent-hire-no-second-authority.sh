#!/usr/bin/env bash
# FF-HIRE-3: No second authority subsystem.
# (a) The three hire-path files must not introduce *_acl / adminFlag / admin_table /
#     aclStore tokens.
# (b) src/http/agents.ts must call validateAdminDelegation at least once.

set -euo pipefail

FILES=(
  "src/http/agents.ts"
  "src/core/agent-hire.ts"
  "src/db/agent-provision.ts"
)

FAIL=0

# (a) No second-authority tokens
for F in "${FILES[@]}"; do
  if [ ! -f "$F" ]; then
    echo "FAIL FF-HIRE-3: $F not found" >&2
    FAIL=1
    continue
  fi
  MATCHES=$(grep -nE '_acl|adminFlag|admin_table|aclStore' "$F" | grep -v '^\s*//' || true)
  if [ -n "$MATCHES" ]; then
    echo "FAIL FF-HIRE-3: second-authority token in $F:" >&2
    echo "$MATCHES" >&2
    FAIL=1
  fi
done

# (b) validateAdminDelegation must be called in agents.ts
if [ -f "src/http/agents.ts" ]; then
  COUNT=$(grep -c "validateAdminDelegation" "src/http/agents.ts" || true)
  if [ "${COUNT:-0}" -lt 1 ]; then
    echo "FAIL FF-HIRE-3: validateAdminDelegation not called in src/http/agents.ts" >&2
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS FF-HIRE-3: no second-authority subsystem; validateAdminDelegation is the gate"
