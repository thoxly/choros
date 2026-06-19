#!/usr/bin/env bash
# T-0298 · OBLIK UX honest-gate G6 — no NEWLY-ADDED hardcoded color / hand-rolled overlay
#
# G6 (design/ux-quality-system.md §2.3): screens must not introduce NEW
# hand-rolled inline modals/overlays or hardcoded colors outside the design
# layer — they must consume the kit. This is the anti-regression lock that
# keeps the OBLIK re-skin from rotting back into the 325-inline-style chaos the
# audit found (root cause A).
#
# DIFF-BASED: compares the current branch against dev (merge-base) and flags
# only NEWLY-ADDED ('+') lines. Pre-existing un-migrated hardcode in dev is NOT
# a violation — only new debt is. This is what makes the lock safe to land on a
# still-unmigrated tree.
#
# SCOPE: added lines in web/src/screens/** and web/src/app-shell/**.
#   EXCLUDED: web/src/design/** and web/src/components/** (tokens + kit legally
#   carry raw color values — that is the single enforced source).
#
# FLAGGED PATTERNS (in an added line):
#   rgba(                          raw rgba color literal
#   #[0-9a-fA-F]{3,6}              hex color literal
#   hand-rolled overlay modal:     a line carrying BOTH a fixed/inset position
#                                  AND an rgba background — i.e. an inline modal
#                                  scrim built by hand instead of via the kit.
#
# MODE — INFORMATIONAL (default): prints findings, exits 0. Pass --required to
# fail (exit 1) on any newly-added hardcode — the future honest-gate flip
# (D-056), enabled once the screens are migrated to the kit.
#
# SELF-TEST (--self-test): synthesizes a fake unified-diff exercising BOTH
# detector paths — a '+' line carrying rgba(0,0,0,0.55), a '+' line carrying a
# bare hex #3366ff, and a hand-rolled fixed-inset rgba overlay — and asserts
# each is flagged, while a tokenized var(--chs-…) line and the '+++' header are
# NOT. (The hex path is asserted explicitly because a non-portable `\b` regex
# would make it silently dead on bash 3.2 — see PORTABILITY above.) Exit 0 on
# success, 2 if broken.
#
# EXIT CODES: 0 clean / informational · 1 violation (only with --required) · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Added-color matcher: a unified-diff ADDED line ('+' but not the '+++' header)
# that carries a raw rgba(...) or a hex #rgb/#rrggbb literal. We deliberately do
# NOT flag CSS-var fallbacks like var(--chs-…, #888) here? — yes we DO flag the
# literal hex even inside a fallback, because the kit/token layer (excluded
# scope) is where fallbacks belong; screens should reference the token only.
# (So `var(--chs-color-text, #888)` IS flagged — a fallback hex in screens scope
# is still a hardcode; it lives in the excluded design/components layer instead.)
#
# PORTABILITY: the hex half uses an explicit trailing boundary
# `([^0-9a-fA-F]|$)` rather than the PCRE `\b` word-boundary. macOS /bin/bash
# 3.2 (the local `npm run fitness` env) runs POSIX-ERE in `[[ =~ ]]` and does
# NOT support `\b` — with `\b` the entire hex branch silently never matched
# locally (it only "worked" on CI ubuntu bash 5), a mac/CI divergence. The
# explicit boundary matches #rgb / #rrggbb on BOTH bash 3.2 and 5 while still
# rejecting partials like `#1234` / `#12` and anchors like `href="#section"`.
HARDCODE_RE='rgba\(|#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([^0-9a-fA-F]|$)'

# Hand-rolled overlay scrim: an added line that positions a fixed/absolute
# full-bleed layer AND paints an rgba background — the inline-modal smell.
OVERLAY_RE="(position:[[:space:]]*['\"]?fixed|inset:[[:space:]]*0).*background:[[:space:]]*['\"]?rgba"

