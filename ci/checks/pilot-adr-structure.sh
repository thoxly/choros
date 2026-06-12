#!/usr/bin/env bash
# T-0132 · FF-2..FF-10 — Pilot ADR structure linter (doc-structure)
#
# T-0132 is design-only; this fitness function machine-verifies the STRUCTURE
# of the ADR (docs/design/T-0132-pilot-rollout.adr.md): that each load-bearing
# claim is present as named sections/tokens, and that banned anti-patterns are
# absent. Companion to pilot-adr-foundations.sh (FF-1/FF-1b).
#
# CHECKS (any failure -> exit 1):
#
#   Check-AXES     (FF-2, AC-1, NF-1)  — three-axis primitives are existing
#                  T-0018 elements; no new scope-mechanism asserted.
#   Check-PREDICATE (FF-3, AC-2)       — interval = grant-predicate, NOT
#                  process if-filter.
#   Check-NARROW   (FF-4, AC-3)        — monotone narrowing via validateNarrowing,
#                  no bypass / self-apply expansion.
#   Check-GRAN1    (FF-5, AC-4, NF-2)  — GRAN-1 pilot/simulation boundary
#                  explicit; no simulate=true effect-toggle.
#   Check-STATES   (FF-6, AC-6)        — state machine with >=5 states + auto-
#                  expiry via isEffective.
#   Check-AUDIT    (FF-7, AC-7, AC-11) — single audit log, pilot NOT labelled
#                  test; no second log.
#   Check-SEAM     (FF-8, AC-9, AC-10) — T-0129 seam + drain-by-default +
#                  предусловие (promote is prerequisite).
#   Check-NATURE   (FF-9, AC-13, AC-14)— product concept + two-floor UX
#                  invariant; no "client edits lattice" path.
#   Check-TRACE    (FF-10, AC-15, AC-16)— >=16 AC traceability rows + [НОВАЯ B-
#                  derivative tasks present.
#
# METHOD: plain grep / awk. grep errors (exit >= 2) fail loud.
#
# SELF-TEST:
#   --self-test runs Check-TRACE against a BROKEN fixture (one AC row deleted,
#   leaving 15). The check MUST go red. If not -> exit 2. On success -> exit 0.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADR="$REPO_ROOT/docs/design/T-0132-pilot-rollout.adr.md"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

grep_present() {
  local file="$1" pat="$2" ff="$3" desc="$4"
  set +e
  grep -qF "$pat" "$file"
  local rc=$?
  set -e
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error scanning for '$pat' in $file (exit $rc)"
    return 1
  elif [ "$rc" -ne 0 ]; then
    echo "FAIL [$ff]: required token MISSING — $desc ('$pat')"
    return 1
  fi
  return 0
}

# grep_absent: strips guard/meta lines (lines mentioning банит/баним/фикстура/
# Check-/FF-/BANNED/Banned: or explicit negation «НЕ реализуется»/«not»/«НЕ»)
# so the banned token only trips on genuine affirmative assertions.
grep_absent() {
  local file="$1" pat="$2" ff="$3" desc="$4"
  set +e
  local hits
  hits=$(grep -vE 'банит|баним|сторожит|self-test|--self-test|фикстура|красный|Check-|\bFF-[0-9]|BANNED|Banned:|\*\*НЕ\*\*|НЕ реализуется|not_asserted' "$file" \
         | grep -F "$pat")
  local rc=$?
  set -e
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error scanning for banned '$pat' in $file (exit $rc)"
    return 1
  fi
  if [ "$rc" -eq 0 ] && [ -n "$hits" ]; then
    echo "FAIL [$ff]: banned construction ASSERTED — $desc ('$pat')"
    echo "$hits"
    return 1
  fi
  return 0
}

