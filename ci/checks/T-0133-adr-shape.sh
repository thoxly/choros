#!/usr/bin/env bash
# T-0133 · FF-self — Template-pack ADR shape linter (doc-structure)
#
# T-0133 is design-only; this fitness function machine-verifies the SHAPE of the ADR
# (docs/design/T-0133-process-templates.adr.md): that each load-bearing reference
# token is present and that banned anti-pattern phrases are absent.
#
# FF-self PRESENCE — the ADR must contain ALL of:
#   T-0082        — bundle-coherence опора
#   T-0140        — seed-pack прецедент (pакет-как-данные)
#   T-0129        — implementation-loop опора (FR-4 интервью)
#   T-0130        — simulation-gate опора
#   T-0031        — единый аудит appendAuditEvent
#   §7            — extensibility §7 (когерентная связка / атомарный коммит)
#   §8            — extensibility §8 (логические тиры draft→published)
#   §11           — extensibility §11 (managed-solution / vendor-documented cliff)
#   ТЭЛ           — референс ТЭЛ (contracts-процесс, founder-зафиксирован)
#   draft-тир     — тир-механика инстанцирования
#   managed-solution — vendor-update механика
#   two-floor     — инвариант two-floor (выбор по описанию)
#   fail-closed   — fail-closed гард
#
# FF-self ABSENCE — the ADR must NOT assertively claim:
#   новая.*сущность-хранилищ  — никаких новых таблиц-хранилищ day-1
#   прямой SQL-инстанц*       — инстанцирование не через прямой SQL
#
# NOTE: absence checks strip guard/meta lines (lines containing банит/баним/
#   FF-/сторожит/красный/ABSENT) before scanning, so FF-self description
#   lines quoting the banned phrases don't trip the check.
#
# SELF-TEST:
#   --self-test runs FF-self against a BROKEN fixture (ADR with token "T-0031"
#   removed). The check MUST go red. If it passes, the check is broken → exit 2.
#   On success of the demonstration, exit 0.
#
# Покрывает AC-2/AC-5/AC-13/AC-14 (fitness, спека T-0133).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ADR="$REPO_ROOT/docs/design/T-0133-process-templates.adr.md"

# ---------------------------------------------------------------------------
# Helper: grep_present <file> <fixed-pattern> <ff-id> <human-desc>
# Returns 0 if present, 1 if missing; >= 2 = grep error.
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

