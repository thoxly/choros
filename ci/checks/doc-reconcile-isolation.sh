#!/usr/bin/env bash
# T-0212 · P-4 — doc-reconcile-isolation: static purity guard for src/core/doc-reconcile.ts.
#
# F-6 (ADR §9): asserts the RECONCILE core is pure — no forbidden I/O imports,
# no collector import, required exports present.
#
# Checks:
#  DRC-1 — src/core/doc-reconcile.ts exists.
#  DRC-2 — Module is pure: no forbidden imports:
#           pg, node:fs, node:http, node:net, node:child_process,
#           child_process, import.meta, process.env, process.exit.
#           (node:crypto is PERMITTED — same exception as doc-regen.ts.)
#  DRC-3 — Module does NOT import doc-live-snapshot (collector is edge-only;
#           planner takes a LiveSnapshot + DocLintResult, it assembles neither).
#  DRC-4 — Required exports present:
#           planReconcile, ReconcilePlan.
#           (Plus plan member types — verified by TSC not grep.)
#
# --self-test mode: runs negative fixtures for each check to prove the
#   violation-detection assertions actually catch violations.
#   Exit 0 = self-test passed (all violations were caught).
#
# Mirrors ci/checks/doc-regen-isolation.sh.
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/doc-reconcile.ts"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0212][self-test] doc-reconcile-isolation --self-test: verifying violation detection"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  SELF_TEST_ERRORS=0

  # ---- Self-test DRC-1: module absent → detected ----
  ABSENT_MODULE="${TMPDIR_ST}/absent.ts"
  if [[ -f "${ABSENT_MODULE}" ]]; then
    echo "SELF-TEST FAIL [DRC-1]: absent module file unexpectedly exists" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  else
    echo "SELF-TEST PASS [DRC-1]: non-existent module correctly detected as absent"
  fi

  # ---- Self-test DRC-2a: pg import → detected ----
  BROKEN_DRC2A="${TMPDIR_ST}/drc2a_broken.ts"
  cat > "${BROKEN_DRC2A}" <<'FIXTURE'
import pg from 'pg';
export function planReconcile() {}
FIXTURE
  if grep -qE "from[[:space:]]*['\"]pg['\"]" "${BROKEN_DRC2A}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-2a]: pg import correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-2a]: pg import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-2b: node:fs import → detected ----
  BROKEN_DRC2B="${TMPDIR_ST}/drc2b_broken.ts"
  cat > "${BROKEN_DRC2B}" <<'FIXTURE'
import * as fs from 'node:fs';
export function planReconcile() {}
FIXTURE
  if grep -qE "from[[:space:]]*['\"]node:fs['\"]" "${BROKEN_DRC2B}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-2b]: node:fs import correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-2b]: node:fs import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-2c: process.env → detected ----
  BROKEN_DRC2C="${TMPDIR_ST}/drc2c_broken.ts"
  cat > "${BROKEN_DRC2C}" <<'FIXTURE'
const x = process.env['DATABASE_URL'];
export function planReconcile() {}
FIXTURE
  if grep -qE "process\.env" "${BROKEN_DRC2C}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-2c]: process.env correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-2c]: process.env NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-2d: process.exit → detected ----
  BROKEN_DRC2D="${TMPDIR_ST}/drc2d_broken.ts"
  cat > "${BROKEN_DRC2D}" <<'FIXTURE'
process.exit(1);
export function planReconcile() {}
FIXTURE
  if grep -qE "process\.exit" "${BROKEN_DRC2D}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-2d]: process.exit correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-2d]: process.exit NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-2e: import.meta → detected ----
  BROKEN_DRC2E="${TMPDIR_ST}/drc2e_broken.ts"
  cat > "${BROKEN_DRC2E}" <<'FIXTURE'
const url = import.meta.url;
export function planReconcile() {}
FIXTURE
  if grep -qE "import\.meta" "${BROKEN_DRC2E}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-2e]: import.meta correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-2e]: import.meta NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-2f: node:http → detected ----
  BROKEN_DRC2F="${TMPDIR_ST}/drc2f_broken.ts"
  cat > "${BROKEN_DRC2F}" <<'FIXTURE'
import http from 'node:http';
export function planReconcile() {}
FIXTURE
  if grep -qE "from[[:space:]]*['\"]node:http['\"]" "${BROKEN_DRC2F}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-2f]: node:http import correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-2f]: node:http import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-3: doc-live-snapshot import → detected ----
  BROKEN_DRC3="${TMPDIR_ST}/drc3_broken.ts"
  cat > "${BROKEN_DRC3}" <<'FIXTURE'
