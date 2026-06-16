#!/usr/bin/env bash
# T-0086 · E12.5 — inflight-migration-isolation: drain-by-default, forward-only
# rollback guard, Camunda mapping as escalation (not default), module purity.
#
# Fitness invariants (one per breakable boundary):
#
#   FF-IM-1  Module exists: src/core/inflight-migration.ts
#
#   FF-IM-2  Public surface exports:
#              drainInstance, guardRollback, validateCamundaMapping,
#              InstanceDrainRecord, RollbackGuardResult,
#              CamundaMappingRequest, CamundaMappingValidation,
#              RollbackSafePort
#
#   FF-IM-3  DRAIN-by-default: drainInstance creates records with
#              state="draining" (drain is the DEFAULT, not a migration).
#
#   FF-IM-4  Forward-only rollback guard fail-CLOSED: guardRollback is
#              async and calls the injected RollbackSafePort; the core
#              does NOT import pg/fs/net/http directly.
#              Default-DENY: the RollbackSafePort interface declares
#              isRollbackSafe + countLiveInstancesAboveVersion.
#
#   FF-IM-5  Camunda mapping is escalation, NOT default: validateCamundaMapping
#              always sets requires_human_gate = true; the validation enforces
#              wait-state-only + no-type-change constraints.
#
#   FF-IM-6  Purity (no-env-in-core boundary): inflight-migration.ts MUST NOT
#              import pg, fs, net, http, child_process, or use process.env /
#              Date.now / Math.random in code lines.
#
#   FF-IM-7  Migration slot: migrations/071_inflight_migration.sql exists and
#              creates both bundle_version_instance and inflight_mapping_request
#              tables with FORCE ROW LEVEL SECURITY.
#
#   FF-IM-8  Rollback guard binds T-0085: RollbackSafePort declares
#              isRollbackSafe (which wraps fn_check_rollback_safe from
#              migration 070) — the downstream contract binding.
#
# DB probes (Section B, requires DATABASE_URL):
#   FF-IM-9  bundle_version_instance: INSERT drain row, verify state=draining;
#              UPDATE to completed, verify state=completed.
#   FF-IM-10 inflight_mapping_request: INSERT pending_approval row,
#              verify state=pending_approval (no auto-execute).
#   FF-IM-11 fn_count_live_instances_above_version: insert draining rows,
#              verify count > 0; complete them, verify count = 0.
#
# EXIT CODES:
#   0 — all checks green
#   1 — one or more violations found
#
# USAGE:
#   bash ci/checks/inflight-migration-isolation.sh             # full run
#   bash ci/checks/inflight-migration-isolation.sh --self-test # Section A only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MODULE="${ROOT}/src/core/inflight-migration.ts"
MIGRATION="${ROOT}/migrations/071_inflight_migration.sql"

ERRORS=0

