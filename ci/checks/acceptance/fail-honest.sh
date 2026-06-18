#!/usr/bin/env bash
# T-0283 · FF-5 — fail-honest: the deploy-acceptance gate MUST go red (exit≠0) when
# an affordance is broken; it can never be green-by-omission (ADR T-0278 §2.4 / NF5,
# AC-8, FF-5). Absence of proof-of-click = red, not "зелёное на ветке".
#
# Default mode (static): assert the fail-honest CONTRACT is encoded in the harness:
#   FF-5-1 — a negative spec exists (e2e/tel-linear-negative.e2e.ts) and asserts the
#            launch affordance is present+enabled and that the start-route returns a
#            2xx — so a regressed/disabled affordance turns the gate red.
#   FF-5-2 — playwright.config.ts sets retries: 0 (a flaky-masking retry would let a
#            broken affordance slip through) — the gate fails on the first red.
#   FF-5-3 — the happy spec asserts a concrete status (toBe(201)/toBe(200)) on the
#            write routes, so a non-2xx (broken wiring) is a hard failure.
#
# --self-test mode: drive the COMPLEMENTARY direction empirically. Stand up a
#   deliberately-BROKEN stub server (serves the SPA shell but 404s
#   /api/processes/start) and run `playwright test` against it; assert the run exits
#   NON-ZERO. If the Playwright browser/binaries are unavailable this degrades to a
#   tooling-gap note (tester-rule 5) and still asserts the static contract, so the
#   ambient `fitness` gate stays green without browser binaries.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CONFIG="${PROJECT_ROOT}/playwright.config.ts"
NEG_SPEC="${PROJECT_ROOT}/e2e/tel-linear-negative.e2e.ts"
HAPPY_SPEC="${PROJECT_ROOT}/e2e/tel-linear.e2e.ts"
ERRORS=0

# ---------------------------------------------------------------------------
# Static contract assertions (shared by default + self-test).
# ---------------------------------------------------------------------------
assert_static_contract() {
  local before=${ERRORS}

  for f in "${CONFIG}" "${NEG_SPEC}" "${HAPPY_SPEC}"; do
    if [[ ! -f "${f}" ]]; then
      echo "FAIL [FF-5]: required harness file missing: ${f}"
      ERRORS=$((ERRORS + 1))
    fi
  done
  [[ ${ERRORS} -ne ${before} ]] && return

  # FF-5-1: negative spec asserts the launch affordance present+enabled.
  if ! grep -qE "toBeEnabled\(\)" "${NEG_SPEC}"; then
    echo "FAIL [FF-5-1]: negative spec does not assert the launch affordance is ENABLED"
    ERRORS=$((ERRORS + 1))
  fi
  if ! grep -qE "Запустить процесс" "${NEG_SPEC}"; then
    echo "FAIL [FF-5-1]: negative spec does not exercise the «Запустить процесс» affordance"
    ERRORS=$((ERRORS + 1))
  fi

  # FF-5-2: retries: 0 (no flaky-masking).
  if ! grep -qE "retries:[[:space:]]*0" "${CONFIG}"; then
    echo "FAIL [FF-5-2]: playwright.config.ts must set retries: 0 (no flaky-masking of a red)"
    ERRORS=$((ERRORS + 1))
  fi

  # FF-5-3: happy spec asserts concrete write-route statuses.
  if ! grep -qE "toBe\(201\)" "${HAPPY_SPEC}"; then
    echo "FAIL [FF-5-3]: happy spec does not assert start-route toBe(201) (non-2xx must fail honestly)"
    ERRORS=$((ERRORS + 1))
  fi
  if ! grep -qE "toBe\(200\)" "${HAPPY_SPEC}"; then
    echo "FAIL [FF-5-3]: happy spec does not assert form/claim toBe(200)"
    ERRORS=$((ERRORS + 1))
  fi

  if [[ ${ERRORS} -eq ${before} ]]; then
    echo "PASS [FF-5-static]: fail-honest contract encoded (enabled-affordance + retries:0 + concrete statuses)"
  fi
}

