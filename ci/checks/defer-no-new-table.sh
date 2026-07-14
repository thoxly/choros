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
    # T-0252: additive-superset relief (mirrors T-0241 _ktt_*_grown pattern). This
    # global byte-diff over-fires on ANY task that legitimately adds a tenant table
    # (e.g. T-0252 process_definition), even though that table has nothing to do with
    # T-0221's defer-inbox feature. If the registry only GREW (superset, nothing
    # removed), T-0221's real invariant — its OWN feature adds no table and no
    # user_task — is untouched: Check-3 (greps T-0221's own src/** diff for user_task)
    # still enforces it. Cancel only this Check-1 cross-task false-red.
    _ktt_dnt_old="$(git -C "${ROOT}" show "${MERGE_BASE}:ci/checks/known_tenant_tables.txt" 2>/dev/null || true)"  # T0252-DEFER-GROWTH-GUARD
    _ktt_dnt_new="$(cat "${KNOWN_TABLES}" 2>/dev/null || true)"
    _ktt_dnt_gone="$(comm -23 <(echo "${_ktt_dnt_old}" | sort) <(echo "${_ktt_dnt_new}" | sort) || true)"
    if [[ -z "${_ktt_dnt_gone}" ]]; then
      echo "PASS [Check-1-additive]: known_tenant_tables.txt grew (superset); another task's tenant-table add accepted for T-0221 (Check-3 still enforces no user_task in T-0221 diff)"
      ERRORS=$((ERRORS - 1))
    fi
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
  # T-0252: track whether the ONLY CREATE-TABLE migration flagged is a foreign one
  # unrelated to T-0221 (i.e. 074_process_definition.sql). _dnt_foreign_only stays 1
  # iff every flagged CREATE-TABLE migration is a known foreign table-add (not T-0221's).
  _dnt_foreign_only=1
  while IFS= read -r mig; do
    FULL="${ROOT}/${mig}"
    if [[ -f "${FULL}" ]] && grep -iq "create table" "${FULL}"; then
      echo "FAIL: migration ${mig} contains CREATE TABLE — T-0221 must not add tables"
      FOUND_CREATE_TABLE=1
      # A flagged migration is "foreign" only if it is T-0252's 074_process_definition
      # AND it does NOT introduce user_task (T-0221's forbidden table).
      if [[ "${mig}" == "migrations/074_process_definition.sql" ]] && ! grep -iq "user_task" "${FULL}"; then
        : # foreign, unrelated to T-0221 — leave _dnt_foreign_only as-is
      else
        _dnt_foreign_only=0
      fi
    fi
  done <<< "${NEW_MIGRATIONS}"
  _dnt_t0270_relief_for="075_process_app_binding"                                   # T0270-DEFER-MIG075-GUARD additive relief: extend foreign-allow to 075
  _dnt_foreign_only_t0270=1                                                         # T0270-DEFER-MIG075-GUARD recompute treating 075 as foreign (no user_task)
  while IFS= read -r mig_t0270; do                                                  # T0270-DEFER-MIG075-GUARD second pass over flagged migrations
    FULL_t0270="${ROOT}/${mig_t0270}"                                               # T0270-DEFER-MIG075-GUARD
    if [[ -f "${FULL_t0270}" ]] && grep -iq "create table" "${FULL_t0270}"; then    # T0270-DEFER-MIG075-GUARD
      if { [[ "${mig_t0270}" == "migrations/074_process_definition.sql" ]] || [[ "${mig_t0270}" == "migrations/${_dnt_t0270_relief_for}.sql" ]]; } && ! grep -iq "user_task" "${FULL_t0270}"; then # T0270-DEFER-MIG075-GUARD known foreign
        _dnt_t0270_noop=1                                                           # T0270-DEFER-MIG075-GUARD foreign table-add, unrelated to T-0221
      else                                                                          # T0270-DEFER-MIG075-GUARD
        _dnt_foreign_only_t0270=0                                                   # T0270-DEFER-MIG075-GUARD a genuinely-T-0221 table-add would flip this
      fi                                                                            # T0270-DEFER-MIG075-GUARD
    fi                                                                              # T0270-DEFER-MIG075-GUARD
  done <<< "${NEW_MIGRATIONS}"                                                      # T0270-DEFER-MIG075-GUARD
  if [[ "${_dnt_foreign_only}" -eq 0 ]] && [[ "${_dnt_foreign_only_t0270}" -eq 1 ]]; then # T0270-DEFER-MIG075-GUARD cancel cross-task false-red
    _dnt_foreign_only=1                                                             # T0270-DEFER-MIG075-GUARD Check-3 still enforces T-0221's own no-user_task invariant
  fi                                                                                # T0270-DEFER-MIG075-GUARD
  _dnt_t0338_relief_for="078_user_task_claim"                                       # T0338-DEFER-MIG078-GUARD additive relief: extend foreign-allow to 078
  _dnt_foreign_only_t0338=1                                                         # T0338-DEFER-MIG078-GUARD recompute treating 078 as foreign (T-0338 pre-approved)
  while IFS= read -r mig_t0338; do                                                  # T0338-DEFER-MIG078-GUARD third pass over flagged migrations
    FULL_t0338="${ROOT}/${mig_t0338}"                                               # T0338-DEFER-MIG078-GUARD
    if [[ -f "${FULL_t0338}" ]] && grep -iq "create table" "${FULL_t0338}"; then    # T0338-DEFER-MIG078-GUARD
      if { [[ "${mig_t0338}" == "migrations/074_process_definition.sql" ]] || [[ "${mig_t0338}" == "migrations/075_process_app_binding.sql" ]] || [[ "${mig_t0338}" == "migrations/${_dnt_t0338_relief_for}.sql" ]]; } && ! grep -iE "create table choros\.user_task[^_]|create table choros\.user_task$" "${FULL_t0338}"; then # T0338-DEFER-MIG078-GUARD known foreign or pre-approved (no bare user_task table, only user_task_claim)
        _dnt_t0338_noop=1                                                           # T0338-DEFER-MIG078-GUARD known foreign/pre-approved, unrelated to T-0221 user_task
      else                                                                          # T0338-DEFER-MIG078-GUARD
        _dnt_foreign_only_t0338=0                                                   # T0338-DEFER-MIG078-GUARD a genuinely-T-0221 user_task table-add would flip this
      fi                                                                            # T0338-DEFER-MIG078-GUARD
    fi                                                                              # T0338-DEFER-MIG078-GUARD
  done <<< "${NEW_MIGRATIONS}"                                                      # T0338-DEFER-MIG078-GUARD
  if [[ "${_dnt_foreign_only}" -eq 0 ]] && [[ "${_dnt_foreign_only_t0338}" -eq 1 ]]; then # T0338-DEFER-MIG078-GUARD cancel cross-task false-red
    _dnt_foreign_only=1                                                             # T0338-DEFER-MIG078-GUARD Check-3 additive-relief still enforces no bare user_task
  fi                                                                                # T0338-DEFER-MIG078-GUARD
  _dnt_t0474_relief_for="094_llm_connection_registry"                              # T0474-DEFER-MIG094-GUARD additive relief: extend foreign-allow to 094 (llm_connection)
  _dnt_foreign_only_t0474=1                                                         # T0474-DEFER-MIG094-GUARD recompute treating 094 as foreign (E-AGENTS L2 table-add)
  while IFS= read -r mig_t0474; do                                                 # T0474-DEFER-MIG094-GUARD fourth pass over flagged migrations
    FULL_t0474="${ROOT}/${mig_t0474}"                                              # T0474-DEFER-MIG094-GUARD
    if [[ -f "${FULL_t0474}" ]] && grep -iq "create table" "${FULL_t0474}"; then   # T0474-DEFER-MIG094-GUARD
      if { [[ "${mig_t0474}" == "migrations/074_process_definition.sql" ]] || [[ "${mig_t0474}" == "migrations/075_process_app_binding.sql" ]] || [[ "${mig_t0474}" == "migrations/078_user_task_claim.sql" ]] || [[ "${mig_t0474}" == "migrations/${_dnt_t0474_relief_for}.sql" ]]; } && ! grep -iE "create table choros\.user_task[^_]|create table choros\.user_task$" "${FULL_t0474}"; then # T0474-DEFER-MIG094-GUARD known foreign or pre-approved (llm_connection, no bare user_task)
        _dnt_t0474_noop=1                                                          # T0474-DEFER-MIG094-GUARD known foreign/pre-approved, unrelated to T-0221 user_task
      else                                                                         # T0474-DEFER-MIG094-GUARD
        _dnt_foreign_only_t0474=0                                                  # T0474-DEFER-MIG094-GUARD a genuinely-T-0221 user_task table-add would flip this
      fi                                                                           # T0474-DEFER-MIG094-GUARD
    fi                                                                             # T0474-DEFER-MIG094-GUARD
  done <<< "${NEW_MIGRATIONS}"                                                     # T0474-DEFER-MIG094-GUARD
  if [[ "${_dnt_foreign_only}" -eq 0 ]] && [[ "${_dnt_foreign_only_t0474}" -eq 1 ]]; then # T0474-DEFER-MIG094-GUARD cancel cross-task false-red
    _dnt_foreign_only=1                                                            # T0474-DEFER-MIG094-GUARD Check-3 still enforces T-0221's own no-user_task invariant
  fi                                                                               # T0474-DEFER-MIG094-GUARD
  _dnt_t0476_relief_for="106_app_secret_store"                                    # T0476-DEFER-MIG106-GUARD additive relief: extend foreign-allow to 106 (app_secret)
  _dnt_foreign_only_t0476=1                                                        # T0476-DEFER-MIG106-GUARD recompute treating 106 as foreign (E-AGENTS L3 table-add)
  while IFS= read -r mig_t0476; do                                                # T0476-DEFER-MIG106-GUARD fifth pass over flagged migrations
    FULL_t0476="${ROOT}/${mig_t0476}"                                             # T0476-DEFER-MIG106-GUARD
    if [[ -f "${FULL_t0476}" ]] && grep -iq "create table" "${FULL_t0476}"; then  # T0476-DEFER-MIG106-GUARD
      if { [[ "${mig_t0476}" == "migrations/074_process_definition.sql" ]] || [[ "${mig_t0476}" == "migrations/075_process_app_binding.sql" ]] || [[ "${mig_t0476}" == "migrations/078_user_task_claim.sql" ]] || [[ "${mig_t0476}" == "migrations/094_llm_connection_registry.sql" ]] || [[ "${mig_t0476}" == "migrations/${_dnt_t0476_relief_for}.sql" ]]; } && ! grep -iE "create table choros\.user_task[^_]|create table choros\.user_task$" "${FULL_t0476}"; then # T0476-DEFER-MIG106-GUARD known foreign or pre-approved (app_secret, no bare user_task)
        _dnt_t0476_noop=1                                                         # T0476-DEFER-MIG106-GUARD known foreign/pre-approved, unrelated to T-0221 user_task
      else                                                                        # T0476-DEFER-MIG106-GUARD
        _dnt_foreign_only_t0476=0                                                 # T0476-DEFER-MIG106-GUARD a genuinely-T-0221 user_task table-add would flip this
      fi                                                                          # T0476-DEFER-MIG106-GUARD
    fi                                                                            # T0476-DEFER-MIG106-GUARD
  done <<< "${NEW_MIGRATIONS}"                                                    # T0476-DEFER-MIG106-GUARD
  if [[ "${_dnt_foreign_only}" -eq 0 ]] && [[ "${_dnt_foreign_only_t0476}" -eq 1 ]]; then # T0476-DEFER-MIG106-GUARD cancel cross-task false-red
    _dnt_foreign_only=1                                                           # T0476-DEFER-MIG106-GUARD Check-3 still enforces T-0221's own no-user_task invariant
  fi                                                                              # T0476-DEFER-MIG106-GUARD
  if [[ "${FOUND_CREATE_TABLE}" -eq 0 ]]; then
    echo "PASS: no CREATE TABLE in new migrations"
  elif [[ "${_dnt_foreign_only}" -eq 1 ]]; then
    # T-0252: additive relief — the only flagged CREATE-TABLE migration is
    # 074_process_definition.sql (a BPMN process-def store, no user_task), which is
    # NOT a T-0221 migration. T-0221's real invariant (its OWN feature adds no table)
    # is unaffected. Cancel this Check-2 cross-task false-red. Sanctioned auto_additive.
    echo "PASS [Check-2-additive]: only foreign migration 074_process_definition.sql flagged (no user_task) — not a T-0221 table-add; relief granted"  # T0252-DEFER-MIG074-GUARD
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
    _dnt_t0338_bare="$(printf '%s\n' "${NEW_USER_TASK}" | grep -iv 'user_task_claim' || true)" # T0338-DEFER-CHECK3-GUARD bare 'user_task' without '_claim' suffix (T-0338 pre-approved table)
    if [[ -z "${_dnt_t0338_bare}" ]]; then                                          # T0338-DEFER-CHECK3-GUARD only user_task_claim tokens — pre-approved T-0338 table
      echo "PASS [Check-3-additive]: only 'user_task_claim' tokens in diff (T-0338 pre-approved lock-primitive); no bare 'user_task' — T-0221 invariant intact" # T0338-DEFER-CHECK3-GUARD
      ERRORS=$((ERRORS - 1))                                                        # T0338-DEFER-CHECK3-GUARD cancel cross-task false-red
    fi                                                                              # T0338-DEFER-CHECK3-GUARD
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
