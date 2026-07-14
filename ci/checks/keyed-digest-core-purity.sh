#!/usr/bin/env bash
# T-0143 · FF-T143-5 — No process.env reads inside the masking modules (NF-1 / AC-8)
#
# Rule: The masking/resolver modules introduced or extended by T-0143:
#   src/core/keyed-digest.ts
#   src/core/data-classification.ts
#   src/core/grant-resolver.ts
# must NOT contain any process.env READ on code lines (comment-only mentions are ok).
# The env boundary stays EXCLUSIVELY in src/main.ts — the only place that reads
# CHOROS_MASK_DIGEST_KEY and other silo secrets (FF-DC9 analogue at the request-path
# layer).
#
# SCOPE NOTE (Amendment after review R-1, T-0143):
#   The original check scanned all of src/core/ recursively. That scope is
#   UNACHIEVABLE as long as src/core/flowable-client.ts (pre-T-0143) legitimately
#   reads process.env at lines 264/269/274. A full no-env-in-core sweep is a
#   separate task (see backlog candidate in T-0143.adr.md §Amendment). This check
#   scopes ONLY to the three masking/resolver modules where the T-0143 invariant is
#   meaningful and provable.
#
# METHOD:
#   1. Strip comment-only lines (lines whose first non-whitespace chars are //, *, or /*)
#   2. Search remaining (code) lines for process.env patterns
#   A grep error (exit >=2) fails loud — no || true suppression.
#
# SELF-TEST:
#   Positive: a planted code-line violation is detected → grep exit 0 with match
#   Negative: a comment-only mention is ignored → no match on code lines
#   If either self-test fails, exit 2 so CI turns red immediately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TARGETS=(
  "$REPO_ROOT/src/core/keyed-digest.ts"
  "$REPO_ROOT/src/core/data-classification.ts"
  "$REPO_ROOT/src/core/grant-resolver.ts"
)

echo "[T-0143] keyed-digest-core-purity: checking no process.env in masking modules"

# ---------------------------------------------------------------------------
# SELF-TEST 1 (positive): plant a code-line violation, verify it is detected.
# ---------------------------------------------------------------------------
TMP_PLANT="$REPO_ROOT/src/core/_t0143_planted_violation.tmp.ts"
trap 'rm -f "$TMP_PLANT"' EXIT

printf 'const _x = process.env["PLANTED_VIOLATION"];\n' > "$TMP_PLANT"

# Two-step: strip comment lines, then look for process.env
PLANTED_MATCH=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TMP_PLANT" | grep -E 'process\.env' 2>&1) || true
if [ -z "$PLANTED_MATCH" ]; then
  echo "SELF-TEST 1 FAIL [FF-T143-5]: grep did NOT detect a planted code-line violation — the check itself is broken (exit 2)"
  exit 2
fi
rm -f "$TMP_PLANT"
trap - EXIT
echo "[T-0143] self-test 1 PASS: planted code-line violation correctly detected"

# ---------------------------------------------------------------------------
# SELF-TEST 2 (negative): comment-only mention must NOT trigger the check.
# ---------------------------------------------------------------------------
TMP_COMMENT="$REPO_ROOT/src/core/_t0143_comment_ok.tmp.ts"
trap 'rm -f "$TMP_COMMENT"' EXIT

printf '// never reads process.env here\n * process.env is not used\n' > "$TMP_COMMENT"

COMMENT_MATCH=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TMP_COMMENT" | grep -E 'process\.env' 2>&1) || true
if [ -n "$COMMENT_MATCH" ]; then
  echo "SELF-TEST 2 FAIL [FF-T143-5]: grep matched a comment-only line — false positive in pattern (exit 2)"
  echo "$COMMENT_MATCH"
  exit 2
fi
rm -f "$TMP_COMMENT"
trap - EXIT
echo "[T-0143] self-test 2 PASS: comment-only mentions correctly ignored"

# ---------------------------------------------------------------------------
# REAL CHECK: scan only the three in-scope masking modules.
# Strip comment-only lines, then look for process.env on code lines.
# Grep errors fail loud (set -e is active; no || true).
# ---------------------------------------------------------------------------
FAIL=0
for TARGET in "${TARGETS[@]}"; do
  if [ ! -f "$TARGET" ]; then
    echo "WARN [FF-T143-5]: target file not found (skipping): $TARGET"
    continue
  fi

  # Step 1: strip comment-only lines — if this grep errors, set -e kills us (fail loud)
  # Step 2: look for process.env on remaining lines
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TARGET")
  STRIP_EXIT=$?
  set -e

  # STRIP_EXIT=0 means code lines found, =1 means file is all comments (clean)
  if [ "$STRIP_EXIT" -ge 2 ]; then
    echo "FAIL [FF-T143-5]: grep error stripping comments from $TARGET (exit $STRIP_EXIT)"
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
    echo "FAIL [FF-T143-5]: grep error scanning $TARGET (exit $GREP_EXIT)"
    FAIL=1
  elif [ "$GREP_EXIT" -eq 0 ] && [ -n "$MATCHES" ]; then
    echo "FAIL [FF-T143-5]: process.env found in $TARGET (env boundary violation):"
    echo "$MATCHES"
    FAIL=1
  fi
  # GREP_EXIT=1 means no matches on code lines — clean
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS [FF-T143-5]: no process.env in masking modules (env boundary intact)"
echo "PASS: keyed-digest-core-purity — FF-T143-5 green"
exit 0
