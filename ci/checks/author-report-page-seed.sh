#!/usr/bin/env bash
# T-0180 · FF-SEED-T0180: author_report_page mcp_tool seed fitness check (T-0121f).
#
# Verifies migration 053_author_report_page_seed.sql satisfies the T-0077 seed
# contract extended to the report-pages authoring tool (ADR T-0121 §6.1).
#
# ARP-1 (static): migration 053_author_report_page_seed.sql exists.
# ARP-2 (static): migration contains 'author_report_page' tool name.
# ARP-3 (idempotency): every INSERT uses ON CONFLICT DO NOTHING.
# ARP-4 (DRAFT-boundary): no 'authoring_published' in non-comment lines.
# ARP-5 (pure_compute): no pure_compute=false in migration 053.
# ARP-6 (no CREATE TABLE): migration 053 is data-seed only.
# ARP-7 (camelCase resource_ops): "resourceType" camelCase key present.
# ARP-8 (dev-tenant): seed row targets a0000000-0000-0000-0000-000000000001.
# ARP-9 (resource_ops create+update): both "create" and "update" ops declared
#        (author_report_page needs both: Floor-1 create + update existing draft).
# ARP-10 (UUID namespace): tool UUID 10...00b and grant UUIDs e2...008/009 correct.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/053_author_report_page_seed.sql"
ERRORS=0

echo "[T-0180] author-report-page-seed fitness check"

# ---- ARP-1: migration file exists ----------------------------------------
echo ""
echo "ARP-1: 053_author_report_page_seed.sql exists"
if [[ -f "${MIG}" ]]; then
  echo "PASS: ${MIG} exists"
else
  echo "FAIL: ${MIG} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- ARP-2: author_report_page tool name present -------------------------
echo ""
echo "ARP-2: 'author_report_page' tool name present in migration 053"
if [[ -f "${MIG}" ]]; then
  if grep -q "'author_report_page'" "${MIG}" 2>/dev/null \
     || grep -q '"author_report_page"' "${MIG}" 2>/dev/null; then
    echo "PASS: tool 'author_report_page' found"
  else
    echo "FAIL: tool 'author_report_page' NOT found in migration 053" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- ARP-3: ON CONFLICT DO NOTHING on every INSERT (non-comment lines) ---
echo ""
echo "ARP-3: migration 053 is idempotent (ON CONFLICT DO NOTHING)"
if [[ -f "${MIG}" ]]; then
  INSERT_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c '\bINSERT\b' || true)
  OC_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c '\bON CONFLICT DO NOTHING\b' || true)
  if [[ "${INSERT_COUNT}" -gt 0 && "${OC_COUNT}" -ge "${INSERT_COUNT}" ]]; then
    echo "PASS: ${INSERT_COUNT} INSERT(s), ${OC_COUNT} ON CONFLICT DO NOTHING (idempotent)"
  else
    echo "FAIL: INSERT_COUNT=${INSERT_COUNT} but ON_CONFLICT_COUNT=${OC_COUNT} — not idempotent" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- ARP-4: DRAFT-boundary — no authoring_published ----------------------
echo ""
echo "ARP-4: DRAFT-boundary — no 'authoring_published' in migration 053 non-comment lines"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q 'authoring_published' 2>/dev/null; then
    echo "FAIL: 'authoring_published' found in non-comment code of migration 053 — DRAFT-boundary violated" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no 'authoring_published' in non-comment code"
  fi
fi

# ---- ARP-5: pure_compute=true for all tool inserts -----------------------
echo ""
echo "ARP-5: all mcp_tool inserts have pure_compute=true"
if [[ -f "${MIG}" ]]; then
  if grep -q 'pure_compute.*false' "${MIG}" 2>/dev/null; then
    echo "FAIL: found pure_compute=false in migration 053" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no pure_compute=false in migration 053"
  fi
fi

