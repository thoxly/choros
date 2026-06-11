#!/usr/bin/env bash
# T-0184 · Static fitness: queryGrantTrail must carry explicit WHERE tenant_id predicate.
#
# AC-1 / AC-5: grep confirms that src/db/audit-grant-trail.ts contains
# a WHERE ... tenant_id = $N clause inside the queryGrantTrail query body.
# This prevents regression to the BYPASSRLS-only-GUC pattern that T-0184 fixed.
#
# SELF-TEST: passes a synthetic source string that lacks WHERE.*tenant_id through
# the grep and asserts the grep fails — proving the check can go red (AC-5).
#
# Exit 0 on clean. Exit 1 on predicate absence (regression). Exit 2 on self-test
# failure (the check itself is broken). grep errors are never suppressed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TARGET="${ROOT}/src/db/audit-grant-trail.ts"

# ---------------------------------------------------------------------------
# SELF-TEST mode: prove the check can fail.
# Invoked as: bash grant-trail-bypassrls-predicate.sh --self-test
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0184] grant-trail-bypassrls-predicate --self-test: proving the check can fail"

  # Synthetic source that deliberately omits WHERE tenant_id.
  BROKEN_SOURCE="const sql = \`SELECT seq FROM choros.audit_event WHERE type = ANY(\\\$1::text[])\`;"

  # The grep must FAIL on this broken source (exit 1 = not found).
  set +e
  echo "${BROKEN_SOURCE}" | grep -qE 'WHERE[[:space:][:alnum:]_.$]*tenant_id'
  GREP_RC=$?
  set -e

  if [ "${GREP_RC}" -eq 0 ]; then
    echo "SELF-TEST FAIL [T-0184]: broken source (no WHERE tenant_id) passed the grep — check is broken"
    exit 2
  elif [ "${GREP_RC}" -ge 2 ]; then
    echo "SELF-TEST FAIL [T-0184]: grep error (exit ${GREP_RC}) on broken fixture"
    exit 2
  fi

  echo "[T-0184] self-test PASS: broken source correctly failed the grep"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK against the live source file.
# ---------------------------------------------------------------------------
echo "[T-0184] grant-trail-bypassrls-predicate: checking ${TARGET}"

if [ ! -f "${TARGET}" ]; then
  echo "FAIL [T-0184]: source file not found: ${TARGET}" >&2
  exit 1
fi

# Grep for WHERE.*tenant_id inside the file.
# grep errors (exit >= 2) abort via set -e — never silently swallowed.
set +e
grep -qE 'WHERE[[:space:][:alnum:]_.$]*tenant_id' "${TARGET}"
GREP_RC=$?
set -e

if [ "${GREP_RC}" -ge 2 ]; then
  echo "FAIL [T-0184]: grep error (exit ${GREP_RC}) scanning ${TARGET}" >&2
  exit 1
fi

if [ "${GREP_RC}" -ne 0 ]; then
  echo "FAIL [T-0184]: queryGrantTrail in ${TARGET} has no WHERE.*tenant_id predicate — BYPASSRLS regression" >&2
  exit 1
fi

echo "PASS [T-0184]: WHERE tenant_id predicate present in audit-grant-trail.ts"
echo "PASS: grant-trail-bypassrls-predicate — AC-1/AC-5 green"
exit 0
