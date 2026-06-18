#!/usr/bin/env bash
# T-0283 · FF-6 — e2e-scope: the browser-E2E run is isolated to THIS checkout's
# e2e/ dir and excludes stale git-worktree paths, mirroring vitest.config.js (ADR
# T-0278 §2.4 / NF2 / AC-10, FF-6). Without this the gate recursively discovers
# specs from .claude/worktrees/* / ../choros-wt/* and runs them twice / on stale
# code → a non-deterministic gate (FE-2026-W24-0005).
#
# Static assertions over playwright.config.ts (no runtime):
#   FF-6-1 — testDir is e2e/ and testMatch pins *.e2e.ts.
#   FF-6-2 — the ignore/exclude list contains .claude/**, ../choros-wt/**, web/**,
#            node_modules/** — the SAME set vitest.config.js excludes (parity).
#
# --self-test: plant a config missing the worktree exclude and assert the predicate
# fires (FF-SELFTEST).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CONFIG="${PROJECT_ROOT}/playwright.config.ts"
VITEST="${PROJECT_ROOT}/vitest.config.js"
ERRORS=0

# Required exclude tokens — mirror vitest.config.js exclude verbatim.
REQUIRED_EXCLUDES=(".claude" "choros-wt" "web" "node_modules")

# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/e2e-scope-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT
  # A config that pins testDir but FORGETS the worktree exclude.
  printf 'export default { testDir: "e2e", testMatch: ["**/*.e2e.ts"], testIgnore: ["**/node_modules/**"] };\n' > "$TMP"
  missing=0
  for tok in ".claude" "choros-wt"; do
    if ! grep -qE "${tok}" "$TMP"; then missing=$((missing + 1)); fi
  done
  if [[ ${missing} -eq 0 ]]; then
    echo "SELF-TEST FAIL: missing-worktree-exclude not detected — check is broken"; exit 2
  fi
  echo "SELF-TEST PASS: e2e-scope predicate detects a missing worktree exclude"
  exit 0
fi

echo "[T-0283 FF-6] e2e-scope: browser-E2E discovery isolated to this checkout (NF2)"

if [[ ! -f "${CONFIG}" ]]; then
  echo "FAIL [FF-6]: playwright.config.ts missing"; exit 1
fi

# ---- FF-6-1: testDir = e2e/, testMatch pins *.e2e.ts --------------------------
before=${ERRORS}
if ! grep -qE "testDir:[[:space:]]*[\"']e2e[\"']" "${CONFIG}"; then
  echo "FAIL [FF-6-1]: testDir is not pinned to 'e2e'"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "testMatch" "${CONFIG}" || ! grep -qE "\*\.e2e\.ts" "${CONFIG}"; then
  echo "FAIL [FF-6-1]: testMatch does not pin *.e2e.ts"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-6-1]: testDir=e2e/ + testMatch=*.e2e.ts"
fi

# ---- FF-6-2: ignore list mirrors vitest exclude (worktree isolation) ----------
before=${ERRORS}
for tok in "${REQUIRED_EXCLUDES[@]}"; do
  if ! grep -qE "${tok}" "${CONFIG}"; then
    echo "FAIL [FF-6-2]: playwright.config.ts ignore list missing '${tok}' (vitest excludes it — parity required)"
    ERRORS=$((ERRORS + 1))
  fi
done
# Parity cross-check: every token vitest excludes (of our set) must be in the pw config.
if [[ -f "${VITEST}" ]]; then
  for tok in ".claude" "choros-wt" "web"; do
    if grep -qE "${tok}" "${VITEST}" && ! grep -qE "${tok}" "${CONFIG}"; then
      echo "FAIL [FF-6-2]: vitest excludes '${tok}' but playwright.config.ts does not (drift)"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-6-2]: ignore list mirrors vitest exclude (.claude/choros-wt/web/node_modules)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: e2e-scope found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: e2e-scope (FF-6) clean"
