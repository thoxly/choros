#!/usr/bin/env bash
# T-0539 · FF-NAV-PROJ — nav-visibility derived ONLY from NavCapabilitySet
#
# The sidebar zone/item filter MUST NOT contain hardcoded role-string checks
# (if role==='admin', slug==='owner', etc.). Visibility comes exclusively from
# navSet.zones / navSet.isGenesisOwner / item.ownerOnly.
#
# Scans: web/src/app-shell/shell.jsx  (the sidebar rendering path)
#         web/src/app-shell/nav-config.js (visibleZones / visibleItems / projectZones)
#
# Denylisted patterns (role-string literals in nav-filter context):
#   role === 'admin'     / role==='admin'    / role=="admin"
#   role === 'owner'     / role==='owner'    / role=="owner"
#   currentUser.role     / devUser.role
#
# SELF-TEST: if --self-test is passed, injects a synthetic violation and expects exit 1.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

TARGETS=(
  "$REPO_ROOT/web/src/app-shell/shell.jsx"
  "$REPO_ROOT/web/src/app-shell/nav-config.js"
)

# Denylist patterns (ERE — portable grep -E)
DENYLIST=(
  "role[[:space:]]*===[[:space:]]*['\"]admin['\"]"
  "role[[:space:]]*===[[:space:]]*['\"]owner['\"]"
  "role[[:space:]]*==[[:space:]]*['\"]admin['\"]"
  "role[[:space:]]*==[[:space:]]*['\"]owner['\"]"
  "slug[[:space:]]*===[[:space:]]*['\"]admin['\"]"
  "slug[[:space:]]*===[[:space:]]*['\"]owner['\"]"
  "currentUser\.role"
  "devUser\.role"
)

if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/nav-proj-selftest.XXXXXX.jsx)"
  echo "// synthetic violation" > "$TMP"
  echo "if (role === 'admin') { showAdmin(); }" >> "$TMP"
  TARGETS=("$TMP")
  SELF_TEST=1
else
  SELF_TEST=0
fi

FOUND=0
for file in "${TARGETS[@]}"; do
  [[ -f "$file" ]] || { echo "SKIP (not found): $file"; continue; }
  for pat in "${DENYLIST[@]}"; do
    matches=$(grep -nE "$pat" "$file" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      echo "FF-NAV-PROJ FAIL: hardcoded role-string in nav filter — $file"
      echo "$matches"
      FOUND=1
    fi
  done
done

if [[ "$SELF_TEST" -eq 1 ]]; then
  rm -f "${TARGETS[0]}" 2>/dev/null || true
  if [[ "$FOUND" -eq 1 ]]; then
    echo "FF-NAV-PROJ self-test PASS (synthetic violation detected as expected)"
    exit 0
  else
    echo "FF-NAV-PROJ self-test FAIL (synthetic violation was NOT detected)"
    exit 1
  fi
fi

if [[ "$FOUND" -eq 1 ]]; then
  echo "FF-NAV-PROJ: nav-visibility contains hardcoded role-string checks — must use navSet.zones/isGenesisOwner only."
  exit 1
fi

echo "FF-NAV-PROJ OK — nav-visibility derived from NavCapabilitySet only."
exit 0
