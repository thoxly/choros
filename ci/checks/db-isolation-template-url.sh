#!/usr/bin/env bash
# T-0147 · FF-T147-4 — db-setup-template script targets choros_test_template URL
#
# Verifies that scripts/db-setup-template.ts contains choros_test_template as
# the template DB name, and that the --self-test flag works.
#
# Usage:
#   bash ci/checks/db-isolation-template-url.sh
#   bash ci/checks/db-isolation-template-url.sh --self-test
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/db-setup-template.ts"

if [[ "${1:-}" == "--self-test" ]]; then
  # Invoke the script's own --self-test to verify URL contains /choros_test_template
  npx --yes tsx "$SCRIPT" --self-test
  exit $?
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL [FF-T147-4]: scripts/db-setup-template.ts not found"
  exit 1
fi

if grep -q "choros_test_template" "$SCRIPT"; then
  echo "OK [FF-T147-4]: scripts/db-setup-template.ts references choros_test_template"
  exit 0
else
  echo "FAIL [FF-T147-4]: scripts/db-setup-template.ts does not reference choros_test_template"
  exit 1
fi
