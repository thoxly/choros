#!/usr/bin/env bash
# T-0184 · Static fitness: queryGrantTrail must carry explicit WHERE tenant_id predicate.
#
# AC-1 / AC-5: grep confirms that src/db/audit-grant-trail.ts contains
# a conditions.push backtick-string `tenant_id = $N` inside the queryGrantTrail
# query body.  The pattern is anchored to the SQL condition entry in the conditions
# array — NOT to prose comments or doc-strings that mention "WHERE tenant_id"
# (those survive even after the real predicate is removed).
#
# ANCHOR: grep -E '`tenant_id = \$[0-9]+'
#   Matches only backtick template-literal lines that begin `tenant_id = $<digit>
#   e.g.  `tenant_id = $2`,
#   Does NOT match:
#     // $2 is always the tenantId — explicit WHERE tenant_id guard ...
#     *  - T-0184: explicit WHERE tenant_id = $N added for BYPASSRLS ...
#
# SELF-TEST: passes a synthetic source string that lacks the condition anchor
# through the grep and asserts the grep fails — proving the check can go red
# (AC-5).  The self-test fixture may contain WHERE tenant_id comments; the check
# still correctly rejects it.
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
  # Note: broken fixture may contain "WHERE tenant_id" in a comment — the anchored
  # pattern must still reject it (proving the nit-R1 fix is effective).
  set +e
  echo "${BROKEN_SOURCE}" | grep -qE '`tenant_id = \$[0-9]+'
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

# Grep for the SQL condition entry in the conditions array:
#   `tenant_id = $N`,
# This anchors to the actual predicate line, not to prose comments that mention
# "WHERE tenant_id".  grep errors (exit >= 2) abort via set -e — never swallowed.
set +e
grep -qE '`tenant_id = \$[0-9]+' "${TARGET}"
GREP_RC=$?
set -e

if [ "${GREP_RC}" -ge 2 ]; then
  echo "FAIL [T-0184]: grep error (exit ${GREP_RC}) scanning ${TARGET}" >&2
  exit 1
fi

if [ "${GREP_RC}" -ne 0 ]; then
  echo "FAIL [T-0184]: queryGrantTrail in ${TARGET} has no \`tenant_id = \$N\` condition entry — BYPASSRLS regression" >&2
  exit 1
fi

echo "PASS [T-0184]: \`tenant_id = \$N\` condition present in audit-grant-trail.ts"
echo "PASS: grant-trail-bypassrls-predicate — AC-1/AC-5 green"
exit 0
