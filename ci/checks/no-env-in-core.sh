#!/usr/bin/env bash
# T-0163 · FF-T163-3/4/7 — No process.env reads inside src/core/ (full sweep, NF-1)
#
# Rule: src/core/ must NOT contain any process.env READ on code lines.
# Comment-only mentions (lines starting with //, *, or /*) are permitted.
# The env boundary is EXCLUSIVELY in composition root (src/main.ts, src/bridge-runner.ts,
# src/bridge-smoke-runner.ts, src/server/) — never in src/core/.
#
# Born from: T-0143 Amendment R-1 SCOPE NOTE — full src/core/ sweep deferred until
# flowable-client.ts env reads were removed. T-0163 removes those violations and
# enables this full-core invariant check.
#
# METHOD:
#   1. Strip comment-only lines (lines whose first non-whitespace chars are //, *, or /*)
#   2. Search remaining (code) lines for process.env patterns
#   A grep error (exit >=2) fails loud — no || true suppression.
#
# SELF-TEST:
#   Positive: a planted code-line violation is detected → check exit 1 (FAIL correctly)
#   Negative: a comment-only mention is ignored → no match on code lines
#   If either self-test fails, exit 2 so CI turns red immediately.
#
# EXIT CODES:
#   0 — no process.env on code lines in src/core/ (PASS)
#   1 — process.env found on a code line (FAIL)
#   2 — self-test broken (check itself is broken)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE_DIR="$REPO_ROOT/src/core"

echo "[T-0163] no-env-in-core: checking no process.env in src/core/ (full sweep)"

# ---------------------------------------------------------------------------
# SELF-TEST 1 (positive): plant a code-line violation, verify it is detected.
# ---------------------------------------------------------------------------
TMP_PLANT="$CORE_DIR/_t0163_planted_violation.tmp.ts"
trap 'rm -f "$TMP_PLANT"' EXIT

printf 'const _x = process.env["PLANTED_VIOLATION"];\n' > "$TMP_PLANT"

PLANTED_MATCH=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TMP_PLANT" | grep -E 'process\.env' 2>&1) || true
if [ -z "$PLANTED_MATCH" ]; then
  echo "SELF-TEST 1 FAIL [FF-T163-4]: grep did NOT detect a planted code-line violation — the check itself is broken (exit 2)"
  exit 2
fi
rm -f "$TMP_PLANT"
trap - EXIT
echo "[T-0163] self-test 1 PASS: planted code-line violation correctly detected"

# ---------------------------------------------------------------------------
# SELF-TEST 2 (negative): comment-only mention must NOT trigger the check.
# ---------------------------------------------------------------------------
TMP_COMMENT="$CORE_DIR/_t0163_comment_ok.tmp.ts"
trap 'rm -f "$TMP_COMMENT"' EXIT

printf '// never reads process.env here\n * process.env is not used\n' > "$TMP_COMMENT"

COMMENT_MATCH=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TMP_COMMENT" | grep -E 'process\.env' 2>&1) || true
if [ -n "$COMMENT_MATCH" ]; then
  echo "SELF-TEST 2 FAIL [FF-T163-4]: grep matched a comment-only line — false positive in pattern (exit 2)"
  echo "$COMMENT_MATCH"
  exit 2
fi
rm -f "$TMP_COMMENT"
trap - EXIT
echo "[T-0163] self-test 2 PASS: comment-only mentions correctly ignored"

# ---------------------------------------------------------------------------
# REAL CHECK: scan ALL files in src/core/ recursively.
# Strip comment-only lines, then look for process.env on code lines.
# Grep errors fail loud (set -e is active; no || true on real checks).
# ---------------------------------------------------------------------------
FAIL=0

# Collect all .ts files in src/core/ (recursive)
while IFS= read -r -d '' TARGET; do
  # Step 1: strip comment-only lines — if this grep errors, set -e kills us (fail loud)
  # Step 2: look for process.env on remaining lines
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TARGET")
  STRIP_EXIT=$?
  set -e

  # STRIP_EXIT=0 means code lines found, =1 means file is all comments/blank (clean)
  if [ "$STRIP_EXIT" -ge 2 ]; then
    echo "FAIL [FF-T163-3]: grep error stripping comments from $TARGET (exit $STRIP_EXIT)"
    FAIL=1
    continue
  fi

  if [ -z "$CODE_LINES" ]; then
    # Entirely comment/blank — clean
    continue
  fi

  set +e
  MATCHES=$(echo "$CODE_LINES" | grep -nE 'process\.env')
  GREP_EXIT=$?
  set -e

  if [ "$GREP_EXIT" -ge 2 ]; then
    echo "FAIL [FF-T163-3]: grep error scanning $TARGET (exit $GREP_EXIT)"
    FAIL=1
  elif [ "$GREP_EXIT" -eq 0 ] && [ -n "$MATCHES" ]; then
    echo "FAIL [FF-T163-3]: process.env found in $TARGET (env boundary violation, NF-1):"
    echo "$MATCHES"
    FAIL=1
  fi
  # GREP_EXIT=1 means no matches on code lines — clean
done < <(find "$CORE_DIR" -name '*.ts' -not -name '*.tmp.ts' -print0)

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS [FF-T163-3]: no process.env on code lines in src/core/ (env boundary intact)"
echo "PASS: no-env-in-core — FF-T163-3/4/7 green"
exit 0
