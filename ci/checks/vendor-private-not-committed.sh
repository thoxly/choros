#!/usr/bin/env bash
# T-0242 · FF-T242-1 — vendor private key must never be committed (vendor-private-not-committed)
#
# Greps all git-tracked files for private-key PEM markers. Any match = FAIL (AC-11 / NF-2).
# An absent/expired/forged key NEVER halts the circuit — but a leaked private key lets
# an attacker issue their own keys; this check prevents accidental commitment.
#
# Markers checked (same set the ADR specifies):
#   BEGIN PRIVATE KEY       (PKCS#8 unencrypted)
#   BEGIN OPENSSH PRIVATE KEY
#   BEGIN EC PRIVATE KEY    (legacy EC)
#   BEGIN RSA PRIVATE KEY   (legacy RSA)
#
# Exclusions:
# 1. Comment-line exclusion: lines whose first non-whitespace chars are #, //, *, /* are
#    excluded — documenting the red-line is allowed.
# 2. .md files are excluded — Markdown docs (ADR/spec) may mention PEM markers as
#    text description; this is documentation, not committed key material.
# 3. printf/echo lines that create test fixtures in CI checks are excluded — they
#    contain the marker as a string argument, not actual key material.
#
# SELF-TEST (--self-test):
#   1. Plants a temp file with a BEGIN PRIVATE KEY marker in a tempdir → must be CAUGHT.
#   2. Plants a line-comment with the same marker → must NOT trip.
#   Exit 2 if either demonstration fails.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

MARKER_RE='BEGIN (PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY|RSA PRIVATE KEY)'

echo "[T-0242] vendor-private-not-committed (FF-T242-1): no vendor private-key PEM committed"

# Strip comment-only lines (# // * /*) and printf/echo fixture lines.
code_lines() {
  grep -vE '^[[:space:]]*(#|//|[*]|/[*])' "$1" 2>/dev/null \
    | grep -vE "printf[^;]*BEGIN (PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY|RSA PRIVATE KEY)" \
    | grep -vE "echo[^;]*BEGIN (PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY|RSA PRIVATE KEY)" \
    || true
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0242] vendor-private-not-committed --self-test"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  # Self-test 1: planted file with PEM marker → must be CAUGHT.
  TMP_PEM="$TMP_DIR/test.pem"
  # Use cat heredoc to avoid printf treating '-----' as options.
  cat > "$TMP_PEM" <<'PEMEOF'
-----BEGIN PRIVATE KEY-----
MFICAQAwBQYDK2VwBCIEIFakeKeyDataForTestingPurposesOnly=
-----END PRIVATE KEY-----
PEMEOF
  if ! code_lines "$TMP_PEM" | grep -qE "$MARKER_RE"; then
    echo "SELF-TEST 1 FAIL: planted PEM marker NOT detected — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0242] self-test 1 PASS: planted PEM marker detected"

  # Self-test 2: comment-only line → must NOT trip.
  TMP_CMT="$TMP_DIR/test.sh"
  printf '# The vendor private key (BEGIN PRIVATE KEY) must not be committed\n' > "$TMP_CMT"
  if code_lines "$TMP_CMT" | grep -qE "$MARKER_RE"; then
    echo "SELF-TEST 2 FAIL: comment-only mention tripped the check — false positive (exit 2)"
    exit 2
  fi
  echo "[T-0242] self-test 2 PASS: comment-only mention ignored"

  trap - EXIT
  rm -rf "$TMP_DIR"
  echo "[T-0242] vendor-private-not-committed --self-test: all self-tests passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK — git ls-files (tracked only; untracked gitignored files are fine)
# ---------------------------------------------------------------------------
FAIL=0
while IFS= read -r tracked_file; do
  [ -f "$REPO_ROOT/$tracked_file" ] || continue
  # Skip .md files — documentation may describe PEM markers as text examples.
  case "$tracked_file" in *.md) continue ;; esac
  if code_lines "$REPO_ROOT/$tracked_file" | grep -qE "$MARKER_RE"; then
    echo "FAIL [FF-T242-1]: private-key PEM marker found in tracked file: $tracked_file"
    code_lines "$REPO_ROOT/$tracked_file" | grep -nE "$MARKER_RE" || true
    FAIL=1
  fi
done < <(git -C "$REPO_ROOT" ls-files 2>/dev/null)

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: vendor private key must not be committed — remove the file or add it to .gitignore"
  exit 1
fi

echo "PASS [FF-T242-1]: no vendor private-key PEM found in git-tracked files"
exit 0
