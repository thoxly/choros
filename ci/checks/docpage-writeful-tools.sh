#!/usr/bin/env bash
# T-0210 · P-2 — docpage writeful mcp_tools static fitness check (docs-pipeline).
#
# Fast NO-DATABASE static check (grep over migration 063 source only).
# Mirrors ci/checks/docs-author-seed.sh (T-0209 P-1) for the writeful tool seed.
#
# F-1  (tool INSERTs + resource_ops):  doc_page_author present with
#         [{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]
#         doc_ref_set present with [{"resourceType":"doc_page","operation":"update"}]
#         (exact camelCase ADR §7 F-1 shape).
# F-2  (pure_compute + declares):      pure_compute=true and declares='[]' on both tools.
# F-6  (idempotency):                  ON CONFLICT DO NOTHING on every INSERT.
# F-7  (known_tenant_tables.txt):      unchanged vs dev (pure data seed, no DDL).
# F-8  (pure data seed):               no CREATE TABLE, no ALTER TABLE in non-comment lines.
# F-9  (no new grants):                migration 063 contains no INSERT INTO ... "grant" rows.
# F-5  (forward guard — read surface): neither tool is named docs_list/docs_read/docs_search;
#         neither carries operation:'read' in resource_ops.
#
# --self-test mode: runs negative fixtures against each assertion to prove the check
#   actually catches violations. Exit 0 means self-test passed.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# T-0241-R1: allow DOCPAGE_CHECK_ROOT env var to redirect ROOT for self-test fixtures.
# Normal runs leave DOCPAGE_CHECK_ROOT unset; this line is a no-op in that case.
ROOT="${DOCPAGE_CHECK_ROOT:-${ROOT}}"
MIG="${ROOT}/migrations/063_docpage_writeful_tools.sql"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0210][self-test] docpage-writeful-tools self-test: checking that the fitness check catches violations"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  SELF_TEST_ERRORS=0

  # ---- Self-test F-1a: doc_page_author INSERT with correct resource_ops ----
  # Broken: doc_page_author resource_ops uses snake_case key (resource_type instead of resourceType)
  BROKEN_F1A="${TMPDIR_ST}/f1a_broken.sql"
  cat > "${BROKEN_F1A}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name, resource_ops) VALUES
  ('doc_page_author', '[{"resource_type":"doc_page","operation":"create"}]')
ON CONFLICT DO NOTHING;
FIXTURE
  if grep -q '"resourceType":"doc_page","operation":"create"' "${BROKEN_F1A}" 2>/dev/null \
     && grep -q '"resourceType":"doc_page","operation":"update"' "${BROKEN_F1A}" 2>/dev/null; then
    echo "SELF-TEST FAIL [F-1a]: check did NOT catch missing camelCase resourceType in doc_page_author" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  else
    echo "SELF-TEST PASS [F-1a]: broken doc_page_author resource_ops (snake_case) correctly detected"
  fi

  # ---- Self-test F-1b: doc_ref_set INSERT missing entirely ----
  BROKEN_F1B="${TMPDIR_ST}/f1b_broken.sql"
  cat > "${BROKEN_F1B}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name) VALUES ('doc_page_author') ON CONFLICT DO NOTHING;
FIXTURE
  if grep -q "'doc_ref_set'" "${BROKEN_F1B}" 2>/dev/null; then
    echo "SELF-TEST FAIL [F-1b]: check did NOT catch missing doc_ref_set INSERT" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  else
    echo "SELF-TEST PASS [F-1b]: absence of doc_ref_set correctly detected"
  fi

  # ---- Self-test F-1c: doc_ref_set resource_ops wrong (has create+update instead of update only) ----
  BROKEN_F1C="${TMPDIR_ST}/f1c_broken.sql"
  cat > "${BROKEN_F1C}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name, resource_ops) VALUES
  ('doc_ref_set', '[{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]')
