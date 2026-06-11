#!/usr/bin/env bash
# T-0077 · config-agent-seed fitness check (E11.6).
#
# Check-1 (static): migration 044_config_agent_seed.sql exists.
# Check-2 (static): migration 044 contains all 7 required mcp_tool names.
# Check-3 (idempotency): migration 044 uses ON CONFLICT DO NOTHING on every INSERT.
# Check-4 (DRAFT-boundary): no 'authoring_published' string in migration 044.
# Check-5 (pure_compute): all tool inserts have pure_compute=true.
# Check-6 (frozen-guard): none of the frozen files are modified vs merge-base with dev.
# Check-7 (no new table): migration 044 contains no CREATE TABLE.
# Check-8 (resource_ops camelCase): resource_ops uses "resourceType" camelCase key.
# Check-9 (no new src/ .ts files): only __tests__ additions in src/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/044_config_agent_seed.sql"
ERRORS=0

echo "[T-0077] config-agent-seed fitness check"

# ---- Check-1: migration file exists ----------------------------------------
echo ""
echo "Check-1: 044_config_agent_seed.sql exists"
if [[ -f "${MIG}" ]]; then
  echo "PASS: ${MIG} exists"
else
  echo "FAIL: ${MIG} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-2: all 7 mcp_tool names present ---------------------------------
echo ""
echo "Check-2: all 7 mcp_tool names present in migration 044"
TOOLS=(
  emit_form_code
  edit_jsonschema
  author_dmn
  scaffold_external_worker
  write_object_migration
  open_draft_branch
  request_promote
)
if [[ -f "${MIG}" ]]; then
  for TOOL in "${TOOLS[@]}"; do
    if grep -q "'${TOOL}'" "${MIG}" 2>/dev/null || grep -q "\"${TOOL}\"" "${MIG}" 2>/dev/null; then
      echo "PASS: tool '${TOOL}' found"
    else
      echo "FAIL: tool '${TOOL}' NOT found in migration 044" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Check-3: ON CONFLICT DO NOTHING on every INSERT (non-comment lines) ---
echo ""
echo "Check-3: migration 044 is idempotent (ON CONFLICT DO NOTHING)"
if [[ -f "${MIG}" ]]; then
  # Exclude comment lines from counts
  INSERT_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c '\bINSERT\b' || true)
  OC_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c '\bON CONFLICT DO NOTHING\b' || true)
  if [[ "${INSERT_COUNT}" -gt 0 && "${OC_COUNT}" -ge "${INSERT_COUNT}" ]]; then
    echo "PASS: ${INSERT_COUNT} INSERT(s), ${OC_COUNT} ON CONFLICT DO NOTHING (idempotent)"
  else
    echo "FAIL: INSERT_COUNT=${INSERT_COUNT} but ON_CONFLICT_COUNT=${OC_COUNT} — not idempotent" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-4: no authoring_published in migration 044 (non-comment lines) --
echo ""
echo "Check-4: DRAFT-boundary — no 'authoring_published' in migration 044 non-comment lines"
if [[ -f "${MIG}" ]]; then
  # Exclude SQL comment lines (starting with --)
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q 'authoring_published' 2>/dev/null; then
    echo "FAIL: 'authoring_published' found in non-comment code of migration 044 — DRAFT-boundary violated" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no 'authoring_published' in migration 044 non-comment code"
  fi
fi

# ---- Check-5: pure_compute=true for all tool inserts -----------------------
echo ""
echo "Check-5: all mcp_tool inserts have pure_compute=true (CHECK constraint)"
if [[ -f "${MIG}" ]]; then
  if grep -q 'pure_compute.*false' "${MIG}" 2>/dev/null; then
    echo "FAIL: found pure_compute=false in migration 044" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no pure_compute=false in migration 044"
  fi
fi

# ---- Check-6: frozen files unmodified vs merge-base ------------------------
echo ""
echo "Check-6: frozen files unmodified vs merge-base with dev"
BASE=$(git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
       || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
       || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
       || echo "")

FROZEN=(
  "src/core/grant-lattice.ts"
  "src/core/grant-resolver.ts"
  "src/core/mcp-tool-registry.ts"
  "src/http/agents.ts"
  "src/http/grants.ts"
  "src/db/audit-writer.ts"
)

if [[ -z "${BASE}" ]]; then
  echo "WARN: cannot determine merge-base; skipping frozen-file check"
else
  for F in "${FROZEN[@]}"; do
    CHANGED=$(git -C "${ROOT}" diff --name-only "${BASE}" -- "${F}" 2>/dev/null || true)
    if [[ -n "${CHANGED}" ]]; then
      echo "FAIL: frozen file ${F} was modified" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS: ${F} unmodified"
    fi
  done
fi

# ---- Check-7: no CREATE TABLE in migration 044 (non-comment lines) ---------
echo ""
echo "Check-7: no CREATE TABLE in migration 044 non-comment lines (data-seed only)"
if [[ -f "${MIG}" ]]; then
  # Exclude SQL comment lines (starting with --)
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bCREATE TABLE\b' 2>/dev/null; then
    echo "FAIL: CREATE TABLE found in non-comment code of migration 044 — must be data-seed only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no CREATE TABLE in migration 044 non-comment code"
  fi
fi

# ---- Check-8: resource_ops uses camelCase "resourceType" -------------------
echo ""
echo "Check-8: resource_ops uses camelCase \"resourceType\" key"
if [[ -f "${MIG}" ]]; then
  if grep -q '"resourceType"' "${MIG}" 2>/dev/null; then
    echo "PASS: camelCase \"resourceType\" key found"
  else
    echo "FAIL: \"resourceType\" key NOT found in migration 044 resource_ops" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-9: no new .ts files in src/ (excluding __tests__) ---------------
echo ""
echo "Check-9: no new .ts files in src/ (except __tests__)"
if [[ -z "${BASE}" ]]; then
  echo "WARN: cannot determine merge-base; skipping src/ new-file check"
else
  NEW_SRC=$(git -C "${ROOT}" diff --name-only --diff-filter=A "${BASE}" -- 'src/**/*.ts' 2>/dev/null \
    | grep -v '__tests__' || true)
  if [[ -n "${NEW_SRC}" ]]; then
    echo "FAIL: new .ts file(s) in src/ (not __tests__): ${NEW_SRC}" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no new .ts files in src/ outside __tests__"
  fi
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: config-agent-seed found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: config-agent-seed — all checks green"
exit 0
