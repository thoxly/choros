#!/usr/bin/env bash
# T-0238 · T-0134a: doc-pipeline-foundation fitness checks
#
# Asserts (ADR T-0134 §8):
#
#  FF-NO-RAW:
#   DPF-1 — No table/folder/variable named 'raw' for docs source material in
#            migrations/ or src/. Source of truth = live system (ADR §1/§7).
#
#  FF-DOCREF-TYPED:
#   DPF-2 — migrations/061_doc_page.sql defines CHECK on ref_kind IN (closed vocab).
#   DPF-3 — ref_target column is jsonb (not text/free-text).
#   DPF-4 — doc-ref-lint.ts exports DocRef and DocRefKind (typed, not free text).
#
#  FF-SCHEMA-DOCS:
#   DPF-5 — migration 061_doc_page.sql exists (doc_page slot).
#   DPF-6 — All three tables (doc_page, doc_ref, doc_log) have tenant_id-leading PK pattern.
#   DPF-7 — All three tables have FORCE ROW LEVEL SECURITY.
#   DPF-8 — All three tables have single tenant_isolation policy (no scope predicate).
#   DPF-9 — All three tables registered in known_tenant_tables.txt.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

MIGRATION="${PROJECT_ROOT}/migrations/061_doc_page.sql"
LINT_MODULE="${PROJECT_ROOT}/src/core/doc-ref-lint.ts"
KTT="${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt"

echo "[FF-DOC-PIPELINE] doc-pipeline-foundation: checking DDL, types, and schema invariants"

# --self-test mode: verify this script itself is discoverable and executes cleanly.
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[self-test] doc-pipeline-foundation.sh --self-test: script reachable and parseable"
  exit 0
fi

# ---- DPF-1: FF-NO-RAW — no raw docs table/folder/variable in migrations/ or src/ ----

echo "--- DPF-1 (FF-NO-RAW): checking for forbidden 'raw' doc patterns ---"

RAW_HITS=$(grep -riE '\bdoc_?raw\b|\bdocs?_source_raw\b|\braw_doc\b' \
  "${PROJECT_ROOT}/migrations/" "${PROJECT_ROOT}/src/" 2>/dev/null || true)

if [[ -n "${RAW_HITS}" ]]; then
  echo "FAIL DPF-1: found forbidden 'raw' doc pattern(s):"
  echo "${RAW_HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS DPF-1: no 'raw' doc tables/folders/vars found (source of truth = live system)"
fi

# ---- DPF-2: FF-DOCREF-TYPED — CHECK constraint on ref_kind in migration ----

