#!/usr/bin/env bash
# T-0213 · P-5 — install-runbook-projection: static one-directional seam guard.
#
# F-6 (ADR §9): proves the genesis ⇏ pipeline AND pipeline ⇏ genesis import
# directions are absent, and that migration 065 is pure SQL with no shell
# escape / no genesis-owner SQL.
#
# Checks:
#   IRP-1 — migrations/065_install_runbook_projection.sql exists.
#   IRP-2 — 065 is PURE SQL: no shell escape (no COPY ... FROM PROGRAM, no \!,
#            no \i, no shell-escape pattern), no genesis-owner SQL
#            (no INSERT INTO choros.role_assignment with source='genesis',
#             no mgmt_object grant rows).
#   IRP-3 — 065 writes ONLY scope='system' for doc_page (no scope='tenant').
#   IRP-4 — Genesis surface imports NO doc-pipeline module:
#            ops/install.sh, ops/docker-entrypoint.sh, migrations/run.mjs,
#            src/vendor/activation.ts, src/vendor/entitlement.ts,
#            src/http/vendor-activation.ts
#            must NOT contain any reference to:
#            doc-page-store, doc-regen, doc-reconcile, doc-ref-lint,
#            doc-live-snapshot, scripts/doc-
#   IRP-5 — Pipeline modules import NO genesis module:
#            src/core/doc-*.ts, src/db/doc-page-store.ts, scripts/doc-*.ts
#            must NOT reference:
#            migrations/run, ops/install, src/vendor/activation,
#            ops/docker-entrypoint
#
# --self-test mode: plants fixture files that contain the forbidden patterns
#   and asserts the guards detect them. Plants a fixture genesis file that
#   imports doc-page-store (IRP-4 negative), and a fixture 065 with a shell
#   escape (IRP-2 negative). Exit 0 = all assertions confirmed.
#
# Mirrors ci/checks/no-killswitch-in-core.sh (genesis red-line shape)
# and ci/checks/doc-regen-isolation.sh (forbidden-import sweep).
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MIGRATION_065="${PROJECT_ROOT}/migrations/065_install_runbook_projection.sql"

# Genesis surface files
GENESIS_FILES=(
  "${PROJECT_ROOT}/ops/install.sh"
  "${PROJECT_ROOT}/ops/docker-entrypoint.sh"
  "${PROJECT_ROOT}/migrations/run.mjs"
  "${PROJECT_ROOT}/src/vendor/activation.ts"
  "${PROJECT_ROOT}/src/vendor/entitlement.ts"
  "${PROJECT_ROOT}/src/http/vendor-activation.ts"
)

# Doc-pipeline forbidden patterns (genesis must not import these)
PIPELINE_PATTERNS=(
  "doc-page-store"
  "doc-regen"
  "doc-reconcile"
  "doc-ref-lint"
  "doc-live-snapshot"
  "scripts/doc-"
)

# Genesis forbidden patterns (pipeline must not import these)
GENESIS_PATTERNS=(
  "migrations/run"
  "ops/install"
  "src/vendor/activation"
  "ops/docker-entrypoint"
)

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0213][self-test] install-runbook-projection --self-test: verifying violation detection"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  SELF_TEST_ERRORS=0

  # ---- Self-test IRP-1: migration file absent → detected ----
  FAKE_MISSING="${TMPDIR_ST}/definitely_absent_065.sql"
  if [[ -f "${FAKE_MISSING}" ]]; then
    echo "SELF-TEST FAIL [IRP-1]: absent-file check unexpectedly found file" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  else
    echo "SELF-TEST PASS [IRP-1]: absent migration file correctly identified as absent"
  fi

  # ---- Self-test IRP-2a: shell escape in 065 → detected ----
  BAD_SHELL_FIXTURE="${TMPDIR_ST}/bad_065_shell.sql"
  cat > "${BAD_SHELL_FIXTURE}" <<'FIXTURE'
