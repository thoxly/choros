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
# DETECTION (T-0699: JSX-tag BLOCK scope, not line-local):
#   The unit of judgement is one JSX opening tag — from the line where `<Tag`
#   starts to the line carrying the `>` (or `/>`) that closes THAT opening tag
#   — not a single diff line. All ADDED (and any interleaved unchanged context)
#   lines inside that span are concatenated into one block before matching.
#   This was flipped from a pure line-local heuristic (T-0652) because a
#   synthetic-diff judge (T-0652 round 3) proved line-local is blind in BOTH
#   directions on real multi-line JSX: (a) it MISSES the exact anti-pattern it
#   exists to stop when `aria-disabled`/inert-`onClick` lands on one line and no
#   reason marker is anywhere in the tag (a multi-line fake button sails
#   through untouched); (b) it FALSE-POSITIVES on an honest multi-line control
#   whenever the reason marker (`title=`/`aria-describedby=`) is attached to a
#   DIFFERENT attribute line than `aria-disabled` — the real shape both
#   shell.jsx topbar stubs and the ra-grant-trail.jsx export stub use.
#
#   A block is a VIOLATION when the concatenated tag text carries an inert
#   marker —
#     • aria-disabled="true"  / aria-disabled={true}
#     • onClick={(e) => e.preventDefault()}   (the inert-only handler idiom)
#   and does NOT ALSO carry a visible-reason marker ANYWHERE in the same tag.
#   Visible-reason markers (any ONE clears the block):
#     • aria-describedby=          — points at a reason element (we then trust
#                                    the author wired a VISIBLE one; the sr-only
#                                    anti-pattern is caught by the class check)
#     • className="…chs-…hint…"    — a visible hint span on the same line
#     • title=                     — a native tooltip reason (visible on hover)
#     • disabled                   — a real disabled attr (kit renders it visibly)
#   HARD anti-pattern (always flagged, even if a describedby is present): the
#   tag pairs `aria-disabled` with `chs-sr-only` anywhere in the block — a
#   reason hidden from sighted users is the exact fake this gate outlaws.
#
#   Only a block whose OPENING line was itself added ('+') is tracked — a block
#   opened by unchanged context is pre-existing debt (or a pre-existing honest
#   control) and out of scope for a diff-based "only new debt" gate. Once
#   tracking starts, both added and interleaved context lines are folded in
#   (a genuinely new insertion is contiguous '+' lines in practice). Tracking
#   resets at any file/hunk boundary (`+++`/`---`/`@@`/`diff --git`) — a tag can
#   never span one, so an unterminated tag at a boundary is silently dropped
#   (no false judgement on a truncated view).
#
#   This is still a heuristic, not a parser (portable bash 3.2 POSIX-ERE, no
#   PCRE, no new deps): finding the tag-closing `>` is done by stripping the
#   `=>`/`>=` two-char tokens (arrow functions / numeric comparisons) before
#   testing for a leftover `>` — a bare `>` comparison inside a JSX expression
#   (e.g. `{count > 5}`) can still misfire as a tag boundary; none of the
#   controls this gate guards use that shape today.
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

# An inert-control marker anywhere in the tag block.
INERT_RE='aria-disabled=("true"|\{true\})|onClick=\{\(e\)[[:space:]]*=>[[:space:]]*e\.preventDefault\(\)\}'
# A visible-reason marker anywhere in the SAME tag block (any one clears it).
REASON_RE='aria-describedby=|title=|[[:space:]]disabled([[:space:]=>/]|$)|className=[^>]*(hint|reason|stub)'
# The hard anti-pattern: an sr-only reason paired with an inert marker.
SRONLY_RE='chs-sr-only'
# A JSX opening tag start, e.g. `<Button` / `<span`.
TAGSTART_RE='<[A-Za-z]'

# judge_block — classifies ONE fully-accumulated JSX opening-tag block (all its
# attribute text concatenated). Prints "RULE\ttext" when it violates. Global
# state (IN_TAG/BLOCK) is owned by classify_added_lines; this only reads its arg.
judge_block() {
  local text="$1"
  # Only lines that mark a control inert are candidates.
  [[ "${text}" =~ ${INERT_RE} ]] || return 0
  # HARD: inert + sr-only reason anywhere in the block — a hidden reason IS the fake.
  if [[ "${text}" =~ ${SRONLY_RE} ]]; then
    printf 'sr-only-reason-on-inert-control\t%s\n' "${text}"
    return 0
  fi
  # Inert WITHOUT any visible-reason marker anywhere in the block → fake button.
  if [[ ! "${text}" =~ ${REASON_RE} ]]; then
    printf 'inert-control-no-visible-reason\t%s\n' "${text}"
  fi
}

# has_tag_close <text> — true iff <text> carries the `>` (or `/>`) that closes a
# JSX opening tag, i.e. a `>` that survives stripping the two-char tokens `=>`
# (arrow functions) and `>=` (numeric comparisons) first.
has_tag_close() {
  local tmp="${1//=>/  }"
  tmp="${tmp//>=/  }"
  [[ "${tmp}" == *">"* ]]
}

