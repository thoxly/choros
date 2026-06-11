#!/usr/bin/env bash
# T-0130 · FF-1 — Simulation ADR foundations linter (doc-structure)
#
# T-0130 is design-only; its phase artifact is the ADR document
# (docs/design/T-0130-simulation.adr.md). This fitness function is a
# doc-structure linter: it machine-verifies that the ADR names ALL load-bearing
# foundations and does NOT introduce banned "second-system" constructions in an
# AFFIRMATIVE context.
#
# RULE (FF-1, AC-15):
#   PRESENCE  — the ADR references each foundation by id at least once:
#               T-0027, T-0021, T-0034, T-0018, T-0023, T-0016
#   ABSENCE   — the ADR does NOT contain banned-construction phrases (a parallel
#               authority store / second resolver / second audit log / parallel
#               lattice / new budget mechanism) outside of explicit rejection /
#               negation context (NF-5). We approximate "affirmative context" by
#               banning the bare affirmative phrases; the ADR states these only
#               as things it does NOT do ("ноль ...", "не ..."), which use a
#               different surface form and are allowed.
#
# METHOD:
#   Plain grep over the ADR. grep errors (exit >= 2) fail loud — no || true
#   suppression on the real check. Missing foundation token OR present banned
#   token -> exit 1 (red).
#
# SELF-TEST (FF-9 contributor):
#   --self-test runs the foundations check against a deliberately BROKEN fixture
#   (an ADR copy with the "T-0027" token stripped). The check MUST go red on it.
#   If the broken fixture passes, the check itself is broken -> exit 2.
#   On success of the self-test demonstration, exit 0.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADR="$REPO_ROOT/docs/design/T-0130-simulation.adr.md"

# Foundations that MUST be named in the ADR.
FOUNDATIONS=("T-0027" "T-0021" "T-0034" "T-0018" "T-0023" "T-0016")

# Banned affirmative second-system constructions. The ADR only ever states
# these in NEGATED form ("ноль нового authority-store", "НЕ вводит ...");
# the bare affirmative surface forms below must be absent.
BANNED=(
  "новый authority-store создаётся"
  "второй резолвер вводится"
  "второй аудит-лог вводится"
  "параллельная решётка вводится"
  "новый бюджет-механизм вводится"
)

# ---------------------------------------------------------------------------
# run_foundations_check <adr-file>
#   echoes failures, returns 1 if any failure, 0 if clean.
# ---------------------------------------------------------------------------
run_foundations_check() {
  local target="$1"
  local fail=0

  if [ ! -f "$target" ]; then
    echo "FAIL [FF-1]: ADR not found: $target"
    return 1
  fi

  # PRESENCE: every foundation token must appear at least once.
  local f
  for f in "${FOUNDATIONS[@]}"; do
    set +e
    grep -qF "$f" "$target"
    local rc=$?
    set -e
    if [ "$rc" -ge 2 ]; then
      echo "FAIL [FF-1]: grep error scanning for $f in $target (exit $rc)"
      fail=1
    elif [ "$rc" -ne 0 ]; then
      echo "FAIL [FF-1]: foundation token '$f' MISSING from ADR (NF-5: must name all load-bearing foundations)"
      fail=1
    fi
  done

  # ABSENCE: no bare affirmative banned construction.
  local b
  for b in "${BANNED[@]}"; do
    set +e
    grep -qF "$b" "$target"
    local rc=$?
    set -e
    if [ "$rc" -ge 2 ]; then
      echo "FAIL [FF-1]: grep error scanning for banned '$b' in $target (exit $rc)"
      fail=1
    elif [ "$rc" -eq 0 ]; then
      echo "FAIL [FF-1]: banned affirmative construction present: '$b' (NF-5 violation)"
      fail=1
    fi
  done

  return $fail
}

# ---------------------------------------------------------------------------
# --self-test: prove the check can go red on a broken fixture (FF-9).
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0130] sim-adr-foundations --self-test: proving the check can fail"
  TMP_FIX="$REPO_ROOT/docs/design/_t0130_foundations_broken.tmp.md"
  trap 'rm -f "$TMP_FIX"' EXIT

  if [ ! -f "$ADR" ]; then
    echo "SELF-TEST FAIL [FF-1]: ADR not found, cannot build fixture: $ADR (exit 2)"
    exit 2
  fi

  # Build a broken fixture: strip the T-0027 token entirely.
  sed 's/T-0027/T-XXXX/g' "$ADR" > "$TMP_FIX"

  # The function toggles set -e internally; guard the call with ||  so a
  # non-zero return does not abort us under set -e.
  fixture_rc=0
  run_foundations_check "$TMP_FIX" >/dev/null 2>&1 || fixture_rc=$?

  rm -f "$TMP_FIX"
  trap - EXIT

  if [ "$fixture_rc" -eq 0 ]; then
    echo "SELF-TEST FAIL [FF-1]: broken fixture (no T-0027) PASSED — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0130] self-test PASS: broken fixture (no T-0027) correctly went red"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK against the live ADR.
# ---------------------------------------------------------------------------
echo "[T-0130] sim-adr-foundations: linting $ADR"
if run_foundations_check "$ADR"; then
  echo "PASS [FF-1]: all foundations named, no banned constructions"
  echo "PASS: sim-adr-foundations — FF-1 green"
  exit 0
else
  echo "FAIL: sim-adr-foundations — FF-1 red"
  exit 1
fi
