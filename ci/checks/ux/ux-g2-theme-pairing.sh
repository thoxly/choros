#!/usr/bin/env bash
# T-0298 · OBLIK UX honest-gate G2 (static) — light is the readable default, dark is reachable
#
# G2 (design/ux-quality-system.md §2.3): no subtree may render with a theme that
# does not match the active one. The audit's 🔴 finding #1 ("dark text on dark,
# invisible input") came from a node falling back to a DARK default when the
# theme was not propagated (FormViewer defaulted to 'dark'). OBLIK Phase 0
# (T-0296) inverted that: LIGHT semantics now live in :root (the default any
# un-themed node falls into) and DARK is an explicit, equal [data-theme="dark"]
# block.
#
# This STATIC half asserts that inversion holds in BOTH token sources — the app
# tokens (web/src/design/tokens.css) AND the self-contained form copy
# (web/src/forms/form-theme.css), which must stay in sync because the form
# renders in an iframe with its own theme machinery:
#
#   A1 — file defines a [data-theme="dark"] block (dark is reachable).
#   A2 — :root carries the light semantics, proven by --chs-color-bg being
#        defined INSIDE the :root block (so an un-themed node lands on the
#        readable light bg, not nothing / not dark).
#
# This is STRICT (exit 1 on failure): T-0296 already made it true, so it must be
# green NOW and stay green. No --required flag — it is required by construction.
#
# SELF-TEST (--self-test): plants a temp CSS missing the dark block and asserts
# the assertion fails on it (and passes a correctly-paired one); exit 0 on
# success, 2 if the check machinery is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# has_dark_block <file> — true iff the file defines a [data-theme="dark"] { … }
# selector block.
has_dark_block() {
  grep -Eq '^[[:space:]]*\[data-theme="dark"\][[:space:]]*\{' "$1"
}

# root_has_light_bg <file> — true iff --chs-color-bg is declared INSIDE the
# :root block (between ':root {' and its closing '}'), proving light semantics
# are the default. Uses awk to track the :root block boundary so a --chs-color-bg
# that only lives under [data-theme="dark"] does NOT satisfy the assertion.
# ASSUMES a flat, un-nested :root { … } block: the boundary is the first '}'
# after ':root {'. CSS nesting inside :root would close the block early here;
# the token sources this guards are flat, so that is fine.
root_has_light_bg() {
  awk '
    /^[[:space:]]*:root[[:space:]]*\{/ { in_root=1; next }
    in_root && /\}/                    { in_root=0 }
    in_root && /--chs-color-bg[[:space:]]*:/ { found=1 }
    END { exit (found ? 0 : 1) }
  ' "$1"
}

# assert_theme_pairing <file> — A1 && A2.
assert_theme_pairing() {
  has_dark_block "$1" && root_has_light_bg "$1"
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0298] ux-g2-theme-pairing: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # Fixture 1: missing the dark block → must fail.
  cat >"${tmp}/no-dark.css" <<'CSS'
:root {
  --chs-color-bg: oklch(0.965 0.008 85);
}
CSS
  if assert_theme_pairing "${tmp}/no-dark.css"; then
    echo "SELF-TEST FAIL: passed a CSS missing the [data-theme=\"dark\"] block"; exit 2
  fi
  echo "  [OK] flagged CSS missing the dark block"

  # Fixture 2: --chs-color-bg only under dark, :root light bg absent → must fail.
  cat >"${tmp}/bg-only-dark.css" <<'CSS'
:root {
  --chs-color-text: oklch(0.2 0 0);
}
[data-theme="dark"] {
  --chs-color-bg: oklch(0.205 0.006 75);
}
CSS
  if assert_theme_pairing "${tmp}/bg-only-dark.css"; then
    echo "SELF-TEST FAIL: passed a CSS where :root lacks the light --chs-color-bg"; exit 2
  fi
  echo "  [OK] flagged CSS where :root carries no light bg"

  # Fixture 3: correctly paired → must pass.
  cat >"${tmp}/ok.css" <<'CSS'
:root {
  --chs-color-bg: oklch(0.965 0.008 85);
}
[data-theme="dark"] {
  --chs-color-bg: oklch(0.205 0.006 75);
}
CSS
  if ! assert_theme_pairing "${tmp}/ok.css"; then
    echo "SELF-TEST FAIL: rejected a correctly light-default / dark-reachable CSS"; exit 2
  fi
  echo "  [OK] accepted correctly-paired CSS"

  echo "[T-0298] ux-g2-theme-pairing: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
echo "[T-0298] ux-g2-theme-pairing (G2-static): asserting light is the default, dark is reachable, in both token sources"

ERRORS=0
for rel in "web/src/design/tokens.css" "web/src/forms/form-theme.css"; do
  f="${ROOT}/${rel}"
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${rel} not found"
    ERRORS=$((ERRORS + 1))
    continue
  fi
  if ! has_dark_block "${f}"; then
    echo "FAIL [G2/A1]: ${rel} has no [data-theme=\"dark\"] block (dark not reachable)"
    ERRORS=$((ERRORS + 1))
  fi
  if ! root_has_light_bg "${f}"; then
    echo "FAIL [G2/A2]: ${rel} :root does not declare --chs-color-bg (light is not the readable default)"
    ERRORS=$((ERRORS + 1))
  fi
  if has_dark_block "${f}" && root_has_light_bg "${f}"; then
    echo "PASS: ${rel} — :root light default + [data-theme=\"dark\"] reachable"
  fi
done

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL [G2]: theme-pairing broken (${ERRORS} violation(s)) — light must be the default, dark explicit" >&2
  exit 1
fi
echo "PASS [G2]: theme-pairing intact in both token sources"
exit 0