# ---------------------------------------------------------------------------
# --self-test: empirically prove the gate goes red against a BROKEN stand.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0283 FF-5] fail-honest --self-test: broken stand ⇒ gate exits non-zero"
  assert_static_contract

  # The empirical red-test needs BOTH the @playwright/test package (resolvable
  # WITHOUT an npx auto-install — a bare `npx playwright` would fetch from the
  # network) AND an installed chromium browser binary. Absent either → tooling-gap
  # (tester-rule 5): the static contract is still asserted, the ambient `fitness`
  # gate stays green + fast, and the empirical run is left to the deploy-acceptance
  # CI job (which runs `npx playwright install`). Opt out explicitly with
  # ACCEPTANCE_SELFTEST_SKIP_LIVE for a pure-static run.
  PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/Library/Caches/ms-playwright}"
  PW_CACHE_LINUX="${HOME}/.cache/ms-playwright"
  has_chromium=""
  if ls -d "${PW_CACHE}/"*chromium* >/dev/null 2>&1 \
    || ls -d "${PW_CACHE_LINUX}/"*chromium* >/dev/null 2>&1; then
    has_chromium="yes"
  fi
  if [[ -n "${ACCEPTANCE_SELFTEST_SKIP_LIVE:-}" ]] \
    || ! node -e "require.resolve('@playwright/test')" >/dev/null 2>&1 \
    || [[ -z "${has_chromium}" ]]; then
    echo "TOOLING-GAP [FF-5]: @playwright/test or chromium browser not installed; static contract asserted, empirical red-test deferred to the deploy-acceptance CI job (tester-rule 5)."
    [[ ${ERRORS} -gt 0 ]] && exit 1
    exit 0
  fi

  PORT=$(( ( RANDOM % 2000 ) + 4100 ))
  STUB="$(mktemp /tmp/fail-honest-stub-XXXXXX.mjs)"
  trap 'rm -f "$STUB"' EXIT
  # A BROKEN stand: serves a minimal SPA shell + /api/users, but 404s
  # /api/processes/start (no start wiring) and 404s the SPA assets — so the
  # click-through CANNOT complete and the gate MUST go red.
  cat > "$STUB" <<'STUBJS'
import http from "node:http";
const html = '<!DOCTYPE html><html><head><title>broken</title></head><body><div id="root"></div></body></html>';
http.createServer((req, res) => {
  if (req.url === "/health") { res.statusCode = 200; res.end("ok"); return; }
  if (req.url === "/api/users") { res.statusCode = 200; res.setHeader("content-type","application/json"); res.end(JSON.stringify({ users: [{ id: "e-orlov", name: "K", position: "p" }] })); return; }
  if (req.url && req.url.startsWith("/api/")) { res.statusCode = 404; res.end("{}"); return; }
  res.statusCode = 200; res.setHeader("content-type","text/html"); res.end(html);
}).listen(Number(process.env.STUB_PORT));
STUBJS
  STUB_PORT="${PORT}" node "$STUB" &
  STUB_PID=$!
  # shellcheck disable=SC2064
  trap "kill ${STUB_PID} 2>/dev/null || true; rm -f \"$STUB\"" EXIT

  # Give the stub a moment, then run the gate against it. We expect NON-ZERO.
  sleep 1
  set +e
  ACCEPTANCE_BASE_URL="http://localhost:${PORT}" ACCEPTANCE_SKIP_BOOTSTRAP=1 \
    npx playwright test --config "${CONFIG}" >/tmp/fail-honest-run.log 2>&1
  RUN_RC=$?
  set -e

  if [[ ${RUN_RC} -eq 0 ]]; then
    echo "SELF-TEST FAIL [FF-5]: gate was GREEN against a broken stand (no start-route) — NOT fail-honest!"
    tail -20 /tmp/fail-honest-run.log || true
    exit 1
  fi
  echo "SELF-TEST PASS [FF-5]: gate exited non-zero (rc=${RUN_RC}) against the broken stand"
  [[ ${ERRORS} -gt 0 ]] && exit 1
  exit 0
fi

# ---------------------------------------------------------------------------
# Default mode
# ---------------------------------------------------------------------------
echo "[T-0283 FF-5] fail-honest: contract that a broken affordance turns the gate red"
assert_static_contract
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: fail-honest found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: fail-honest (FF-5) clean"
