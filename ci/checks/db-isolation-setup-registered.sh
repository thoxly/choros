#!/usr/bin/env bash
# T-0147 · FF-T147-1 — globalSetup registered in vitest.config.js
#
# Checks that vitest.config.js references globalSetup pointing to
# ci/checks/db/globalSetup.ts (FF-T147-1).
#
# Usage:
#   bash ci/checks/db-isolation-setup-registered.sh
#   bash ci/checks/db-isolation-setup-registered.sh --self-test
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$REPO_ROOT/vitest.config.js"

if [[ "${1:-}" == "--self-test" ]]; then
  # Self-test: verify the check correctly detects presence/absence
  TMP=$(mktemp)
  echo "globalSetup: ['ci/checks/db/globalSetup.ts']" > "$TMP"
  if grep -q "globalSetup.*globalSetup" "$TMP"; then
    echo "[FF-T147-1 self-test] PASS — grep detects pattern"
    rm -f "$TMP"
    exit 0
  else
    echo "[FF-T147-1 self-test] FAIL — grep missed pattern"
    rm -f "$TMP"
    exit 1
  fi
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "FAIL [FF-T147-1]: vitest.config.js not found at $CONFIG"
  exit 1
fi

if grep -q "globalSetup.*globalSetup" "$CONFIG"; then
  echo "OK [FF-T147-1]: globalSetup registered in vitest.config.js"
  exit 0
else
  echo "FAIL [FF-T147-1]: vitest.config.js does not reference globalSetup pointing to globalSetup.ts"
  echo "  Expected: globalSetup: ['ci/checks/db/globalSetup.ts'] in $CONFIG"
  exit 1
fi
