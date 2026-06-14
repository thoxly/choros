#!/usr/bin/env bash
# T-0216 · CI workflow pins a UTF-8 locale (runner-locale invariant)
#
# Runner-locale invariant. Several frozen fitness checks grep over Cyrillic
# RANGE expressions like [а-яё] (e.g. ci/checks/T-0133-adr-shape.sh). GNU grep
# resolves a multibyte range against the locale's LC_COLLATE table; locales
# WITHOUT a real collation table (C, POSIX, and — counter-intuitively — C.UTF-8)
# raise "Invalid collation character" (exit 2) on such ranges, turning a
# green-local run red-on-runner.
#
# Empirically verified on ubuntu-latest (T-0216 diag run 27496192707):
#   LC_ALL=C.UTF-8      → grep "нов[а-яё]+"  → "Invalid collation character" rc=2
#   LC_ALL=C / POSIX    → byte-wise match, rc=0 (works, but not UTF-8-aware)
#   LC_ALL=en_US.UTF-8  → match, rc=0  (UTF-8-aware AND has a collation table)
#
# So a *.UTF-8 value alone is NOT sufficient — C.UTF-8 is the broken default.
# This check asserts ci.yml pins BOTH LANG and LC_ALL to a TERRITORY UTF-8
# locale (xx_YY.UTF-8, e.g. en_US.UTF-8) and explicitly REJECTS C.UTF-8 / C /
# POSIX, so the locale-dependent regression cannot return unnoticed.
#
# Assertions:
#   A1 — ci.yml pins LANG   to a territory UTF-8 locale (xx_YY.UTF-8), not C.UTF-8.
#   A2 — ci.yml pins LC_ALL to a territory UTF-8 locale (xx_YY.UTF-8), not C.UTF-8.
#
# SELF-TEST (--self-test): plant workflow fixtures (no pin / partial pin /
# broken C.UTF-8 pin / good territory pin) and assert the machinery classifies
# each correctly; exit 0 if the demonstration succeeds, 2 if the check is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Territory UTF-8 locale matcher: language_TERRITORY.UTF-8 (e.g. en_US.UTF-8,
# ru_RU.UTF-8). Requires the lang_TERR prefix, which excludes bare C.UTF-8 /
# C / POSIX (those have no collation table for multibyte ranges).
# Accepts .UTF-8 / .UTF8 / .utf-8 / .utf8, quoted or unquoted YAML scalar.
TERR_UTF8_RE="[a-z]{2,3}_[A-Z]{2}\.(UTF-?8|utf-?8)"

# assert_var_pinned <var> <ci.yml path> — true iff <var> is pinned to a
# territory UTF-8 locale.
assert_var_pinned() {
  local var="$1" f="$2"
  grep -Eq "^[[:space:]]*${var}:[[:space:]]*[\"']?${TERR_UTF8_RE}[\"']?[[:space:]]*$" "$f"
}

# assert_locale_pinned <ci.yml path> — true iff BOTH LANG and LC_ALL are pinned
# to a territory UTF-8 locale.
assert_locale_pinned() {
  local f="$1"
  assert_var_pinned "LANG" "$f" && assert_var_pinned "LC_ALL" "$f"
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0216] ci-locale-pinned: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # Fixture 1: NO locale pin → must be flagged.
  cat >"${tmp}/no-locale.yml" <<'YML'
name: ci
on:
  push:
jobs:
  ci:
    runs-on: ubuntu-latest
YML
  if assert_locale_pinned "${tmp}/no-locale.yml"; then
    echo "SELF-TEST FAIL: assertion passed a workflow with NO locale pin"
    exit 2
  fi
  echo "  [OK] flagged workflow with no locale pin"

  # Fixture 2: only LANG pinned (LC_ALL missing) → must still be flagged.
  cat >"${tmp}/lang-only.yml" <<'YML'
name: ci
env:
  LANG: en_US.UTF-8
on:
  push:
jobs:
  ci:
    runs-on: ubuntu-latest
YML
  if assert_locale_pinned "${tmp}/lang-only.yml"; then
    echo "SELF-TEST FAIL: assertion passed a workflow missing LC_ALL"
    exit 2
  fi
  echo "  [OK] flagged workflow with LANG but no LC_ALL"

  # Fixture 3: pinned to the BROKEN C.UTF-8 → must be flagged (this is the exact
  # regression T-0216 fixed; a *.UTF-8 value that lacks a collation table).
  cat >"${tmp}/c-utf8.yml" <<'YML'
name: ci
env:
  LANG: C.UTF-8
  LC_ALL: C.UTF-8
on:
  push:
jobs:
  ci:
    runs-on: ubuntu-latest
YML
  if assert_locale_pinned "${tmp}/c-utf8.yml"; then
    echo "SELF-TEST FAIL: assertion accepted C.UTF-8 (no collation table → broken)"
    exit 2
  fi
  echo "  [OK] flagged workflow pinned to C.UTF-8 (collation-broken)"

  # Fixture 4: both pinned to a territory UTF-8 locale → must pass.
  cat >"${tmp}/ok.yml" <<'YML'
name: ci
env:
  LANG: en_US.UTF-8
  LC_ALL: en_US.UTF-8
on:
  push:
jobs:
  ci:
    runs-on: ubuntu-latest
YML
  if ! assert_locale_pinned "${tmp}/ok.yml"; then
    echo "SELF-TEST FAIL: assertion rejected a correctly-pinned (en_US.UTF-8) workflow"
    exit 2
  fi
  echo "  [OK] accepted workflow with LANG+LC_ALL pinned to en_US.UTF-8"

  echo "[T-0216] ci-locale-pinned: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
CI="${ROOT}/.github/workflows/ci.yml"
echo "[T-0216] ci-locale-pinned: asserting ci.yml pins a collation-capable UTF-8 locale (runner-locale invariant)"

if [[ ! -f "${CI}" ]]; then
  echo "FAIL: ${CI} not found"
  exit 1
fi

if assert_locale_pinned "${CI}"; then
  echo "PASS: ci.yml pins LANG and LC_ALL to a territory UTF-8 locale (collation-capable)"
  exit 0
fi

echo "FAIL [T-0216]: ci.yml must pin BOTH LANG and LC_ALL to a territory UTF-8 locale (e.g. en_US.UTF-8)" >&2
echo "  Cyrillic-RANGE greps (e.g. [а-яё]) in frozen checks fail with exit 2 ('Invalid collation" >&2
echo "  character') under C / POSIX / C.UTF-8 — those locales carry no multibyte collation table." >&2
exit 1