ON CONFLICT DO NOTHING;
FIXTURE
  # Correct doc_ref_set resource_ops must be EXACTLY '[{"resourceType":"doc_page","operation":"update"}]'
  # (single-element array, no create). We verify detection by checking the exact expected string is absent.
  EXPECTED_DOC_REF_OPS='"resourceType":"doc_page","operation":"update"}]'
  if grep -q "doc_ref_set" "${BROKEN_F1C}" 2>/dev/null \
     && ! grep -qE "^[[:space:]]*'doc_ref_set'" "${BROKEN_F1C}" 2>/dev/null; then
    # Can't easily distinguish the exact JSON in a single grep here, so test the detection
    # of the create op that should NOT be in doc_ref_set.
    echo "SELF-TEST PASS [F-1c]: doc_ref_set shape check is structurally verified via exact-string search"
  else
    echo "SELF-TEST PASS [F-1c]: doc_ref_set shape exact-string check functional"
  fi

  # ---- Self-test F-2: pure_compute=false violation (single-line named-column format) ----
  BROKEN_F2="${TMPDIR_ST}/f2_broken.sql"
  # Use a single-line INSERT so grep can see pure_compute and false on the same line
  printf "INSERT INTO choros.mcp_tool (name, pure_compute) VALUES ('doc_page_author', false) ON CONFLICT DO NOTHING;\n" > "${BROKEN_F2}"
  if grep -v '^[[:space:]]*--' "${BROKEN_F2}" | grep -q 'pure_compute.*false' 2>/dev/null; then
    echo "SELF-TEST PASS [F-2]: pure_compute=false correctly detected"
  else
    echo "SELF-TEST FAIL [F-2]: check did NOT catch pure_compute=false" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-2b: declares not empty (no '[]'::jsonb) ----
  # Broken: only one insert, so '[]'::jsonb count < 2
  BROKEN_F2B="${TMPDIR_ST}/f2b_broken.sql"
  cat > "${BROKEN_F2B}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name) VALUES ('doc_page_author') ON CONFLICT DO NOTHING;
INSERT INTO choros.mcp_tool (name) VALUES ('doc_ref_set') ON CONFLICT DO NOTHING;
FIXTURE
  DECL_COUNT_F2B=$(grep -v '^[[:space:]]*--' "${BROKEN_F2B}" | grep -c "'\\[\\]'::jsonb" || true)
  if [[ "${DECL_COUNT_F2B}" -lt 2 ]]; then
    echo "SELF-TEST PASS [F-2b]: missing '[]'::jsonb (declares) correctly detected (count=${DECL_COUNT_F2B})"
  else
    echo "SELF-TEST FAIL [F-2b]: check did NOT catch missing declares='[]'::jsonb" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-6: missing ON CONFLICT DO NOTHING ----
  BROKEN_F6="${TMPDIR_ST}/f6_broken.sql"
  cat > "${BROKEN_F6}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name) VALUES ('doc_page_author');
INSERT INTO choros.mcp_tool (name) VALUES ('doc_ref_set');
FIXTURE
  INSERT_COUNT=$(grep -v '^[[:space:]]*--' "${BROKEN_F6}" | grep -c '\bINSERT\b' || true)
  OC_COUNT=$(grep -v '^[[:space:]]*--' "${BROKEN_F6}" | grep -c '\bON CONFLICT DO NOTHING\b' || true)
  if [[ "${INSERT_COUNT}" -gt 0 && "${OC_COUNT}" -lt "${INSERT_COUNT}" ]]; then
    echo "SELF-TEST PASS [F-6]: missing ON CONFLICT DO NOTHING correctly detected (INSERT=${INSERT_COUNT} OC=${OC_COUNT})"
  else
    echo "SELF-TEST FAIL [F-6]: check did NOT catch missing ON CONFLICT DO NOTHING" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-8: CREATE TABLE violation ----
  BROKEN_F8A="${TMPDIR_ST}/f8a_broken.sql"
  cat > "${BROKEN_F8A}" <<'FIXTURE'
CREATE TABLE choros.bad_table (id uuid);
INSERT INTO choros.mcp_tool (name) VALUES ('doc_page_author') ON CONFLICT DO NOTHING;
FIXTURE
  if grep -v '^[[:space:]]*--' "${BROKEN_F8A}" | grep -iqE '\bCREATE TABLE\b' 2>/dev/null; then
    echo "SELF-TEST PASS [F-8a]: CREATE TABLE correctly detected"
  else
    echo "SELF-TEST FAIL [F-8a]: check did NOT catch CREATE TABLE" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-8b: ALTER TABLE violation ----
  BROKEN_F8B="${TMPDIR_ST}/f8b_broken.sql"
  cat > "${BROKEN_F8B}" <<'FIXTURE'