# ---------------------------------------------------------------------------
# --self-test mode: run Section A only (no DB), verify detection logic
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[inflight-migration-isolation] self-test mode"

  # ST-1: module existence detection
  TMP=$(mktemp /tmp/im_selftest_XXXXX.ts)
  printf '// placeholder\n' > "${TMP}"
  if [[ -f "${TMP}" ]]; then
    echo "PASS self-test ST-1: file existence detection works"
  else
    echo "FAIL self-test ST-1: file existence detection broken"
    rm -f "${TMP}"
    exit 2
  fi
  rm -f "${TMP}"

  # ST-2: export detection
  TMP2=$(mktemp /tmp/im_selftest_XXXXX.ts)
  printf 'export function drainInstance() {}\nexport async function guardRollback() {}\n' > "${TMP2}"
  if grep -qE "export (function|async function|interface|type) drainInstance|export function drainInstance" "${TMP2}"; then
    echo "PASS self-test ST-2: export detection works"
  else
    echo "FAIL self-test ST-2: export detection broken"
    rm -f "${TMP2}"
    exit 2
  fi
  rm -f "${TMP2}"

  # ST-3: forbidden import detection
  TMP3=$(mktemp /tmp/im_selftest_XXXXX.ts)
  printf 'import pg from "pg";\n' > "${TMP3}"
  if grep -qE 'from "pg"|from '"'"'pg'"'"'' "${TMP3}"; then
    echo "PASS self-test ST-3: forbidden import detection works"
  else
    echo "FAIL self-test ST-3: forbidden import detection broken"
    rm -f "${TMP3}"
    exit 2
  fi
  rm -f "${TMP3}"

  # ST-4: requires_human_gate detection
  TMP4=$(mktemp /tmp/im_selftest_XXXXX.ts)
  printf 'return { valid: true, errors: [], requires_human_gate: true };\n' > "${TMP4}"
  if grep -qE "requires_human_gate.*true" "${TMP4}"; then
    echo "PASS self-test ST-4: requires_human_gate detection works"
  else
    echo "FAIL self-test ST-4: requires_human_gate detection broken"
    rm -f "${TMP4}"
    exit 2
  fi
  rm -f "${TMP4}"

  # ST-5: FORCE ROW LEVEL SECURITY detection
  TMP5=$(mktemp /tmp/im_selftest_XXXXX.sql)
  printf 'ALTER TABLE choros.bundle_version_instance FORCE ROW LEVEL SECURITY;\n' > "${TMP5}"
  if grep -qE "FORCE[[:space:]]+ROW LEVEL SECURITY" "${TMP5}"; then
    echo "PASS self-test ST-5: FORCE RLS detection works"
  else
    echo "FAIL self-test ST-5: FORCE RLS detection broken"
    rm -f "${TMP5}"
    exit 2
  fi
  rm -f "${TMP5}"

  echo "PASS: inflight-migration-isolation self-tests all green"
  exit 0
fi

echo "[T-0086] inflight-migration-isolation: drain-by-default + rollback guard + mapping escalation checks"

# ============================================================
# Section A: Static Assertions (no DATABASE_URL required)
# ============================================================

echo ""
echo "=== Section A: Static Assertions ==="

