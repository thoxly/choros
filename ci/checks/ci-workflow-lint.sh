#!/usr/bin/env bash
# FF-CI (static-now half, AC-17 / D-056): the CI gate is integration-honest.
#
# Asserts .github/workflows/ci.yml:
#  - has a `db` job that pins a postgres:16 service container,
#  - runs the migration runner AND re-runs it (idempotency) AND the live db probes,
# and that vitest.config.js excludes the worktree dirs (no ambient-state discovery).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CI="${ROOT}/.github/workflows/ci.yml"
VITEST="${ROOT}/vitest.config.js"
ERRORS=0

echo "[FF-CI] ci-workflow-lint: checking integration-honest db job + worktree exclusion"

if [[ ! -f "${CI}" ]]; then
  echo "FAIL: ${CI} not found"
  exit 1
fi

# ---- Check 1: a `db` job exists ------------------------------------------
if grep -qE '^[[:space:]]+db:' "${CI}"; then
  echo "PASS: ci.yml defines a db job"
else
  echo "FAIL: ci.yml has no db job"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: it pins a postgres:16 service ------------------------------
if grep -qE 'postgres:16' "${CI}"; then
  echo "PASS: ci.yml pins a postgres:16 service"
else
  echo "FAIL: ci.yml does not pin postgres:16"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 3: runner is run AND re-run (idempotency) ---------------------
RUNNER_RUNS=$(grep -cE 'migrations/run\.mjs|npm run migrate' "${CI}" || true)
if [[ "${RUNNER_RUNS}" -ge 2 ]]; then
  echo "PASS: ci.yml runs the migration runner at least twice (apply + idempotency re-run)"
else
  echo "FAIL: ci.yml must run the runner at least twice (got ${RUNNER_RUNS})"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 4: it runs the live db probes (>=2-tenant + fitness:db) -------
if grep -qE 'fitness:db|ci/checks/db' "${CI}"; then
  echo "PASS: ci.yml runs the live db probe suite"
else
  echo "FAIL: ci.yml does not run the live db probe suite (fitness:db / ci/checks/db)"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 5: vitest excludes worktree dirs (no ambient discovery) -------
if [[ -f "${VITEST}" ]] \
   && grep -q "\.claude/\*\*" "${VITEST}" \
   && grep -q "choros-wt/\*\*" "${VITEST}"; then
  echo "PASS: vitest.config.js excludes .claude/** and ../choros-wt/**"
else
  echo "FAIL: vitest.config.js must exclude .claude/** and ../choros-wt/**"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: ci-workflow-lint found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: ci-workflow-lint — all checks green"
exit 0
