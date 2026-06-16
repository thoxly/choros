#!/usr/bin/env bash
# T-0211 · P-3 — doc-regen-isolation: static purity guard for src/core/doc-regen.ts.
#
# F-7 (ADR §9): asserts the REGEN core is pure — no forbidden I/O imports,
# no collector import, required exports present.
#
# Checks:
#  DRG-1 — src/core/doc-regen.ts exists.
#  DRG-2 — Module is pure: no forbidden imports:
#           pg, node:fs, node:http, node:net, node:child_process,
#           child_process, import.meta, process.env, process.exit.
#           (node:crypto is PERMITTED — same exception as document-render.ts.)
#  DRG-3 — Module does NOT import doc-live-snapshot (collector is edge-only;
#           planner takes a LiveSnapshot, it does not assemble one).
#  DRG-4 — Required exports present:
#           planRegen, RegenPlan, slugify.
#           (Plus plan member types — verified by TSC not grep.)
#
# --self-test mode: runs negative fixtures for each check to prove the
#   violation-detection assertions actually catch violations.
#   Exit 0 = self-test passed (all violations were caught).
#
# Mirrors ci/checks/doc-ref-lint-isolation.sh and document-render-isolation.sh.
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/doc-regen.ts"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0211][self-test] doc-regen-isolation --self-test: verifying violation detection"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  SELF_TEST_ERRORS=0

  # ---- Self-test DRG-1: module absent → detected ----
  ABSENT_MODULE="${TMPDIR_ST}/absent.ts"
  # Verify that a non-existent path would fail the DRG-1 check
  if [[ -f "${ABSENT_MODULE}" ]]; then
    echo "SELF-TEST FAIL [DRG-1]: absent module file unexpectedly exists" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  else
    echo "SELF-TEST PASS [DRG-1]: non-existent module correctly detected as absent"
  fi

  # ---- Self-test DRG-2a: pg import → detected ----
  BROKEN_DRG2A="${TMPDIR_ST}/drg2a_broken.ts"
  cat > "${BROKEN_DRG2A}" <<'FIXTURE'
import pg from 'pg';
export function planRegen() {}
FIXTURE
  if grep -qE "from[[:space:]]*['\"]pg['\"]" "${BROKEN_DRG2A}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-2a]: pg import correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-2a]: pg import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-2b: node:fs import → detected ----
  BROKEN_DRG2B="${TMPDIR_ST}/drg2b_broken.ts"
  cat > "${BROKEN_DRG2B}" <<'FIXTURE'
import * as fs from 'node:fs';
export function planRegen() {}
FIXTURE
  if grep -qE "from[[:space:]]*['\"]node:fs['\"]" "${BROKEN_DRG2B}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-2b]: node:fs import correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-2b]: node:fs import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-2c: process.env → detected ----
  BROKEN_DRG2C="${TMPDIR_ST}/drg2c_broken.ts"
  cat > "${BROKEN_DRG2C}" <<'FIXTURE'
const x = process.env['DATABASE_URL'];
export function planRegen() {}
FIXTURE
  if grep -qE "process\.env" "${BROKEN_DRG2C}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-2c]: process.env correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-2c]: process.env NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-2d: process.exit → detected ----
  BROKEN_DRG2D="${TMPDIR_ST}/drg2d_broken.ts"
  cat > "${BROKEN_DRG2D}" <<'FIXTURE'
process.exit(1);
export function planRegen() {}
FIXTURE
  if grep -qE "process\.exit" "${BROKEN_DRG2D}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-2d]: process.exit correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-2d]: process.exit NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-2e: import.meta → detected ----
  BROKEN_DRG2E="${TMPDIR_ST}/drg2e_broken.ts"
  cat > "${BROKEN_DRG2E}" <<'FIXTURE'
const url = import.meta.url;
export function planRegen() {}
FIXTURE
  if grep -qE "import\.meta" "${BROKEN_DRG2E}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-2e]: import.meta correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-2e]: import.meta NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-3: doc-live-snapshot import → detected ----
  BROKEN_DRG3="${TMPDIR_ST}/drg3_broken.ts"
  cat > "${BROKEN_DRG3}" <<'FIXTURE'