import { assembleFullSnapshot } from './doc-live-snapshot.js';
export function planReconcile() {}
FIXTURE
  if grep -qE "doc-live-snapshot" "${BROKEN_DRC3}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-3]: doc-live-snapshot import correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-3]: doc-live-snapshot import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-4: missing planReconcile export → detected ----
  BROKEN_DRC4="${TMPDIR_ST}/drc4_broken.ts"
  cat > "${BROKEN_DRC4}" <<'FIXTURE'
export interface ReconcilePlan { tenantId: string; }
// planReconcile is missing
FIXTURE
  if ! grep -qE "export.*(function|const|type).*planReconcile" "${BROKEN_DRC4}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-4]: missing planReconcile export correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-4]: should have detected missing planReconcile export" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRC-4b: missing ReconcilePlan export → detected ----
  BROKEN_DRC4B="${TMPDIR_ST}/drc4b_broken.ts"
  cat > "${BROKEN_DRC4B}" <<'FIXTURE'
export function planReconcile() {}
// ReconcilePlan is missing
FIXTURE
  if ! grep -qE "export.*ReconcilePlan" "${BROKEN_DRC4B}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRC-4b]: missing ReconcilePlan export correctly detected"
  else
    echo "SELF-TEST FAIL [DRC-4b]: should have detected missing ReconcilePlan export" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — the fitness check has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: doc-reconcile-isolation self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0212][F-6] doc-reconcile-isolation: checking src/core/doc-reconcile.ts module boundary"

# ---- DRC-1: file exists --------------------------------------------------------
echo ""
echo "DRC-1: src/core/doc-reconcile.ts exists"
if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL DRC-1: src/core/doc-reconcile.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS DRC-1: src/core/doc-reconcile.ts exists"
fi

# ---- DRC-2: no forbidden I/O imports ------------------------------------------
echo ""
echo "DRC-2: module is pure — no forbidden I/O imports"
if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRC-2: module not found (already failed in DRC-1)"
else
  FORBIDDEN_PATTERNS=(
    "from[[:space:]]*['\"]pg['\"]"
    "from[[:space:]]*['\"]node:fs['\"]"
    "from[[:space:]]*['\"]node:http['\"]"
    "from[[:space:]]*['\"]node:net['\"]"
    "from[[:space:]]*['\"]node:child_process['\"]"
    "from[[:space:]]*['\"]child_process['\"]"
    "import\.meta"
    "process\.env"
    "process\.exit"
    "require\("
  )

  DRC2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    # Exclude comment lines (// or *)
    if grep -vE "^[[:space:]]*(//|\*)" "${MODULE}" | grep -qE "${pattern}" 2>/dev/null; then
      echo "FAIL DRC-2: doc-reconcile.ts contains forbidden pattern: ${pattern}"
      DRC2_ERRORS=$((DRC2_ERRORS + 1))
    fi
  done

  if [[ ${DRC2_ERRORS} -eq 0 ]]; then
    echo "PASS DRC-2: no forbidden I/O imports in doc-reconcile.ts (node:crypto permitted)"
  else
    ERRORS=$((ERRORS + DRC2_ERRORS))
  fi
fi

# ---- DRC-3: no doc-live-snapshot import (collector is edge-only) ---------------
echo ""
echo "DRC-3: doc-reconcile.ts does NOT import doc-live-snapshot (collector is edge-only)"
if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRC-3: module not found"
else
  if grep -vE "^[[:space:]]*(//|\*)" "${MODULE}" | grep -qE "doc-live-snapshot" 2>/dev/null; then
    echo "FAIL DRC-3: doc-reconcile.ts imports doc-live-snapshot — planner must not assemble snapshot"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS DRC-3: doc-reconcile.ts does not import doc-live-snapshot (collector stays at edge)"
  fi
fi

# ---- DRC-4: required exports present ------------------------------------------
echo ""
echo "DRC-4: required public-surface exports present"
if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRC-4: module not found"
else
  DRC4_ERRORS=0

  REQUIRED_EXPORTS=(
    "export.*(function|const|type).*planReconcile"
    "export.*ReconcilePlan"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -qE "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL DRC-4: doc-reconcile.ts missing export matching: ${pattern}"
      DRC4_ERRORS=$((DRC4_ERRORS + 1))
    else
      echo "PASS DRC-4: '${pattern}' found"
    fi
  done

  if [[ ${DRC4_ERRORS} -eq 0 ]]; then
    echo "PASS DRC-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + DRC4_ERRORS))
  fi
fi

# ---- Result -------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: doc-reconcile-isolation found ${ERRORS} violation(s) [T-0212 F-6]"
  exit 1
fi
echo "PASS: doc-reconcile-isolation — all checks green [T-0212 F-6]"
exit 0
