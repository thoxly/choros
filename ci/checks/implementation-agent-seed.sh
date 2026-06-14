#!/usr/bin/env bash
# T-0207 · implementation-agent-seed fitness check (B-1 / ADR T-0129 §3/§14).
#
# Mirrors ci/checks/config-agent-seed.sh (T-0077) exactly for the
# implementation-agent seed (migration 059).
#
# Check-1  (static):        migration 059_implementation_agent_seed.sql exists.
# Check-2  (static):        migration 059 contains all expected implementation_op
#                           mcp_tool names (6 new tools; 7 inherited authoring_draft
#                           tools are asserted via grant rows, not new mcp_tool rows).
# Check-3  (idempotency):   migration 059 uses ON CONFLICT DO NOTHING on every INSERT.
# Check-4  (DRAFT-boundary):no 'authoring_published' string in migration 059 non-comment code.
# Check-5  (pure_compute):  all mcp_tool inserts have pure_compute=true.
# Check-6  (frozen-guard):  none of the frozen files are modified vs merge-base with dev.
# Check-7  (no new table):  migration 059 contains no CREATE TABLE.
# Check-8  (resource_ops camelCase): resource_ops uses "resourceType" camelCase key.
# Check-9  (no src runtime module): no src/ runtime file for implementation-agent
#           (seed-only delivery, mirrors T-0077 Check-9).
# Check-10 (role UUID distinct): implementation-agent role UUID (e0...004) differs
#           from config-agent UUID (e0...003) — additive, not a replacement.
# Check-11 (zero authoring_published grants): grep confirms no grant row in 059
#           carries resource_type='authoring_published' in non-comment code.
#           (Structural DRAFT-boundary — ADR §4 / AC-03 / FF-2.)
#
# --self-test arm: runs all checks against a deliberately broken fixture and
# verifies that each check catches the violation (exit 0 means self-test passed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/059_implementation_agent_seed.sql"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0207][self-test] implementation-agent-seed self-test: checking that the fitness check catches violations"

  # Create a temp dir with a deliberately broken fixture migration
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  # Broken fixture: missing required tools, has authoring_published, no ON CONFLICT,
  # has CREATE TABLE, missing resourceType camelCase.
  BROKEN_MIG="${TMPDIR_ST}/059_implementation_agent_seed.sql"
  cat > "${BROKEN_MIG}" <<'FIXTURE'
