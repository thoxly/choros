#!/usr/bin/env bash
# T-0147 · FF-T147-7 — DB_ISOLATION=off fallback path present in globalSetup.ts
#
# Verifies that ci/checks/db/globalSetup.ts checks the DB_ISOLATION env var
# to allow bypassing the isolation mechanism (backward compat, FR-10).
#
# Usage:
#   bash ci/checks/db-isolation-fallback-path.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/ci/checks/db/globalSetup.ts"

if [[ ! -f "$SETUP" ]]; then
  echo "FAIL [FF-T147-7]: ci/checks/db/globalSetup.ts not found"
  exit 1
fi

if grep -q "DB_ISOLATION" "$SETUP"; then
  echo "OK [FF-T147-7]: globalSetup.ts contains DB_ISOLATION fallback path"
  exit 0
else
  echo "FAIL [FF-T147-7]: globalSetup.ts missing DB_ISOLATION check (fallback path)"
  exit 1
fi
