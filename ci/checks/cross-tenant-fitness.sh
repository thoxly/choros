#!/usr/bin/env bash
# T-0115 · Static fitness checks for cross-tenant CI-blocker (AC-10..AC-12).
#
# AC-10: cross_tenant.test.ts reads KNOWN_TENANT_TABLES from _helpers (not hardcoded).
# AC-11: .github/workflows/ci.yml includes fitness:db in the db job (blocking gate).
# AC-12: cross_tenant.test.ts uses appUrl() for cross-tenant queries and migratorUrl()
#        for verification (role discipline: only choros_app proves 152-FZ invariant).
#
# Exit non-zero on any failure (set -e) — this script is used in npm run fitness.

set -euo pipefail

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
CROSS_TENANT_TEST="$REPO/ci/checks/db/cross_tenant.test.ts"
CI_WORKFLOW="$REPO/.github/workflows/ci.yml"

echo "T-0115 fitness: checking cross-tenant invariants..."

# AC-10: anti-hardcode — test must import KNOWN_TENANT_TABLES (not a hardcoded list)
if ! grep -qE 'KNOWN_TENANT_TABLES' "$CROSS_TENANT_TEST"; then
  echo "FAIL AC-10: $CROSS_TENANT_TEST does not reference KNOWN_TENANT_TABLES" >&2
  exit 1
fi
echo "  AC-10 PASS: KNOWN_TENANT_TABLES referenced in cross_tenant.test.ts"

# AC-11: CI gate — fitness:db must be present in ci.yml (db job blocks merge)
if ! grep -qE 'fitness:db' "$CI_WORKFLOW"; then
  echo "FAIL AC-11: $CI_WORKFLOW does not contain 'fitness:db'" >&2
  exit 1
fi
echo "  AC-11 PASS: fitness:db found in $CI_WORKFLOW"

# AC-12a: role discipline — appUrl() used for cross-tenant queries
if ! grep -qE 'appUrl\(\)' "$CROSS_TENANT_TEST"; then
  echo "FAIL AC-12: $CROSS_TENANT_TEST does not use appUrl()" >&2
  exit 1
fi
echo "  AC-12a PASS: appUrl() found in cross_tenant.test.ts"

# AC-12b: role discipline — migratorUrl() used for verification
if ! grep -qE 'migratorUrl\(\)' "$CROSS_TENANT_TEST"; then
  echo "FAIL AC-12: $CROSS_TENANT_TEST does not use migratorUrl()" >&2
  exit 1
fi
echo "  AC-12b PASS: migratorUrl() found in cross_tenant.test.ts"

echo "T-0115 fitness: all checks PASSED"