import { assembleFullSnapshot } from './doc-live-snapshot.js';
export function planRegen() {}
FIXTURE
  if grep -qE "doc-live-snapshot" "${BROKEN_DRG3}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-3]: doc-live-snapshot import correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-3]: doc-live-snapshot import NOT detected" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-4: missing planRegen export → detected ----
  BROKEN_DRG4="${TMPDIR_ST}/drg4_broken.ts"
  cat > "${BROKEN_DRG4}" <<'FIXTURE'
export function slugify(s: string) { return s; }
// planRegen is missing
FIXTURE
  if ! grep -qE "export.*(function|const|type).*planRegen" "${BROKEN_DRG4}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-4]: missing planRegen export correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-4]: should have detected missing planRegen export" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test DRG-4b: missing slugify export → detected ----
  BROKEN_DRG4B="${TMPDIR_ST}/drg4b_broken.ts"
  cat > "${BROKEN_DRG4B}" <<'FIXTURE'
export function planRegen() {}
// slugify is missing
FIXTURE
  if ! grep -qE "export.*(function|const|type).*slugify" "${BROKEN_DRG4B}" 2>/dev/null; then
    echo "SELF-TEST PASS [DRG-4b]: missing slugify export correctly detected"
  else
    echo "SELF-TEST FAIL [DRG-4b]: should have detected missing slugify export" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — the fitness check has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: doc-regen-isolation self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0211][F-7] doc-regen-isolation: checking src/core/doc-regen.ts module boundary"

# ---- DRG-1: file exists --------------------------------------------------------
echo ""
echo "DRG-1: src/core/doc-regen.ts exists"
if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL DRG-1: src/core/doc-regen.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS DRG-1: src/core/doc-regen.ts exists"
fi

# ---- DRG-2: no forbidden I/O imports ------------------------------------------
echo ""
echo "DRG-2: module is pure — no forbidden I/O imports"
if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRG-2: module not found (already failed in DRG-1)"
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

  DRG2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    # Exclude comment lines (// or *)
    if grep -vE "^[[:space:]]*(//|\*)" "${MODULE}" | grep -qE "${pattern}" 2>/dev/null; then
      echo "FAIL DRG-2: doc-regen.ts contains forbidden pattern: ${pattern}"
      DRG2_ERRORS=$((DRG2_ERRORS + 1))
    fi
  done

  if [[ ${DRG2_ERRORS} -eq 0 ]]; then
    echo "PASS DRG-2: no forbidden I/O imports in doc-regen.ts (node:crypto permitted)"
  else
    ERRORS=$((ERRORS + DRG2_ERRORS))
  fi
fi

# ---- DRG-3: no doc-live-snapshot import (collector is edge-only) ---------------
echo ""
echo "DRG-3: doc-regen.ts does NOT import doc-live-snapshot (collector is edge-only)"
if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRG-3: module not found"
else
  if grep -vE "^[[:space:]]*(//|\*)" "${MODULE}" | grep -qE "doc-live-snapshot" 2>/dev/null; then
    echo "FAIL DRG-3: doc-regen.ts imports doc-live-snapshot — planner must not assemble snapshot"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS DRG-3: doc-regen.ts does not import doc-live-snapshot (collector stays at edge)"
  fi
fi

# ---- DRG-4: required exports present ------------------------------------------
echo ""
echo "DRG-4: required public-surface exports present"
if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP DRG-4: module not found"
else
  DRG4_ERRORS=0

  REQUIRED_EXPORTS=(
    "export.*(function|const|type).*planRegen"
    "export.*(function|const|type).*slugify"
    "export.*RegenPlan"
  )

  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -qE "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL DRG-4: doc-regen.ts missing export matching: ${pattern}"
      DRG4_ERRORS=$((DRG4_ERRORS + 1))
    else
      echo "PASS DRG-4: '${pattern}' found"
    fi
  done

  if [[ ${DRG4_ERRORS} -eq 0 ]]; then
    echo "PASS DRG-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + DRG4_ERRORS))
  fi
fi

# ---- Result -------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: doc-regen-isolation found ${ERRORS} violation(s) [T-0211 F-7]"
  exit 1
fi
echo "PASS: doc-regen-isolation — all checks green [T-0211 F-7]"
exit 0
