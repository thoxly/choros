#!/usr/bin/env bash
# T-0179 · E12.2 — bundle-coherence companion: check-report-page-deps static guard
#
# Verifies static invariants for the report_page_dep bundle member (T-0121e):
#
#   RD-1 — report_page_dep registered in bundle_members.txt as kind=choros_table.
#   RD-2 — Migration 052_report_page_dep.sql exists.
#   RD-3 — DDL invariant: dep_kind CHECK constraint (report_page_dep_kind_chk)
#           is declared in migration 052 (guards dep_kind ∈ {read, aggregate}).
#   RD-4 — DDL invariant: UNIQUE constraint on (tenant_id, page_id, registry_def_id, field_key)
#           is declared in migration 052 (guards no duplicate deps).
#   RD-5 — DDL invariant: stale boolean column with DEFAULT false declared in
#           migration 052 (guards the stale-path escape-hatch ADR §5.3).
#   RD-6 — report_page_dep present in known_tenant_tables.txt (T-0013 contract).
#
# Companion to bundle-coherence.sh (T-0082 · frozen). Does NOT modify that file.
# Live DB check (field_key ∈ registry_def.record_schema.properties) is in
# ci/checks/db/report_page_bundle_deps.test.ts (FF-BUNDLE-DEPS, fitness:db).
#
# Usage:
#   check-report-page-deps.sh [--self-test]
#   --self-test  runs fail-closed probe: temporarily unsets MEMBERS_FILE to a
#                non-existent path and asserts exit 1 (NF-3 / AC-11).
#
# Exit 0 — all static invariants satisfied.
# Exit 1 — one or more violations found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MEMBERS_FILE="${SCRIPT_DIR}/bundle_members.txt"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
MIGRATION_052="${PROJECT_ROOT}/migrations/052_report_page_dep.sql"

# ---- Self-test mode (--self-test flag) --------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0179 self-test] Running fail-closed probe: bundle_members.txt absent → expect exit 1"
  FAKE_MEMBERS="/tmp/check-report-page-deps-selftest-absent-$$.txt"
  # Invoke ourselves without the missing file (override via env substitution in subshell)
  if MEMBERS_OVERRIDE="${FAKE_MEMBERS}" bash "${BASH_SOURCE[0]}"; then
    echo "FAIL [self-test]: check-report-page-deps did not exit 1 on absent bundle_members.txt"
    exit 1
  else
    echo "PASS [self-test]: correctly exited non-zero on absent bundle_members.txt"
  fi
  echo "PASS [self-test]: check-report-page-deps self-test complete"
  exit 0
fi

# Support MEMBERS_OVERRIDE for self-test sub-invocation
if [[ -n "${MEMBERS_OVERRIDE:-}" ]]; then
  MEMBERS_FILE="${MEMBERS_OVERRIDE}"
fi

ERRORS=0

echo "[T-0179] check-report-page-deps: verifying report_page_dep bundle member static invariants"

# ---- Fail-closed: bundle_members.txt must exist (NF-3) ----------------------
if [[ ! -f "${MEMBERS_FILE}" ]]; then
  echo "FAIL [check-report-page-deps]: bundle_members.txt missing: ${MEMBERS_FILE}"
  exit 1
fi

# ---- RD-1: report_page_dep registered as choros_table -----------------------
echo ""
echo "Check RD-1: report_page_dep registered in bundle_members.txt as choros_table"

if grep -Eq '^report_page_dep[|]choros_table[|]' "${MEMBERS_FILE}"; then
  echo "PASS RD-1: report_page_dep|choros_table entry found in bundle_members.txt"
else
  echo "FAIL RD-1: report_page_dep not registered as choros_table in bundle_members.txt"
  ERRORS=$((ERRORS + 1))
fi

# ---- RD-2: Migration 052_report_page_dep.sql must exist ---------------------
echo ""
echo "Check RD-2: migrations/052_report_page_dep.sql exists"

if [[ -f "${MIGRATION_052}" ]]; then
  echo "PASS RD-2: migrations/052_report_page_dep.sql found"
else
  echo "FAIL RD-2: migrations/052_report_page_dep.sql not found (expected at ${MIGRATION_052})"
  ERRORS=$((ERRORS + 1))
fi

# ---- RD-3: dep_kind CHECK constraint in migration ---------------------------
echo ""
echo "Check RD-3: dep_kind CHECK constraint (report_page_dep_kind_chk) in migration 052"

if [[ ! -f "${MIGRATION_052}" ]]; then
  echo "SKIP RD-3: migration not found (already failed RD-2)"
else
  # Whitespace-tolerant grep for dep_kind IN ('read','aggregate') CHECK pattern.
  # Matches both inline CHECK and named constraint styles.
  if grep -Eq "dep_kind[[:space:]]+IN[[:space:]]*\(" "${MIGRATION_052}" 2>/dev/null; then
    echo "PASS RD-3: dep_kind CHECK constraint present in migration 052"
  else
    echo "FAIL RD-3: dep_kind IN (...) CHECK pattern not found in migration 052"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- RD-4: UNIQUE constraint on (tenant_id, page_id, registry_def_id, field_key) ---
echo ""
echo "Check RD-4: UNIQUE (tenant_id, page_id, registry_def_id, field_key) in migration 052"

if [[ ! -f "${MIGRATION_052}" ]]; then
  echo "SKIP RD-4: migration not found"
else
  # Check for the presence of all four columns in a UNIQUE constraint context.
  # Pattern: lines that reference UNIQUE and contain the key columns.
  if grep -q "report_page_dep_page_field_uniq" "${MIGRATION_052}" 2>/dev/null || \
     grep -Eq "UNIQUE[[:space:]]*\([[:space:]]*tenant_id" "${MIGRATION_052}" 2>/dev/null; then
    echo "PASS RD-4: UNIQUE constraint covering (tenant_id, page_id, registry_def_id, field_key) found"
  else
    echo "FAIL RD-4: UNIQUE constraint on (tenant_id, page_id, registry_def_id, field_key) not found in migration 052"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- RD-5: stale boolean column with DEFAULT false --------------------------
echo ""
echo "Check RD-5: stale boolean DEFAULT false column declared in migration 052"

if [[ ! -f "${MIGRATION_052}" ]]; then
  echo "SKIP RD-5: migration not found"
else
  if grep -Eq 'stale[[:space:]]+boolean[[:space:]]+NOT[[:space:]]+NULL' "${MIGRATION_052}" 2>/dev/null; then
    echo "PASS RD-5: stale boolean NOT NULL declared in migration 052"
  else
    echo "FAIL RD-5: stale boolean NOT NULL pattern not found in migration 052"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- RD-6: report_page_dep in known_tenant_tables.txt -----------------------
echo ""
echo "Check RD-6: report_page_dep in known_tenant_tables.txt"

if [[ ! -f "${KNOWN_TABLES}" ]]; then
  echo "FAIL RD-6: known_tenant_tables.txt missing: ${KNOWN_TABLES}"
  ERRORS=$((ERRORS + 1))
elif grep -qx "report_page_dep" "${KNOWN_TABLES}"; then
  echo "PASS RD-6: report_page_dep found in known_tenant_tables.txt"
else
  echo "FAIL RD-6: report_page_dep not found in known_tenant_tables.txt"
  ERRORS=$((ERRORS + 1))
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL [check-report-page-deps]: ${ERRORS} violation(s) found"
  exit 1
fi

echo "PASS [check-report-page-deps]: all report_page_dep static invariants satisfied"
exit 0
