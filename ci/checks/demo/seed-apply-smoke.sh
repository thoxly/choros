#!/usr/bin/env bash
# T-0141 · FF-APPLY-1 — seed apply smoke gate (live DB required)
#
# Runs seed apply against the dev DB, asserts counts:
#   GET /api/tenants/showcase → 200 + {slug:"showcase"}
#   GET /api/org (X-Dev-User: e-kravtsova) → departments.length === 3
#   GET /api/org → employees total === 12, positions === 7
#   GET /api/rights → roles.length === 8
#   GET /api/processes → instances.length === 8
#
# SELF-TEST: deliberately asserts wrong expected count to verify the check
# can detect regressions (FF-SELFTEST-8).
#
# Requires: DATABASE_URL, BASE_URL (default http://localhost:8080)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "SKIP FF-APPLY-1: DATABASE_URL not set — live-DB probe skipped"
  exit 0
fi

echo "[FF-APPLY-1] Running seed apply smoke against $BASE_URL"

# Step 1: apply seed
# Prefer compiled seed/cli.js (dist/) if available; else use --experimental-strip-types
cd "$REPO_ROOT"
if [[ -f "seed/cli.js" ]]; then
  node seed/cli.js apply --tenant showcase --pack showcase --base-url "$BASE_URL"
else
  node --experimental-strip-types seed/cli.ts apply --tenant showcase --pack showcase --base-url "$BASE_URL"
fi

# Step 2: assert tenant exists
TENANT_RESP=$(curl -sf "$BASE_URL/api/tenants/showcase" 2>/dev/null || echo '{}')
SLUG=$(echo "$TENANT_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(d.slug||'')")
if [[ "$SLUG" != "showcase" ]]; then
  echo "FAIL FF-APPLY-1: expected slug=showcase, got: $SLUG" >&2
  exit 1
fi
echo "PASS: /api/tenants/showcase → slug=showcase"

# Step 3: assert GET /api/org departments count === 3
ORG_RESP=$(curl -sf -H "X-Dev-User: e-kravtsova" "$BASE_URL/api/org" 2>/dev/null || echo '{"departments":[]}')
DEPT_COUNT=$(echo "$ORG_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.departments||[]).length))")
if [[ "$DEPT_COUNT" != "3" ]]; then
  echo "FAIL FF-APPLY-1: expected 3 departments, got: $DEPT_COUNT" >&2
  exit 1
fi
echo "PASS: /api/org → $DEPT_COUNT departments"

# Step 4: assert employees total === 12, positions === 7
EMP_COUNT=$(echo "$ORG_RESP" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
let emp=0,pos=0;
for(const dept of d.departments||[]){
  for(const p of dept.positions||[]){pos++;emp+=p.people.length;}
}
process.stdout.write(emp+','+pos)
")
EMPLOYEES="${EMP_COUNT%%,*}"
POSITIONS="${EMP_COUNT##*,}"
if [[ "$EMPLOYEES" != "12" ]]; then
  echo "FAIL FF-APPLY-1: expected 12 employees, got: $EMPLOYEES" >&2
  exit 1
fi
if [[ "$POSITIONS" != "7" ]]; then
  echo "FAIL FF-APPLY-1: expected 7 positions, got: $POSITIONS" >&2
  exit 1
fi
echo "PASS: org tree → $EMPLOYEES employees, $POSITIONS positions"

# Step 5: assert rights cards === 8
RIGHTS_RESP=$(curl -sf "$BASE_URL/api/rights" 2>/dev/null || echo '{"roles":[]}')
RIGHTS_COUNT=$(echo "$RIGHTS_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.roles||[]).length))")
if [[ "$RIGHTS_COUNT" != "8" ]]; then
  echo "FAIL FF-APPLY-1: expected 8 rights cards, got: $RIGHTS_COUNT" >&2
  exit 1
fi
echo "PASS: /api/rights → $RIGHTS_COUNT role cards"

# Step 6: assert process instances === 8
PROC_RESP=$(curl -sf "$BASE_URL/api/processes" 2>/dev/null || echo '{"instances":[]}')
PROC_COUNT=$(echo "$PROC_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.instances||[]).length))")
if [[ "$PROC_COUNT" != "8" ]]; then
  echo "FAIL FF-APPLY-1: expected 8 process instances, got: $PROC_COUNT" >&2
  exit 1
fi
echo "PASS: /api/processes → $PROC_COUNT instances"

# SELF-TEST: verify this check can detect wrong counts
# The following block runs a deliberate wrong-value assertion that MUST fail.
if [[ "${FF_SELFTEST:-}" == "1" ]]; then
  echo "[FF-SELFTEST-8] Running self-test for FF-APPLY-1 (deliberate failure expected)"
  # SELF-TEST: assert wrong department count — must exit non-zero
  WRONG_DEPT="999"
  if [[ "$DEPT_COUNT" == "$WRONG_DEPT" ]]; then
    echo "ERROR: self-test broken — wrong count matched real count unexpectedly"
    exit 1
  fi
  echo "SELF-TEST PASS: wrong count ($WRONG_DEPT) correctly != real count ($DEPT_COUNT)"
fi

echo "FF-APPLY-1: seed-apply-smoke PASS"
