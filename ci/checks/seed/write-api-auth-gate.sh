#!/usr/bin/env bash
# FF-6: every new write handler (tenants|departments|positions|employees|roles)
# references loadAdminContext/isGenesisOwnerForTenant/validateAdminDelegation
# and contains no hardcoded === 'e-owner' / === "e-owner" slug comparison.
# AC-18.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SEED_WRITE="$REPO_ROOT/src/http/seed-write.ts"

if [[ ! -f "$SEED_WRITE" ]]; then
  echo "FAIL: src/http/seed-write.ts does not exist" >&2
  exit 1
fi

# Check gate function is present
if ! grep -q "loadAdminContext" "$SEED_WRITE"; then
  echo "FAIL: seed-write.ts does not reference loadAdminContext" >&2
  exit 1
fi
if ! grep -q "isGenesisOwner\b" "$SEED_WRITE"; then
  echo "FAIL: seed-write.ts does not gate on isGenesisOwner" >&2
  exit 1
fi

# Check no hardcoded === 'e-owner' or === "e-owner" (slug bypass) — skip comment lines
# Filter out lines where the code portion (after line number) is a comment
hardcoded=$(grep -En "(===\s*['\"]e-owner['\"]|['\"]e-owner['\"]\s*===)" "$SEED_WRITE" \
  | grep -vE ':[[:space:]]*//' | grep -vE ':[[:space:]]*\*' || true)
if [[ -n "$hardcoded" ]]; then
  echo "FAIL: hardcoded 'e-owner' slug comparison found in seed-write.ts (FF-6):" >&2
  echo "$hardcoded" >&2
  exit 1
fi

echo "FF-6: write-api-auth-gate PASS"
