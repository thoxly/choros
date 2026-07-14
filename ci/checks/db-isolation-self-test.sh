#!/usr/bin/env bash
# T-0147 · FF-T147-9 — globalSetup self-test (unit, no real Postgres)
#
# Runs the --self-test path of ci/checks/db/globalSetup.ts via tsx to verify
# run_id generation and URL rewriting without a real Postgres connection.
#
# Usage:
#   bash ci/checks/db-isolation-self-test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/ci/checks/db/globalSetup.ts"

if [[ ! -f "$SETUP" ]]; then
  echo "FAIL [FF-T147-9]: ci/checks/db/globalSetup.ts not found"
  exit 1
fi

echo "[FF-T147-9] running globalSetup --self-test ..."
npx --yes tsx "$SETUP" --self-test

echo "OK [FF-T147-9]: globalSetup self-test passed"
exit 0