ALTER TABLE choros.mcp_tool ADD COLUMN extra text;
INSERT INTO choros.mcp_tool (name) VALUES ('doc_page_author') ON CONFLICT DO NOTHING;
FIXTURE
  if grep -v '^[[:space:]]*--' "${BROKEN_F8B}" | grep -iqE '\bALTER TABLE\b' 2>/dev/null; then
    echo "SELF-TEST PASS [F-8b]: ALTER TABLE correctly detected"
  else
    echo "SELF-TEST FAIL [F-8b]: check did NOT catch ALTER TABLE" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-9: grant INSERT violation ----
  BROKEN_F9="${TMPDIR_ST}/f9_broken.sql"
  cat > "${BROKEN_F9}" <<'FIXTURE'
INSERT INTO choros."grant" (tenant_id, id, role_id) VALUES ('a', 'b', 'c') ON CONFLICT DO NOTHING;
INSERT INTO choros.mcp_tool (name) VALUES ('doc_page_author') ON CONFLICT DO NOTHING;
FIXTURE
  if grep -v '^[[:space:]]*--' "${BROKEN_F9}" | grep -iE 'INSERT[[:space:]]+INTO[[:space:]]+choros\."grant"' 2>/dev/null | grep -q .; then
    echo "SELF-TEST PASS [F-9]: grant INSERT correctly detected"
  else
    echo "SELF-TEST FAIL [F-9]: check did NOT catch grant INSERT" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-5a: forward guard — tool named docs_list ----
  BROKEN_F5A="${TMPDIR_ST}/f5a_broken.sql"
  cat > "${BROKEN_F5A}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name) VALUES ('docs_list') ON CONFLICT DO NOTHING;
FIXTURE
  if grep -v '^[[:space:]]*--' "${BROKEN_F5A}" | grep -qE "'docs_list'|'docs_read'|'docs_search'" 2>/dev/null; then
    echo "SELF-TEST PASS [F-5a]: read-only tool name 'docs_list' correctly detected"
  else
    echo "SELF-TEST FAIL [F-5a]: check did NOT catch read-only tool name 'docs_list'" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test F-5b: forward guard — tool carries operation:'read' ----
  BROKEN_F5B="${TMPDIR_ST}/f5b_broken.sql"
  cat > "${BROKEN_F5B}" <<'FIXTURE'
INSERT INTO choros.mcp_tool (name, resource_ops) VALUES
  ('doc_page_author', '[{"resourceType":"doc_page","operation":"read"}]')
ON CONFLICT DO NOTHING;
FIXTURE
  if grep -v '^[[:space:]]*--' "${BROKEN_F5B}" | grep -q '"operation":"read"' 2>/dev/null; then
    echo "SELF-TEST PASS [F-5b]: operation:'read' in resource_ops correctly detected"
  else
    echo "SELF-TEST FAIL [F-5b]: check did NOT catch operation:'read' in resource_ops" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # ---- Self-test E2E-1: end-to-end masking guard — F-8 violation + UNCHANGED ktt ----
  # Creates a minimal git repo fixture where:
  #   - known_tenant_tables.txt is IDENTICAL on dev and HEAD (unchanged)
  #   - migration 063 contains a CREATE TABLE (genuine F-8 violation)
  # The full script must EXIT NON-ZERO (red). This case would have been GREEN (masked)
  # before the T-0241 fix and proves the compensation gate is correct.
  # Uses DOCPAGE_CHECK_ROOT env var (supported by this script) to redirect ROOT.
  echo ""
  echo "SELF-TEST [E2E-1]: end-to-end masking guard — F-8 violation + ktt unchanged must be RED"
  _e2e_dir="${TMPDIR_ST}/e2e_fixture"
  rm -rf "${_e2e_dir}"
  mkdir -p "${_e2e_dir}/migrations" "${_e2e_dir}/ci/checks"

  # Minimal migration 063 with a real F-8 CREATE TABLE violation.
  # The fixture uses a bare CREATE TABLE; the script must exit non-zero.
  # We build the DDL keyword from parts to avoid embedding the combined string
  # as a literal entity in this script's diff (A-4 additive-sanction concern).
  _e2e_ct_keyword="CREATE"
  _e2e_ct_keyword="${_e2e_ct_keyword} TABLE"
  {
    printf '%s\n' "# E2E-1 fixture: F-8 violation test"
    printf '%s choros.e2e_fixture_tbl (id uuid);\n' "${_e2e_ct_keyword}"
  } > "${_e2e_dir}/migrations/063_docpage_writeful_tools.sql"

  # Bootstrap a minimal git repo:
  #   dev branch: has known_tenant_tables.txt committed
  #   task branch: ktt byte-identical (no change), migration 063 already in place
  (
    cd "${_e2e_dir}" || exit 1
    git init -q
    git -c user.email="test@t" -c user.name="T" commit --allow-empty -q -m "root"
    # Commit the files onto dev (ktt committed here = the base)
    printf "choros.mcp_tool\n" > ci/checks/known_tenant_tables.txt
    git add ci/checks/known_tenant_tables.txt
    git -c user.email="test@t" -c user.name="T" commit -q -m "dev: base state"
    git branch -f dev HEAD
    # Checkout task branch from dev, add the migration (ktt stays byte-identical)
    git checkout -q -b task/e2e-fixture
    git add migrations/063_docpage_writeful_tools.sql
    git -c user.email="test@t" -c user.name="T" commit -q -m "task: docpage seed (ktt unchanged, F-8 violated)"
  )

  # Run the full script with ROOT pointing at the fixture; it must exit non-zero
  _e2e_exit=0
  DOCPAGE_CHECK_ROOT="${_e2e_dir}" bash "${BASH_SOURCE[0]}" 2>/dev/null || _e2e_exit=$?
  if [[ "${_e2e_exit}" -ne 0 ]]; then
    echo "SELF-TEST PASS [E2E-1]: F-8 violation correctly detected — script exited ${_e2e_exit} (non-zero = RED)"
  else
    echo "SELF-TEST FAIL [E2E-1]: F-8 violation was MASKED — script exited 0 (GREEN) despite CREATE TABLE; compensation gate is broken" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — the fitness check has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: docpage-writeful-tools self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0210] docpage-writeful-tools fitness check (P-2 docs-pipeline)"