# classify_added_lines — reads a unified diff on stdin and prints
# "RULE\ttext" for each offending ADDED line. Used by both MAIN and SELF-TEST.
classify_added_lines() {
  local line body
  while IFS= read -r line; do
    # Only ADDED content lines (start with a single '+', not the '+++' header).
    [[ "${line}" == +++* ]] && continue
    [[ "${line}" == +* ]] || continue
    body="${line#+}"
    if [[ "${body}" =~ ${OVERLAY_RE} ]]; then
      printf 'inline-overlay-modal\t%s\n' "${body}"
    elif [[ "${body}" =~ ${HARDCODE_RE} ]]; then
      printf 'hardcoded-color\t%s\n' "${body}"
    fi
  done
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0298] ux-g6-no-new-hardcode: --self-test"

  # A synthetic unified-diff fragment exercising BOTH detector paths:
  #   - one new rgba() hardcode line,
  #   - one new bare-hex (#3366ff) hardcode line — the path a non-portable `\b`
  #     regex would leave silently dead on bash 3.2,
  #   - one tokenized var(--chs-…) line (must pass),
  #   - one hand-rolled fixed-inset rgba overlay line,
  #   - the '+++' header (must be ignored).
  fake_diff=$'+++ b/web/src/screens/screen-x.jsx\n+        background: \'rgba(0,0,0,0.55)\',\n+        color: \'#3366ff\',\n+        color: var(--chs-color-text),\n+        position: \'fixed\', inset: 0, background: \'rgba(0,0,0,0.4)\','
  out="$(printf '%s\n' "${fake_diff}" | classify_added_lines)"

  if ! grep -qE $'hardcoded-color\t.*rgba\\(' <<<"${out}"; then
    echo "SELF-TEST FAIL: detector missed an added rgba() hardcode"; exit 2
  fi
  echo "  [OK] detected newly-added rgba() hardcode"

  if ! grep -qE $'hardcoded-color\t.*#3366ff' <<<"${out}"; then
    echo "SELF-TEST FAIL: detector missed an added bare-hex (#3366ff) hardcode (bash-3.2 \\b dead-regex regression)"; exit 2
  fi
  echo "  [OK] detected newly-added bare-hex (#3366ff) hardcode"

  if ! grep -q $'inline-overlay-modal\t' <<<"${out}"; then
    echo "SELF-TEST FAIL: detector missed a hand-rolled fixed-inset rgba overlay"; exit 2
  fi
  echo "  [OK] detected hand-rolled inline overlay modal"

  if grep -q 'var(--chs-color-text)' <<<"${out}"; then
    echo "SELF-TEST FAIL: detector flagged a tokenized var(--chs-…) line"; exit 2
  fi
  echo "  [OK] tokenized var(--chs-…) line not flagged"

  # The '+++' header must never be classified.
  if grep -q 'screen-x.jsx' <<<"${out}"; then
    echo "SELF-TEST FAIL: detector classified the '+++' diff header"; exit 2
  fi
  echo "  [OK] '+++' diff header ignored"

  echo "[T-0298] ux-g6-no-new-hardcode: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
REQUIRED=0
if [[ "${1:-}" == "--required" ]]; then REQUIRED=1; fi
MODE_LABEL="INFORMATIONAL"
[[ "${REQUIRED}" -eq 1 ]] && MODE_LABEL="REQUIRED"

echo "[T-0298] ux-g6-no-new-hardcode (G6): scanning NEW diff lines for hardcoded color / inline overlay (mode=${MODE_LABEL})"

# Base ref to diff against: merge-base with dev (so only this branch's additions
# are inspected). Fall back gracefully when dev/merge-base is unavailable
# (detached / shallow) — then there is nothing new to compare → clean.
BASE=""
if git -C "${ROOT}" rev-parse --verify -q dev >/dev/null 2>&1; then
  BASE="$(git -C "${ROOT}" merge-base dev HEAD 2>/dev/null || true)"
fi

if [[ -z "${BASE}" ]]; then
  echo "[T-0298] ux-g6-no-new-hardcode: no dev/merge-base reachable — nothing to diff (clean)"
  echo "PASS [G6]: no new hardcode (no base ref)"
  exit 0
fi

# Restrict the diff to the in-scope screen/app-shell paths, excluding the
# design + components layers (where raw color is legal).
DIFF="$(git -C "${ROOT}" diff "${BASE}...HEAD" -- \
  'web/src/screens/**' 'web/src/app-shell/**' \
  ':(exclude)web/src/design/**' ':(exclude)web/src/components/**' 2>/dev/null || true)"

FINDINGS="$(printf '%s\n' "${DIFF}" | classify_added_lines || true)"

COUNT=0
if [[ -n "${FINDINGS//[$'\n']/}" ]]; then
  COUNT="$(grep -c . <<<"${FINDINGS}" || true)"
  echo "${FINDINGS}" | sed '/^$/d'
fi

echo "[T-0298] ux-g6-no-new-hardcode: ${COUNT} newly-added hardcode/overlay finding(s)"

if [[ "${COUNT}" -gt 0 && "${REQUIRED}" -eq 1 ]]; then
  echo "FAIL [G6]: branch adds new hardcoded color / hand-rolled overlay — consume the kit instead" >&2
  exit 1
fi
echo "PASS [G6]: informational (exit 0) — flip to required with --required once screens consume the kit"
exit 0
