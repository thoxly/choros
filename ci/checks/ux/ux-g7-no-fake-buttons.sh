#!/usr/bin/env bash
# T-0652 · OBLIK UX honest-gate G7 — «нет фейковых кнопок»
#
# RULE (design/ux-study-2026-07-05.md §6.1): a control either WORKS, or is
# VISIBLY disabled WITH A VISIBLE reason, or is not rendered at all. What is
# FORBIDDEN is the middle-ground fake: a button styled to look ordinary and
# clickable that silently does nothing — `aria-disabled="true"` (or an inert
# `onClick={(e) => e.preventDefault()}` as its ONLY handler) WITHOUT any
# visible explanation. A reason that lives only in `chs-sr-only` (screen-reader
# only) does NOT help the sighted user — they still see a "working" button that
# is dead. Two such stubs shipped in the topbar («Экспорт прав» / «+ Исполнитель»)
# — this gate stops new ones.
#
# DIFF-BASED: compares the current branch against dev (merge-base) and flags
# only NEWLY-ADDED ('+') lines. Pre-existing stubs in dev are NOT a violation —
# only new debt is. Safe to land on a tree that still has un-migrated stubs.
#
# SCOPE: added lines in web/src/screens/** and web/src/app-shell/**.
#
# DETECTION (line-local heuristic on an ADDED line):
#   A line that marks a control inert —
#     • aria-disabled="true"  / aria-disabled={true}
#     • onClick={(e) => e.preventDefault()}   (the inert-only handler idiom)
#   is a VIOLATION when that SAME added line does NOT ALSO carry a visible-reason
#   marker. Visible-reason markers (any ONE clears the line):
#     • aria-describedby=          — points at a reason element (we then trust
#                                    the author wired a VISIBLE one; the sr-only
#                                    anti-pattern is caught by the class check)
#     • className="…chs-…hint…"    — a visible hint span on the same line
#     • title=                     — a native tooltip reason (visible on hover)
#     • disabled                   — a real disabled attr (kit renders it visibly)
#   HARD anti-pattern (always flagged, even if a describedby is present): the
#   SAME added line pairs `aria-disabled` with `chs-sr-only` — a reason hidden
#   from sighted users is the exact fake this gate outlaws.
#
# This is a heuristic, not a parser: it is intentionally conservative (line-local)
# to stay portable (bash 3.2 POSIX-ERE, no PCRE) and to avoid false positives on
# multi-line JSX. It catches the copy-paste stub idiom, which is the real risk.
#
# MODE — INFORMATIONAL (default): prints findings, exits 0. Pass --required to
# fail (exit 1) on any newly-added fake button.
#
# SELF-TEST (--self-test): synthesizes a unified-diff exercising each path and
# asserts the classifier's verdicts. Exit 0 on success, 2 if broken.
#
# EXIT CODES: 0 clean / informational · 1 violation (only with --required) · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# An inert-control marker on the line.
INERT_RE='aria-disabled=("true"|\{true\})|onClick=\{\(e\)[[:space:]]*=>[[:space:]]*e\.preventDefault\(\)\}'
# A visible-reason marker on the SAME line (any one clears it).
REASON_RE='aria-describedby=|title=|[[:space:]]disabled([[:space:]=>/]|$)|className=[^>]*(hint|reason|stub)'
# The hard anti-pattern: an sr-only reason paired with an inert marker.
SRONLY_RE='chs-sr-only'

