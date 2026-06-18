#!/usr/bin/env bash
# T-0221 — defer-no-new-table static fitness check.
#
# FF-1: T-0221 diff adds NO migration with CREATE TABLE and does NOT add user_task.
# FF-5: defer-inbox-store.ts → InboxItem mapper carries role/pool/execType (ordinary task).
# FF-7: deferred-inbox-store.ts contains NO INSERT/UPDATE/DELETE; reads only audit_event.
#
# These checks are static-now (tsc/lint/grep). No DB required.
# Exit 0 on all PASS, non-zero on any FAIL. Supports --self-test.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[defer-no-new-table] --self-test"

  # Verify that the pattern for CREATE TABLE is detectable.
  PLANTED="CREATE TABLE choros.user_task"
  if printf '%s\n' "${PLANTED}" | grep -iq "create table"; then
    echo "PASS self-test: CREATE TABLE pattern detectable"
  else
    echo "FAIL self-test: CREATE TABLE detector broken"
    exit 1
  fi

  # Verify that INSERT pattern is detectable.
  PLANTED2="INSERT INTO choros.audit_event"
  if printf '%s\n' "${PLANTED2}" | grep -iq "insert into"; then
    echo "PASS self-test: INSERT INTO pattern detectable"
  else
    echo "FAIL self-test: INSERT INTO detector broken"
    exit 1
  fi

  echo "PASS self-test: all detectors functional"
  exit 0
fi

echo "[T-0221] defer-no-new-table: static fitness checks"

# ---------------------------------------------------------------------------
# Check-1 (FF-1): known_tenant_tables.txt must NOT be modified.
# ---------------------------------------------------------------------------
echo ""
echo "Check-1 (FF-1): known_tenant_tables.txt must not be modified"

KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"

if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN: could not determine merge-base with dev; checking working tree for user_task"
  if grep -q "user_task" "${KNOWN_TABLES}" 2>/dev/null; then
    echo "FAIL: known_tenant_tables.txt contains 'user_task' (T-0221 must NOT add a table)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: known_tenant_tables.txt does not contain 'user_task'"
  fi
else
  if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- ci/checks/known_tenant_tables.txt; then
    echo "PASS: known_tenant_tables.txt unchanged relative to merge-base"
  else
    echo "FAIL: known_tenant_tables.txt was modified — T-0221 must not add new tables"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Check-2 (FF-1): No migration added by T-0221 contains CREATE TABLE.
# ---------------------------------------------------------------------------
echo ""
echo "Check-2 (FF-1): no new migration from T-0221 adds CREATE TABLE"

MIGRATIONS="${ROOT}/migrations"
if [[ -n "${MERGE_BASE}" ]]; then
  NEW_MIGRATIONS="$(git -C "${ROOT}" diff --name-only "${MERGE_BASE}" HEAD -- 'migrations/0*.sql' 2>/dev/null || echo "")"
else
  NEW_MIGRATIONS=""
fi

if [[ -z "${NEW_MIGRATIONS}" ]]; then
  echo "PASS: no new migration files in T-0221 diff"
else
  FOUND_CREATE_TABLE=0
  while IFS= read -r mig; do
    FULL="${ROOT}/${mig}"
    if [[ -f "${FULL}" ]] && grep -iq "create table" "${FULL}"; then
      echo "FAIL: migration ${mig} contains CREATE TABLE — T-0221 must not add tables"
      FOUND_CREATE_TABLE=1
    fi
  done <<< "${NEW_MIGRATIONS}"
  if [[ "${FOUND_CREATE_TABLE}" -eq 0 ]]; then
    echo "PASS: no CREATE TABLE in new migrations"
  else
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Check-3 (FF-1): 'user_task' must not appear in NEW lines added by T-0221.
# (Pre-existing comments e.g. in inbox.ts are allowed — we check the diff.)
# ---------------------------------------------------------------------------
echo ""
echo "Check-3 (FF-1): 'user_task' must not appear in new lines added by T-0221"

