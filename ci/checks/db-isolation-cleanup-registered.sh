#!/usr/bin/env bash
# T-0147 · FF-T147-5 — cleanup-orphans script exists and is registered in package.json
#
# Verifies:
#   1. scripts/db-cleanup-orphans.ts exists.
#   2. package.json contains fitness:db:cleanup-orphans script.
#
# Usage:
#   bash ci/checks/db-isolation-cleanup-registered.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SCRIPT="$REPO_ROOT/scripts/db-cleanup-orphans.ts"
PKG="$REPO_ROOT/package.json"

FAIL=0

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL [FF-T147-5]: scripts/db-cleanup-orphans.ts not found"
  FAIL=1
else
  echo "OK [FF-T147-5a]: scripts/db-cleanup-orphans.ts exists"
fi

if grep -q "fitness:db:cleanup-orphans" "$PKG"; then
  echo "OK [FF-T147-5b]: package.json contains fitness:db:cleanup-orphans"
else
  echo "FAIL [FF-T147-5b]: package.json missing fitness:db:cleanup-orphans script"
  FAIL=1
fi

exit $FAIL