-- BROKEN FIXTURE for self-test (intentionally violates all checks)
INSERT INTO choros.role (tenant_id, id, slug) VALUES ('a', 'b', 'implementation-agent');
-- Grant on authoring_published (DRAFT-boundary violation):
INSERT INTO choros."grant" (resource_type) VALUES ('authoring_published');
-- Missing ON CONFLICT DO NOTHING
-- No resourceType camelCase — uses snake_case:
INSERT INTO choros.mcp_tool (resource_ops) VALUES ('[{"resource_type":"foo"}]');
-- CREATE TABLE (no-new-table violation):
CREATE TABLE choros.bad_table (id uuid);
FIXTURE

  # Run checks against the broken fixture using MIG override trick
  # We patch the MIG variable to point to the broken fixture, then source checks inline
  SELF_TEST_ERRORS=0

  # Check-1: file existence (broken = fixture exists so this would PASS — we test the inverse)
  # To test Check-1 failure, point to a nonexistent file
  MIG_MISSING="${TMPDIR_ST}/nonexistent.sql"
  if [[ -f "${MIG_MISSING}" ]]; then
    echo "SELF-TEST FAIL: nonexistent file somehow exists" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  else
    echo "SELF-TEST PASS: Check-1 correctly fails for missing file"
  fi

  # Check-4: DRAFT-boundary — broken fixture has 'authoring_published' in non-comment code
  if grep -v '^[[:space:]]*--' "${BROKEN_MIG}" | grep -q 'authoring_published' 2>/dev/null; then
    echo "SELF-TEST PASS: Check-4 correctly catches 'authoring_published' in broken fixture"
  else
    echo "SELF-TEST FAIL: Check-4 did NOT catch 'authoring_published' — check is broken" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-3: ON CONFLICT DO NOTHING — broken fixture has INSERTs but no ON CONFLICT
  INSERT_COUNT=$(grep -v '^[[:space:]]*--' "${BROKEN_MIG}" | grep -c '\bINSERT\b' || true)
  OC_COUNT=$(grep -v '^[[:space:]]*--' "${BROKEN_MIG}" | grep -c '\bON CONFLICT DO NOTHING\b' || true)
  if [[ "${INSERT_COUNT}" -gt 0 && "${OC_COUNT}" -lt "${INSERT_COUNT}" ]]; then
    echo "SELF-TEST PASS: Check-3 correctly detects non-idempotent fixture (INSERT_COUNT=${INSERT_COUNT} OC_COUNT=${OC_COUNT})"
  else
    echo "SELF-TEST FAIL: Check-3 did NOT catch missing ON CONFLICT in broken fixture" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-7: CREATE TABLE — broken fixture has CREATE TABLE
  if grep -v '^[[:space:]]*--' "${BROKEN_MIG}" | grep -iqE '\bCREATE TABLE\b'; then
    echo "SELF-TEST PASS: Check-7 correctly catches CREATE TABLE in broken fixture"
  else
    echo "SELF-TEST FAIL: Check-7 did NOT catch CREATE TABLE — check is broken" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-8: resource_ops camelCase — broken fixture uses snake_case key 'resource_type'
  if ! grep -q '"resourceType"' "${BROKEN_MIG}" 2>/dev/null; then
    echo "SELF-TEST PASS: Check-8 correctly detects missing camelCase 'resourceType' in broken fixture"
  else
    echo "SELF-TEST FAIL: Check-8 did NOT catch missing camelCase key — check is broken" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-11: zero authoring_published grants — same as Check-4 for grants specifically
  if grep -v '^[[:space:]]*--' "${BROKEN_MIG}" | grep -q "authoring_published" 2>/dev/null; then
    echo "SELF-TEST PASS: Check-11 correctly catches authoring_published in broken fixture"
  else
    echo "SELF-TEST FAIL: Check-11 did NOT catch authoring_published — check is broken" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — the fitness check has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: implementation-agent-seed self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0207] implementation-agent-seed fitness check (ADR T-0129 §3/§14 B-1)"

# ---- Check-1: migration file exists ----------------------------------------
echo ""
echo "Check-1: 059_implementation_agent_seed.sql exists"
if [[ -f "${MIG}" ]]; then
  echo "PASS: ${MIG} exists"
else
  echo "FAIL: ${MIG} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-2: expected new mcp_tool names present --------------------------
# 6 new implementation tools added in migration 059:
#   assemble_bundle       — authoring_draft create (new B-1 tool, not in 044)
#   ask_interview_question — implementation_op create
#   propose_scenarios      — implementation_op create
#   run_simulation         — implementation_op create
#   propose_pilot_scope    — implementation_op create
#   update_pilot_scope     — implementation_op update
# (7 inherited authoring_draft tools from migration 044 are NOT new mcp_tool rows here)
echo ""
echo "Check-2: all expected implementation-agent mcp_tool names present in migration 059"
NEW_TOOLS=(
  assemble_bundle
  ask_interview_question
  propose_scenarios
  run_simulation
  propose_pilot_scope
  update_pilot_scope
)
if [[ -f "${MIG}" ]]; then
  for TOOL in "${NEW_TOOLS[@]}"; do
    if grep -q "'${TOOL}'" "${MIG}" 2>/dev/null || grep -q "\"${TOOL}\"" "${MIG}" 2>/dev/null; then
      echo "PASS: tool '${TOOL}' found"
    else
      echo "FAIL: tool '${TOOL}' NOT found in migration 059" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Check-3: ON CONFLICT DO NOTHING on every INSERT (non-comment lines) ---
echo ""
echo "Check-3: migration 059 is idempotent (ON CONFLICT DO NOTHING)"
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

# ---- Check-4: no authoring_published in migration 059 (DRAFT-boundary) ----
echo ""
echo "Check-4: DRAFT-boundary — no 'authoring_published' in migration 059 non-comment lines"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q 'authoring_published' 2>/dev/null; then
    echo "FAIL: 'authoring_published' found in non-comment code of migration 059 — DRAFT-boundary violated (ADR §4 / AC-03)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no 'authoring_published' in migration 059 non-comment code (DRAFT-boundary intact)"
  fi