# classify_added_lines — reads a unified diff on stdin, prints "RULE\ttext" per
# offending ADDED line. Used by both MAIN and SELF-TEST.
classify_added_lines() {
  local line body
  while IFS= read -r line; do
    [[ "${line}" == +++* ]] && continue
    [[ "${line}" == +* ]] || continue
    body="${line#+}"
    # Only lines that mark a control inert are candidates.
    [[ "${body}" =~ ${INERT_RE} ]] || continue
    # HARD: inert + sr-only reason on the same line — a hidden reason IS the fake.
    if [[ "${body}" =~ ${SRONLY_RE} ]]; then
      printf 'sr-only-reason-on-inert-control\t%s\n' "${body}"
      continue
    fi
    # Inert WITHOUT any visible-reason marker → fake button.
    if [[ ! "${body}" =~ ${REASON_RE} ]]; then
      printf 'inert-control-no-visible-reason\t%s\n' "${body}"
    fi
  done
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0652] ux-g7-no-fake-buttons: --self-test"

  fake_diff=$'+++ b/web/src/app-shell/shell.jsx\n'
  # 1. inert + NO visible reason → FLAG (inert-control-no-visible-reason)
  fake_diff+=$'+        <Button aria-disabled="true" onClick={(e) => e.preventDefault()}>Экспорт</Button>\n'
  # 2. inert + sr-only reason on same line → FLAG (sr-only-reason-on-inert-control)
  fake_diff+=$'+        <Button aria-disabled="true" className="chs-sr-only">nope</Button>\n'
  # 3. inert + aria-describedby → CLEAN (author wired a reason element)
  fake_diff+=$'+        <Button aria-disabled="true" aria-describedby="topbar-org-hint">Исполнитель</Button>\n'
  # 4. inert + visible hint class → CLEAN
  fake_diff+=$'+        <Button aria-disabled="true" className="chs-btn--stub chs-hint">X</Button>\n'
  # 5. inert + title → CLEAN
  fake_diff+=$'+        <Button aria-disabled="true" title="в разработке">Y</Button>\n'
  # 6. a real working button (no inert marker) → CLEAN (not a candidate)
  fake_diff+=$'+        <Button onClick={() => doThing()}>Работает</Button>'

  out="$(printf '%s\n' "${fake_diff}" | classify_added_lines)"

  if ! grep -q $'inert-control-no-visible-reason\t.*Экспорт' <<<"${out}"; then
    echo "SELF-TEST FAIL: missed an inert control with NO visible reason"; exit 2
  fi
  echo "  [OK] flagged inert control without visible reason"

  if ! grep -q $'sr-only-reason-on-inert-control\t' <<<"${out}"; then
    echo "SELF-TEST FAIL: missed inert control whose reason is chs-sr-only only"; exit 2
  fi
  echo "  [OK] flagged sr-only-only reason on inert control"

  if grep -q 'aria-describedby="topbar-org-hint"' <<<"${out}"; then
    echo "SELF-TEST FAIL: flagged an inert control that HAS aria-describedby"; exit 2
  fi
  echo "  [OK] inert + aria-describedby not flagged"

  if grep -q 'chs-btn--stub chs-hint' <<<"${out}"; then
    echo "SELF-TEST FAIL: flagged an inert control with a visible hint class"; exit 2
  fi
  echo "  [OK] inert + visible hint class not flagged"

  if grep -q 'title="в разработке"' <<<"${out}"; then
    echo "SELF-TEST FAIL: flagged an inert control with a title reason"; exit 2
  fi
  echo "  [OK] inert + title not flagged"

  if grep -q 'Работает' <<<"${out}"; then
    echo "SELF-TEST FAIL: flagged a working (non-inert) button"; exit 2
  fi
  echo "  [OK] working button not flagged"

  if grep -q 'shell.jsx' <<<"${out}"; then
    echo "SELF-TEST FAIL: classified the '+++' diff header"; exit 2
  fi
  echo "  [OK] '+++' diff header ignored"

  echo "[T-0652] ux-g7-no-fake-buttons: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
REQUIRED=0
if [[ "${1:-}" == "--required" ]]; then REQUIRED=1; fi
MODE_LABEL="INFORMATIONAL"
[[ "${REQUIRED}" -eq 1 ]] && MODE_LABEL="REQUIRED"

echo "[T-0652] ux-g7-no-fake-buttons (G7): scanning NEW diff lines for fake buttons (mode=${MODE_LABEL})"

BASE=""
if git -C "${ROOT}" rev-parse --verify -q dev >/dev/null 2>&1; then
  BASE="$(git -C "${ROOT}" merge-base dev HEAD 2>/dev/null || true)"
fi

if [[ -z "${BASE}" ]]; then
  echo "[T-0652] ux-g7-no-fake-buttons: no dev/merge-base reachable — nothing to diff (clean)"
  echo "PASS [G7]: no new fake buttons (no base ref)"
  exit 0
fi

# SCOPE: JSX/TSX only — controls (the aria-disabled/onClick idioms) live there.
# CSS selectors like `.chs-btn--stub[aria-disabled="true"]` legitimately carry
# the attribute string and are NOT controls, so we never scan *.css here.
DIFF="$(git -C "${ROOT}" diff "${BASE}...HEAD" -- \
  'web/src/screens/**/*.jsx' 'web/src/screens/**/*.tsx' \
  'web/src/app-shell/**/*.jsx' 'web/src/app-shell/**/*.tsx' 2>/dev/null || true)"

FINDINGS="$(printf '%s\n' "${DIFF}" | classify_added_lines || true)"

COUNT=0
if [[ -n "${FINDINGS//[$'\n']/}" ]]; then
  COUNT="$(grep -c . <<<"${FINDINGS}" || true)"
  echo "${FINDINGS}" | sed '/^$/d'
fi

echo "[T-0652] ux-g7-no-fake-buttons: ${COUNT} newly-added fake-button finding(s)"

if [[ "${COUNT}" -gt 0 && "${REQUIRED}" -eq 1 ]]; then
  echo "FAIL [G7]: branch adds a control that is inert without a VISIBLE reason — make it work, visibly-disable it with a visible reason, or don't render it" >&2
  exit 1
fi
echo "PASS [G7]: informational (exit 0) — flip to required with --required once the topbar stubs are resolved"
exit 0
