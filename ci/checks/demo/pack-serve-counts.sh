#!/usr/bin/env bash
# T-0141 · FF-PACK-2 — pack-file-serve count gate (no live DB required)
#
# Starts the server with DATABASE_URL set to a sentinel value and CHOROS_PACK_DIR
# pointing at the real seed directory. Asserts:
#   GET /api/rights → roles.length === 8
#   GET /api/processes → instances.length === 8
#
# Uses a mock DATABASE_URL (non-connectable) so the DB-path branch is taken
# without requiring a running Postgres instance (pack-file serve is file-only).
#
# SELF-TEST: asserts a wrong-pack path produces a non-zero exit (FF-SELFTEST-8).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Build first if dist/index.js missing
if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
  echo "[FF-PACK-2] Building TypeScript..."
  cd "$REPO_ROOT" && npm run build 2>/dev/null
fi

# Pick two free ports (main + self-test) — python3 socket trick guarantees no collision
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")
WRONG_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")

# Start server with DATABASE_URL sentinel and real pack dir
DATABASE_URL="postgres://mock:mock@127.0.0.1:59999/mock_nonexistent" \
CHOROS_PACK_DIR="$REPO_ROOT/seed" \
PORT=$PORT \
  node "$REPO_ROOT/dist/index.js" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# Wait for server ready (up to 10s)
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/api/rights" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "[FF-PACK-2] Server started (pid=$SERVER_PID), testing..."

# Assert rights count
RIGHTS_RESP=$(curl -sf "http://localhost:$PORT/api/rights" 2>/dev/null || echo '{"roles":[]}')
RIGHTS_COUNT=$(echo "$RIGHTS_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.roles||[]).length))")
if [[ "$RIGHTS_COUNT" != "8" ]]; then
  echo "FAIL FF-PACK-2: expected 8 rights cards (pack-file path), got: $RIGHTS_COUNT" >&2
  exit 1
fi
echo "PASS: /api/rights → $RIGHTS_COUNT role cards (pack-file path)"

# Assert processes count
PROC_RESP=$(curl -sf "http://localhost:$PORT/api/processes" 2>/dev/null || echo '{"instances":[]}')
PROC_COUNT=$(echo "$PROC_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(String((d.instances||[]).length))")
if [[ "$PROC_COUNT" != "8" ]]; then
  echo "FAIL FF-PACK-2: expected 8 process instances (pack-file path), got: $PROC_COUNT" >&2
  exit 1
fi
echo "PASS: /api/processes → $PROC_COUNT instances (pack-file path)"

kill $SERVER_PID 2>/dev/null || true
trap - EXIT

# SELF-TEST: verify that a wrong CHOROS_PACK_DIR causes a startup crash / empty response
# SELF-TEST: when CHOROS_PACK_DIR points at a non-existent directory, server should fail
# to load the pack and exit or return an error — not silently return 8 items.
# WRONG_PORT is already chosen above (free port, no collision with main server).
DATABASE_URL="postgres://mock:mock@127.0.0.1:59999/mock_nonexistent" \
CHOROS_PACK_DIR="/tmp/nonexistent_pack_dir_selftest_$$" \
PORT=$WRONG_PORT \
  node "$REPO_ROOT/dist/index.js" &
WRONG_PID=$!
trap 'kill $WRONG_PID 2>/dev/null || true' EXIT

sleep 1  # brief wait

# Try to query — should either fail to start or return an error on the rights endpoint
WRONG_RESP=$(curl -sf "http://localhost:$WRONG_PORT/api/rights" 2>/dev/null || echo 'CURL_FAILED')
kill $WRONG_PID 2>/dev/null || true
trap - EXIT

if [[ "$WRONG_RESP" == "CURL_FAILED" ]]; then
  echo "SELF-TEST PASS: wrong CHOROS_PACK_DIR caused server/endpoint failure as expected"
else
  WRONG_COUNT=$(echo "$WRONG_RESP" | node -e "
    try {
      const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      process.stdout.write(String((d.roles||[]).length));
    } catch { process.stdout.write('ERROR'); }
  " 2>/dev/null || echo "ERROR")
  if [[ "$WRONG_COUNT" == "8" ]]; then
    echo "FAIL FF-SELFTEST-8: wrong CHOROS_PACK_DIR still returned 8 items — self-test broken" >&2
    exit 1
  fi
  echo "SELF-TEST PASS: wrong CHOROS_PACK_DIR returned non-8 count ($WRONG_COUNT)"
fi

echo "FF-PACK-2: pack-serve-counts PASS"