# ---------------------------------------------------------------------------
# Helper: grep_absent <file> <ERE-pattern> <ff-id> <human-desc>
# Strips guard/meta lines before checking. Returns 0 if absent, 1 if present.
# ---------------------------------------------------------------------------
grep_absent() {
  local file="$1" pat="$2" ff="$3" desc="$4"
  set +e
  local hits
  hits=$(grep -vE 'банит|баним|FF-self|сторожит|красный|ABSENT|CI-чек|ci_check|regex' "$file" \
         | grep -E "$pat")
  local rc=$?
  set -e
  if [ "$rc" -ge 2 ]; then
    echo "FAIL [$ff]: grep error scanning for banned '$pat' (exit $rc)"
    return 1
  elif [ "$rc" -eq 0 ] && [ -n "$hits" ]; then
    echo "FAIL [$ff]: banned construction ASSERTED — $desc"
    echo "$hits"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# run_shape_check <adr-file>
# ---------------------------------------------------------------------------
run_shape_check() {
  local target="$1"
  local fail=0

  if [ ! -f "$target" ]; then
    echo "FAIL [FF-self]: ADR not found: $target"
    return 1
  fi

  # --- PRESENCE tokens ---
  grep_present "$target" "T-0082"          "FF-self" "bundle-coherence опора"                || fail=1
  grep_present "$target" "T-0140"          "FF-self" "seed-pack прецедент"                   || fail=1
  grep_present "$target" "T-0129"          "FF-self" "implementation-loop опора (FR-4)"       || fail=1
  grep_present "$target" "T-0130"          "FF-self" "simulation-gate опора"                  || fail=1
  grep_present "$target" "T-0031"          "FF-self" "единый аудит appendAuditEvent"          || fail=1
  grep_present "$target" "§7"              "FF-self" "extensibility §7 (когерентная связка)"  || fail=1
  grep_present "$target" "§8"              "FF-self" "extensibility §8 (тиры draft→published)" || fail=1
  grep_present "$target" "§11"             "FF-self" "extensibility §11 (managed-solution)"   || fail=1
  grep_present "$target" "ТЭЛ"             "FF-self" "референс ТЭЛ (contracts-процесс)"       || fail=1
  grep_present "$target" "draft-тир"       "FF-self" "тир-механика инстанцирования"           || fail=1
  grep_present "$target" "managed-solution" "FF-self" "vendor-update managed-solution"        || fail=1
  grep_present "$target" "two-floor"       "FF-self" "инвариант two-floor"                    || fail=1
  grep_present "$target" "fail-closed"     "FF-self" "fail-closed гард"                       || fail=1

  # --- ABSENCE: no new storage entity day-1 (AC-2/AC-12) ---
  grep_absent "$target" \
    'нов[а-яё]+[[:space:]]+[а-яёА-ЯЁ]+[[:space:]]+сущность-хранилищ' \
    "FF-self" "новая сущность-хранилище (day-1 forbidden)" || fail=1

  # --- ABSENCE: no direct-SQL instantiation path (AC-2/FF-3 pre-condition) ---
  # Banned pattern: "прямой SQL" used as instantiation method WITHOUT negation on same line
  # Approach: lines containing "прям" and "SQL" but NOT "НЕ", "не", "никакого", "без"
  set +e
  local sql_hits
  sql_hits=$(grep -vE 'банит|баним|FF-self|сторожит|красный|ABSENT|CI-чек|ci_check|regex|deferred' "$target" \
             | grep -E 'прям[а-яё]+ SQL' \
             | grep -vE 'НЕ|не |никакого|без |НЕ прямой|не SQL|не через прям|not.*SQL')
  set -e
  if [ -n "$sql_hits" ]; then
    echo "FAIL [FF-self]: прямой SQL-путь заявлен как инстанцирование (AC-2)"
    echo "$sql_hits"
    fail=1
  fi

  return $fail
}

# ---------------------------------------------------------------------------
# --self-test: prove the check can go red on a broken fixture (FF-self).
# Fixture: strip all occurrences of "T-0031" → required token disappears → FAIL.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0133] T-0133-adr-shape --self-test: proving the check can fail"

  if [ ! -f "$ADR" ]; then
    echo "SELF-TEST FAIL: ADR not found, cannot build fixture: $ADR (exit 2)"
    exit 2
  fi

  TMP_FIX="$REPO_ROOT/docs/design/_t0133_shape_broken.tmp.md"
  trap 'rm -f "$TMP_FIX"' EXIT

  # Delete all lines containing "T-0031" → token vanishes from fixture.
  grep -v "T-0031" "$ADR" > "$TMP_FIX"

  # Sanity: fixture must NOT contain T-0031.
  set +e
  still_there=$(grep -c "T-0031" "$TMP_FIX" || true)
  set -e
  if [ "$still_there" -ne 0 ]; then
    echo "SELF-TEST FAIL: fixture still contains T-0031 — fixture build broken (exit 2)"
    rm -f "$TMP_FIX"; trap - EXIT
    exit 2
  fi

  fixture_rc=0
  run_shape_check "$TMP_FIX" >/dev/null 2>&1 || fixture_rc=$?

  rm -f "$TMP_FIX"
  trap - EXIT

  if [ "$fixture_rc" -eq 0 ]; then
    echo "SELF-TEST FAIL: broken fixture (T-0031 stripped) PASSED — check is broken (exit 2)"
    exit 2
  fi
  echo "[T-0133] self-test PASS: broken fixture correctly went red (exit $fixture_rc)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK against the live ADR.
# ---------------------------------------------------------------------------
echo "[T-0133] T-0133-adr-shape: linting $ADR"
if run_shape_check "$ADR"; then
  echo "PASS: T-0133-adr-shape — FF-self green (AC-2/AC-5/AC-13/AC-14)"
  exit 0
else
  echo "FAIL: T-0133-adr-shape — FF-self red"
  exit 1
fi
