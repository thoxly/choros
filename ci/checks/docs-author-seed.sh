#!/usr/bin/env bash
# T-0209 · P-1 — docs-author seed fitness check (docs-pipeline).
#
# Mirrors ci/checks/implementation-agent-seed.sh (T-0207) for the
# DocsAuthorAgent seed (migration 062).
#
# Check-1  (static):          migration 062_docs_author_seed.sql exists.
# Check-2  (idempotency):     every non-comment INSERT uses ON CONFLICT DO NOTHING.
# Check-3  (no new table):    no CREATE TABLE in non-comment lines (data-seed only).
# Check-4  (write-boundary):  migration contains 'doc_page' with both 'create' AND 'update'
#                             operations, and no 'delete' grant on doc_page.
# Check-5  (resource_type):   value 'doc_page' present in grant INSERT rows (correct resource_type).
# Check-6  (frozen-guard):    none of the frozen source files modified vs merge-base with dev
#                             (grant-lattice.ts, grant-resolver.ts, mcp-tool-registry.ts,
#                             audit-writer.ts — same list as config-agent-seed.sh; the
#                             two src/http route handlers were removed in T-0291, founder-sanctioned).
# Check-7  (known_tenant_tables untouched): ci/checks/known_tenant_tables.txt unchanged
#                             vs merge-base (pure seed adds no table).
# Check-8  (UUID collision guard): migration uses pinned UUIDs e0...005 / d0...015 /
#                             f0...004 / e2...018 / e2...019, and none of the prior
#                             migrations ≤061 use these UUIDs.
# Check-9  (delegable=false): no delegable=true on any grant INSERT line in non-comment code.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations/062_docs_author_seed.sql"
ERRORS=0

echo "[T-0209] docs-author-seed fitness check (P-1 docs-pipeline)"

# ---- Check-1: migration file exists ----------------------------------------
echo ""
echo "Check-1: 062_docs_author_seed.sql exists"
if [[ -f "${MIG}" ]]; then
  echo "PASS: ${MIG} exists"
else
  echo "FAIL: ${MIG} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-2: ON CONFLICT DO NOTHING on every INSERT (non-comment lines) ---
echo ""
echo "Check-2: migration 062 is idempotent (ON CONFLICT DO NOTHING)"
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

# ---- Check-3: no CREATE TABLE in migration 062 (non-comment lines) ---------
echo ""
echo "Check-3: no CREATE TABLE in migration 062 non-comment lines (data-seed only)"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bCREATE TABLE\b' 2>/dev/null; then
    echo "FAIL: CREATE TABLE found in non-comment code of migration 062 — must be data-seed only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no CREATE TABLE in migration 062 non-comment code"
  fi
fi

# ---- Check-4: write-boundary — doc_page create+update present, no delete ----
echo ""
echo "Check-4: write-boundary — doc_page 'create' + 'update' present, no 'delete' in non-comment lines"
if [[ -f "${MIG}" ]]; then
  CHECK4_ERRORS=0

  # Must have 'doc_page' with 'create'
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'doc_page'" 2>/dev/null \
     && grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'create'" 2>/dev/null; then
    echo "PASS: 'doc_page'/'create' found in non-comment code"
  else
    echo "FAIL: 'doc_page'/'create' NOT found in non-comment code of migration 062" >&2
    CHECK4_ERRORS=$((CHECK4_ERRORS + 1))
  fi

  # Must have 'doc_page' with 'update'
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'doc_page'" 2>/dev/null \
     && grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'update'" 2>/dev/null; then
    echo "PASS: 'doc_page'/'update' found in non-comment code"
  else
    echo "FAIL: 'doc_page'/'update' NOT found in non-comment code of migration 062" >&2
    CHECK4_ERRORS=$((CHECK4_ERRORS + 1))
  fi

  # Must NOT have a grant INSERT carrying doc_page + delete in non-comment lines
  # (look for lines containing both doc_page and delete outside comments)
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'doc_page'" 2>/dev/null \
     && grep -v '^[[:space:]]*--' "${MIG}" | grep "'doc_page'" | grep -q "'delete'" 2>/dev/null; then
    echo "FAIL: 'doc_page'/'delete' grant found in non-comment code — DRAFT-boundary violated" >&2
    CHECK4_ERRORS=$((CHECK4_ERRORS + 1))
  else
    echo "PASS: no 'doc_page'/'delete' grant in non-comment code (DRAFT-boundary intact)"
  fi

  ERRORS=$((ERRORS + CHECK4_ERRORS))
fi

# ---- Check-5: resource_type 'doc_page' present in grant INSERT rows --------
echo ""
echo "Check-5: resource_type 'doc_page' present in migration 062 non-comment lines"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'doc_page'" 2>/dev/null; then
    echo "PASS: 'doc_page' resource_type found in non-comment code"
  else
    echo "FAIL: 'doc_page' resource_type NOT found in migration 062 non-comment code" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-6: frozen files unmodified vs merge-base with dev ----------------
echo ""
echo "Check-6: frozen files unmodified vs merge-base with dev"
BASE=$(git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
       || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
       || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
       || echo "")

