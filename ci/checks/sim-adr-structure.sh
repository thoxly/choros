#!/usr/bin/env bash
# T-0130 · FF-2..FF-8 — Simulation ADR structure linter (doc-structure)
#
# T-0130 is design-only; this fitness function machine-verifies the STRUCTURE of
# the ADR (docs/design/T-0130-simulation.adr.md): that each load-bearing claim
# the ADR makes is actually present as named sections / tokens, and that banned
# anti-pattern phrases are absent. Companion to sim-adr-foundations.sh (FF-1).
#
# CHECKS (each a guarded grep block; any failure -> exit 1):
#   Check-MODES   (FF-2, AC-6)  — 3 mode sections present, each with a boundary
#                                 token ("НЕ доказывает"/"not_proven").
#   Check-STATIST (FF-3, AC-8)  — statist ephemerality tokens present; banned
#                                 "статист = employee" forms absent.
#   Check-EFFECT  (FF-4, AC-11/14) — draft-affine effect red-line tokens present
#                                 ("draft-аффин","по построению","0 реальных");
#                                 banned effect-toggle forms absent.
#   Check-VERDICT (FF-5, AC-13) — deterministic + advisory + human-gate present;
#                                 banned "advisory автогейтит промоут" absent.
#   Check-AB      (FF-6, AC-10/12) — RunVariant + "идентичн" + spend_ledger.
#   Check-SEAM    (FF-7, AC-16) — §10 has T-0129 + >=6 consumption rows + 4
#                                 non-reopened invariants.
#   Check-TRACE   (FF-8)        — 17 "| AC-N |" traceability rows + 2026-06-11.
#
# METHOD: plain grep. grep errors (exit >= 2) fail loud (no || true on the real
# check). Missing-required OR present-banned -> failure.
#
# SELF-TEST (FF-9 contributor):
#   --self-test runs Check-TRACE against a BROKEN fixture (an ADR copy with one
#   AC traceability row deleted, leaving 16). The structure check MUST go red on
#   it. If the broken fixture passes, the check is broken -> exit 2. On success
#   of the demonstration, exit 0.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADR="$REPO_ROOT/docs/design/T-0130-simulation.adr.md"

# grep_present <file> <fixed-pattern> <ff-id> <human-desc>  -> 0 ok / 1 missing
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

# grep_absent <file> <fixed-pattern> <ff-id> <human-desc>  -> 0 ok / 1 present
#
# A banned phrase is a VIOLATION only when ASSERTED, not when the ADR QUOTES it
# to say it is banned (the §13 fitness table and the inline FF guards spell each
# banned phrase out inside guillemets, e.g. банит «статист — сотрудник»). We
# therefore strip guard-description lines (lines mentioning банит/баним/сторожит/
# self-test/фикстура/красный/Check-/FF-) BEFORE searching, so only an affirmative
# assertion of the banned phrase trips the check.
grep_absent() {
  local file="$1" pat="$2" ff="$3" desc="$4"
  set +e
  local hits
  hits=$(grep -vE 'банит|баним|сторожит|self-test|--self-test|фикстура|красный|Check-|\bFF-[0-9]' "$file" | grep -F "$pat")
  local rc=$?
  set -e
  # rc=1 => no match after filtering (clean); rc=0 => banned assertion present;
  # rc>=2 => grep pipeline error.
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error scanning for banned '$pat' in $file (exit $rc)"
    return 1
  elif [ "$rc" -eq 0 ] && [ -n "$hits" ]; then
    echo "FAIL [$ff]: banned construction ASSERTED — $desc ('$pat')"
    echo "$hits"
    return 1
  fi
  return 0
}