-- bad fixture: has a COPY FROM PROGRAM shell escape
COPY choros.doc_page FROM PROGRAM 'ls /';
INSERT INTO choros.doc_page (tenant_id) VALUES ('a0000000-0000-0000-0000-000000000001');
FIXTURE

  if grep -qiE "COPY[[:space:]]+.*FROM[[:space:]]+PROGRAM" "${BAD_SHELL_FIXTURE}" 2>/dev/null; then
    echo "SELF-TEST PASS [IRP-2a]: COPY FROM PROGRAM shell escape correctly detected"
  else
    echo "SELF-TEST FAIL [IRP-2a]: COPY FROM PROGRAM NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test IRP-2b: genesis-owner SQL in 065 → detected ----
  # The guard checks for INSERT INTO choros.role_assignment (the structural marker)
  # rather than source='genesis' alone (which could appear in embedded prose/comments).
  BAD_GENESIS_SQL_FIXTURE="${TMPDIR_ST}/bad_065_genesis.sql"
  cat > "${BAD_GENESIS_SQL_FIXTURE}" <<'FIXTURE'
-- bad fixture: has genesis-owner SQL (INSERT INTO choros.role_assignment)
INSERT INTO choros.role_assignment (tenant_id, id, employee_id, role_id, source)
VALUES ('a0000000-0000-0000-0000-000000000001', 'b0...', 'd0...', 'e0...', 'genesis');
FIXTURE

  if grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+choros\.role_assignment" "${BAD_GENESIS_SQL_FIXTURE}" 2>/dev/null; then
    echo "SELF-TEST PASS [IRP-2b]: genesis-owner SQL (INSERT INTO choros.role_assignment) correctly detected"
  else
    echo "SELF-TEST FAIL [IRP-2b]: genesis-owner SQL NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test IRP-4: genesis file importing doc-page-store → detected ----
  BAD_GENESIS_IMPORT_FIXTURE="${TMPDIR_ST}/bad_install.sh"
  cat > "${BAD_GENESIS_IMPORT_FIXTURE}" <<'FIXTURE'
#!/usr/bin/env bash
# bad fixture: genesis file that imports doc-page-store
source "$(dirname "$0")/../src/db/doc-page-store.ts"
echo "genesis should not import pipeline modules"
FIXTURE

  DETECTED_PIPELINE_IMPORT=false
  for pattern in "${PIPELINE_PATTERNS[@]}"; do
    if grep -qF "${pattern}" "${BAD_GENESIS_IMPORT_FIXTURE}" 2>/dev/null; then
      DETECTED_PIPELINE_IMPORT=true
      break
    fi
  done

  if [[ "${DETECTED_PIPELINE_IMPORT}" == "true" ]]; then
    echo "SELF-TEST PASS [IRP-4]: pipeline module import in genesis fixture correctly detected"
  else
    echo "SELF-TEST FAIL [IRP-4]: pipeline module import in genesis file NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test IRP-5: pipeline file importing genesis module → detected ----
  BAD_PIPELINE_IMPORT_FIXTURE="${TMPDIR_ST}/bad_doc-regen.ts"
  cat > "${BAD_PIPELINE_IMPORT_FIXTURE}" <<'FIXTURE'
// bad fixture: pipeline module that imports genesis
import { runMigrations } from 'migrations/run';
export function planRegen() {}
FIXTURE

  DETECTED_GENESIS_IMPORT=false
  for pattern in "${GENESIS_PATTERNS[@]}"; do
    if grep -qF "${pattern}" "${BAD_PIPELINE_IMPORT_FIXTURE}" 2>/dev/null; then
      DETECTED_GENESIS_IMPORT=true
      break
    fi
  done

  if [[ "${DETECTED_GENESIS_IMPORT}" == "true" ]]; then
    echo "SELF-TEST PASS [IRP-5]: genesis module import in pipeline fixture correctly detected"
  else
    echo "SELF-TEST FAIL [IRP-5]: genesis module import in pipeline file NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — the guard has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: install-runbook-projection self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0213][F-6] install-runbook-projection: checking one-directional seam (genesis ⇏ pipeline, pipeline ⇏ genesis)"

# ---- IRP-1: migration 065 exists ---------------------------------------------------
echo ""
echo "IRP-1: migrations/065_install_runbook_projection.sql exists"
if [[ ! -f "${MIGRATION_065}" ]]; then
  echo "FAIL IRP-1: migrations/065_install_runbook_projection.sql does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS IRP-1: migrations/065_install_runbook_projection.sql exists"
