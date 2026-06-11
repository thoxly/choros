#!/usr/bin/env bash
# T-0068 · FF-11 (layer boundaries): the audit core modules are PURE, and the
# writer is the SINGLE module issuing write-SQL against audit_event / audit_head.
#
# Asserts:
#   - src/core/audit-preimage.ts and src/core/lifecycle-audit.ts and
#     src/core/lifecycle-guard.ts have NO IO import (pg/fetch/http/https/net/
#     child_process) — IO-free, by the audit-grant-encoder.ts template;
#   - the ONLY non-migration production module with INSERT/UPDATE/DELETE on
#     audit_event/audit_head is src/db/audit-writer.ts (single write path).
#
# (Reads — SELECT — are allowed elsewhere, e.g. the grant-trail reader; only the
# WRITE path is chokepointed here. T-0016 §4.4: writer = single sanctioned write.)
#
# Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

IO_IMPORT_RE="^import.*['\"]pg['\"]|['\"]node:pg['\"]|['\"]fetch['\"]|['\"]node:http['\"]|['\"]http['\"]|['\"]https['\"]|['\"]node:https['\"]|['\"]net['\"]|['\"]node:net['\"]|['\"]child_process['\"]|['\"]node:child_process['\"]"

echo "[FF-11] audit_writer_isolation: core purity + single audit write path"

# ---- Check 1: pure core modules (no IO import) ------------------------------
for f in src/core/audit-preimage.ts src/core/lifecycle-audit.ts src/core/lifecycle-guard.ts; do
  path="${ROOT}/${f}"
  if [[ ! -f "${path}" ]]; then
    echo "FAIL: expected pure module missing: ${f}"
    ERRORS=$((ERRORS + 1))
    continue
  fi
  if grep -qE "${IO_IMPORT_RE}" "${path}"; then
    echo "FAIL: ${f} contains a forbidden IO import (pg/fetch/http/https/net/child_process)"
    grep -nE "${IO_IMPORT_RE}" "${path}" || true
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: ${f} is IO-free"
  fi
done

# ---- Check 2: single audit write path --------------------------------------
# Find production .ts files (exclude migrations dir + tests) that issue an
# INSERT/UPDATE/DELETE statement against audit_event or audit_head.
WRITERS="$(grep -rlnE '(INSERT INTO|UPDATE|DELETE FROM)[^;]*choros\.audit_(event|head)' \
            "${ROOT}/src" --include='*.ts' 2>/dev/null | grep -v '__tests__' || true)"

UNEXPECTED="$(printf '%s\n' "${WRITERS}" | grep -v '/src/db/audit-writer.ts' | grep -v '^$' || true)"

if [[ -n "${UNEXPECTED}" ]]; then
  echo "FAIL: audit write-SQL found outside src/db/audit-writer.ts:"
  printf '%s\n' "${UNEXPECTED}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: only src/db/audit-writer.ts writes audit_event/audit_head"
fi

# ---- Check 3: writer does NOT UPDATE/DELETE audit_event (append-only) -------
if grep -qE 'UPDATE[[:space:]]+choros\.audit_event|DELETE[[:space:]]+FROM[[:space:]]+choros\.audit_event' \
     "${ROOT}/src/db/audit-writer.ts"; then
  echo "FAIL: audit-writer.ts mutates audit_event (append-only violated)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: audit-writer.ts never UPDATE/DELETE audit_event (append-only)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: audit_writer_isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: audit_writer_isolation — all checks green"
exit 0