# classify_added_lines — reads a unified diff on stdin, prints "RULE\ttext" per
# offending JSX-tag BLOCK (T-0699: block-scope, from `<Tag` to its closing `>`,
# not a single line). Used by both MAIN and SELF-TEST.
classify_added_lines() {
  local line marker body
  IN_TAG=0
  BLOCK=""
  while IFS= read -r line; do
    # File/hunk boundary — a tag can never span one; drop any in-flight block.
    if [[ "${line}" == +++* || "${line}" == ---* || "${line}" == @@* || "${line}" == "diff --git"* ]]; then
      IN_TAG=0
      BLOCK=""
      continue
    fi

    marker="${line:0:1}"

    if [[ "${IN_TAG}" -eq 1 ]]; then
      # Inside an in-progress tag: fold in '+' and unchanged context lines
      # (a genuinely new insertion is contiguous '+' in practice); a '-'
      # (removed) line belongs to the OLD tag shape — irrelevant, skip it.
      [[ "${marker}" == "+" || "${marker}" == " " ]] || continue
      body="${line:1}"
      BLOCK+=" ${body}"
      if has_tag_close "${BLOCK}"; then
        judge_block "${BLOCK}"
        IN_TAG=0
        BLOCK=""
      fi
      continue
    fi

    # Not inside a tag: only a newly-ADDED line can start new debt — a tag
    # opened by unchanged context is pre-existing and out of diff-based scope.
    [[ "${marker}" == "+" ]] || continue
    body="${line:1}"
    [[ "${body}" =~ ${TAGSTART_RE} ]] || continue

    if has_tag_close "${body}"; then
      judge_block "${body}"
    else
      IN_TAG=1
      BLOCK="${body}"
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
  fake_diff+=$'+        <Button onClick={() => doThing()}>Работает</Button>\n'
  # 7. T-0699 regression case (a): MULTI-LINE fake button — aria-disabled and
  #    the inert onClick land on SEPARATE added lines, no reason marker
  #    anywhere in the tag → MUST be flagged. A line-local heuristic misses
  #    this (neither line alone carries "inert + no reason" together).
  fake_diff+=$'+        <Button\n+          aria-disabled="true"\n+          onClick={(e) => e.preventDefault()}\n+        >РегрессФейк</Button>\n'
  # 8. T-0699 regression case (b): MULTI-LINE HONEST button, shell.jsx real
  #    shape — aria-disabled and its aria-describedby reason on DIFFERENT
  #    lines of the same opening tag → must NOT be flagged.
  fake_diff+=$'+        <Button\n+          variant="secondary"\n+          size="sm"\n+          aria-disabled="true"\n+          aria-describedby="hint-multiline-ok"\n+          className="chs-btn--stub"\n+          onClick={(e) => e.preventDefault()}\n+        >ЧестнаяДискрайб</Button>\n'
  # 9. T-0699 regression case (b), second shape — ra-grant-trail.jsx real
  #    shape — aria-disabled and its `title=` reason on DIFFERENT lines →
  #    must NOT be flagged.
  fake_diff+=$'+        <Button\n+          variant="secondary"\n+          size="sm"\n+          aria-disabled="true"\n+          className="chs-btn--stub"\n+          title="Нет записей для экспорта"\n+          onClick={(e) => e.preventDefault()}\n+        >ЧестнаяТайтл</Button>'

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

  # --- T-0699: block-scope (multi-line JSX tag) cases -----------------------

  if ! grep -q $'inert-control-no-visible-reason\t.*РегрессФейк' <<<"${out}"; then
    echo "SELF-TEST FAIL (T-0699): missed a MULTI-LINE inert control (attrs on separate added lines) with no visible reason anywhere in the tag"; exit 2
  fi
  echo "  [OK] T-0699: flagged multi-line fake button (aria-disabled + inert onClick on separate lines, no reason)"

  if grep -q 'ЧестнаяДискрайб' <<<"${out}"; then
    echo "SELF-TEST FAIL (T-0699): flagged a MULTI-LINE honest control whose aria-describedby reason lands on a different line than aria-disabled (shell.jsx real shape)"; exit 2
  fi
  echo "  [OK] T-0699: multi-line honest control (aria-describedby on a different line) not flagged"

  if grep -q 'ЧестнаяТайтл' <<<"${out}"; then
    echo "SELF-TEST FAIL (T-0699): flagged a MULTI-LINE honest control whose title reason lands on a different line than aria-disabled (ra-grant-trail.jsx real shape)"; exit 2
  fi
  echo "  [OK] T-0699: multi-line honest control (title on a different line) not flagged"

  # A tag that never closes before a hunk boundary must be dropped silently —
  # no false judgement on a truncated view, no crash.
  boundary_diff=$'+++ b/web/src/app-shell/shell.jsx\n@@ -1,3 +1,6 @@\n+        <Button\n+          aria-disabled="true"\n@@ -10,2 +13,2 @@\n+          onClick={(e) => e.preventDefault()}\n+        >ХвостБезГраницы</Button>'
  boundary_out="$(printf '%s\n' "${boundary_diff}" | classify_added_lines)"
  if [[ -n "${boundary_out}" ]]; then
    echo "SELF-TEST FAIL (T-0699): a tag truncated by a hunk boundary produced a finding instead of being dropped: ${boundary_out}"; exit 2
  fi
  echo "  [OK] T-0699: tag truncated at a hunk boundary is dropped, not judged"

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
