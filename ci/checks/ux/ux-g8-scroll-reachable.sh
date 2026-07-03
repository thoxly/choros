#!/usr/bin/env bash
# T-0601 · OBLIK UX honest-gate G8 — the shell content pane must be reachable by scroll
#
# Live-proof bug (owner complaint, T-0601): on a real deployed stand, `.chs-screen`
# (web/src/app-shell/app.css) had `overflow: hidden` while its content was taller
# than the viewport (diagnosed height=591px vs scrollHeight=1498px on /llm-connections).
# Its ancestors `.chs-main`/`.chs-shell` are ALSO overflow:hidden by design (they are
# the fixed viewport frame — the browser window must not scroll as a whole, only the
# nav and the content pane may). With `.chs-screen` also hidden, the ONLY scrollable
# element left on the entire page was the left nav (`.chs-nav__scroll`) — the bottom
# of every screen taller than the viewport was physically unreachable by wheel/
# trackpad (ref/scrollIntoView calls in tests can still "reach" a hidden overflow
# box programmatically, which is why this shipped unnoticed — see ADR-T0601 §1 for
# why a deterministic static gate, not manual click-testing, is required here).
#
# FIX (T-0601): `.chs-screen` is the single legitimate scroll owner for shell-routed
# content — `overflow-y: auto` (not `overflow: hidden`). This does NOT create a
# double/nested scrollbar for the many screens that already carry their OWN bounded
# internal scroll container (`.chs-inbox` → `.chs-inbox__scroll`, `.chs-org` →
# `.chs-org__detail`, `.chs-audit-screen`, `.chs-notif-screen` → `.chs-notif__scroll`,
# `.chs-asst`, `.chs-editor` BPMN canvas, `.chs-forms-screen` canvas): those wrappers
# are sized `height:100%` / `flex:1` + `min-height:0`, so they FILL — never exceed —
# the bounded height `.chs-screen` already had from the flex layout above it. Giving
# `.chs-screen` an auto scrollbar only changes what happens if content DOES overflow
# the box; for those screens it still never engages (content fits exactly), and the
# inner scroller keeps doing the actual scrolling, same as before this fix. For the
# bare-div screens that had NO internal scroll wrapper at all (llm-connections,
# agents, llm-config, spend, reports, process-analytics, ops-overview,
# operational-analytics, assistant-prompt — confirmed by inventory, ADR-T0601 §1),
# `.chs-screen`'s scrollbar is now the ONLY one and makes the previously-dead tail
# of the screen reachable.
#
# THIS CHECK is STATIC (no jsdom/browser available in the web vitest tier — it runs
# with environment:'node', see web/vitest.config.js): it parses
# web/src/app-shell/app.css directly and asserts, for the `.chs-screen` rule:
#
#   A1 — the rule does NOT set `overflow: hidden` or `overflow-y: hidden` (the bug).
#   A2 — the rule DOES set `overflow-y: auto` (or `overflow: auto`) — proving the
#        fix is actively in place, not merely "not yet hidden".
#
# STRICT (exit 1 on failure) — no --required flag; the bug is fixed now and must
# stay fixed. This is a regression lock, not a phased rollout gate.
#
# SELF-TEST (--self-test): plants three temp CSS fixtures — (1) the ORIGINAL bug
# (`.chs-screen { overflow: hidden; }`) must FAIL A1; (2) a rule with neither hidden
# nor auto (e.g. `overflow: visible`) must FAIL A2 (fix not actively present); (3) the
# corrected rule (`overflow-y: auto`) must PASS both — asserts the detector behaves
# correctly on all three; exit 0 on success, 2 if the check machinery is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# extract_rule_body <file> <selector> — print the declaration block body (between
# the braces) of the FIRST rule matching a literal selector line (e.g. ".chs-screen"),
# one declaration per output line. Uses awk to track the matching selector's brace
# boundary. ASSUMES a flat, un-nested single-line-or-multi-line rule (the app.css
# style throughout this file: `.selector { decl; decl; }` on one line, or across a
# few lines) — good enough for this token-only stylesheet's actual shape.
extract_rule_body() {
  local file="$1" selector="$2"
  awk -v sel="${selector}" '
    BEGIN { insel=0; depth=0; body="" }
    {
      line = $0
      if (!insel) {
        # match "<selector> {" allowing leading whitespace and trailing content
        # on the same line (selector must appear as its own token, followed by
        # optional whitespace then "{").
        idx = index(line, sel)
        if (idx > 0) {
          after = substr(line, idx + length(sel))
          # next non-space char after the selector must be "{" (avoid matching
          # ".chs-screen-foo" as a prefix of ".chs-screen").
          gsub(/^[ \t]+/, "", after)
          if (substr(after, 1, 1) == "{") {
            insel = 1
            depth = 1
            rest = substr(after, 2)
            body = body rest "\n"
            # rule may close on the same line
            if (index(rest, "}") > 0) { insel = 0 }
            next
          }
        }
      } else {
        body = body line "\n"
        if (index(line, "}") > 0) { insel = 0 }
      }
    }
    END { printf "%s", body }
  ' "${file}"
}

