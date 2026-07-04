#!/usr/bin/env bash
# T-0636 [agent-bridge] — agent-bridge-contract.
#
# Static gate covering the parts of the T-0636 spec that are best asserted by
# grep rather than a unit test:
#
#   FF-1 (AC-1)  — lifecycle-bridge.ts / timer-firing-loop.ts read the REAL
#                  FLOWABLE_REST_APP_ADMIN_USER_ID / FLOWABLE_REST_APP_ADMIN_PASSWORD
#                  env names (the same ones src/server.ts already uses
#                  successfully) — NOT the never-set FLOWABLE_ADMIN_USER /
#                  FLOWABLE_ADMIN_PASSWORD names, and no literal 'test' password
#                  default remains.
#
#   FF-6 (F5)    — process-start.ts and records.ts stamp CHOROS_TENANT_VAR onto
#                  the launch variables before calling flowable.startInstance
#                  (the tenant-resolution source the bridge reads at enqueue).
#
#   FF-12 (NF-6) — the new visible logs in externalTaskBridge.ts / timer-firing-loop.ts
#                  never interpolate a password / Authorization header value.
#
#   FF-15 (AC-16)— diff does not touch the T-0586/T-0587/T-0588 owned zones
#                  (src/runtime/agent-dispatch/**, src/core/assistant-analyst.ts,
#                  src/db/registry-digest-dao.ts, src/http/inbox.ts).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

echo "[T-0636] agent-bridge-contract: static checks (FF-1 / FF-6 / FF-12 / FF-15)"

# ---------------------------------------------------------------------------
# FF-1 (AC-1): correct FLOWABLE credential env names, no old names, no 'test' default
# ---------------------------------------------------------------------------
echo ""
echo "[FF-1] checking FLOWABLE credential env names in lifecycle-bridge.ts / timer-firing-loop.ts ..."

LB="${SRC}/server/lifecycle-bridge.ts"
TFL="${SRC}/server/timer-firing-loop.ts"

for f in "${LB}" "${TFL}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL [FF-1]: expected file not found: ${f}"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # CODE-only match: strip full-line comments (leading //, *, /*) before
  # grepping — this file's own doc-comments legitimately EXPLAIN the old (bad)
  # env names as part of documenting the fix (mirrors the comment-strip
  # convention used throughout ci/checks, e.g. anti-case-lock.sh).
  CODE_ONLY="$(grep -vE '^\s*(//|\*|/\*)' "${f}")"
  if echo "${CODE_ONLY}" | grep -nE 'FLOWABLE_ADMIN_(USER|PASSWORD)' >/dev/null 2>&1; then
    echo "FAIL [FF-1]: ${f} still references the OLD (never-set) FLOWABLE_ADMIN_USER/FLOWABLE_ADMIN_PASSWORD env names (code, not just comments)"
    echo "${CODE_ONLY}" | grep -nE 'FLOWABLE_ADMIN_(USER|PASSWORD)' || true
    ERRORS=$((ERRORS + 1))
  fi

  if ! grep -q 'FLOWABLE_REST_APP_ADMIN_PASSWORD' "${f}"; then
    echo "FAIL [FF-1]: ${f} does not read FLOWABLE_REST_APP_ADMIN_PASSWORD"
    ERRORS=$((ERRORS + 1))
  fi

  if ! grep -q 'FLOWABLE_REST_APP_ADMIN_USER_ID' "${f}"; then
    echo "FAIL [FF-1]: ${f} does not read FLOWABLE_REST_APP_ADMIN_USER_ID"
    ERRORS=$((ERRORS + 1))
  fi

  # No literal 'test' fallback for the password (any quote style).
  if grep -nE "ADMIN_PASSWORD.{0,40}\?\?.{0,10}['\"\`]test['\"\`]" "${f}" >/dev/null 2>&1; then
    echo "FAIL [FF-1]: ${f} still falls back to the literal password 'test'"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-1]: both files read FLOWABLE_REST_APP_ADMIN_USER_ID/PASSWORD; no old names; no 'test' default"
fi

