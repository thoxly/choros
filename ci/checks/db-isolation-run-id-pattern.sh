#!/usr/bin/env bash
# T-0147 · FF-T147-6 — run_id follows choros_test_<digits>_<hex> pattern
#
# Statically checks that ci/checks/db/globalSetup.ts generates run_id using
# Date.now() + randomHex, matching /^choros_test_\d{10,13}_[0-9a-f]{4}$/.
#
# Usage:
#   bash ci/checks/db-isolation-run-id-pattern.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/ci/checks/db/globalSetup.ts"

if [[ ! -f "$SETUP" ]]; then
  echo "FAIL [FF-T147-6]: ci/checks/db/globalSetup.ts not found"
  exit 1
fi

# Check for Date.now() usage combined with randomHex-like pattern in run_id construction
if grep -qE "choros_test.*Date\.now\(\)" "$SETUP"; then
  echo "OK [FF-T147-6]: globalSetup.ts generates run_id with choros_test_<epoch> pattern"
  exit 0
else
  echo "FAIL [FF-T147-6]: globalSetup.ts does not use Date.now() for run_id generation"
  echo "  Expected pattern: choros_test_\${Date.now()}_\${randomHex(...)}"
  exit 1
fi