# ---- ARP-6: no CREATE TABLE in migration 053 (data-seed only) -----------
echo ""
echo "ARP-6: no CREATE TABLE in migration 053 non-comment lines (data-seed only)"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bCREATE TABLE\b' 2>/dev/null; then
    echo "FAIL: CREATE TABLE found in non-comment code of migration 053 — must be data-seed only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no CREATE TABLE in migration 053 non-comment code"
  fi
fi

# ---- ARP-7: resource_ops uses camelCase "resourceType" -------------------
echo ""
echo "ARP-7: resource_ops uses camelCase \"resourceType\" key"
if [[ -f "${MIG}" ]]; then
  if grep -q '"resourceType"' "${MIG}" 2>/dev/null; then
    echo "PASS: camelCase \"resourceType\" key found"
  else
    echo "FAIL: \"resourceType\" key NOT found in migration 053 resource_ops" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- ARP-8: dev-tenant UUID a0000000-...-000000000001 in seed rows ------
echo ""
echo "ARP-8: dev-tenant UUID (a0000000-0000-0000-0000-000000000001) in seed rows"
if [[ -f "${MIG}" ]]; then
  if grep -q "'a0000000-0000-0000-0000-000000000001'" "${MIG}" 2>/dev/null; then
    echo "PASS: dev-tenant UUID present (T-0077 §2.3 invariant)"
  else
    echo "FAIL: dev-tenant UUID a0000000-0000-0000-0000-000000000001 NOT found — resolveAgentToolset isolation violation" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- ARP-9: resource_ops declares both create AND update ops ------------
echo ""
echo "ARP-9: resource_ops declares both 'create' and 'update' operations"
if [[ -f "${MIG}" ]]; then
  HAS_CREATE=0
  HAS_UPDATE=0
  grep -v '^[[:space:]]*--' "${MIG}" | grep -q '"operation":"create"' 2>/dev/null && HAS_CREATE=1 || true
  grep -v '^[[:space:]]*--' "${MIG}" | grep -q '"operation":"update"' 2>/dev/null && HAS_UPDATE=1 || true
  if [[ ${HAS_CREATE} -eq 1 && ${HAS_UPDATE} -eq 1 ]]; then
    echo "PASS: both 'create' and 'update' operations present in resource_ops"
  else
    echo "FAIL: missing operation(s) in resource_ops — HAS_CREATE=${HAS_CREATE}, HAS_UPDATE=${HAS_UPDATE}" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- ARP-10: correct UUID namespace for tool and grant rows -------------
echo ""
echo "ARP-10: tool UUID 10...00b and grant UUIDs e2...008/e2...009 present"
if [[ -f "${MIG}" ]]; then
  ARP10_ERRORS=0
  if ! grep -q "'10000000-0000-0000-0000-00000000000b'" "${MIG}" 2>/dev/null; then
    echo "FAIL: mcp_tool UUID 10000000-0000-0000-0000-00000000000b NOT found" >&2
    ARP10_ERRORS=$((ARP10_ERRORS + 1))
  fi
  if ! grep -q "'e2000000-0000-0000-0000-000000000008'" "${MIG}" 2>/dev/null; then
    echo "FAIL: grant UUID e2000000-0000-0000-0000-000000000008 NOT found" >&2
    ARP10_ERRORS=$((ARP10_ERRORS + 1))
  fi
  if ! grep -q "'e2000000-0000-0000-0000-000000000009'" "${MIG}" 2>/dev/null; then
    echo "FAIL: grant UUID e2000000-0000-0000-0000-000000000009 NOT found" >&2
    ARP10_ERRORS=$((ARP10_ERRORS + 1))
  fi
  if [[ ${ARP10_ERRORS} -eq 0 ]]; then
    echo "PASS: all expected UUIDs present (no namespace collision with migration 044)"
  fi
  ERRORS=$((ERRORS + ARP10_ERRORS))
fi

# ---- Result ----------------------------------------------------------------
echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: author-report-page-seed found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: author-report-page-seed (T-0180) — all checks green [FF-SEED-T0180]"
exit 0