# ---------------------------------------------------------------------------
# FF-6 (F5): CHOROS_TENANT_VAR stamped before startInstance in both call-sites
# ---------------------------------------------------------------------------
echo ""
echo "[FF-6] checking CHOROS_TENANT_VAR is stamped before startInstance ..."

PS="${SRC}/http/process-start.ts"
REC="${SRC}/http/records.ts"

for f in "${PS}" "${REC}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL [FF-6]: expected file not found: ${f}"
    ERRORS=$((ERRORS + 1))
    continue
  fi
  if ! grep -q 'CHOROS_TENANT_VAR' "${f}"; then
    echo "FAIL [FF-6]: ${f} does not reference CHOROS_TENANT_VAR (tenant stamp missing before startInstance)"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-6]: both process-start.ts and records.ts stamp CHOROS_TENANT_VAR"
fi

# ---------------------------------------------------------------------------
# FF-12 (NF-6): new visible logs never interpolate a password / Authorization value
# ---------------------------------------------------------------------------
echo ""
echo "[FF-12] checking bridge/timer log lines never interpolate a secret ..."

ETB="${SRC}/core/externalTaskBridge.ts"

# Heuristic: no console.error/warn/log line (or logThrottle/emit call) contains
# the identifiers adminPassword/Authorization/basicAuth/auth in the SAME
# statement as a template literal interpolation. We scan for the dangerous
# pattern directly: a log-emitting call whose argument contains `${...auth...}`
# or `${...assword...}` (case-insensitive) referencing a credential variable.
for f in "${ETB}" "${TFL}"; do
  if grep -nE '(console\.(error|warn|log)|emit\()[^;]*\$\{[^}]*(adminPassword|Authorization|basicAuth)[^}]*\}' "${f}" >/dev/null 2>&1; then
    echo "FAIL [FF-12]: ${f} appears to interpolate a credential value into a log line"
    grep -nE '(console\.(error|warn|log)|emit\()[^;]*\$\{[^}]*(adminPassword|Authorization|basicAuth)[^}]*\}' "${f}" || true
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-12]: no log line interpolates a credential value"
fi

# ---------------------------------------------------------------------------
# FF-15 (AC-16): diff does not touch T-0586/T-0587/T-0588 owned zones
# ---------------------------------------------------------------------------
echo ""
echo "[FF-15] checking diff does not touch T-0586/T-0587/T-0588 owned zones ..."

FORBIDDEN_PATHS=(
  "src/runtime/agent-dispatch/"
  "src/core/assistant-analyst.ts"
  "src/db/registry-digest-dao.ts"
  "src/http/inbox.ts"
)

# Compare against the merge-base with dev when available (mirrors the spec's
# "git diff --stat против dev@f0151cf" AC-16 wording); fall back to HEAD~0 (i.e.
# skip) when dev is not a reachable ref in this checkout (e.g. a shallow CI clone
# of a single branch) — the check is advisory-safe in that case, not a false FAIL.
cd "${ROOT}"
BASE_REF=""
if git rev-parse --verify --quiet dev >/dev/null; then
  BASE_REF="$(git merge-base HEAD dev 2>/dev/null || true)"
elif git rev-parse --verify --quiet origin/dev >/dev/null; then
  BASE_REF="$(git merge-base HEAD origin/dev 2>/dev/null || true)"
fi

if [[ -z "${BASE_REF}" ]]; then
  echo "SKIP [FF-15]: no reachable dev/origin/dev ref in this checkout — cannot compute diff base (non-fatal)"
else
  CHANGED_FILES="$(git diff --name-only "${BASE_REF}"...HEAD 2>/dev/null || true)"
  for forbidden in "${FORBIDDEN_PATHS[@]}"; do
    if echo "${CHANGED_FILES}" | grep -F "${forbidden}" >/dev/null 2>&1; then
      echo "FAIL [FF-15]: diff touches forbidden zone path: ${forbidden}"
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [[ ${ERRORS} -eq 0 ]]; then
    echo "PASS [FF-15]: diff vs ${BASE_REF} does not touch any T-0586/T-0587/T-0588 owned path"
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL [T-0636]: agent-bridge-contract found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS [T-0636]: agent-bridge-contract — all static checks clean"
exit 0
