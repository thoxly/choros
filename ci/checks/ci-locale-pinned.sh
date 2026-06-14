#!/usr/bin/env bash
# T-0216 · CI workflow pins a UTF-8 locale (runner-locale invariant)
#
# Runner-locale invariant. Several frozen fitness checks grep over Cyrillic
# char-classes like [а-яё] (e.g. ci/checks/T-0133-adr-shape.sh). On a runner
# whose locale is C/POSIX, GNU grep raises "Invalid collation character" and
# exits 2 — turning a green-local run red-on-runner (the exact failure that
# T-0216 fixed). This check asserts .github/workflows/ci.yml pins BOTH LANG and
# LC_ALL to a UTF-8 locale at the workflow level, so a future locale-dependent
# bug cannot regress unnoticed.
#
# Assertions:
#   A1 — ci.yml declares LANG pinned to a *.UTF-8 (or *.utf8) locale.
#   A2 — ci.yml declares LC_ALL pinned to a *.UTF-8 (or *.utf8) locale.
#
# SELF-TEST (--self-test): plant a workflow fixture WITHOUT a locale pin and
# assert this check's machinery flags it; exit 0 if the demonstration succeeds,
# 2 if the check machinery is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# UTF-8 locale value matcher: LANG/LC_ALL = C.UTF-8, en_US.UTF-8, *.utf8, …
# (quoted or unquoted YAML scalar). Accepts .UTF-8 / .UTF8 / .utf-8 / .utf8.
UTF8_RE='[A-Za-z0-9_]+\.(UTF-?8|utf-?8)'

# assert_locale_pinned <ci.yml path> — true iff BOTH LANG and LC_ALL are pinned
# to a UTF-8 locale somewhere in the workflow file.
assert_locale_pinned() {
  local f="$1"
  grep -Eq "^[[:space:]]*LANG:[[:space:]]*[\"']?${UTF8_RE}[\"']?[[:space:]]*$" "$f" \
    && grep -Eq "^[[:space:]]*LC_ALL:[[:space:]]*[\"']?${UTF8_RE}[\"']?[[:space:]]*$" "$f"
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0216] ci-locale-pinned: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # Fixture 1: NO locale pin → must be flagged (assertion returns false).
  cat >"${tmp}/no-locale.yml" <<'YML'
name: ci
on:
  push:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npm run ci
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
  LANG: C.UTF-8
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

  # Fixture 3: both pinned to UTF-8 → must pass.
  cat >"${tmp}/ok.yml" <<'YML'
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
  if ! assert_locale_pinned "${tmp}/ok.yml"; then
    echo "SELF-TEST FAIL: assertion rejected a correctly-pinned workflow"
    exit 2
  fi
  echo "  [OK] accepted workflow with LANG+LC_ALL pinned to C.UTF-8"

  echo "[T-0216] ci-locale-pinned: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
CI="${ROOT}/.github/workflows/ci.yml"
echo "[T-0216] ci-locale-pinned: asserting ci.yml pins a UTF-8 locale (runner-locale invariant)"

if [[ ! -f "${CI}" ]]; then
  echo "FAIL: ${CI} not found"
  exit 1
fi

if assert_locale_pinned "${CI}"; then
  echo "PASS: ci.yml pins LANG and LC_ALL to a UTF-8 locale"
  exit 0
fi

echo "FAIL [T-0216]: ci.yml must pin BOTH LANG and LC_ALL to a UTF-8 locale" >&2
echo "  (Cyrillic-char-class greps in frozen checks fail with exit 2 under a C/POSIX locale.)" >&2
exit 1