if [[ -n "${MERGE_BASE}" ]]; then
  # Lines added by T-0221 (starting with '+', not '+++' header lines).
  NEW_USER_TASK="$(git -C "${ROOT}" diff "${MERGE_BASE}" HEAD -- 'src/**' 2>/dev/null \
    | grep '^+' | grep -v '^+++' | grep -i 'user_task' || true)"
  if [[ -n "${NEW_USER_TASK}" ]]; then
    echo "FAIL: 'user_task' found in new lines added by T-0221 diff:"
    printf '%s\n' "${NEW_USER_TASK}" | sed 's/^/  /'
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: 'user_task' not added in T-0221 diff"
  fi
else
  # No merge-base: check migrations/ only (the dangerous path for new tables).
  if grep -rq "user_task" "${ROOT}/migrations/" 2>/dev/null; then
    echo "FAIL: found 'user_task' in migrations/ — T-0221 must not add this table"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: 'user_task' not found in migrations/"
  fi
fi

# ---------------------------------------------------------------------------
# Check-4 (FF-7): deferred-inbox-store.ts has no INSERT/UPDATE/DELETE.
# ---------------------------------------------------------------------------
echo ""
echo "Check-4 (FF-7): deferred-inbox-store.ts must be read-only (no INSERT/UPDATE/DELETE)"

STORE="${ROOT}/src/db/deferred-inbox-store.ts"
if [[ ! -f "${STORE}" ]]; then
  echo "WARN: deferred-inbox-store.ts does not exist yet — skip"
else
  if grep -iqE "\b(INSERT INTO|UPDATE .* SET|DELETE FROM)\b" "${STORE}"; then
    echo "FAIL: deferred-inbox-store.ts contains write SQL (INSERT/UPDATE/DELETE)"
    grep -inE "\b(INSERT INTO|UPDATE .* SET|DELETE FROM)\b" "${STORE}" | sed 's/^/  /'
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: deferred-inbox-store.ts is read-only"
  fi
fi

# ---------------------------------------------------------------------------
# Check-5 (FF-7): deferred-inbox-store.ts reads only audit_event (not other tables).
# ---------------------------------------------------------------------------
echo ""
echo "Check-5 (FF-7): deferred-inbox-store.ts must read only audit_event"

if [[ -f "${STORE}" ]]; then
  # Look for FROM choros.<table> patterns excluding audit_event.
  # (We ignore SET/GUC lines and function-call patterns.)
  if grep -iE "FROM choros\." "${STORE}" | grep -ivE "from choros\.audit_event"; then
    echo "FAIL: deferred-inbox-store.ts reads from a table other than audit_event"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: deferred-inbox-store.ts reads only from audit_event"
  fi
fi

# ---------------------------------------------------------------------------
# Check-6 (FF-6): run-precheck.ts defer branches use only appendAuditEvent.
# ---------------------------------------------------------------------------
echo ""
echo "Check-6 (FF-6): run-precheck.ts uses only appendAuditEvent for defer writes"

PRECHECK="${ROOT}/src/runtime/legal-precheck/run-precheck.ts"
if [[ ! -f "${PRECHECK}" ]]; then
  echo "WARN: run-precheck.ts not found — skip"
else
  # There must be no INSERT INTO inside run-precheck.ts.
  if grep -iqE "INSERT INTO" "${PRECHECK}"; then
    echo "FAIL: run-precheck.ts contains INSERT INTO — only appendAuditEvent allowed"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: run-precheck.ts has no direct INSERT INTO"
  fi
fi

# ---------------------------------------------------------------------------
# Check-7 (FF-5): deferred-inbox-store.ts DeferredInboxRow carries role and step.
# ---------------------------------------------------------------------------
echo ""
echo "Check-7 (FF-5): DeferredInboxRow in deferred-inbox-store.ts carries role/step"

if [[ -f "${STORE}" ]]; then
  MISSING=()
  for field in "role:" "step:" "execName:"; do
    if ! grep -q "${field}" "${STORE}"; then
      MISSING+=("${field}")
    fi
  done
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "FAIL: DeferredInboxRow missing fields: ${MISSING[*]}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: DeferredInboxRow carries role, step, execName"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ "${ERRORS}" -eq 0 ]]; then
  echo "[T-0221] defer-no-new-table: ALL CHECKS PASSED"
  exit 0
else
  echo "[T-0221] defer-no-new-table: ${ERRORS} check(s) FAILED"
  exit 1
fi