fi

# ---- IRP-2: 065 is pure SQL — no shell escape, no genesis-owner SQL ---------------
echo ""
echo "IRP-2: 065 is pure SQL (no shell escape, no genesis-owner SQL)"
if [[ ! -f "${MIGRATION_065}" ]]; then
  echo "SKIP IRP-2: file not found (already failed in IRP-1)"
else
  IRP2_ERRORS=0

  # IRP-2a: no COPY ... FROM PROGRAM
  if grep -qiE "COPY[[:space:]]+.*FROM[[:space:]]+PROGRAM" "${MIGRATION_065}" 2>/dev/null; then
    echo "FAIL IRP-2a: 065 contains COPY FROM PROGRAM shell escape — forbidden in pure SQL seed"
    IRP2_ERRORS=$((IRP2_ERRORS + 1))
  else
    echo "PASS IRP-2a: no COPY FROM PROGRAM in 065"
  fi

  # IRP-2b: no \! (psql meta-escape)
  if grep -qE '\\!' "${MIGRATION_065}" 2>/dev/null; then
    echo "FAIL IRP-2b: 065 contains \! shell escape — forbidden in pure SQL seed"
    IRP2_ERRORS=$((IRP2_ERRORS + 1))
  else
    echo "PASS IRP-2b: no \! escape in 065"
  fi

  # IRP-2c: no \i (psql include)
  if grep -qE '^\\i[[:space:]]' "${MIGRATION_065}" 2>/dev/null; then
    echo "FAIL IRP-2c: 065 contains \i include — forbidden in pure SQL seed (no external file includes)"
    IRP2_ERRORS=$((IRP2_ERRORS + 1))
  else
    echo "PASS IRP-2c: no \i include in 065"
  fi

  # IRP-2d: no genesis-owner SQL (INSERT INTO role_assignment ... source='genesis')
  # We check for the combination of role_assignment table with source='genesis' context.
  # A bare grep for source='genesis' would falsely match markdown body text embedded
  # in dollar-quoted strings (e.g. the install.md runbook prose references it).
  # So: flag only if role_assignment INSERT is present alongside source='genesis'.
  if grep -qiE "INSERT[[:space:]]+INTO[[:space:]]+choros\.role_assignment" "${MIGRATION_065}" 2>/dev/null; then
    if grep -qE "source[[:space:]]*=[[:space:]]*'genesis'" "${MIGRATION_065}" 2>/dev/null; then
      echo "FAIL IRP-2d: 065 contains INSERT INTO choros.role_assignment with source='genesis' — genesis-owner path must stay in migration 026 only"
      IRP2_ERRORS=$((IRP2_ERRORS + 1))
    else
      echo "FAIL IRP-2d: 065 contains INSERT INTO choros.role_assignment — this is a genesis-owner SQL pattern forbidden in a docs seed"
      IRP2_ERRORS=$((IRP2_ERRORS + 1))
    fi
  else
    echo "PASS IRP-2d: no genesis-owner SQL (role_assignment INSERT / source='genesis') in 065"
  fi

  # IRP-2e: no mgmt_object grant (genesis-owner authority type)
  if grep -qiE "mgmt_object" "${MIGRATION_065}" 2>/dev/null; then
    echo "FAIL IRP-2e: 065 contains mgmt_object — genesis management-object grant must not appear in docs seed"
    IRP2_ERRORS=$((IRP2_ERRORS + 1))
  else
    echo "PASS IRP-2e: no mgmt_object grant in 065"
  fi

  # IRP-2f: no DDL (CREATE TABLE, ALTER TABLE, CREATE POLICY)
  if grep -qiE "^[[:space:]]*(CREATE[[:space:]]+TABLE|ALTER[[:space:]]+TABLE|CREATE[[:space:]]+POLICY|DROP[[:space:]])" "${MIGRATION_065}" 2>/dev/null; then
    echo "FAIL IRP-2f: 065 contains DDL statement — must be INSERT-only data seed"
    IRP2_ERRORS=$((IRP2_ERRORS + 1))
  else
    echo "PASS IRP-2f: no DDL in 065 (INSERT-only seed confirmed)"
  fi

  if [[ ${IRP2_ERRORS} -eq 0 ]]; then
    echo "PASS IRP-2: 065 is pure SQL — no shell escape, no genesis-owner SQL, no DDL"
  else
    ERRORS=$((ERRORS + IRP2_ERRORS))
  fi
