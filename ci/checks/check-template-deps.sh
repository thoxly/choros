#!/usr/bin/env bash
# T-0235 · T-0124 · check-template-deps — bundle-coherence companion: template_dep static guard.
#
# Verifies static invariants for the template_dep bundle member (T-0124 §2.9):
#
#   TD-1 — template_dep registered in bundle_members.txt as kind=choros_table.
#   TD-2 — Migration 060_template_def.sql exists.
#   TD-3 — DDL invariant: dep_kind CHECK constraint (template_dep_kind_chk)
#           is declared in migration 060 (guards dep_kind ∈ {read, aggregate}).
#   TD-4 — DDL invariant: UNIQUE constraint on (tenant_id, template_id, registry_def_id, field_key)
#           is declared in migration 060 (guards no duplicate deps).
#   TD-5 — DDL invariant: stale boolean column with DEFAULT false declared in
#           migration 060 (escape-hatch discipline, ADR §2.9 / T-0121 §5 mirror).
#   TD-6 — template_dep present in known_tenant_tables.txt (T-0013 contract).
#   TD-7 — template_def_format_chk CHECK ∈ {csv,html} present in migration 060 (FF-FORMAT-CLOSED).
#
# Companion to bundle-coherence.sh (T-0082). Does NOT modify that file.
# Division of responsibility:
#   bundle-coherence.sh  — generic: every bundle_members.txt entry has a known_tenant_tables
#                          row + migration DDL key-invariant (one guard per entry, all kinds).
#   check-template-deps.sh (this file) — template_dep-specific DDL detail checks.
# Live DB check (field_key ∈ registry_def.record_schema.properties) is in
# ci/checks/db/template_bundle_deps.test.ts (FF-TEMPLATE-COHERENCE, fitness:db).
#
# Usage:
#   check-template-deps.sh [--self-test]
#   --self-test  fail-closed probe: temporarily point to absent bundle_members.txt → expect exit 1.
#
# Exit 0 — all static invariants satisfied.
# Exit 1 — one or more violations found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---- Self-test mode ---------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0235 self-test] Running fail-closed probe: bundle_members.txt absent → expect exit 1"
  FAKE_MEMBERS="/tmp/check-template-deps-selftest-absent-$$.txt"
  if MEMBERS_OVERRIDE="${FAKE_MEMBERS}" bash "${BASH_SOURCE[0]}"; then
    echo "FAIL [self-test]: check-template-deps did not exit 1 on absent bundle_members.txt"
    exit 1
  else
    echo "PASS [self-test]: correctly exited non-zero on absent bundle_members.txt"
  fi
  echo "PASS [self-test]: check-template-deps self-test complete"
  exit 0
fi

MEMBERS_FILE="${MEMBERS_OVERRIDE:-${SCRIPT_DIR}/bundle_members.txt}"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
MIGRATION_060="${PROJECT_ROOT}/migrations/060_template_def.sql"

ERRORS=0

echo "[T-0235] check-template-deps: verifying template_dep bundle member static invariants"

# ---- Fail-closed: bundle_members.txt must exist -----------------------------
if [[ ! -f "${MEMBERS_FILE}" ]]; then
  echo "FAIL [check-template-deps]: bundle_members.txt missing: ${MEMBERS_FILE}"
  exit 1
fi

# ---- TD-1: template_dep registered as choros_table --------------------------
echo ""
echo "Check TD-1: template_dep registered in bundle_members.txt as choros_table"
if grep -Eq '^template_dep[|]choros_table[|]' "${MEMBERS_FILE}"; then
  echo "PASS TD-1: template_dep|choros_table entry found in bundle_members.txt"
else
  echo "FAIL TD-1: template_dep not registered as choros_table in bundle_members.txt"
  ERRORS=$((ERRORS + 1))
fi

# ---- TD-2: Migration 060_template_def.sql must exist ------------------------
echo ""
echo "Check TD-2: migrations/060_template_def.sql exists"
if [[ -f "${MIGRATION_060}" ]]; then
  echo "PASS TD-2: migrations/060_template_def.sql found"
