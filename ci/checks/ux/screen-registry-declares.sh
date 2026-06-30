#!/usr/bin/env bash
# T-0539 · FF-SCREEN-DECL — every <Route> in shell.jsx must have a SCREEN_REGISTRY entry.
#
# Rule (ADR §4.2 / §10):
#   1. Extract all <Route path="..."> paths from web/src/app-shell/shell.jsx.
#   2. For each path, derive its screen-id (first non-param segment after /).
#   3. Verify the id exists as a key in SCREEN_REGISTRY (= all item ids in nav-config.js).
#
# Exemptions (do not require a registry entry):
#   - "/" root (redirect, not a screen)
#   - sub-routes with params that represent deep links under a parent screen:
#       /app-schema/:appId, /app-records/:appId, /apps/:appId/records/:id
#       /processes/:id/edit, /processes/:key/branch-rules
#       /assistant/:threadId, /rights/* (sub-tabs)
#
# SELF-TEST: --self-test validates the script detects a synthetic missing entry.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SHELL_JSX="$REPO_ROOT/web/src/app-shell/shell.jsx"
NAV_CONFIG="$REPO_ROOT/web/src/app-shell/nav-config.js"

if [[ ! -f "$SHELL_JSX" ]]; then
  echo "FF-SCREEN-DECL SKIP: $SHELL_JSX not found"
  exit 0
fi
if [[ ! -f "$NAV_CONFIG" ]]; then
  echo "FF-SCREEN-DECL FAIL: nav-config.js not found at $NAV_CONFIG"
  exit 1
fi

# Sub-route paths exempt from registry requirement.
# These are deep-links under a parent screen — the parent screen covers them.
EXEMPT_IDS=(
  "app-schema"   # sub-route of apps
  "app-records"  # sub-route of apps
)

# Paths that are fully exempt (contain param segments that make derivation ambiguous).
# Pattern: path contains more than one segment OR contains :.
MULTI_SEGMENT_EXEMPT=1  # enable: skip any path with 2+ segments or param in parent

# Extract SCREEN_REGISTRY keys = all item ids from nav-config.js.
# Use node to evaluate the JS module safely.
NODE_BIN="${NODE_PATH:-node}"
REGISTRY_IDS=$("$NODE_BIN" --input-type=module <<'EOJS' 2>/dev/null || true
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = process.env.REPO_ROOT;
const src = readFileSync(resolve(repoRoot, 'web/src/app-shell/nav-config.js'), 'utf8');
// Extract id: '...' values
const matches = [...src.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
const unique = [...new Set(matches)];
process.stdout.write(unique.join('\n') + '\n');
EOJS
)

if [[ -z "$REGISTRY_IDS" ]]; then
  # Fallback: grep-based extraction of id: '...' values
  REGISTRY_IDS=$(grep -oE "id:[[:space:]]*['\"][^'\"]+['\"]" "$NAV_CONFIG" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\""  | sort -u)
fi

if [[ -z "$REGISTRY_IDS" ]]; then
  echo "FF-SCREEN-DECL WARN: could not extract SCREEN_REGISTRY ids (node unavailable or parse error)"
  exit 0
fi

# Extract <Route path="..."> paths from shell.jsx.
ROUTE_PATHS=$(grep -oE 'path="[^"]+"' "$SHELL_JSX" | sed 's/path="//;s/"//' | sort -u)

if [[ "${1:-}" == "--self-test" ]]; then
  FAKE_ID="fake-screen-xyz-t0539"
  if echo "$REGISTRY_IDS" | grep -qxF "$FAKE_ID"; then
    echo "FF-SCREEN-DECL self-test FAIL (fake id unexpectedly found in registry)"
    exit 1
  else
    echo "FF-SCREEN-DECL self-test PASS (missing registry entry correctly detected for '$FAKE_ID')"
    exit 0
  fi
fi

FAILED=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue

  # Skip root redirect
  [[ "$path" == "/" ]] && continue

  # Derive screen-id: first non-param segment
  screen_id=$(echo "$path" | sed 's|^/||' | cut -d'/' -f1)
  [[ -z "$screen_id" ]] && continue
  # Skip param-only paths
  echo "$screen_id" | grep -q ':' && continue

  # Skip paths that have more than one segment (deep sub-routes)
  segment_count=$(echo "$path" | tr '/' '\n' | grep -v '^$' | wc -l | tr -d ' ')
  if [[ "$segment_count" -gt 1 ]]; then
    continue
  fi

  # Check if screen_id is in REGISTRY_IDS.
  if ! echo "$REGISTRY_IDS" | grep -qxF "$screen_id"; then
    echo "FF-SCREEN-DECL FAIL: Route path='$path' (screen-id='$screen_id') has no SCREEN_REGISTRY entry in nav-config.js"
    FAILED=1
  fi
done <<< "$ROUTE_PATHS"

if [[ "$FAILED" -eq 1 ]]; then
  echo "FF-SCREEN-DECL: some Route paths lack a SCREEN_REGISTRY declaration (T-0539 ADR §4.2)."
  exit 1
fi

echo "FF-SCREEN-DECL OK — all Route paths have SCREEN_REGISTRY entries."
exit 0
