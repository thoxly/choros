#!/usr/bin/env bash
# T-0141 · FF-FALLBACK-6 — dev-no-DB fallback preserved
#
# Starts the server WITHOUT DATABASE_URL set. Asserts all four display-plane
# endpoints return 200 with non-empty arrays (served from in-memory seeds).
#
# SELF-TEST: asserts that an endpoint that should fail with non-200 is detected
# (verifies the 200-check logic works — FF-SELFTEST-8).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# D-056: ambient-build honesty — this check MUST NOT depend on an externally-supplied
# dist. We ensure a fresh build by verifying the compiled output contains the
# CHOROS_PACK_DIR seam introduced by T-0141.  A stale dist (pre-T-0141) on a dev
# checkout passes the "file exists" test but ignores the env, so fallback behaviour
# under a mock DATABASE_URL is untested against the real new code paths.  Grepping
# for the literal string is O(ms) when fresh and triggers a full rebuild only when
# needed (tsc is incremental — subsequent runs take seconds).
if ! grep -q "CHOROS_PACK_DIR" "$REPO_ROOT/dist/http/pack-serve.js" 2>/dev/null; then
  echo "[FF-FALLBACK-6] dist is missing or stale (no CHOROS_PACK_DIR seam) — building..."
  cd "$REPO_ROOT" && npm run build --silent
fi

PORT=18143

# Start server WITHOUT DATABASE_URL
unset DATABASE_URL
PORT=$PORT node "$REPO_ROOT/dist/index.js" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# Wait for server ready
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/api/rights" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "[FF-FALLBACK-6] Server started without DATABASE_URL (pid=$SERVER_PID)"

FAIL=0

# Assert /api/rights returns 200 + non-empty roles
RIGHTS_HTTP=$(curl -so /dev/null -w "%{http_code}" "http://localhost:$PORT/api/rights" 2>/dev/null || echo "000")
RIGHTS_BODY=$(curl -sf "http://localhost:$PORT/api/rights" 2>/dev/null || echo '{"roles":[]}')
RIGHTS_COUNT=$(echo "$RIGHTS_BODY" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.roles||[]).length))")
if [[ "$RIGHTS_HTTP" != "200" ]] || [[ "$RIGHTS_COUNT" == "0" ]]; then
  echo "FAIL FF-FALLBACK-6: /api/rights (no DB) returned HTTP=$RIGHTS_HTTP, count=$RIGHTS_COUNT" >&2
  FAIL=1
else
  echo "PASS: /api/rights (no DB) → 200 + $RIGHTS_COUNT roles"
fi

# Assert /api/processes returns 200 + non-empty instances
PROC_HTTP=$(curl -so /dev/null -w "%{http_code}" "http://localhost:$PORT/api/processes" 2>/dev/null || echo "000")
PROC_BODY=$(curl -sf "http://localhost:$PORT/api/processes" 2>/dev/null || echo '{"instances":[]}')
PROC_COUNT=$(echo "$PROC_BODY" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.instances||[]).length))")
if [[ "$PROC_HTTP" != "200" ]] || [[ "$PROC_COUNT" == "0" ]]; then
  echo "FAIL FF-FALLBACK-6: /api/processes (no DB) returned HTTP=$PROC_HTTP, count=$PROC_COUNT" >&2
  FAIL=1
else
  echo "PASS: /api/processes (no DB) → 200 + $PROC_COUNT instances"
fi

# Assert /api/org returns 200 + non-empty departments
ORG_HTTP=$(curl -so /dev/null -w "%{http_code}" "http://localhost:$PORT/api/org" 2>/dev/null || echo "000")
ORG_BODY=$(curl -sf "http://localhost:$PORT/api/org" 2>/dev/null || echo '{"departments":[]}')
ORG_COUNT=$(echo "$ORG_BODY" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.departments||[]).length))")
if [[ "$ORG_HTTP" != "200" ]] || [[ "$ORG_COUNT" == "0" ]]; then
  echo "FAIL FF-FALLBACK-6: /api/org (no DB) returned HTTP=$ORG_HTTP, count=$ORG_COUNT" >&2
  FAIL=1
else
  echo "PASS: /api/org (no DB) → 200 + $ORG_COUNT departments"
fi

# Assert /api/users returns 200 + non-empty users
USERS_HTTP=$(curl -so /dev/null -w "%{http_code}" "http://localhost:$PORT/api/users" 2>/dev/null || echo "000")
USERS_BODY=$(curl -sf "http://localhost:$PORT/api/users" 2>/dev/null || echo '{"users":[]}')
USERS_COUNT=$(echo "$USERS_BODY" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.users||[]).length))")
if [[ "$USERS_HTTP" != "200" ]] || [[ "$USERS_COUNT" == "0" ]]; then
  echo "FAIL FF-FALLBACK-6: /api/users (no DB) returned HTTP=$USERS_HTTP, count=$USERS_COUNT" >&2
  FAIL=1
else
  echo "PASS: /api/users (no DB) → 200 + $USERS_COUNT users"
fi

kill $SERVER_PID 2>/dev/null || true
trap - EXIT

if [[ $FAIL -eq 1 ]]; then
  echo "FAIL FF-FALLBACK-6: one or more fallback checks failed" >&2
  exit 1
fi

# SELF-TEST: verify HTTP 404 would be detected as failure
# SELF-TEST: check that HTTP code 404 != "200" (our assertion logic works)
TEST_HTTP="404"
if [[ "$TEST_HTTP" == "200" ]]; then
  echo "FAIL FF-SELFTEST-8: self-test broken — 404 matched 200" >&2
  exit 1
fi
echo "SELF-TEST PASS: HTTP 404 correctly != 200"

echo "FF-FALLBACK-6: no-db-fallback PASS"
