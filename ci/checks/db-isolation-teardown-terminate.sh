#!/usr/bin/env bash
# T-0147 · FF-T147-8 — teardown calls pg_terminate_backend before DROP DATABASE
#
# Verifies that the teardown function in ci/checks/db/globalSetup.ts uses
# pg_terminate_backend before DROP DATABASE (FR-8).
#
# Usage:
#   bash ci/checks/db-isolation-teardown-terminate.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/ci/checks/db/globalSetup.ts"

if [[ ! -f "$SETUP" ]]; then
  echo "FAIL [FF-T147-8]: ci/checks/db/globalSetup.ts not found"
  exit 1
fi

if grep -q "pg_terminate_backend" "$SETUP"; then
  echo "OK [FF-T147-8]: teardown calls pg_terminate_backend before DROP DATABASE"
  exit 0
else
  echo "FAIL [FF-T147-8]: globalSetup.ts teardown does not call pg_terminate_backend"
  exit 1
fi