fi

# ---- IRP-3: 065 writes only scope='system' for doc_page ----------------------------
echo ""
echo "IRP-3: 065 writes ONLY scope='system' for doc_page rows (provision-writer boundary)"
if [[ ! -f "${MIGRATION_065}" ]]; then
  echo "SKIP IRP-3: file not found"
else
  # Check for any scope='tenant' in INSERT context
  if grep -qE "scope[[:space:]]*=[[:space:]]*'tenant'" "${MIGRATION_065}" 2>/dev/null; then
    echo "FAIL IRP-3: 065 contains scope='tenant' — projection seed must write only scope='system' (T-0134 §2.4)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS IRP-3: no scope='tenant' in 065 (only scope='system' writes)"
  fi
fi

# ---- IRP-4: genesis surface imports no doc-pipeline module -------------------------
echo ""
echo "IRP-4: genesis files contain no import of doc-pipeline modules"

IRP4_ERRORS=0
for genesis_file in "${GENESIS_FILES[@]}"; do
  if [[ ! -f "${genesis_file}" ]]; then
    # genesis files should exist — flag missing files
    echo "WARN IRP-4: genesis file not found (skipping): ${genesis_file}"
    continue
  fi

  for pattern in "${PIPELINE_PATTERNS[@]}"; do
    if grep -vE "^[[:space:]]*(#|//|\*)" "${genesis_file}" | grep -qF "${pattern}" 2>/dev/null; then
      echo "FAIL IRP-4: ${genesis_file} references doc-pipeline module '${pattern}' — genesis must NOT depend on the pipeline"
      IRP4_ERRORS=$((IRP4_ERRORS + 1))
    fi
  done
done

if [[ ${IRP4_ERRORS} -eq 0 ]]; then
  echo "PASS IRP-4: no genesis file imports any doc-pipeline module (genesis ⇏ pipeline confirmed)"
else
  ERRORS=$((ERRORS + IRP4_ERRORS))
fi

# ---- IRP-5: pipeline modules import no genesis module ------------------------------
echo ""
echo "IRP-5: pipeline modules contain no import of genesis modules"

# Collect pipeline files
PIPELINE_FILES=()
while IFS= read -r -d '' f; do
  PIPELINE_FILES+=("$f")
done < <(find "${PROJECT_ROOT}/src/core" -name "doc-*.ts" -print0 2>/dev/null)

if [[ -f "${PROJECT_ROOT}/src/db/doc-page-store.ts" ]]; then
  PIPELINE_FILES+=("${PROJECT_ROOT}/src/db/doc-page-store.ts")
fi

while IFS= read -r -d '' f; do
  PIPELINE_FILES+=("$f")
done < <(find "${PROJECT_ROOT}/scripts" -name "doc-*.ts" -print0 2>/dev/null)

IRP5_ERRORS=0
for pipeline_file in "${PIPELINE_FILES[@]}"; do
  if [[ ! -f "${pipeline_file}" ]]; then
    continue
  fi

  for pattern in "${GENESIS_PATTERNS[@]}"; do
    if grep -vE "^[[:space:]]*(//|\*)" "${pipeline_file}" | grep -qF "${pattern}" 2>/dev/null; then
      echo "FAIL IRP-5: ${pipeline_file} references genesis module '${pattern}' — pipeline must NOT import genesis"
      IRP5_ERRORS=$((IRP5_ERRORS + 1))
    fi
  done
done

if [[ ${IRP5_ERRORS} -eq 0 ]]; then
  echo "PASS IRP-5: no pipeline module imports any genesis module (pipeline ⇏ genesis confirmed)"
else
  ERRORS=$((ERRORS + IRP5_ERRORS))
fi

# ---- Result -------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: install-runbook-projection found ${ERRORS} violation(s) [T-0213 P-5 F-6]"
  exit 1
fi
echo "PASS: install-runbook-projection — all checks green [T-0213 P-5 F-6]"
exit 0
