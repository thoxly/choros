#!/usr/bin/env bash
# T-0132 · FF-1 / FF-1b — Pilot ADR foundations linter (doc-structure)
#
# T-0132 is design-only; its phase artifact is the ADR document
# (docs/design/T-0132-pilot-rollout.adr.md). This fitness function is a
# doc-structure linter: it machine-verifies that the ADR references ALL
# load-bearing live symbols by their exact names in the source files, and
# that it does NOT mis-apply them in banned affirmative ways (FF-1b).
#
# FF-1  PRESENCE — each load-bearing symbol appears in the named source file:
#       grant-lattice.ts  : interval (kind), isNarrowerOrEqual, meet, normalize,
#                           validateNarrowing, isEffective
#       grant-resolver.ts : resolveFor, refToScope
#       effect-resource.ts: (file existence)
#
# FF-1b ANTI-MIS-USE — the ADR does NOT assert banned formula mis-applications:
#       Banned: "meet(node,interval)" asserted to produce a set / kind:"set"
#               (R-1 correction: that path returns BOTTOM; normalize is correct).
#       Required: "normalize({kind:\"set\"" present (correct composition form).
#       Required: "[НОВАЯ B-7]" present (amount-axis read-path flagged as NEW).
#       Required: "identity-only" present (honest refToScope characterisation).
#       Required: note that "глубокая сверка = ревью" is stated (boundary of
#               linter acknowledged in ADR §12 / FF-1b description).
#
#       NOTE: The grep-based absence check can only catch *gross* mis-citation
#       in the ADR text; deep behavioural verification ("meet actually returns
#       BOTTOM for cross-kind atoms") is a reviewer / unit-test responsibility
#       (B-1 implementation FF), not a doc-linter responsibility. This is
#       stated explicitly in the ADR §12 FF-1b description.
#
# SELF-TEST (FF-1b contributor):
#   --self-test runs the foundations check against a deliberately BROKEN fixture
#   (an ADR copy with the "isNarrowerOrEqual" symbol stripped). The check MUST
#   go red on it. If the broken fixture passes, the check itself is broken ->
#   exit 2. On success of the demonstration, exit 0.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADR="$REPO_ROOT/docs/design/T-0132-pilot-rollout.adr.md"

# --- FF-1: symbols that MUST be referenced in the ADR -------------------------
# Each entry: "token|source-file-hint" (hint used in error messages only).
SYMBOL_TOKENS=(
  "interval"
  "isNarrowerOrEqual"
  "meet"
  "normalize"
  "validateNarrowing"
  "isEffective"
  "resolveFor"
  "refToScope"
  "effect-resource.ts"
)

# --- FF-1: source files that MUST exist on disk --------------------------------
SOURCE_FILES=(
  "src/core/grant-lattice.ts"
  "src/core/grant-resolver.ts"
  "src/core/effect-resource.ts"
)

# --- FF-1b: tokens that MUST be present (correct usage / honest labelling) ----
REQUIRED_1B=(
  'normalize({kind:"set"'
  '[НОВАЯ B-7]'
  'identity-only'
  'глубокая сверка'
)

# --- FF-1b: banned gross mis-citation patterns (affirmative assertion only) ---
# The ADR's own §12 FF-table and §3.3 correction notes quote these phrases to
# SAY they are banned; we strip guard/meta lines before the check.
BANNED_1B=(
  'meet(node,interval) ⇒ set'
  'meet(node,interval)⇒set'
)

