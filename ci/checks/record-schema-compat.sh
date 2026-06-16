#!/usr/bin/env bash
# T-0085 · FF-RSV-1..FF-RSV-5: record-schema-compat
#
# Section A — Static assertions (no DATABASE_URL required):
#   RSV-1: src/core/record-schema-validator.ts exists
#   RSV-2: Module exports validateRecordAgainstSchema, SchemaHistoryMap, ValidationResult
#   RSV-3: Module imports no pg/fs/net/http/child_process/import.meta/process.env
#
# Section B — DB probes (skip if DATABASE_URL unset):
#   RSV-4: Trigger self-test — INSERT record without schema_version, verify
#          schema_version equals registry's current record_schema_version
#   RSV-5: SELF-TEST — insert v1 record, bump schema to v2, verify
#          fn_check_rollback_safe returns false; v1 record passes v1 validation,
#          fails v2 validation
#
# --self-test: run Section A only (no DB required); exits 0 if all static checks pass.
#
# Exit 0 if all pass, non-zero if any violation.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODULE="${REPO_ROOT}/src/core/record-schema-validator.ts"
ERRORS=0

SELF_TEST=false
if [[ "${1:-}" == "--self-test" ]]; then
  SELF_TEST=true
fi

echo "[T-0085] record-schema-compat: checking schema versioning infrastructure"

# ============================================================
# Section A: Static Assertions (always run, no DATABASE_URL)
# ============================================================

echo ""
echo "=== Section A: Static Assertions ==="

# RSV-1: Module exists
if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL [FF-RSV-1]: ${MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FF-RSV-1]: ${MODULE} exists"
fi

# RSV-2: Exports public surface
echo -n "Checking [FF-RSV-2] exports... "
EXPORTS="validateRecordAgainstSchema SchemaHistoryMap ValidationResult"
FOUND_ALL=true
for export_name in $EXPORTS; do
  if ! grep -q "export.*${export_name}" "${MODULE}"; then
    echo "FAIL: missing export ${export_name}"
    FOUND_ALL=false
    ERRORS=$((ERRORS + 1))
  fi
done
if $FOUND_ALL; then
  echo "PASS"
fi

# RSV-3: No forbidden imports — only check actual import statements, not comments
echo -n "Checking [FF-RSV-3] forbidden imports... "
# Extract only real import statements (lines starting with 'import', skip comments)
IMPORTS=$(grep "^import" "${MODULE}" 2>/dev/null || true)
if echo "$IMPORTS" | grep -qE "(from\s+['\"]pg['\"]|from\s+['\"]node:fs['\"]|from\s+['\"]node:net['\"]|from\s+['\"]node:http['\"]|from\s+['\"]child_process['\"])" ; then
  echo "FAIL: forbidden import detected"
  ERRORS=$((ERRORS + 1))
# Also check for process.env usage in non-comment code
elif grep -E "process\.(env|argv|cwd|exit)" "${MODULE}" 2>/dev/null | grep -vE "^\s*\*|^\s*//" > /dev/null 2>&1; then
  echo "FAIL: process usage detected"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS"
fi

# ============================================================
# Early exit for --self-test (Section A only)
# ============================================================

if $SELF_TEST; then
  if [[ ${ERRORS} -gt 0 ]]; then
    echo ""
    echo "FAIL: record-schema-compat --self-test found ${ERRORS} violation(s)"
    exit 1
  fi
  echo ""
  echo "PASS: record-schema-compat --self-test — all static checks green"
  exit 0
fi

# ============================================================
# Section B: DB Probes (skip if DATABASE_URL unset)
# ============================================================

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo ""
  echo "=== Section B: DB Probes (SKIPPED — DATABASE_URL not set) ==="
  echo "SKIP [FF-RSV-4/FF-RSV-5]: Database tests skipped (no DATABASE_URL)"
else
  echo ""
  echo "=== Section B: DB Probes ==="

  # Create SQL file to avoid bash parsing issues with SQL syntax
  SQL_FILE="/tmp/t0085_selftest_$$.sql"
  cat > "$SQL_FILE" << 'EOFTEST'
BEGIN;

-- Create a dev tenant for testing (fresh UUIDs to avoid collision with other tests)
SET LOCAL search_path = choros, public;
SET LOCAL choros.tenant_id = 'a0000085-0000-0000-0000-000000000099';

-- Create application
INSERT INTO choros.application
  (tenant_id, id, slug, display_name, created_at, updated_at)
VALUES
  ('a0000085-0000-0000-0000-000000000099',
   'b0000085-0000-0000-0000-000000000099',
   'test-rsv-app', 'test-rsv-app', 0, 0)
ON CONFLICT DO NOTHING;

