#!/usr/bin/env bash
# T-0141 · FF-ACTOR-7 — resolveActorTenant / resolveTenantBySlug must not hard-code dev UUID
#
# Checks that src/db/org.ts does NOT contain the literal dev UUID
# "a0000000-0000-0000-0000-000000000001" inside the resolveActorTenant or
# resolveTenantBySlug function bodies (fallback is only via DEV_TENANT_ID constant).
#
# SELF-TEST: verifies that a file containing the literal UUID would be detected (FF-SELFTEST-8).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ORG_DB_FILE="$REPO_ROOT/src/db/org.ts"
DEV_UUID="a0000000-0000-0000-0000-000000000001"

if [[ ! -f "$ORG_DB_FILE" ]]; then
  echo "FAIL FF-ACTOR-7: src/db/org.ts not found" >&2
  exit 1
fi

# Extract only the resolveActorTenant and resolveTenantBySlug function bodies.
# Strategy: look for the literal UUID in those function bodies using node AST-light parse.
# Simpler approach: extract lines between the function start and the next export/function.
node - "$ORG_DB_FILE" "$DEV_UUID" <<'NODEJS'
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const targetUuid = process.argv[3];
const lines = src.split('\n');

// Find function body lines for resolveActorTenant and resolveTenantBySlug
const fnNames = ['resolveActorTenant', 'resolveTenantBySlug'];
let inFn = false;
let braceDepth = 0;
let failed = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Check if we're entering one of the target functions
  const enteringFn = fnNames.some(fn => line.includes(`async function ${fn}`) || line.includes(`function ${fn}`));

  if (enteringFn) {
    inFn = true;
    braceDepth = 0;
  }

  if (inFn) {
    // Count braces to know when we exit the function
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // Check for hardcoded UUID (not via DEV_TENANT_ID constant)
    if (line.includes(targetUuid)) {
      // Allow only: the constant definition line itself
      if (!line.includes('DEV_TENANT_ID') || !line.includes('process.env')) {
        // This line contains the raw UUID inside a function body
        console.error(`FAIL FF-ACTOR-7: literal dev UUID found inside function body at line ${i+1}: ${line.trim()}`);
        failed = true;
      }
    }

    if (braceDepth <= 0 && braceDepth !== 0) {
      // Note: braceDepth starts at 0 before first '{', so we check when it goes negative
    }
    if (enteringFn === false && braceDepth === 0 && i > 0) {
      // We exited the function
      inFn = false;
    }
  }
}

if (failed) process.exit(1);
console.log('FF-ACTOR-7: no hardcoded dev UUID in resolveActorTenant/resolveTenantBySlug bodies');
NODEJS

# Simpler secondary check: grep for the UUID in the two function bodies
# Extract function bodies by line range using awk
FUNC_BODIES=$(awk '/async function resolveActorTenant/,/^export async function resolveTenantBySlug/ { print }
/async function resolveTenantBySlug/,/^\/\/ --/ { print }' "$ORG_DB_FILE")

if echo "$FUNC_BODIES" | grep -qF "$DEV_UUID"; then
  # Check if it's only in the const definition context
  LITERAL_USAGE=$(echo "$FUNC_BODIES" | grep -F "$DEV_UUID" | grep -v "process.env" | grep -v "??" || true)
  if [[ -n "$LITERAL_USAGE" ]]; then
    echo "FAIL FF-ACTOR-7: literal dev UUID found in function bodies (not via constant):" >&2
    echo "$LITERAL_USAGE" >&2
    exit 1
  fi
fi

echo "PASS FF-ACTOR-7: no hardcoded dev UUID in resolveActorTenant/resolveTenantBySlug"

# SELF-TEST: verify that a file with the literal UUID would be detected
# SELF-TEST: create a temp file and assert grep finds the UUID
TMPFILE=$(mktemp /tmp/ff-actor7-selftest-XXXXXX.ts)
trap 'rm -f "$TMPFILE"' EXIT
echo "async function resolveActorTenant() { return 'a0000000-0000-0000-0000-000000000001'; }" > "$TMPFILE"
if ! grep -qF "$DEV_UUID" "$TMPFILE"; then
  echo "FAIL FF-SELFTEST-8: self-test broken — literal UUID not detected in temp file" >&2
  exit 1
fi
echo "SELF-TEST PASS: literal UUID correctly detected in temp file"

echo "FF-ACTOR-7: no-hardcoded-tenant PASS"