# assert_no_overflow_hidden <body> — A1: body must not set overflow(-y):hidden.
assert_no_overflow_hidden() {
  ! grep -Eq 'overflow(-y)?[[:space:]]*:[[:space:]]*hidden' <<<"$1"
}

# assert_overflow_auto <body> — A2: body must set overflow(-y):auto.
assert_overflow_auto() {
  grep -Eq 'overflow(-y)?[[:space:]]*:[[:space:]]*auto' <<<"$1"
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0601] ux-g8-scroll-reachable: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # Fixture 1: the ORIGINAL bug — overflow:hidden. Must fail A1.
  cat >"${tmp}/bug.css" <<'CSS'
.chs-main { display: flex; overflow: hidden; }
.chs-screen { flex: 1; min-height: 0; overflow: hidden; }
.chs-iconbtn { width: 24px; }
CSS
  body="$(extract_rule_body "${tmp}/bug.css" ".chs-screen")"
  if assert_no_overflow_hidden "${body}"; then
    echo "SELF-TEST FAIL: did not detect overflow:hidden on .chs-screen (the T-0601 bug)"; exit 2
  fi
  echo "  [OK] flagged the original overflow:hidden bug"

  # Fixture 2: neither hidden nor auto (e.g. overflow:visible) — fix not present.
  # Must pass A1 (not hidden) but FAIL A2 (no active auto scroller).
  cat >"${tmp}/half.css" <<'CSS'
.chs-screen { flex: 1; min-height: 0; overflow: visible; }
CSS
  body="$(extract_rule_body "${tmp}/half.css" ".chs-screen")"
  if ! assert_no_overflow_hidden "${body}"; then
    echo "SELF-TEST FAIL: false positive on overflow:visible (not hidden)"; exit 2
  fi
  if assert_overflow_auto "${body}"; then
    echo "SELF-TEST FAIL: overflow:visible incorrectly counted as the auto-scroll fix"; exit 2
  fi
  echo "  [OK] overflow:visible passes A1 but correctly fails A2 (fix not actively present)"

  # Fixture 3: the CORRECTED rule — overflow-y:auto. Must pass both.
  cat >"${tmp}/fixed.css" <<'CSS'
.chs-screen { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
CSS
  body="$(extract_rule_body "${tmp}/fixed.css" ".chs-screen")"
  if ! assert_no_overflow_hidden "${body}"; then
    echo "SELF-TEST FAIL: false positive — overflow-x:hidden on a sibling axis must not trip A1 (only .chs-screen's own overflow(-y) matters, not overflow-x)"; exit 2
  fi
  if ! assert_overflow_auto "${body}"; then
    echo "SELF-TEST FAIL: did not detect the corrected overflow-y:auto"; exit 2
  fi
  echo "  [OK] corrected overflow-y:auto rule passes both assertions"

  # Fixture 4: selector prefix collision guard — a DIFFERENT rule
  # ".chs-screen-foo { overflow: hidden; }" must not be mistaken for ".chs-screen".
  cat >"${tmp}/prefix.css" <<'CSS'
.chs-screen-foo { overflow: hidden; }
.chs-screen { overflow-y: auto; }
CSS
  body="$(extract_rule_body "${tmp}/prefix.css" ".chs-screen")"
  if ! assert_no_overflow_hidden "${body}"; then
    echo "SELF-TEST FAIL: matched .chs-screen-foo's overflow:hidden instead of .chs-screen's own rule (selector prefix collision)"; exit 2
  fi
  echo "  [OK] does not confuse .chs-screen-foo with .chs-screen"

  echo "[T-0601] ux-g8-scroll-reachable: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
echo "[T-0601] ux-g8-scroll-reachable (G8): asserting the shell content pane (.chs-screen) is the reachable scroll owner"

APP_CSS="${ROOT}/web/src/app-shell/app.css"
if [[ ! -f "${APP_CSS}" ]]; then
  echo "FAIL [G8]: web/src/app-shell/app.css not found" >&2
  exit 1
fi

BODY="$(extract_rule_body "${APP_CSS}" ".chs-screen")"
if [[ -z "${BODY}" ]]; then
  echo "FAIL [G8]: no .chs-screen rule found in web/src/app-shell/app.css (selector renamed/removed?)" >&2
  exit 1
fi

ERRORS=0
if ! assert_no_overflow_hidden "${BODY}"; then
  echo "FAIL [G8/A1]: .chs-screen sets overflow(-y):hidden — content taller than the viewport becomes physically unreachable (the T-0601 live-proof bug). Rule body: ${BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi
if ! assert_overflow_auto "${BODY}"; then
  echo "FAIL [G8/A2]: .chs-screen does not set overflow(-y):auto — no active scroll owner for shell-routed content. Rule body: ${BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL [G8]: shell content pane is not a reachable scroller (${ERRORS} violation(s))" >&2
  exit 1
fi
echo "PASS [G8]: .chs-screen is the single reachable scroll owner (not hidden, overflow-y:auto active)"
exit 0