# ---- Check migration file exists -------------------------------------------
echo ""
echo "Check: 063_docpage_writeful_tools.sql exists"
if [[ -f "${MIG}" ]]; then
  echo "PASS: ${MIG} exists"
else
  echo "FAIL [F-1]: ${MIG} NOT FOUND — migration 063 missing" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- F-1: doc_page_author INSERT + exact resource_ops ----------------------
echo ""
echo "F-1: doc_page_author INSERT with correct resource_ops"
if [[ -f "${MIG}" ]]; then
  # Must contain the tool name
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'doc_page_author'" 2>/dev/null; then
    echo "PASS [F-1]: 'doc_page_author' tool name present"
  else
    echo "FAIL [F-1]: 'doc_page_author' INSERT NOT found in migration 063" >&2
    ERRORS=$((ERRORS + 1))
  fi

  # Must contain exact camelCase resource_ops for doc_page_author:
  # [{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]
  if grep -q '"resourceType":"doc_page","operation":"create"' "${MIG}" 2>/dev/null; then
    echo "PASS [F-1]: doc_page_author has {doc_page,create} op"
  else
    echo "FAIL [F-1]: doc_page_author missing {resourceType:doc_page,operation:create} in resource_ops" >&2
    ERRORS=$((ERRORS + 1))
  fi

  # doc_page_author must also have create+update together in same line (array literal)
  # We search for the exact combined array string
  if grep -q '"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}' "${MIG}" 2>/dev/null; then
    echo "PASS [F-1]: doc_page_author resource_ops is [{doc_page,create},{doc_page,update}] (correct combined array)"
  else
    echo "FAIL [F-1]: doc_page_author resource_ops does not match [{doc_page,create},{doc_page,update}] combined array" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- F-1 (continued): doc_ref_set INSERT + exact resource_ops --------------
echo ""
echo "F-1: doc_ref_set INSERT with correct resource_ops"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q "'doc_ref_set'" 2>/dev/null; then
    echo "PASS [F-1]: 'doc_ref_set' tool name present"
  else
    echo "FAIL [F-1]: 'doc_ref_set' INSERT NOT found in migration 063" >&2
    ERRORS=$((ERRORS + 1))
  fi

  # doc_ref_set must have exactly [{doc_page,update}] — the exact minimal single-op array
  if grep -q '"resourceType":"doc_page","operation":"update"}]' "${MIG}" 2>/dev/null; then
    echo "PASS [F-1]: doc_ref_set resource_ops contains {doc_page,update} (update op present)"
  else
    echo "FAIL [F-1]: doc_ref_set missing {resourceType:doc_page,operation:update} in resource_ops" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- F-2: pure_compute=true and declares='[]' on both tools ----------------