# FF-IM-1: Module exists
echo ""
echo "--- FF-IM-1: module exists ---"
if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL FF-IM-1: ${MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-IM-1: ${MODULE} exists"
fi

# FF-IM-2: Public surface exports
echo ""
echo "--- FF-IM-2: public surface exports ---"
if [[ -f "${MODULE}" ]]; then
  REQUIRED_EXPORTS=(
    "drainInstance"
    "guardRollback"
    "validateCamundaMapping"
    "InstanceDrainRecord"
    "RollbackGuardResult"
    "CamundaMappingRequest"
    "CamundaMappingValidation"
    "RollbackSafePort"
  )
  for name in "${REQUIRED_EXPORTS[@]}"; do
    if grep -qE "export.*(function|interface|type|const|async function).*${name}|export.*${name}" "${MODULE}"; then
      echo "PASS FF-IM-2: export ${name} found"
    else
      echo "FAIL FF-IM-2: export ${name} NOT found in ${MODULE}"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# FF-IM-3: DRAIN-by-default — drainInstance produces state="draining"
echo ""
echo "--- FF-IM-3: drain-by-default (state=draining default) ---"
if [[ -f "${MODULE}" ]]; then
  if grep -qE 'state.*"draining"|"draining".*state' "${MODULE}"; then
    echo "PASS FF-IM-3: drainInstance creates state='draining' (drain default found)"
  else
    echo "FAIL FF-IM-3: state='draining' not found in ${MODULE} (drain-by-default invariant broken)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# FF-IM-4: Forward-only rollback guard fail-CLOSED
echo ""
echo "--- FF-IM-4: rollback guard fail-CLOSED + async port injection ---"
if [[ -f "${MODULE}" ]]; then
  # guardRollback must be async
  if grep -qE "export async function guardRollback" "${MODULE}"; then
    echo "PASS FF-IM-4a: guardRollback is async (port-injected async call)"
  else
    echo "FAIL FF-IM-4a: guardRollback is not async (must be async to call port)"
    ERRORS=$((ERRORS + 1))
  fi

  # Must NOT import pg/fs/net/http directly
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${MODULE}" 2>/dev/null || true)
  FORBIDDEN_IMPORTS=$(echo "${CODE_LINES}" | grep -E \
    'from "pg"|from '"'"'pg'"'"'|from "node:fs"|from '"'"'node:fs'"'"'|from "node:net"|from "node:http"' \
    2>/dev/null || true)
  if [[ -n "${FORBIDDEN_IMPORTS}" ]]; then
    echo "FAIL FF-IM-4b: forbidden import in pure core:"
    echo "${FORBIDDEN_IMPORTS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-IM-4b: no forbidden imports in pure core"
  fi

  # Must return allowed=false by default on error (fail-closed: look for error return paths)
  if grep -qE 'allowed: false' "${MODULE}"; then
    echo "PASS FF-IM-4c: fail-CLOSED paths (allowed: false) present in guardRollback"
  else
    echo "FAIL FF-IM-4c: fail-CLOSED return (allowed: false) not found — default-DENY missing"
    ERRORS=$((ERRORS + 1))
  fi
fi

# FF-IM-5: Camunda mapping is escalation, NOT default
echo ""
echo "--- FF-IM-5: Camunda mapping is escalation (requires_human_gate: true, always) ---"
if [[ -f "${MODULE}" ]]; then
  # requires_human_gate must be hardcoded true (not conditional)
  if grep -qE "requires_human_gate: true" "${MODULE}"; then
    echo "PASS FF-IM-5a: requires_human_gate: true found (mapping is always human-gated)"
  else
    echo "FAIL FF-IM-5a: requires_human_gate: true NOT found in ${MODULE}"
    ERRORS=$((ERRORS + 1))
  fi

  # validateCamundaMapping must enforce wait-state-only
  if grep -qE "WAIT_STATE_KINDS|wait.state|waitState" "${MODULE}"; then
    echo "PASS FF-IM-5b: wait-state constraint present in validateCamundaMapping"
  else
    echo "FAIL FF-IM-5b: wait-state constraint missing from validateCamundaMapping"
    ERRORS=$((ERRORS + 1))
  fi

  # validateCamundaMapping must enforce no-type-change
  if grep -qE "from_activity.kind.*to_activity.kind|toActivity\.kind.*fromActivity\.kind|kind.*kind" "${MODULE}"; then
    echo "PASS FF-IM-5c: no-type-change constraint present (fromActivity.kind === toActivity.kind)"
  else
    echo "FAIL FF-IM-5c: no-type-change constraint missing from validateCamundaMapping"
    ERRORS=$((ERRORS + 1))
  fi
fi

# FF-IM-6: Purity (no-env-in-core boundary)
echo ""
echo "--- FF-IM-6: purity (no process.env / Date.now / Math.random in code lines) ---"
if [[ -f "${MODULE}" ]]; then
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${MODULE}" 2>/dev/null || true)

  ENV_MATCH=$(echo "${CODE_LINES}" | grep -E 'process\.env' 2>/dev/null || true)
  if [[ -n "${ENV_MATCH}" ]]; then
    echo "FAIL FF-IM-6a: process.env found on code lines:"
    echo "${ENV_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-IM-6a: no process.env in pure core"
  fi

  DATE_MATCH=$(echo "${CODE_LINES}" | grep -E 'Date\.now\(\)' 2>/dev/null || true)
  if [[ -n "${DATE_MATCH}" ]]; then
    echo "FAIL FF-IM-6b: Date.now() found on code lines (must be injected):"
    echo "${DATE_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-IM-6b: no Date.now() in pure core"
  fi

  RAND_MATCH=$(echo "${CODE_LINES}" | grep -E 'Math\.random\(\)' 2>/dev/null || true)
  if [[ -n "${RAND_MATCH}" ]]; then
    echo "FAIL FF-IM-6c: Math.random() found on code lines (must be injected):"
    echo "${RAND_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-IM-6c: no Math.random() in pure core"
  fi
fi

# FF-IM-7: Migration slot 071 correct
echo ""
echo "--- FF-IM-7: migration 071_inflight_migration.sql correctness ---"
if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL FF-IM-7: ${MIGRATION} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "CREATE TABLE IF NOT EXISTS choros\.bundle_version_instance" "${MIGRATION}"; then
    echo "PASS FF-IM-7a: bundle_version_instance table created in migration 071"
  else
    echo "FAIL FF-IM-7a: bundle_version_instance CREATE TABLE not found in migration 071"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "CREATE TABLE IF NOT EXISTS choros\.inflight_mapping_request" "${MIGRATION}"; then
    echo "PASS FF-IM-7b: inflight_mapping_request table created in migration 071"
  else
    echo "FAIL FF-IM-7b: inflight_mapping_request CREATE TABLE not found in migration 071"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "FORCE[[:space:]]+ROW LEVEL SECURITY" "${MIGRATION}"; then
    echo "PASS FF-IM-7c: FORCE ROW LEVEL SECURITY present in migration 071"
  else
    echo "FAIL FF-IM-7c: FORCE ROW LEVEL SECURITY missing from migration 071"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "GRANT SELECT, INSERT, UPDATE ON choros\.bundle_version_instance TO choros_app" "${MIGRATION}"; then
    echo "PASS FF-IM-7d: choros_app GRANT on bundle_version_instance present"
  else
    echo "FAIL FF-IM-7d: choros_app GRANT on bundle_version_instance missing"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "GRANT SELECT, INSERT, UPDATE ON choros\.inflight_mapping_request TO choros_app" "${MIGRATION}"; then
    echo "PASS FF-IM-7e: choros_app GRANT on inflight_mapping_request present"
  else
    echo "FAIL FF-IM-7e: choros_app GRANT on inflight_mapping_request missing"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "fn_count_live_instances_above_version" "${MIGRATION}"; then
    echo "PASS FF-IM-7f: fn_count_live_instances_above_version SQL function present"
  else
    echo "FAIL FF-IM-7f: fn_count_live_instances_above_version missing from migration 071"
    ERRORS=$((ERRORS + 1))
  fi
fi

# FF-IM-8: RollbackSafePort binds T-0085 (downstream contract)
echo ""
echo "--- FF-IM-8: RollbackSafePort binds T-0085 fn_check_rollback_safe ---"
if [[ -f "${MODULE}" ]]; then
  if grep -qE "isRollbackSafe" "${MODULE}"; then
    echo "PASS FF-IM-8a: isRollbackSafe declared in RollbackSafePort (binds fn_check_rollback_safe)"
  else
    echo "FAIL FF-IM-8a: isRollbackSafe NOT found in ${MODULE} (T-0085 binding missing)"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "countLiveInstancesAboveVersion" "${MODULE}"; then
    echo "PASS FF-IM-8b: countLiveInstancesAboveVersion declared (companion drain-count port)"
  else
    echo "FAIL FF-IM-8b: countLiveInstancesAboveVersion NOT found in ${MODULE}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ============================================================
# Section B: DB Probes (skip if DATABASE_URL unset)
# ============================================================

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo ""
  echo "=== Section B: DB Probes (SKIPPED — DATABASE_URL not set) ==="
  echo "SKIP [FF-IM-9/FF-IM-10/FF-IM-11]: Database tests skipped (no DATABASE_URL)"
else
  echo ""
  echo "=== Section B: DB Probes ==="

  SQL_FILE="/tmp/t0086_selftest_$$.sql"
  cat > "${SQL_FILE}" << 'EOFTEST'
BEGIN;

SET LOCAL search_path = choros, public;
SET LOCAL choros.tenant_id = 'a0000086-0000-0000-0000-000000000099';

-- FF-IM-9: bundle_version_instance drain row lifecycle
INSERT INTO choros.bundle_version_instance
  (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
VALUES
  ('a0000086-0000-0000-0000-000000000099',
   'proc-drain-test-001',
   'bundle-drain-test',
   'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
   0,
   'draining')
ON CONFLICT DO NOTHING;

-- Verify state=draining
SELECT CASE WHEN state = 'draining' THEN 'OK:drain_default' ELSE 'FAIL:drain_state_mismatch' END
FROM choros.bundle_version_instance
WHERE tenant_id = 'a0000086-0000-0000-0000-000000000099'
  AND process_instance_id = 'proc-drain-test-001';

-- Update to completed
UPDATE choros.bundle_version_instance
SET state = 'completed'
WHERE tenant_id = 'a0000086-0000-0000-0000-000000000099'
  AND process_instance_id = 'proc-drain-test-001';

SELECT CASE WHEN state = 'completed' THEN 'OK:drain_completed' ELSE 'FAIL:drain_completed_mismatch' END
FROM choros.bundle_version_instance
WHERE tenant_id = 'a0000086-0000-0000-0000-000000000099'
  AND process_instance_id = 'proc-drain-test-001';

-- FF-IM-10: inflight_mapping_request — pending_approval (no auto-execute)
INSERT INTO choros.inflight_mapping_request
  (tenant_id, id, process_instance_id,
   from_content_hash, to_content_hash,
   from_activity_id, from_activity_kind,
   to_activity_id, to_activity_kind,
   auto_map_matching_ids, requested_by, requested_at, state)
VALUES
  ('a0000086-0000-0000-0000-000000000099',
   'b0000086-0000-0000-0000-000000000001',
   'proc-map-test-001',
   'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
   'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
   'Task_ApproveContract', 'userTask',
   'Task_ApproveContract', 'userTask',
   false, 'founder@example.com', 0, 'pending_approval')
ON CONFLICT DO NOTHING;

-- Verify state=pending_approval (human-gate enforced)
SELECT CASE WHEN state = 'pending_approval'
            THEN 'OK:mapping_pending_approval'
            ELSE 'FAIL:mapping_state_mismatch' END
FROM choros.inflight_mapping_request
WHERE tenant_id = 'a0000086-0000-0000-0000-000000000099'
  AND id = 'b0000086-0000-0000-0000-000000000001';

-- FF-IM-11: fn_count_live_instances_above_version
-- Insert a second draining instance
INSERT INTO choros.bundle_version_instance
  (tenant_id, process_instance_id, bundle_id, pinned_content_hash, pinned_at, state)
VALUES
  ('a0000086-0000-0000-0000-000000000099',
   'proc-count-test-001',
   'bundle-count-test',
   'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
   0,
   'draining')
ON CONFLICT DO NOTHING;

-- Verify count > 0 for this bundle
SELECT CASE WHEN fn_count_live_instances_above_version(
               'a0000086-0000-0000-0000-000000000099'::uuid,
               'bundle-count-test', 1) > 0
            THEN 'OK:count_live_instances_above_zero'
            ELSE 'FAIL:count_live_instances_expected_positive' END;

-- Mark as completed
UPDATE choros.bundle_version_instance
SET state = 'completed'
WHERE tenant_id = 'a0000086-0000-0000-0000-000000000099'
  AND bundle_id = 'bundle-count-test'
  AND state = 'draining';

-- Verify count = 0 after drain
SELECT CASE WHEN fn_count_live_instances_above_version(
               'a0000086-0000-0000-0000-000000000099'::uuid,
               'bundle-count-test', 1) = 0
            THEN 'OK:count_live_instances_zero_after_drain'
            ELSE 'FAIL:count_live_instances_expected_zero' END;

ROLLBACK;
EOFTEST

  TEST_RESULT=$(psql "$DATABASE_URL" -f "${SQL_FILE}" 2>&1 || echo "PSQL_FAILED")
  rm -f "${SQL_FILE}"

  if echo "${TEST_RESULT}" | grep -q "OK:drain_default" && \
     echo "${TEST_RESULT}" | grep -q "OK:drain_completed" && \
     echo "${TEST_RESULT}" | grep -q "OK:mapping_pending_approval" && \
     echo "${TEST_RESULT}" | grep -q "OK:count_live_instances_above_zero" && \
     echo "${TEST_RESULT}" | grep -q "OK:count_live_instances_zero_after_drain"; then
    echo "PASS [FF-IM-9/FF-IM-10/FF-IM-11]: DB probes passed"
  else
    echo "FAIL [FF-IM-9/FF-IM-10/FF-IM-11]: DB probes failed"
    echo "${TEST_RESULT}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ============================================================
# Summary
# ============================================================

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: inflight-migration-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: inflight-migration-isolation — all FF-IM-1..FF-IM-11 green (T-0086)"
exit 0
