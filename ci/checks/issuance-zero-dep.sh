#!/usr/bin/env bash
# T-0242 · FF-T242-3 — src/vendor/issuance.ts is zero-dep (crypto only) (issuance-zero-dep)
#
# Rule (NF-4 / AC-15): src/vendor/issuance.ts may only import from:
#   - node: builtins (node:crypto etc.)
#   - src/vendor/activation.ts (reuse canonicalPayloadBytes / types; vendor→vendor allowed)
#
# Forbidden in issuance.ts (non-exhaustive; catches the most common leaks):
#   - http, https (bare or node:)
#   - axios, node-fetch, undici, got, cross-fetch
#   - pg (Postgres driver — store is via injectable port, not direct driver)
#   - fetch( call on a code line
#
# Also positively requires that node:crypto IS imported (sanity check).
#
# SELF-TEST (--self-test):
#   1. Plants axios import in a temp copy → must be CAUGHT.
#   2. Plants fetch( call → must be CAUGHT.
#   3. Ensures node:crypto import is required → must be PRESENT in real file.
#   Exit 2 if any demonstration fails.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$REPO_ROOT/src/vendor/issuance.ts"

echo "[T-0242] issuance-zero-dep (FF-T242-3): src/vendor/issuance.ts uses only node:crypto + vendor/activation"

code_lines() { grep -vE '^[[:space:]]*(//|[*]|/[*])' "$1" 2>/dev/null || true; }

# Forbidden external import patterns.
BAD_IMPORT_RE='^[[:space:]]*import[^;]*from[[:space:]]*["'"'"'](http|https|node:http|node:https|axios|node-fetch|undici|got|cross-fetch|pg)["'"'"']'
# Forbidden call patterns.
BAD_CALL_RE='fetch\(|https?:\/\/'

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0242] issuance-zero-dep --self-test"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  # Self-test 1: planted axios import → must FAIL.
  TMP_AX="$TMP_DIR/issuance_axios.ts"
  printf 'import axios from "axios";\nexport function foo() {}\n' > "$TMP_AX"
  if ! code_lines "$TMP_AX" | grep -qE "$BAD_IMPORT_RE"; then
    echo "SELF-TEST 1 FAIL: planted axios import NOT detected — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0242] self-test 1 PASS: planted axios import detected"

  # Self-test 2: planted fetch( call → must FAIL.
  TMP_FETCH="$TMP_DIR/issuance_fetch.ts"
  printf 'const r = fetch("https://example.com");\n' > "$TMP_FETCH"
  if ! code_lines "$TMP_FETCH" | grep -qE "$BAD_CALL_RE"; then
    echo "SELF-TEST 2 FAIL: planted fetch() call NOT detected — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0242] self-test 2 PASS: planted fetch() call detected"

  # Self-test 3: real issuance.ts must import node:crypto.
  if ! [ -f "$TARGET" ]; then
    echo "SELF-TEST 3 SKIP: $TARGET does not exist yet (will be checked on real run)"
  else
    if ! grep -qE 'from[[:space:]]*"node:crypto"' "$TARGET"; then
      echo "SELF-TEST 3 FAIL: node:crypto import NOT found in $TARGET — check is broken (exit 2)"
      exit 2
    fi
    echo "[T-0242] self-test 3 PASS: node:crypto import present in issuance.ts"
  fi

  trap - EXIT
  rm -rf "$TMP_DIR"
  echo "[T-0242] issuance-zero-dep --self-test: all self-tests passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK
# ---------------------------------------------------------------------------
if [ ! -f "$TARGET" ]; then
  echo "FAIL [FF-T242-3]: $TARGET not found"
  exit 1
fi

FAIL=0

# Positive: node:crypto must be imported.
if ! grep -qE 'from[[:space:]]*"node:crypto"' "$TARGET"; then
  echo "FAIL [FF-T242-3]: node:crypto import NOT found in issuance.ts (required for signing)"
  FAIL=1
fi

code="$(code_lines "$TARGET")"

# Negative: no bad external imports.
if echo "$code" | grep -qE "$BAD_IMPORT_RE"; then
  echo "FAIL [FF-T242-3]: forbidden external import in issuance.ts:"
  echo "$code" | grep -nE "$BAD_IMPORT_RE"
  FAIL=1
fi

# Negative: no network call patterns.
if echo "$code" | grep -qE "$BAD_CALL_RE"; then
  echo "FAIL [FF-T242-3]: network call pattern in issuance.ts:"
  echo "$code" | grep -nE "$BAD_CALL_RE"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: issuance.ts is not zero-dep (FF-T242-3)"
  exit 1
fi

echo "PASS [FF-T242-3]: src/vendor/issuance.ts is zero-dep (node:crypto only, no network)"
exit 0