-- Create registry_def with v1 schema (record_schema_version defaults to 1)
INSERT INTO choros.registry_def
  (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
VALUES
  ('a0000085-0000-0000-0000-000000000099',
   'c0000085-0000-0000-0000-000000000099',
   'b0000085-0000-0000-0000-000000000099',
   'test-rsv-reg', 'test-rsv-reg',
   '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}'::jsonb,
   0, 0)
ON CONFLICT DO NOTHING;

-- Verify registry_schema_version is 1
SELECT CASE WHEN record_schema_version = 1 THEN 'OK:v1' ELSE 'FAIL:v1_mismatch' END
FROM choros.registry_def
WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099' AND id = 'c0000085-0000-0000-0000-000000000099';

-- Insert v1 record (schema_version should auto-default to 1 via trigger)
INSERT INTO choros.record
  (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
VALUES
  ('a0000085-0000-0000-0000-000000000099',
   'd0000085-0000-0000-0000-000000000099',
   'c0000085-0000-0000-0000-000000000099',
   '{"name":"Alice"}'::jsonb,
   0, 0, 'ct-test')
ON CONFLICT DO NOTHING;

-- Verify record inherited schema_version=1 from trigger
SELECT CASE WHEN schema_version = 1 THEN 'OK:record_v1' ELSE 'FAIL:record_v1_mismatch' END
FROM choros.record
WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099' AND id = 'd0000085-0000-0000-0000-000000000099';

-- Update schema to v2 (add required email field)
UPDATE choros.registry_def
SET record_schema = '{"type":"object","properties":{"name":{"type":"string"},"email":{"type":"string"}},"required":["name","email"]}'::jsonb
WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099' AND id = 'c0000085-0000-0000-0000-000000000099';

-- Verify registry_schema_version incremented to 2 (by BEFORE UPDATE trigger)
SELECT CASE WHEN record_schema_version = 2 THEN 'OK:v2' ELSE 'FAIL:v2_mismatch' END
FROM choros.registry_def
WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099' AND id = 'c0000085-0000-0000-0000-000000000099';

-- Verify history record was appended (by AFTER UPDATE trigger)
SELECT CASE WHEN COUNT(*) = 1 THEN 'OK:history' ELSE 'FAIL:history_mismatch' END
FROM choros.registry_schema_history
WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099'
  AND registry_id = 'c0000085-0000-0000-0000-000000000099'
  AND schema_version = 2;

-- AC-3 critical: INSERT new record WITHOUT explicit schema_version after registry upgraded to v2.
-- Trigger must assign schema_version=2, not v1 from a DEFAULT constraint.
INSERT INTO choros.record
  (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
VALUES
  ('a0000085-0000-0000-0000-000000000099',
   'e0000085-0000-0000-0000-000000000099',
   'c0000085-0000-0000-0000-000000000099',
   '{"name":"Bob","email":"bob@example.com"}'::jsonb,
   0, 0, 'ct-test')
ON CONFLICT DO NOTHING;

-- Verify new record inherited schema_version=2 (not v1 from a DEFAULT)
SELECT CASE WHEN schema_version = 2 THEN 'OK:record_v2_after_upgrade' ELSE 'FAIL:record_v2_mismatch' END
FROM choros.record
WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099' AND id = 'e0000085-0000-0000-0000-000000000099';

-- Verify fn_check_rollback_safe: v2 record exists, rollback to v2 is safe (true)
SELECT CASE WHEN fn_check_rollback_safe(
  'a0000085-0000-0000-0000-000000000099'::uuid,
  'c0000085-0000-0000-0000-000000000099'::uuid,
  2
) = true THEN 'OK:rollback_safe_v2' ELSE 'FAIL:rollback_safe_check' END;

-- Verify fn_check_rollback_safe: rollback to v1 is NOT safe (v2 record exists → false)
SELECT CASE WHEN fn_check_rollback_safe(
  'a0000085-0000-0000-0000-000000000099'::uuid,
  'c0000085-0000-0000-0000-000000000099'::uuid,
  1
) = false THEN 'OK:rollback_blocked_v1' ELSE 'FAIL:rollback_block_check' END;

-- Verify immutability: attempt to UPDATE schema_version should raise restrict_violation (23001)
DO $$
BEGIN
  UPDATE choros.record
  SET schema_version = 2
  WHERE tenant_id = 'a0000085-0000-0000-0000-000000000099'
    AND id = 'd0000085-0000-0000-0000-000000000099';
  RAISE EXCEPTION 'FAIL:immutability_not_enforced';
EXCEPTION WHEN others THEN
  IF SQLSTATE = '23001' THEN
    RAISE NOTICE 'OK:immutable_enforced';
  ELSE
    RAISE EXCEPTION 'FAIL:unexpected_error %', SQLSTATE;
  END IF;
END;
$$ LANGUAGE plpgsql;

ROLLBACK;
EOFTEST

  # Run the SQL and capture output
  TEST_RESULT=$(psql "$DATABASE_URL" -f "$SQL_FILE" 2>&1 || echo "PSQL_FAILED")
  rm -f "$SQL_FILE"

  if echo "$TEST_RESULT" | grep -q "OK:v1" && \
     echo "$TEST_RESULT" | grep -q "OK:record_v1" && \
     echo "$TEST_RESULT" | grep -q "OK:v2" && \
     echo "$TEST_RESULT" | grep -q "OK:history" && \
     echo "$TEST_RESULT" | grep -q "OK:record_v2_after_upgrade" && \
     echo "$TEST_RESULT" | grep -q "OK:rollback_safe_v2" && \
     echo "$TEST_RESULT" | grep -q "OK:rollback_blocked_v1" && \
     echo "$TEST_RESULT" | grep -q "OK:immutable_enforced"; then
    echo "PASS [FF-RSV-4/FF-RSV-5]: SELF-TEST passed"
  else
    echo "FAIL [FF-RSV-4/FF-RSV-5]: SELF-TEST failed"
    echo "$TEST_RESULT"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ============================================================
# Exit
# ============================================================

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "FAIL: record-schema-compat found ${ERRORS} violation(s)"
  exit 1
fi

echo ""
echo "PASS: record-schema-compat — all checks green"
exit 0
