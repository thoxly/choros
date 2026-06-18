#!/usr/bin/env bash
# T-0283 · FF-3 — no-mock-stack: the deploy-acceptance gate runs against the REAL
# stack (built web/dist + live HTTP + Postgres + Flowable), never a mock /
# in-memory fallback (ADR T-0278 §2.4 / NF1 / D-056, FF-3).
#
# Static assertions (grep / boundary analysis — no runtime) over the e2e harness:
#   FF-3-1 — playwright.config.ts baseURL points at a real localhost server
#            (the launched choros), NOT a mock host.
#   FF-3-2 — no e2e spec / config / bootstrap references a mock or in-memory
#            fallback (MOCK / in-memory / stub-server / storeMode:"memory" /
#            page.route(... fulfill) request-interception that fakes the backend).
#   FF-3-3 — the runner launches the server pointed at DATABASE_URL + the Flowable
#            REST base (real engine), and serves the built web/dist (CHOROS_WEB_DIST),
#            proving the gate drives the same artifact a user sees.
#
# SELF-TEST (`--self-test`): plants a `page.route(...fulfill)` mock + an `in-memory`
# token in temp files and asserts the predicates fire (FF-SELFTEST).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CONFIG="${PROJECT_ROOT}/playwright.config.ts"
E2E_DIR="${PROJECT_ROOT}/e2e"
RUNNER="${PROJECT_ROOT}/ops/acceptance-tel.mjs"
ERRORS=0

# grep wrapper: matches on NON-comment code lines (strips // * /* leading comments).
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -vE '^[[:space:]]*(//|\*|/\*|#)' "${file}" | grep -nE "${pattern}")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/no-mock-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT
  printf 'await page.route("**/api/**", (r) => r.fulfill({ body: "{}" }));\nconst store = "in-memory";\n' > "$TMP"
  if [[ -z "$(grep_noncomment 'route\(.*fulfill|in-memory|\bMOCK\b|storeMode.*memory' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: mock/in-memory not detected — check is broken"; exit 2
  fi
  echo "SELF-TEST PASS: no-mock-stack predicates detect planted violations"
  exit 0
fi

echo "[T-0283 FF-3] no-mock-stack: deploy-acceptance gate runs against the REAL stack"

# Files must exist (the harness is the deliverable).
for f in "${CONFIG}" "${RUNNER}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL [FF-3]: required harness file missing: ${f}"; exit 1
  fi
done
if [[ ! -d "${E2E_DIR}" ]]; then
  echo "FAIL [FF-3]: e2e/ directory missing"; exit 1
fi

# ---- FF-3-1: baseURL is a real localhost server, not a mock host --------------
before=${ERRORS}
if ! grep -qE "baseURL" "${CONFIG}"; then
  echo "FAIL [FF-3-1]: playwright.config.ts declares no baseURL"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "localhost:" "${CONFIG}"; then
  echo "FAIL [FF-3-1]: baseURL does not target a localhost server (real launched choros)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-3-1]: baseURL targets the real launched server"
fi

# ---- FF-3-2: no mock / in-memory fallback in any e2e file ---------------------
before=${ERRORS}
for f in "${CONFIG}" "${E2E_DIR}"/*.ts; do
  [[ -e "${f}" ]] || continue
  hit="$(grep_noncomment 'page\.route\([^)]*fulfill|\bMOCK\b|in-memory|in_memory|storeMode[[:space:]]*[:=][[:space:]]*["'"'"']?memory|nock\(|msw' "${f}")"
  if [[ -n "${hit}" ]]; then
    echo "FAIL [FF-3-2]: mock/in-memory backend fallback in ${f}:"
    echo "${hit}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-3-2]: no mock / in-memory fallback in the e2e harness"
fi

# ---- FF-3-3: runner launches against real DATABASE_URL + Flowable + built dist -
before=${ERRORS}
if ! grep -qE "DATABASE_URL" "${RUNNER}"; then
  echo "FAIL [FF-3-3]: runner does not point the server at DATABASE_URL (real Postgres)"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "FLOWABLE_REST_BASE_URL|flowable-rest" "${RUNNER}"; then
  echo "FAIL [FF-3-3]: runner does not point the server at the Flowable REST engine"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "CHOROS_WEB_DIST|web/dist" "${RUNNER}"; then
  echo "FAIL [FF-3-3]: runner does not serve the built web/dist (NF1: same artifact a user sees)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-3-3]: runner launches the real server (Postgres + Flowable + built dist)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: no-mock-stack found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: no-mock-stack (FF-3) clean"
