#!/usr/bin/env bash
# T-0141 · FF-DISPLAY-4 — display-plane serve must not import pg or src/db/*
#
# Checks that src/http/pack-serve.ts, src/http/rights.ts, and
# src/http/processes.ts do NOT import pg or any module from src/db/*.
#
# This enforces I-1 (display plane is read-only file serve, no DB writes).
#
# SELF-TEST: verifies that a file containing a pg import would be detected (FF-SELFTEST-8).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

FILES=(
  "$REPO_ROOT/src/http/pack-serve.ts"
  "$REPO_ROOT/src/http/rights.ts"
  "$REPO_ROOT/src/http/processes.ts"
)

FAIL=0
for FILE in "${FILES[@]}"; do
  if [[ ! -f "$FILE" ]]; then
    echo "FAIL FF-DISPLAY-4: expected file not found: $FILE" >&2
    FAIL=1
    continue
  fi
  # Check for direct pg import
  if grep -qE "from ['\"]pg['\"]" "$FILE"; then
    echo "FAIL FF-DISPLAY-4: $FILE imports 'pg' directly (display plane must not)" >&2
    FAIL=1
  fi
  # Check for src/db/* imports
  if grep -qE "from ['\"].*src/db" "$FILE"; then
    echo "FAIL FF-DISPLAY-4: $FILE imports from src/db/* (display plane must not)" >&2
    FAIL=1
  fi
  # Check for relative ../db/* imports (from src/http/ perspective)
  if grep -qE "from ['\"]\.\.\/db\/" "$FILE"; then
    echo "FAIL FF-DISPLAY-4: $FILE imports from ../db/ (display plane must not)" >&2
    FAIL=1
  fi
done

if [[ $FAIL -eq 1 ]]; then
  echo "FAIL FF-DISPLAY-4: pack-serve-no-write check failed" >&2
  exit 1
fi
echo "PASS: no pg or src/db/* imports in display-plane modules"

# SELF-TEST: verify grep would detect a pg import if present
# SELF-TEST: create a temp file with a pg import and assert grep fires
TMPFILE=$(mktemp /tmp/ff-display4-selftest-XXXXXX.ts)
trap 'rm -f "$TMPFILE"' EXIT
echo "import pg from 'pg';" > "$TMPFILE"
if ! grep -qE "from ['\"]pg['\"]" "$TMPFILE"; then
  echo "FAIL FF-SELFTEST-8: self-test broken — grep did not detect pg import" >&2
  exit 1
fi
echo "SELF-TEST PASS: grep correctly detects pg import in temp file"

echo "FF-DISPLAY-4: pack-serve-no-write PASS"