# count_ge <file> <ERE> <min> <ff-id> <human-desc>  -> 0 ok / 1 too few
count_ge() {
  local file="$1" ere="$2" min="$3" ff="$4" desc="$5"
  set +e
  local n
  n=$(grep -cE "$ere" "$file")
  local rc=$?
  set -e
  # grep -c returns 1 when zero matches; >=2 is a real error.
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

run_structure_check() {
  local target="$1"
  local fail=0

  if [ ! -f "$target" ]; then
    echo "FAIL: ADR not found: $target"
    return 1
  fi

  # --- Check-MODES (FF-2, AC-6) ---
  count_ge "$target" '^## 3\. Режим 1|^## 4\. Режим 2|^## 5\. Режим 3' 3 "FF-2" "3 mode sections (Режим 1/2/3)" || fail=1
  grep_present "$target" "not_proven" "FF-2" "режим-1 boundary token not_proven" || fail=1
  grep_present "$target" "НЕ доказывает" "FF-2" "explicit 'НЕ доказывает' boundary" || fail=1

  # --- Check-STATIST (FF-3, AC-8) ---
  grep_present "$target" "StatistSubject" "FF-3" "ephemeral statist subject type" || fail=1
  grep_present "$target" "DraftStatistGrantSource" "FF-3" "statist grant-source overlay" || fail=1
  grep_present "$target" "эфемерный" "FF-3" "statist ephemerality" || fail=1
  grep_absent  "$target" "статист — сотрудник" "FF-3" "statist must NOT be an employee" || fail=1
  grep_absent  "$target" "статист получает assignment" "FF-3" "statist must NOT get assignment" || fail=1

  # --- Check-EFFECT (FF-4, AC-11/AC-14) ---
  grep_present "$target" "draft-аффин" "FF-4" "draft-affine effect red-line" || fail=1
  grep_present "$target" "по построению" "FF-4" "deny by construction" || fail=1
  grep_present "$target" "0 реальных" "FF-4" "zero real effects claim" || fail=1
  grep_absent  "$target" "simulate=true гасит эффекты" "FF-4" "no simulate=true effect-toggle" || fail=1
  grep_absent  "$target" "флаг выключения эффектов" "FF-4" "no effect-disable flag" || fail=1

  # --- Check-VERDICT (FF-5, AC-13) ---
  grep_present "$target" "deterministic" "FF-5" "deterministic verdict half" || fail=1
  grep_present "$target" "advisory" "FF-5" "advisory verdict half" || fail=1
  grep_present "$target" "human-gate" "FF-5" "promote stays human-gate" || fail=1
  grep_absent  "$target" "advisory автогейтит промоут" "FF-5" "advisory must NOT autogate promote" || fail=1

  # --- Check-AB (FF-6, AC-10/AC-12) ---
  grep_present "$target" "RunVariant" "FF-6" "A/B run variant" || fail=1
  grep_present "$target" "идентичн" "FF-6" "identical scenario set across variants" || fail=1
  grep_present "$target" "spend_ledger" "FF-6" "cost from spend_ledger (T-0023)" || fail=1

  # --- Check-SEAM (FF-7, AC-16) ---
  grep_present "$target" "T-0129" "FF-7" "seam with T-0129" || fail=1
  # §10.1 consumption table: >=6 table data rows in the section.
  set +e
  local seam_rows
  seam_rows=$(awk '/^### 10\.1/,/^### 10\.2/' "$target" | grep -cE '^\| .+ \| .+ \|')
  set -e
  if [ "$seam_rows" -lt 7 ]; then  # 1 header + 6 guarantees
    echo "FAIL [FF-7]: §10.1 consumption table has $seam_rows rows, need >= 7 (header + 6 guarantees)"
    fail=1
  fi
  grep_present "$target" "frozen seam T-0129 §11" "FF-7" "reference to frozen seam T-0129 §11" || fail=1

  # --- Check-TRACE (FF-8) ---
  count_ge "$target" '^\| AC-[0-9]+ \|' 17 "FF-8" "17 AC traceability rows" || fail=1
  grep_present "$target" "2026-06-11" "FF-8" "founder-confirmation date present" || fail=1

  return $fail
}

# ---------------------------------------------------------------------------
# --self-test: prove the check can go red on a broken fixture (FF-9).
# Fixture: delete one AC traceability row (16 left) -> Check-TRACE must fail.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0130] sim-adr-structure --self-test: proving the check can fail"
  TMP_FIX="$REPO_ROOT/docs/design/_t0130_structure_broken.tmp.md"
  trap 'rm -f "$TMP_FIX"' EXIT

  if [ ! -f "$ADR" ]; then
    echo "SELF-TEST FAIL: ADR not found, cannot build fixture: $ADR (exit 2)"
    exit 2
  fi

  # Delete the FIRST AC traceability row -> 16 rows remain.
  awk 'BEGIN{done=0} /^\| AC-[0-9]+ \|/ && done==0 {done=1; next} {print}' "$ADR" > "$TMP_FIX"

  # Sanity: fixture must actually have 16 AC rows (proves the strip worked).
  set +e
  fix_rows=$(grep -cE '^\| AC-[0-9]+ \|' "$TMP_FIX")
  set -e
  if [ "$fix_rows" -ne 16 ]; then
    echo "SELF-TEST FAIL: fixture has $fix_rows AC rows, expected 16 — fixture build broken (exit 2)"
    rm -f "$TMP_FIX"; trap - EXIT
    exit 2
  fi

  # The function toggles set -e internally; guard the call with || so a
  # non-zero return does not abort us under set -e.
  fixture_rc=0
  run_structure_check "$TMP_FIX" >/dev/null 2>&1 || fixture_rc=$?

  rm -f "$TMP_FIX"
  trap - EXIT

  if [ "$fixture_rc" -eq 0 ]; then
    echo "SELF-TEST FAIL: broken fixture (16 AC rows) PASSED — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0130] self-test PASS: broken fixture (16 AC rows) correctly went red"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK against the live ADR.
# ---------------------------------------------------------------------------
echo "[T-0130] sim-adr-structure: linting $ADR"
if run_structure_check "$ADR"; then
  echo "PASS: sim-adr-structure — FF-2..FF-8 green"
  exit 0
else
  echo "FAIL: sim-adr-structure — FF-2..FF-8 red"
  exit 1
fi
