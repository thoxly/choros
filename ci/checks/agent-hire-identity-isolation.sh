#!/usr/bin/env bash
# FF-HIRE-2: Identity invisible to rights layer.
# Asserts that grant-resolver.ts, grant-lattice.ts, and mcp-tool-registry.ts
# contain no references to kc_client_id, agent_card, or kc_ tokens
# (excluding comment lines starting with //).

set -euo pipefail

FILES=(
  "src/core/grant-resolver.ts"
  "src/core/grant-lattice.ts"
  "src/core/mcp-tool-registry.ts"
)

FAIL=0
for F in "${FILES[@]}"; do
  if [ ! -f "$F" ]; then
    echo "FAIL FF-HIRE-2: $F not found" >&2
    FAIL=1
    continue
  fi
  # Grep for kc_ tokens in non-comment code.
  # Exclude full-line comment lines AND lines where token appears only after //.
  # Strategy: remove inline comments (// to end-of-line) before grepping,
  # so only real code (not comment text) is searched.
  MATCHES=$(sed 's|//.*||g' "$F" | grep -nE 'kc_client_id|agent_card|kc_' || true)
  if [ -n "$MATCHES" ]; then
    echo "FAIL FF-HIRE-2: $F contains kc_/agent_card reference:" >&2
    echo "$MATCHES" >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS FF-HIRE-2: no kc_client_id/agent_card/kc_ in rights layer files"
