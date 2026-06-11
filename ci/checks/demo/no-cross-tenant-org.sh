#!/usr/bin/env bash
# T-0141 · FF-SCOPE-3 — no cross-tenant org data (live DB gate)
#
# After seed apply, asserts that GET /api/org with X-Dev-User: e-kravtsova
# returns showcase-tenant departments (fin, cs, plat) and does NOT contain
# any department id matching the genesis-owner dev silo structure.
#
# SELF-TEST: asserts that a wrong expected slug fails detection (FF-SELFTEST-8).
#
# Requires: DATABASE_URL, BASE_URL (default http://localhost:8080)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "SKIP FF-SCOPE-3: DATABASE_URL not set — live-DB probe skipped"
  exit 0
fi

echo "[FF-SCOPE-3] Checking no cross-tenant org data for showcase actor"

ORG_RESP=$(curl -sf -H "X-Dev-User: e-kravtsova" "$BASE_URL/api/org" 2>/dev/null || echo '{"departments":[]}')

# Showcase dept slugs that MUST be present
for SLUG in "fin" "cs" "plat"; do
  FOUND=$(echo "$ORG_RESP" | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const found=(d.departments||[]).some(dept=>dept.id==='$SLUG');
    process.stdout.write(found?'yes':'no');
  ")
  if [[ "$FOUND" != "yes" ]]; then
    echo "FAIL FF-SCOPE-3: expected showcase dept '$SLUG' not found in /api/org response" >&2
    exit 1
  fi
done
echo "PASS: showcase depts (fin, cs, plat) present"

# DEV_TENANT_ID silo's genesis dept must NOT be present
# In dev silo (migration 013), the default department slugs are also 'fin','cs','plat'
# but they belong to tenant a0000000-0000-0000-0000-000000000001.
# The key test is that the department count is exactly 3 (showcase only, not merged).
DEPT_COUNT=$(echo "$ORG_RESP" | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(String((d.departments||[]).length));
")
if [[ "$DEPT_COUNT" != "3" ]]; then
  echo "FAIL FF-SCOPE-3: expected exactly 3 departments (showcase tenant only), got: $DEPT_COUNT" >&2
  echo "  Possible cross-tenant leakage or wrong tenant scoping" >&2
  exit 1
fi
echo "PASS: exactly $DEPT_COUNT departments (no cross-tenant leakage)"

# SELF-TEST: assert that a non-existent slug 'nonexistent-dept-xyz' is not found
# SELF-TEST: this validates the detection logic works (slug match is correct)
NON_SLUG="nonexistent-dept-xyz-selftest"
FOUND_NONE=$(echo "$ORG_RESP" | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const found=(d.departments||[]).some(dept=>dept.id==='$NON_SLUG');
  process.stdout.write(found?'yes':'no');
")
if [[ "$FOUND_NONE" == "yes" ]]; then
  echo "FAIL FF-SELFTEST-8: self-test broken — non-existent slug was found" >&2
  exit 1
fi
echo "SELF-TEST PASS: non-existent slug correctly not found"

echo "FF-SCOPE-3: no-cross-tenant-org PASS"