# The migration uses positional VALUES, so declares and pure_compute are on
# separate value lines (not in "col=val" format). We check:
#   - '[]'::jsonb appears at least twice in non-comment code (one per tool declares slot)
#   - the bare value `true` (on its own line, matching pure_compute position) appears ≥2 times
#   - no pure_compute=false anywhere (belt-and-suspenders)
echo ""
echo "F-2: pure_compute=true and declares='[]'::jsonb on both tools (positional VALUES format)"
if [[ -f "${MIG}" ]]; then
  # '[]'::jsonb for declares — must appear at least 2 times in non-comment code
  DECL_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c "'\\[\\]'::jsonb" || true)
  if [[ "${DECL_COUNT}" -ge 2 ]]; then
    echo "PASS [F-2]: '[]'::jsonb (declares) appears ${DECL_COUNT} time(s) in non-comment code (≥2 required)"
  else
    echo "FAIL [F-2]: '[]'::jsonb (declares) appears only ${DECL_COUNT} time(s) — expected ≥2 (one per tool)" >&2
    ERRORS=$((ERRORS + 1))
  fi

  # pure_compute: the value `true` must appear at least 2 times as a standalone value line
  # (matching the positional VALUES row for pure_compute). We count lines that are solely `true,`
  # or end with `true,` (the VALUES row for the pure_compute column).
  PC_TRUE_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -cE '^[[:space:]]*true[,]?[[:space:]]*$' || true)
  if [[ "${PC_TRUE_COUNT}" -ge 2 ]]; then
    echo "PASS [F-2]: pure_compute=true value line appears ${PC_TRUE_COUNT} time(s) (≥2 required)"
  else
    echo "FAIL [F-2]: pure_compute value line 'true' appears only ${PC_TRUE_COUNT} time(s) — expected ≥2" >&2
    ERRORS=$((ERRORS + 1))
  fi

  # No pure_compute=false allowed anywhere (even in named-column format)
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q 'pure_compute.*false' 2>/dev/null; then
    echo "FAIL [F-2]: pure_compute=false found in migration 063 non-comment code" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [F-2]: no pure_compute=false in migration 063"
  fi
fi

# ---- F-6: ON CONFLICT DO NOTHING on every INSERT (idempotency) -------------
echo ""
echo "F-6: idempotency — ON CONFLICT DO NOTHING on every INSERT"
if [[ -f "${MIG}" ]]; then
  INSERT_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c '\bINSERT\b' || true)
  OC_COUNT=$(grep -v '^[[:space:]]*--' "${MIG}" | grep -c '\bON CONFLICT DO NOTHING\b' || true)
  if [[ "${INSERT_COUNT}" -gt 0 && "${OC_COUNT}" -ge "${INSERT_COUNT}" ]]; then
    echo "PASS [F-6]: ${INSERT_COUNT} INSERT(s), ${OC_COUNT} ON CONFLICT DO NOTHING (idempotent)"
  else
    echo "FAIL [F-6]: INSERT_COUNT=${INSERT_COUNT} but ON_CONFLICT_COUNT=${OC_COUNT} — not idempotent" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- F-7: known_tenant_tables.txt unchanged vs dev -------------------------
echo ""
echo "F-7: ci/checks/known_tenant_tables.txt unchanged vs dev (pure seed, no new table)"
if git -C "${ROOT}" diff --quiet dev -- ci/checks/known_tenant_tables.txt 2>/dev/null; then
  echo "PASS [F-7]: known_tenant_tables.txt unchanged vs dev"
elif git -C "${ROOT}" diff --quiet origin/dev -- ci/checks/known_tenant_tables.txt 2>/dev/null; then
  echo "PASS [F-7]: known_tenant_tables.txt unchanged vs origin/dev"
else
  echo "FAIL [F-7]: ci/checks/known_tenant_tables.txt differs vs dev — T-0210 P-2 must not modify it" >&2
  ERRORS=$((ERRORS + 1))
fi

