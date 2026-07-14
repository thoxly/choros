#!/usr/bin/env bash
# T-0214 · P-6 — doc-summary-no-body-in-index: static guard.
#
# DSB-1: asserts that readDocIndex's SQL in src/db/doc-page-store.ts
#   does NOT reference the `body` column in its SELECT.
#
# This statically enforces the "without reading body" invariant from P-6:
#   index/docs_list must carry summary WITHOUT reading body.
#
# Checks:
#   DSB-1a — src/db/doc-page-store.ts exists.
#   DSB-1b — A `readDocIndex` function is present in the file.
#   DSB-1c — The SELECT statement inside readDocIndex's function body does NOT
#             include `body` as a selected column (negative grep in function scope).
#
# --self-test mode: runs positive and negative fixtures to prove the
#   violation-detection assertions actually catch violations.
#   Positive fixture: compliant readDocIndex (no body in SELECT) → guard PASSES.
#   Negative fixture: readDocIndex with `body` in SELECT → guard FAILS.
#   Exit 0 = self-test passed (all assertions confirmed).
#
# Mirrors ci/checks/doc-regen-isolation.sh discipline.
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STORE="${PROJECT_ROOT}/src/db/doc-page-store.ts"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0214][self-test] doc-summary-no-body-in-index --self-test: verifying violation detection"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  SELF_TEST_ERRORS=0

  # ---- Positive fixture: compliant readDocIndex — guard must PASS ----
  GOOD_FIXTURE="${TMPDIR_ST}/good_fixture.ts"
  cat > "${GOOD_FIXTURE}" <<'FIXTURE'
export async function readDocIndex(client: DocStoreClient, tenantId: string) {
  const { rows } = await client.query(
    `SELECT tenant_id, id, slug, title, summary, scope, stale, updated_at
       FROM choros.doc_page
      WHERE tenant_id = $1
      ORDER BY slug`,
    [tenantId],
  );
  return rows;
}
FIXTURE

  # Extract function body of readDocIndex from the fixture.
  # Strategy: awk from 'function readDocIndex' through next top-level export/end.
  # We use a simple grep on the SQL literal between the backticks.
  # For the positive fixture: body must NOT appear in the SELECT list.
  if python3 - "${GOOD_FIXTURE}" <<'PYEOF'
import sys, re
content = open(sys.argv[1]).read()
# Find the readDocIndex function
m = re.search(r'function readDocIndex\b.*?(?=\nexport|\Z)', content, re.DOTALL)
if not m:
    print("GOOD fixture: readDocIndex not found — test setup error")
    sys.exit(1)
fn_body = m.group(0)
# Check for `body` as a SELECT column (as a standalone word in SELECT list)
# We look for body appearing as a selected column name (preceded by comma, newline, or 'SELECT')
if re.search(r'SELECT[^;]*\bbody\b[^;]*FROM', fn_body, re.DOTALL | re.IGNORECASE):
    print("SELF-TEST FAIL [DSB-1c positive]: 'body' detected in SELECT — fixture is wrong")
    sys.exit(2)
else:
    print("SELF-TEST PASS [DSB-1c positive]: compliant readDocIndex correctly detected as clean")
    sys.exit(0)
PYEOF
  then
    : # exit 0 from python → pass
  else
    py_exit=$?
    if [[ $py_exit -eq 2 ]]; then
      echo "SELF-TEST FAIL [DSB-1c positive]: positive fixture was detected as having 'body'" >&2
      SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
    else
      echo "SELF-TEST FAIL [DSB-1c positive]: python check failed with exit $py_exit" >&2
      SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
    fi
  fi

  # ---- Negative fixture: readDocIndex with body in SELECT — guard must FAIL ----
  BAD_FIXTURE="${TMPDIR_ST}/bad_fixture.ts"
  cat > "${BAD_FIXTURE}" <<'FIXTURE'
export async function readDocIndex(client: DocStoreClient, tenantId: string) {
  const { rows } = await client.query(
    `SELECT tenant_id, id, slug, title, body, summary, scope, stale, updated_at
       FROM choros.doc_page
      WHERE tenant_id = $1
      ORDER BY slug`,
    [tenantId],
  );
  return rows;
}
FIXTURE

  if python3 - "${BAD_FIXTURE}" <<'PYEOF'