echo "--- DPF-2 (FF-DOCREF-TYPED): ref_kind CHECK in migration ---"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL DPF-2: migration 061_doc_page.sql does not exist (slot must be 061)"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "ref_kind\s+IN\s*\(" "${MIGRATION}" 2>/dev/null; then
    echo "PASS DPF-2: ref_kind CHECK IN (...) present in migration"
  else
    echo "FAIL DPF-2: ref_kind CHECK IN (...) not found in 061_doc_page.sql"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check all five ref_kind values are present
if [[ -f "${MIGRATION}" ]]; then
  REF_KINDS=("code_symbol" "rest_endpoint" "schema_field" "process" "config_key")
  for kind in "${REF_KINDS[@]}"; do
    if grep -q "${kind}" "${MIGRATION}" 2>/dev/null; then
      echo "PASS DPF-2b: ref_kind '${kind}' present in CHECK constraint"
    else
      echo "FAIL DPF-2b: ref_kind '${kind}' missing from CHECK constraint in migration"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- DPF-3: FF-DOCREF-TYPED — ref_target is jsonb (not text) in migration ----

echo "--- DPF-3 (FF-DOCREF-TYPED): ref_target column is jsonb ---"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "SKIP DPF-3: migration not found (already failed in DPF-2)"
else
  if grep -Eq 'ref_target\s+jsonb' "${MIGRATION}" 2>/dev/null; then
    echo "PASS DPF-3: ref_target is jsonb in migration"
  else
    echo "FAIL DPF-3: ref_target must be jsonb (not free text) in 061_doc_page.sql"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- DPF-4: FF-DOCREF-TYPED — DocRef and DocRefKind exported from doc-ref-lint.ts ----

echo "--- DPF-4 (FF-DOCREF-TYPED): DocRef and DocRefKind exported from doc-ref-lint.ts ---"

if [[ ! -f "${LINT_MODULE}" ]]; then
  echo "FAIL DPF-4: src/core/doc-ref-lint.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  TYPED_EXPORTS=("export.*DocRefKind" "export.*DocRef")
  for pattern in "${TYPED_EXPORTS[@]}"; do
    if grep -Eq "${pattern}" "${LINT_MODULE}" 2>/dev/null; then
      echo "PASS DPF-4: '${pattern}' found in doc-ref-lint.ts"
    else
      echo "FAIL DPF-4: '${pattern}' missing from src/core/doc-ref-lint.ts"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- DPF-5: FF-SCHEMA-DOCS — migration 061_doc_page.sql exists ----

echo "--- DPF-5 (FF-SCHEMA-DOCS): migration 061_doc_page.sql exists ---"

if [[ -f "${MIGRATION}" ]]; then
  echo "PASS DPF-5: migrations/061_doc_page.sql exists"
else
  echo "FAIL DPF-5: migrations/061_doc_page.sql missing"
  ERRORS=$((ERRORS + 1))
fi

# ---- DPF-6: FF-SCHEMA-DOCS — all three tables have tenant_id-leading PK ----

echo "--- DPF-6 (FF-SCHEMA-DOCS): tenant_id-leading PK for all three tables ---"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "SKIP DPF-6: migration not found"
else
  TABLES=("doc_page" "doc_ref" "doc_log")
  for table in "${TABLES[@]}"; do
    if grep -A 20 "CREATE TABLE.*${table}" "${MIGRATION}" 2>/dev/null | \
       grep -q "PRIMARY KEY (tenant_id, id)"; then
      echo "PASS DPF-6: ${table} has PRIMARY KEY (tenant_id, id)"
    else
      echo "FAIL DPF-6: ${table} missing tenant_id-leading PK in migration"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- DPF-7: FF-SCHEMA-DOCS — FORCE ROW LEVEL SECURITY for all three tables ----

echo "--- DPF-7 (FF-SCHEMA-DOCS): FORCE ROW LEVEL SECURITY present for all three tables ---"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "SKIP DPF-7: migration not found"
else
  TABLES=("doc_page" "doc_ref" "doc_log")
  for table in "${TABLES[@]}"; do
    if grep -q "FORCE.*ROW LEVEL SECURITY" "${MIGRATION}" 2>/dev/null; then
      echo "PASS DPF-7: FORCE RLS statement found in migration (covers ${table})"
      break
    fi
  done
  # Check each table specifically
  DPF7_ERRORS=0
  for table in "${TABLES[@]}"; do
    if ! grep -A 5 "ALTER TABLE choros.${table}" "${MIGRATION}" 2>/dev/null | \
       grep -q "FORCE.*ROW LEVEL SECURITY"; then
      echo "FAIL DPF-7: ${table} missing FORCE ROW LEVEL SECURITY in migration"
      DPF7_ERRORS=$((DPF7_ERRORS + 1))
    else
      echo "PASS DPF-7: choros.${table} has FORCE ROW LEVEL SECURITY"
    fi
  done
  ERRORS=$((ERRORS + DPF7_ERRORS))
fi

# ---- DPF-8: FF-SCHEMA-DOCS / FF-DOCS-SYSTEM-PROJECTION — single tenant_id predicate, no scope ----

echo "--- DPF-8 (FF-SCHEMA-DOCS / NF-1): single tenant_id predicate, no scope predicate ---"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "SKIP DPF-8: migration not found"
else
  # Policy USING must reference tenant_id = current_setting(...)
  POLICY_COUNT=$(grep -c "tenant_id = current_setting" "${MIGRATION}" 2>/dev/null || echo 0)
  if [[ "${POLICY_COUNT}" -ge 3 ]]; then
    echo "PASS DPF-8: at least 3 tenant_id-only policy USING clauses found (one per table)"
  else
    echo "FAIL DPF-8: expected ≥ 3 tenant_id-only policy USING clauses, found ${POLICY_COUNT}"
    ERRORS=$((ERRORS + 1))
  fi

  # Must NOT have a scope predicate in the RLS policies
  if grep -E "USING.*scope|scope.*USING" "${MIGRATION}" 2>/dev/null | grep -v "^\s*--"; then
    echo "FAIL DPF-8: scope predicate found in RLS policy (NF-1 violation — must be tenant_id only)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS DPF-8: no scope predicate in RLS policies (NF-1 satisfied)"
  fi
fi

# ---- DPF-9: FF-SCHEMA-DOCS — all three tables in known_tenant_tables.txt ----

echo "--- DPF-9 (FF-SCHEMA-DOCS): all three tables in known_tenant_tables.txt ---"

if [[ ! -f "${KTT}" ]]; then
  echo "FAIL DPF-9: ci/checks/known_tenant_tables.txt does not exist"
  ERRORS=$((ERRORS + 1))
else
  TABLES=("doc_page" "doc_ref" "doc_log")
  for table in "${TABLES[@]}"; do
    if grep -qxF "${table}" "${KTT}" 2>/dev/null; then
      echo "PASS DPF-9: '${table}' found in known_tenant_tables.txt"
    else
      echo "FAIL DPF-9: '${table}' missing from ci/checks/known_tenant_tables.txt"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Result ----------------------------------------------------------------

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: doc-pipeline-foundation found ${ERRORS} violation(s) [FF-NO-RAW, FF-DOCREF-TYPED, FF-SCHEMA-DOCS]"
  exit 1
fi

echo "PASS: doc-pipeline-foundation — all checks green [FF-NO-RAW, FF-DOCREF-TYPED, FF-SCHEMA-DOCS]"
exit 0