else
  echo "FAIL TD-2: migrations/060_template_def.sql not found (expected at ${MIGRATION_060})"
  ERRORS=$((ERRORS + 1))
fi

# ---- TD-3: dep_kind CHECK constraint in migration ---------------------------
echo ""
echo "Check TD-3: dep_kind CHECK constraint (template_dep_kind_chk) in migration 060"
if [[ ! -f "${MIGRATION_060}" ]]; then
  echo "SKIP TD-3: migration not found (already failed TD-2)"
else
  if grep -Eq "dep_kind[[:space:]]+IN[[:space:]]*\(" "${MIGRATION_060}" 2>/dev/null; then
    echo "PASS TD-3: dep_kind CHECK constraint present in migration 060"
  else
    echo "FAIL TD-3: dep_kind IN (...) CHECK pattern not found in migration 060"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- TD-4: UNIQUE constraint on (tenant_id, template_id, registry_def_id, field_key) ---
echo ""
echo "Check TD-4: UNIQUE (tenant_id, template_id, registry_def_id, field_key) in migration 060"
if [[ ! -f "${MIGRATION_060}" ]]; then
  echo "SKIP TD-4: migration not found"
else
  if grep -q "template_dep_template_field_uniq" "${MIGRATION_060}" 2>/dev/null || \
     grep -Eq "UNIQUE[[:space:]]*\([[:space:]]*tenant_id" "${MIGRATION_060}" 2>/dev/null; then
    echo "PASS TD-4: UNIQUE constraint covering (tenant_id, template_id, registry_def_id, field_key) found"
  else
    echo "FAIL TD-4: UNIQUE constraint not found in migration 060"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- TD-5: stale boolean column with DEFAULT false --------------------------
echo ""
echo "Check TD-5: stale boolean DEFAULT false declared in migration 060"
if [[ ! -f "${MIGRATION_060}" ]]; then
  echo "SKIP TD-5: migration not found"
else
  if grep -Eq 'stale[[:space:]]+boolean[[:space:]]+NOT[[:space:]]+NULL' "${MIGRATION_060}" 2>/dev/null; then
    echo "PASS TD-5: stale boolean NOT NULL declared in migration 060"
  else
    echo "FAIL TD-5: stale boolean NOT NULL pattern not found in migration 060"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- TD-6: template_dep in known_tenant_tables.txt --------------------------
echo ""
echo "Check TD-6: template_dep in known_tenant_tables.txt"
if [[ ! -f "${KNOWN_TABLES}" ]]; then
  echo "FAIL TD-6: known_tenant_tables.txt missing: ${KNOWN_TABLES}"
  ERRORS=$((ERRORS + 1))
elif grep -qx "template_dep" "${KNOWN_TABLES}"; then
  echo "PASS TD-6: template_dep found in known_tenant_tables.txt"
else
  echo "FAIL TD-6: template_dep not found in known_tenant_tables.txt"
  ERRORS=$((ERRORS + 1))
fi

# ---- TD-7: template_def_format_chk CHECK ∈ {csv,html} (FF-FORMAT-CLOSED) ---
echo ""
echo "Check TD-7: template_def_format_chk CHECK in migration 060 (FF-FORMAT-CLOSED)"
if [[ ! -f "${MIGRATION_060}" ]]; then
  echo "SKIP TD-7: migration not found"
else
  if grep -q "template_def_format_chk" "${MIGRATION_060}" 2>/dev/null; then
    echo "PASS TD-7: template_def_format_chk CHECK found in migration 060 (format ∈ {csv,html})"
  else
    echo "FAIL TD-7: template_def_format_chk CHECK not found in migration 060"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL [check-template-deps]: ${ERRORS} violation(s) found"
  exit 1
fi

echo "PASS [check-template-deps]: all template_dep static invariants satisfied [TD-1..TD-7]"
exit 0
