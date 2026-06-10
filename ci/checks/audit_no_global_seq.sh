#!/usr/bin/env bash
# T-0068 · FF-2 (AC-4 static): the canonical audit writer serializes the per-tenant
# seq ONLY via `audit_head ... FOR UPDATE` — never a global SEQUENCE / bigserial /
# nextval / constant-keyed advisory lock. A global serialization point would couple
# every tenant's audit throughput and make seq tenant-global (T-0016 NF-2 / AC-4).
#
# Over src/db/audit-writer.ts, asserts:
#   - `FOR UPDATE` on audit_head is present (per-tenant lock);
#   - no nextval(...) / CREATE SEQUENCE ... audit / serial/bigserial seq;
#   - no constant-keyed advisory lock (pg_advisory_lock(<number>)).
#
# Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WRITER="${ROOT}/src/db/audit-writer.ts"
ERRORS=0

echo "[FF-2] audit_no_global_seq: per-tenant FOR UPDATE serialization, no global ordinal"

if [[ ! -f "${WRITER}" ]]; then
  echo "FAIL: writer not found at ${WRITER}"
  exit 1
fi

# ---- Check 1: per-tenant FOR UPDATE lock on audit_head present --------------
if grep -iqE 'audit_head' "${WRITER}" && grep -iqE 'FOR UPDATE' "${WRITER}"; then
  echo "PASS: audit_head ... FOR UPDATE present (per-tenant serialization)"
else
  echo "FAIL: no 'audit_head ... FOR UPDATE' per-tenant lock found in writer"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: no global SEQUENCE / serial / nextval backing the seq ---------
if grep -iqE 'nextval[[:space:]]*\(' "${WRITER}"; then
  echo "FAIL: writer uses nextval() (global sequence) for the audit seq"
  ERRORS=$((ERRORS + 1))
fi
if grep -iqE 'CREATE SEQUENCE' "${WRITER}"; then
  echo "FAIL: writer issues CREATE SEQUENCE (global ordinal forbidden)"
  ERRORS=$((ERRORS + 1))
fi
if grep -iqE '\bseq\b[[:space:]]+(big)?serial\b' "${WRITER}"; then
  echo "FAIL: writer declares seq serial/bigserial (implicit global sequence)"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 3: no constant-keyed (global) advisory lock ----------------------
if grep -iqE 'pg_advisory(_xact)?_lock[[:space:]]*\([[:space:]]*[0-9]' "${WRITER}"; then
  echo "FAIL: a constant-keyed (global) advisory lock is used for the ordinal"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: audit_no_global_seq found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: audit_no_global_seq — per-tenant ordinal, no global serialization point"
exit 0