import sys, re
content = open(sys.argv[1]).read()
m = re.search(r'function readDocIndex\b.*?(?=\nexport|\Z)', content, re.DOTALL)
if not m:
    print("BAD fixture: readDocIndex not found — test setup error")
    sys.exit(1)
fn_body = m.group(0)
if re.search(r'SELECT[^;]*\bbody\b[^;]*FROM', fn_body, re.DOTALL | re.IGNORECASE):
    print("SELF-TEST PASS [DSB-1c negative]: 'body' in SELECT correctly detected")
    sys.exit(0)
else:
    print("SELF-TEST FAIL [DSB-1c negative]: 'body' in SELECT was NOT detected")
    sys.exit(2)
PYEOF
  then
    : # exit 0 → correctly detected body → negative test passes
  else
    py_exit=$?
    if [[ $py_exit -eq 2 ]]; then
      echo "SELF-TEST FAIL [DSB-1c negative]: negative fixture body was NOT detected" >&2
      SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
    else
      echo "SELF-TEST FAIL [DSB-1c negative]: python check failed with exit $py_exit" >&2
      SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
    fi
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — the guard has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: doc-summary-no-body-in-index self-test — all assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0214][DSB-1] doc-summary-no-body-in-index: checking readDocIndex body-absence in src/db/doc-page-store.ts"

# ---- DSB-1a: file exists -------------------------------------------------------
echo ""
echo "DSB-1a: src/db/doc-page-store.ts exists"
if [[ ! -f "${STORE}" ]]; then
  echo "FAIL DSB-1a: src/db/doc-page-store.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS DSB-1a: src/db/doc-page-store.ts exists"
fi

# ---- DSB-1b: readDocIndex function present ------------------------------------
echo ""
echo "DSB-1b: readDocIndex function present in doc-page-store.ts"
if [[ ! -f "${STORE}" ]]; then
  echo "SKIP DSB-1b: file not found (already failed in DSB-1a)"
else
  if ! grep -q "readDocIndex" "${STORE}" 2>/dev/null; then
    echo "FAIL DSB-1b: readDocIndex not found in src/db/doc-page-store.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS DSB-1b: readDocIndex is present"
  fi
fi

# ---- DSB-1c: readDocIndex SELECT must NOT contain `body` ----------------------
echo ""
echo "DSB-1c: readDocIndex SELECT does not reference 'body' column"
if [[ ! -f "${STORE}" ]]; then
  echo "SKIP DSB-1c: file not found"
else
  # Use python3 to extract the readDocIndex function body and grep for `body`
  # in its SELECT clause. This is more reliable than line-range awk.
  RESULT="$(python3 - "${STORE}" <<'PYEOF'
import sys, re
content = open(sys.argv[1]).read()
# Find readDocIndex function — capture from function declaration to next top-level export or EOF
m = re.search(r'(export\s+async\s+function\s+readDocIndex\b.*?)(?=\nexport\s|\Z)', content, re.DOTALL)
if not m:
    print("NOTFOUND")
    sys.exit(0)
fn_body = m.group(1)
# Check for `body` as a selected column in a SELECT ... FROM statement.
# We look for SELECT followed by body (as a standalone word) before FROM.
if re.search(r'SELECT[^;`]*\bbody\b[^;`]*FROM', fn_body, re.DOTALL | re.IGNORECASE):
    print("VIOLATION")
else:
    print("CLEAN")
PYEOF
)"

  if [[ "${RESULT}" == "NOTFOUND" ]]; then
    echo "FAIL DSB-1c: readDocIndex function not parseable — ensure it is a top-level export async function"
    ERRORS=$((ERRORS + 1))
  elif [[ "${RESULT}" == "VIOLATION" ]]; then
    echo "FAIL DSB-1c: readDocIndex SELECT contains 'body' — the index query MUST NOT select the body column (P-6 invariant)"
    ERRORS=$((ERRORS + 1))
  elif [[ "${RESULT}" == "CLEAN" ]]; then
    echo "PASS DSB-1c: readDocIndex SELECT does not reference 'body' column"
  else
    echo "FAIL DSB-1c: unexpected output from parser: ${RESULT}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Result -------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: doc-summary-no-body-in-index found ${ERRORS} violation(s) [T-0214 P-6]"
  exit 1
fi
echo "PASS: doc-summary-no-body-in-index — all checks green [T-0214 P-6]"
exit 0