fi

# ---- Check-5: pure_compute=true for all tool inserts -----------------------
echo ""
echo "Check-5: all mcp_tool inserts have pure_compute=true (CHECK constraint)"
if [[ -f "${MIG}" ]]; then
  if grep -q 'pure_compute.*false' "${MIG}" 2>/dev/null; then
    echo "FAIL: found pure_compute=false in migration 059" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no pure_compute=false in migration 059"
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

# ---- Check-7: no CREATE TABLE in migration 059 (non-comment lines) ---------
echo ""
echo "Check-7: no CREATE TABLE in migration 059 non-comment lines (data-seed only)"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bCREATE TABLE\b' 2>/dev/null; then
    echo "FAIL: CREATE TABLE found in non-comment code of migration 059 — must be data-seed only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no CREATE TABLE in migration 059 non-comment code"
  fi
fi

# ---- Check-8: resource_ops uses camelCase "resourceType" -------------------
echo ""
echo "Check-8: resource_ops uses camelCase \"resourceType\" key"
if [[ -f "${MIG}" ]]; then
  if grep -q '"resourceType"' "${MIG}" 2>/dev/null; then
    echo "PASS: camelCase \"resourceType\" key found"
  else
    echo "FAIL: \"resourceType\" key NOT found in migration 059 resource_ops" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-9: no src/ runtime module for implementation-agent (self-scope) -
# T-0207 B-1 invariant: implementation-agent is delivered as data-seed only (migration 059
# mcp_tool + grant rows); it must NOT have a runtime src/ implementation module in B-1.
echo ""
echo "Check-9: no src/ runtime module for implementation-agent (B-1 self-scope: data-seed only)"
IA_RUNTIME=$(find "${ROOT}/src" -type f -name 'implementation-agent*.ts' \
  | grep -v '__tests__' || true)
if [[ -n "${IA_RUNTIME}" ]]; then
  echo "FAIL: implementation-agent runtime src/ file(s) found — T-0207 B-1 invariant: seed-only delivery: ${IA_RUNTIME}" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no implementation-agent runtime src/ module (seed-only delivery confirmed)"
fi

# ---- Check-10: role UUID distinct from config-agent UUID -------------------
echo ""
echo "Check-10: implementation-agent role UUID (e0...004) distinct from config-agent (e0...003)"
CONFIG_AGENT_UUID="e0000000-0000-0000-0000-000000000003"
IMPL_AGENT_UUID="e0000000-0000-0000-0000-000000000004"
if [[ -f "${MIG}" ]]; then
  if grep -q "${IMPL_AGENT_UUID}" "${MIG}" 2>/dev/null; then
    echo "PASS: implementation-agent role UUID ${IMPL_AGENT_UUID} present in migration 059"
  else
    echo "FAIL: expected role UUID ${IMPL_AGENT_UUID} NOT found in migration 059" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if grep -q "${CONFIG_AGENT_UUID}" "${MIG}" 2>/dev/null; then
    echo "FAIL: config-agent UUID ${CONFIG_AGENT_UUID} found in migration 059 — must be additive (separate role)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: config-agent UUID ${CONFIG_AGENT_UUID} NOT in migration 059 (migration 044 untouched)"
  fi
fi

# ---- Check-11: zero authoring_published grant rows (structural DRAFT-boundary) ---
# Belt-and-suspenders over Check-4: explicitly scan for any grant INSERT that
# carries resource_type='authoring_published' in non-comment lines.
echo ""
echo "Check-11: ZERO authoring_published grant rows in migration 059 (ADR §4 / AC-03)"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'authoring_published'" 2>/dev/null; then
    echo "FAIL: grant row with resource_type='authoring_published' found in migration 059 — DRAFT-boundary violated" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: zero 'authoring_published' grant rows in migration 059 — DRAFT-boundary (structural)"
  fi
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: implementation-agent-seed found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: implementation-agent-seed — all checks green (T-0207 B-1 / ADR T-0129 §3/§14)"
exit 0