# Seed-coupled core invariant: this seed migration promises it does not drift
# the grant algebra / resolver / tool-registry / audit-sink its rows depend on.
# (T-0291, founder-sanctioned) src/http/agents.ts & src/http/grants.ts removed —
# they are HTTP route handlers, not seed/catalog data; freezing them over-reached
# onto unrelated tasks' legitimate route edits (same self-scope class as Check-9).
FROZEN=(
  "src/core/grant-lattice.ts"
  "src/core/grant-resolver.ts"
  "src/core/mcp-tool-registry.ts"
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

# ---- Check-7: known_tenant_tables.txt unchanged vs merge-base ---------------
echo ""
echo "Check-7: ci/checks/known_tenant_tables.txt unchanged vs merge-base (pure seed adds no table)"
if [[ -z "${BASE:-}" ]]; then
  echo "WARN: cannot determine merge-base; skipping known_tenant_tables check"
else
  TABLES_CHANGED=$(git -C "${ROOT}" diff --name-only "${BASE}" -- \
    "ci/checks/known_tenant_tables.txt" 2>/dev/null || true)
  if [[ -n "${TABLES_CHANGED}" ]]; then
    echo "FAIL: ci/checks/known_tenant_tables.txt was modified — T-0209 P-1 must add no table" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: ci/checks/known_tenant_tables.txt unmodified (NF-1 pure seed)"
  fi
fi

# T-0241: additive-superset relief — if known_tenant_tables.txt only GREW
# (another task legitimately added a tenant table), T-0209 P-1's real
# invariant (pure seed, no new table) is NOT violated. Cancel the false-red.
# Real guard: Check-3 above catches any CREATE TABLE in migration 062.
_ktt_das_grown=0
_ktt_das_path=ci/checks/known_tenant_tables.txt
if [[ -n "${BASE:-}" ]] && git -C "${ROOT}" diff --name-only "${BASE}" -- "${_ktt_das_path}" 2>/dev/null | grep -qxF "${_ktt_das_path}"; then
  _ktt_das_old="$(git -C "${ROOT}" show "${BASE}:${_ktt_das_path}" 2>/dev/null || true)"
  _ktt_das_new="$(cat "${ROOT}/${_ktt_das_path}" 2>/dev/null || true)"
  _ktt_das_gone="$(comm -23 <(echo "${_ktt_das_old}" | sort) <(echo "${_ktt_das_new}" | sort) || true)"
  [[ -z "${_ktt_das_gone}" ]] && _ktt_das_grown=1
fi
if [[ "${_ktt_das_grown}" -eq 1 ]]; then
  echo "PASS [Check-7-additive]: known_tenant_tables.txt grew (superset); another task's table add accepted for T-0209"
  ERRORS=$((ERRORS - 1))
fi

# ---- Check-8: pinned UUIDs present and no prior-migration collision ---------
echo ""
echo "Check-8: pinned UUIDs present in migration 062 + no collision with migrations ≤061"
if [[ -f "${MIG}" ]]; then
  CHECK8_ERRORS=0

  EXPECTED_UUIDS=(
    "e0000000-0000-0000-0000-000000000005"
    "d0000000-0000-0000-0000-000000000015"
    "f0000000-0000-0000-0000-000000000004"
    "e2000000-0000-0000-0000-000000000018"
    "e2000000-0000-0000-0000-000000000019"
  )
  for UUID in "${EXPECTED_UUIDS[@]}"; do
    if grep -q "${UUID}" "${MIG}" 2>/dev/null; then
      echo "PASS: pinned UUID ${UUID} present in migration 062"
    else
      echo "FAIL: pinned UUID ${UUID} NOT found in migration 062" >&2
      CHECK8_ERRORS=$((CHECK8_ERRORS + 1))
    fi
  done

  # Collision guard: none of these UUIDs should appear in migrations ≤061
  PRIOR_MIGS=$(find "${ROOT}/migrations" -maxdepth 1 -name '0[0-5][0-9]_*.sql' -o \
                                          -name '06[01]_*.sql' 2>/dev/null | sort)
  for UUID in "${EXPECTED_UUIDS[@]}"; do
    COLLISION=$(echo "${PRIOR_MIGS}" | xargs grep -l "${UUID}" 2>/dev/null || true)
    if [[ -n "${COLLISION}" ]]; then
      echo "FAIL: UUID ${UUID} appears in prior migration(s): ${COLLISION} — collision!" >&2
      CHECK8_ERRORS=$((CHECK8_ERRORS + 1))
    else
      echo "PASS: UUID ${UUID} not in any prior migration (≤061)"
    fi
  done

  ERRORS=$((ERRORS + CHECK8_ERRORS))
fi

# ---- Check-9: no delegable=true on any grant INSERT (non-comment lines) ----
echo ""
echo "Check-9: no delegable=true in migration 062 non-comment lines (structural DRAFT-boundary)"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bdelegable\b.*true|true.*\bdelegable\b' 2>/dev/null; then
    echo "FAIL: delegable=true found in non-comment code of migration 062 — boundary violated" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: no delegable=true in migration 062 non-comment code"
  fi
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: docs-author-seed found ${ERRORS} violation(s) (T-0209 P-1)"
  exit 1
fi
echo "PASS: docs-author-seed (T-0209 P-1) — all checks green"
exit 0