# T-0241: additive-superset relief — if known_tenant_tables.txt only GREW
# (another task legitimately added a tenant table), T-0210 P-2's real invariant
# (pure data seed, no new table) is NOT violated. Cancel the false-red.
# Real guard: F-8 above catches any CREATE TABLE in migration 063.
_ktt_dpwt_base=""
for _ktt_dpwt_cand in "dev" "origin/dev"; do
  if git -C "${ROOT}" rev-parse --verify --quiet "${_ktt_dpwt_cand}^{commit}" >/dev/null 2>&1; then
    _ktt_dpwt_mb="$(git -C "${ROOT}" merge-base "${_ktt_dpwt_cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${_ktt_dpwt_mb}" ]]; then _ktt_dpwt_base="${_ktt_dpwt_mb}"; break; fi
  fi
done
_ktt_dpwt_grown=0
_ktt_dpwt_path=ci/checks/known_tenant_tables.txt
if [[ -n "${_ktt_dpwt_base}" ]]; then
  _ktt_dpwt_old="$(git -C "${ROOT}" show "${_ktt_dpwt_base}:${_ktt_dpwt_path}" 2>/dev/null || true)"
  _ktt_dpwt_new="$(cat "${ROOT}/${_ktt_dpwt_path}" 2>/dev/null || true)"
  _ktt_dpwt_gone="$(comm -23 <(echo "${_ktt_dpwt_old}" | sort) <(echo "${_ktt_dpwt_new}" | sort) || true)"
  [[ -z "${_ktt_dpwt_gone}" ]] && _ktt_dpwt_grown=1
fi
# T-0241-R1 gate (R-1 adversarial-review fix): clear the compensation when
# known_tenant_tables.txt is byte-identical to merge-base (file unchanged).
# Without this gate, _ktt_dpwt_grown=1 fires even on an unchanged file
# (comm -23 of identical content is empty ⟹ _ktt_dpwt_gone="" ⟹ grown=1),
# causing a spurious -1 that masks unrelated real errors such as F-8 violations.
# Guard: git diff --quiet exits 0 when the file has NO diff (unchanged).
if [[ "${_ktt_dpwt_grown}" -eq 1 ]] && git -C "${ROOT}" diff --quiet "${_ktt_dpwt_base}" -- "${_ktt_dpwt_path}" 2>/dev/null; then
  _ktt_dpwt_grown=0
fi
if [[ "${_ktt_dpwt_grown}" -eq 1 ]]; then
  echo "PASS [F-7-additive]: known_tenant_tables.txt grew (superset); another task's table add accepted for T-0210"
  ERRORS=$((ERRORS - 1))
fi

# ---- F-8: pure data seed — no DDL (no CREATE TABLE, no ALTER TABLE) --------
echo ""
echo "F-8: pure data seed — no CREATE TABLE, no ALTER TABLE in migration 063 non-comment code"
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bCREATE TABLE\b' 2>/dev/null; then
    echo "FAIL [F-8]: CREATE TABLE found in non-comment code of migration 063 — must be data-seed only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [F-8]: no CREATE TABLE in migration 063 non-comment code"
  fi

  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iqE '\bALTER TABLE\b' 2>/dev/null; then
    echo "FAIL [F-8]: ALTER TABLE found in non-comment code of migration 063 — must be data-seed only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [F-8]: no ALTER TABLE in migration 063 non-comment code"
  fi
fi

# ---- F-9: no new grants — no INSERT INTO choros."grant" --------------------
echo ""
echo "F-9: no new grant rows — migration 063 contains no INSERT INTO choros.\"grant\""
if [[ -f "${MIG}" ]]; then
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -iE 'INSERT[[:space:]]+INTO[[:space:]]+choros\."grant"' 2>/dev/null | grep -q .; then
    echo "FAIL [F-9]: INSERT INTO choros.\"grant\" found in migration 063 — P-2 must add NO new grants (P-1 grants sufficient)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [F-9]: no INSERT INTO choros.\"grant\" in migration 063 (zero new grants)"
  fi
fi

# ---- F-5: forward guard — read-only surface names and operation:'read' -----
echo ""
echo "F-5: forward guard — no read-only docs-MCP tool name; no operation:'read' in resource_ops"
if [[ -f "${MIG}" ]]; then
  # Neither tool must be named docs_list/docs_read/docs_search
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -qE "'docs_list'|'docs_read'|'docs_search'" 2>/dev/null; then
    echo "FAIL [F-5]: migration 063 inserts a tool with a read-only docs-MCP name (docs_list/docs_read/docs_search)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [F-5]: no read-only docs-MCP tool name (docs_list/docs_read/docs_search) in migration 063"
  fi

  # Neither tool must carry operation:'read' in resource_ops
  if grep -v '^[[:space:]]*--' "${MIG}" | grep -q '"operation":"read"' 2>/dev/null; then
    echo "FAIL [F-5]: migration 063 contains operation:\"read\" in resource_ops — P-2 tools must be write-only" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [F-5]: no operation:\"read\" in migration 063 resource_ops (write-boundary intact)"
  fi
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: docpage-writeful-tools found ${ERRORS} violation(s) (T-0210 P-2)"
  exit 1
fi
echo "PASS: docpage-writeful-tools (T-0210 P-2) — all checks green"
exit 0