count_ge() {
  local file="$1" ere="$2" min="$3" ff="$4" desc="$5"
  set +e
  local n
  n=$(grep -cE "$ere" "$file")
  local rc=$?
  set -e
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error counting '$ere' in $file (exit $rc)"
    return 1
  fi
  if [ "$n" -lt "$min" ]; then
    echo "FAIL [$ff]: $desc — found $n, need >= $min"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# run_structure_check <adr-file>
# ---------------------------------------------------------------------------
run_structure_check() {
  local target="$1"
  local fail=0

  if [ ! -f "$target" ]; then
    echo "FAIL: ADR not found: $target"
    return 1
  fi

  # --- Check-AXES (FF-2, AC-1, NF-1) ---
  grep_present "$target" "interval"         "FF-2" "interval-kind present (T-0018 primitive)" || fail=1
  grep_present "$target" "set([node"        "FF-2" "set([node,...]) composition form" || fail=1
  grep_present "$target" "T-0018"           "FF-2" "reference to T-0018 scope-lattice" || fail=1
  grep_absent  "$target" "новый scope-механизм вводится" "FF-2" "no new scope-mechanism asserted" || fail=1

  # --- Check-PREDICATE (FF-3, AC-2) ---
  grep_present "$target" "grant-предикат"   "FF-3" "interval as grant-predicate (not if-filter)" || fail=1
  grep_present "$target" "validateNarrowing" "FF-3" "write-time gate validateNarrowing" || fail=1
  grep_absent  "$target" "if (case.amount"  "FF-3" "no process-level if-filter on amount" || fail=1

  # --- Check-NARROW (FF-4, AC-3) ---
  grep_present "$target" "validateNarrowing" "FF-4" "validateNarrowing (monotone narrowing gate)" || fail=1
  grep_present "$target" "сужение"          "FF-4" "narrowing concept" || fail=1
  grep_present "$target" "пилотный.scope ⊑" "FF-4" "pilot.scope ⊑ full.scope claim" || fail=1
  grep_absent  "$target" "обход validateNarrowing" "FF-4" "no bypass of validateNarrowing" || fail=1

  # --- Check-GRAN1 (FF-5, AC-4, NF-2) ---
  grep_present "$target" "published"        "FF-5" "published-tier pilot" || fail=1
  grep_present "$target" "застаблен"        "FF-5" "simulation effects stubbed (draft-affine)" || fail=1
  grep_present "$target" "охват, а НЕ"      "FF-5" "pilot limits scope, not liveness (GRAN-1)" || fail=1
  grep_present "$target" "T-0130"           "FF-5" "reference to T-0130 simulation" || fail=1
  grep_absent  "$target" "simulate=true гасит" "FF-5" "no simulate=true effect-toggle" || fail=1

  # --- Check-STATES (FF-6, AC-6) ---
  grep_present "$target" "запланирован"     "FF-6" "state: planned" || fail=1
  grep_present "$target" "активен"          "FF-6" "state: active" || fail=1
  grep_present "$target" "расширен"         "FF-6" "state: expanded" || fail=1
  grep_present "$target" "откачен"          "FF-6" "state: rolled-back" || fail=1
  grep_present "$target" "истёк"            "FF-6" "state: expired" || fail=1
  grep_present "$target" "isEffective"      "FF-6" "auto-expiry via isEffective" || fail=1
  grep_present "$target" "без ручного действия" "FF-6" "auto-transition (no manual action)" || fail=1

  # --- Check-AUDIT (FF-7, AC-7, AC-11) ---
  grep_present "$target" "appendAuditEvent" "FF-7" "single audit sink appendAuditEvent" || fail=1
  grep_present "$target" "GrantAuditEvent"  "FF-7" "GrantAuditEvent type reference" || fail=1
  grep_present "$target" "НЕ помечен"       "FF-7" "pilot events NOT labelled test" || fail=1
  grep_present "$target" "комплаенс"        "FF-7" "compliance export mention" || fail=1
  grep_absent  "$target" "второй аудит-лог вводится" "FF-7" "no second audit log" || fail=1

  # --- Check-SEAM (FF-8, AC-9, AC-10) ---
  grep_present "$target" "T-0129"           "FF-8" "seam with T-0129 implementation loop" || fail=1
  grep_present "$target" "FR-10"            "FF-8" "T-0129 FR-10 parent requirement" || fail=1
  grep_present "$target" "drain-by-default" "FF-8" "drain-by-default rollback policy" || fail=1
  grep_present "$target" "предусловие"      "FF-8" "promote as prerequisite for pilot" || fail=1

  # --- Check-NATURE (FF-9, AC-13, AC-14) ---
  grep_present "$target" "продуктовое понятие" "FF-9" "pilot defined as product concept" || fail=1
  grep_present "$target" "two-floor"        "FF-9" "two-floor UX invariant" || fail=1
  grep_present "$target" "карточк"          "FF-9" "UX action in implementation card" || fail=1
  grep_absent  "$target" "клиент редактирует решётку руками" "FF-9" "no client-edits-lattice path" || fail=1

  # --- Check-TRACE (FF-10, AC-15, AC-16) ---
  # The ADR has exactly 16 AC traceability rows (AC-1..AC-16); min=16.
  count_ge "$target" '^\| AC-[0-9]' 16 "FF-10" ">=16 AC traceability rows" || fail=1
  grep_present "$target" "[НОВАЯ B-"        "FF-10" "derivative build tasks [НОВАЯ B-N]" || fail=1

  return $fail
}

# ---------------------------------------------------------------------------
# --self-test: prove the check can go red on a broken fixture.
# Fixture: delete one AC traceability row (15 left) -> Check-TRACE must fail.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0132] pilot-adr-structure --self-test: proving the check can fail"
  TMP_FIX="$REPO_ROOT/docs/design/_t0132_structure_broken.tmp.md"
  trap 'rm -f "$TMP_FIX"' EXIT

  if [ ! -f "$ADR" ]; then
    echo "SELF-TEST FAIL: ADR not found, cannot build fixture: $ADR (exit 2)"
    exit 2
  fi

  # Delete the FIRST AC traceability row -> 15 rows remain.
  awk 'BEGIN{done=0} /^\| AC-[0-9]/ && done==0 {done=1; next} {print}' "$ADR" > "$TMP_FIX"

  # Sanity: fixture must have 15 AC rows.
  set +e
  fix_rows=$(grep -cE '^\| AC-[0-9]' "$TMP_FIX")
  set -e
  if [ "$fix_rows" -ne 15 ]; then
    echo "SELF-TEST FAIL: fixture has $fix_rows AC rows, expected 15 — fixture build broken (exit 2)"
    rm -f "$TMP_FIX"; trap - EXIT
    exit 2
  fi

  fixture_rc=0
  run_structure_check "$TMP_FIX" >/dev/null 2>&1 || fixture_rc=$?

  rm -f "$TMP_FIX"
  trap - EXIT

  if [ "$fixture_rc" -eq 0 ]; then
    echo "SELF-TEST FAIL: broken fixture (15 AC rows) PASSED — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0132] self-test PASS: broken fixture (15 AC rows) correctly went red"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK against the live ADR.
# ---------------------------------------------------------------------------
echo "[T-0132] pilot-adr-structure: linting $ADR"
if run_structure_check "$ADR"; then
  echo "PASS: pilot-adr-structure — FF-2..FF-10 green"
  exit 0
else
  echo "FAIL: pilot-adr-structure — FF-2..FF-10 red"
  exit 1
fi