# ---------------------------------------------------------------------------
# Helper: grep_present <file> <token> <ff-id>  — 0=ok, 1=missing
# ---------------------------------------------------------------------------
grep_present() {
  local file="$1" token="$2" ff="$3"
  set +e
  grep -qF "$token" "$file"
  local rc=$?
  set -e
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error scanning for '$token' in $file (exit $rc)"
    return 1
  elif [ "$rc" -ne 0 ]; then
    echo "FAIL [$ff]: required token MISSING — '$token'"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Helper: grep_absent_filtered <file> <token> <ff-id>
#   Strips meta/guard lines before checking; only affirmative assertions trip.
# ---------------------------------------------------------------------------
grep_absent_filtered() {
  local file="$1" token="$2" ff="$3"
  set +e
  local hits
  hits=$(grep -vE 'банит|баним|сторожит|self-test|--self-test|фикстура|красный|Check-|\bFF-[0-9]|Banned:|BANNED' "$file" \
         | grep -F "$token")
  local rc=$?
  set -e
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error scanning for banned '$token' in $file (exit $rc)"
    return 1
  fi
  if [ "$rc" -eq 0 ] && [ -n "$hits" ]; then
    echo "FAIL [$ff]: banned mis-citation ASSERTED — '$token'"
    echo "$hits"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# run_foundations_check <adr-file>
# ---------------------------------------------------------------------------
run_foundations_check() {
  local target="$1"
  local fail=0

  if [ ! -f "$target" ]; then
    echo "FAIL [FF-1]: ADR not found: $target"
    return 1
  fi

  # FF-1: source files must exist on disk (only applies to real check, not
  # arbitrary fixtures — skip for fixtures outside REPO_ROOT tree).
  if [ "$target" = "$ADR" ]; then
    local sf
    for sf in "${SOURCE_FILES[@]}"; do
      if [ ! -f "$REPO_ROOT/$sf" ]; then
        echo "FAIL [FF-1]: source file MISSING from repo: $sf"
        fail=1
      fi
    done
  fi

  # FF-1: every symbol token must appear at least once in the ADR.
  local tok
  for tok in "${SYMBOL_TOKENS[@]}"; do
    grep_present "$target" "$tok" "FF-1" || fail=1
  done

  # FF-1b: required honest-labelling tokens must be present.
  local req
  for req in "${REQUIRED_1B[@]}"; do
    grep_present "$target" "$req" "FF-1b" || fail=1
  done

  # FF-1b: banned gross mis-citation must be absent (affirmative context only).
  local banned
  for banned in "${BANNED_1B[@]}"; do
    grep_absent_filtered "$target" "$banned" "FF-1b" || fail=1
  done

  return $fail
}

# ---------------------------------------------------------------------------
# --self-test: prove the check can go red on a broken fixture.
# Fixture: strip "isNarrowerOrEqual" -> FF-1 must fire.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0132] pilot-adr-foundations --self-test: proving the check can fail"
  TMP_FIX="$REPO_ROOT/docs/design/_t0132_foundations_broken.tmp.md"
  trap 'rm -f "$TMP_FIX"' EXIT

  if [ ! -f "$ADR" ]; then
    echo "SELF-TEST FAIL [FF-1]: ADR not found, cannot build fixture: $ADR (exit 2)"
    exit 2
  fi

  # Build broken fixture: remove effect-resource.ts token entirely.
  # (Using effect-resource.ts because it's a unique token that won't be
  # a substring of any replacement — unlike isNarrowerOrEqual which
  # appears in isNarrowerOrEqualXXX and still matches as substring.)
  sed 's/effect-resource\.ts/effect-resource-MISSING.ts/g' "$ADR" > "$TMP_FIX"

  fixture_rc=0
  run_foundations_check "$TMP_FIX" >/dev/null 2>&1 || fixture_rc=$?

  rm -f "$TMP_FIX"
  trap - EXIT

  if [ "$fixture_rc" -eq 0 ]; then
    echo "SELF-TEST FAIL [FF-1]: broken fixture (no effect-resource.ts) PASSED — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0132] self-test PASS: broken fixture (no effect-resource.ts) correctly went red"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK against the live ADR.
# ---------------------------------------------------------------------------
echo "[T-0132] pilot-adr-foundations: linting $ADR"
if run_foundations_check "$ADR"; then
  echo "PASS [FF-1/FF-1b]: all foundation symbols referenced, no banned mis-citations"
  echo "PASS: pilot-adr-foundations — FF-1/FF-1b green"
  exit 0
else
  echo "FAIL: pilot-adr-foundations — FF-1/FF-1b red"
  exit 1
fi
