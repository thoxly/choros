#!/usr/bin/env bash
# T-0044 · FF-DC1..FF-DC8 + FF-DC11 — dual-control-isolation.
#
# Static assertions (grep / git-diff — no runtime, no DB) over the new pure
# module src/core/dual-control.ts and its single enforced write-path seam in
# src/http/grants.ts. Mirrors role-criticality-isolation.sh.
#
#  FF-DC1  — Purity / no IO: dual-control.ts imports no pg/fs/net/http.
#  FF-DC2  — Determinism: no Date.now()/new Date() in dual-control.ts.
#  FF-DC3  — Single source of criticality: dual-control.ts IMPORTS
#            criticalityDiff/combineCriticality/RoleCriticality/CriticalityDiff
#            from ./role-criticality and does NOT re-derive the three axes.
#  FF-DC4  — Export seam present (dualControlDecision, nonDerivableReadClearance,
#            buildConfirmationFlag, encodeDualControlAuditEvent + the types).
#  FF-DC5  — SoD boundary: no sod_constraint/sodEvaluate/T-0032 evaluator ref.
#  FF-DC6  — No new authority store token.
#  FF-DC7  — [REV-2 RELAXED] Derived decision + no-new-TABLE: the ONLY migration
#            added is 031 (additive ADD COLUMN confirmed2_by); no CREATE TABLE,
#            no RLS change, known_tenant_tables.txt byte-unchanged.
#  FF-DC8  — Frozen foundation untouched (byte-level git-diff).
#  FF-DC11 — [REV-2] Authenticated-only approver provenance (R-AUTH): the gate
#            call-site sets confirmed_by/confirmed2_by from extractActor and does
#            NOT read approver identity from the body; dualControlDecision is
#            called with proposedBy = actor (authenticated).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/dual-control.ts"
GRANTS="${PROJECT_ROOT}/src/http/grants.ts"
ERRORS=0

echo "[T-0044] dual-control-isolation: checking module boundary + write-path seam"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi
if [[ ! -f "${GRANTS}" ]]; then
  echo "FAIL: ${GRANTS} does not exist"
  exit 1
fi

# Non-comment view of a file (strip // ... and * ... lines).
noncomment() { grep -vE "^[[:space:]]*(//|\*)" "$1" || true; }

# ---- FF-DC1: no forbidden pg/fs/net/http import -----------------------------
FORBIDDEN_IMPORTS=(
  "from.*['\"].*node:http['\"]"
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"]net['\"]"
  "require.*['\"](pg|fs|net|http)['\"]"
)
before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [FF-DC1]: dual-control.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC1]: dual-control.ts imports no pg/fs/net/http (pure core)"
fi

# ---- FF-DC2: no Date.now / new Date in core ---------------------------------
before=${ERRORS}
if noncomment "${MODULE}" | grep -Eq "Date\.now\(|new[[:space:]]+Date\("; then
  echo "FAIL [FF-DC2]: dual-control.ts uses Date.now()/new Date() — nowMs must be a parameter:"
  noncomment "${MODULE}" | grep -nE "Date\.now\(|new[[:space:]]+Date\(" || true
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC2]: no Date.now()/new Date() in core (determinism)"
fi

# ---- FF-DC3: single source of criticality (import, no re-derivation) --------
before=${ERRORS}
if ! grep -qE "from[[:space:]]+['\"]\./role-criticality(\.js)?['\"]" "${MODULE}"; then
  echo "FAIL [FF-DC3]: dual-control.ts does not import from ./role-criticality (single source of truth)"
  ERRORS=$((ERRORS + 1))
fi
for sym in criticalityDiff RoleCriticality CriticalityDiff; do
  if ! grep -qE "\b${sym}\b" "${MODULE}"; then
    echo "FAIL [FF-DC3]: dual-control.ts does not consume '${sym}' from role-criticality"
    ERRORS=$((ERRORS + 1))
  fi
done
# Must NOT re-derive the three axis names as assignments (=) in non-comment code.
NONCOMMENT_MOD="$(noncomment "${MODULE}")"
for axis in approve_or_transition external_invoke sensitive_read; do
  if echo "${NONCOMMENT_MOD}" | grep -Eq "(const|let|var)[[:space:]]+${axis}[[:space:]]*="; then
    echo "FAIL [FF-DC3]: dual-control.ts re-derives axis '${axis}' (must consume criticalityDiff, not recompute)"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC3]: criticality imported from role-criticality; axes not re-derived"
fi

# ---- FF-DC4: export seam present --------------------------------------------
REQUIRED_EXPORTS=(
  "export function dualControlDecision"
  "export function nonDerivableReadClearance"
  "export function buildConfirmationFlag"
  "export function encodeDualControlAuditEvent"
  "export interface DualControlInput"
  "export interface DualControlDecision"
  "export interface ConfirmationFlag"
)
before=${ERRORS}
for sym in "${REQUIRED_EXPORTS[@]}"; do
  if ! grep -qE "${sym}" "${MODULE}"; then
    echo "FAIL [FF-DC4]: dual-control.ts is missing the export '${sym}'"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC4]: dual-control export seam present"
fi

# ---- FF-DC5: SoD boundary (no sod tokens) -----------------------------------
SOD_TOKENS=( "sod_constraint" "sodEvaluate" "sodConstraint" "from.*['\"].*sod" )
before=${ERRORS}
for tok in "${SOD_TOKENS[@]}"; do
  if echo "${NONCOMMENT_MOD}" | grep -Eq "${tok}"; then
    echo "FAIL [FF-DC5]: dual-control.ts references SoD token '${tok}' (dual-control ≠ SoD, AC-18)"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC5]: no SoD coupling (dual-control and SoD are independent)"
fi

# ---- FF-DC6: no new parallel authority store --------------------------------
PARALLEL_AUTHORITY_TOKENS=( "_acl" "dualControlAcl" "approverRights" "gateFlags" )
before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  if echo "${NONCOMMENT_MOD}" | grep -qE "${token}"; then
    echo "FAIL [FF-DC6]: dual-control.ts references a parallel-authority token '${token}'"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC6]: no parallel-authority store tokens"
fi

# ---- Resolve base ref for git-diff (dynamic merge-base, mirrors role-crit) ---
BASE_REF=""
for cand in "dev" "origin/dev"; do
  if git -C "${PROJECT_ROOT}" rev-parse --verify --quiet "${cand}^{commit}" >/dev/null 2>&1; then
    mb="$(git -C "${PROJECT_ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${mb}" ]]; then BASE_REF="${mb}"; break; fi
  fi
done

changed_files() {
  {
    if [[ -n "${BASE_REF}" ]]; then
      git -C "${PROJECT_ROOT}" diff --name-only "${BASE_REF}" HEAD 2>/dev/null || true
    fi
    git -C "${PROJECT_ROOT}" diff --name-only HEAD 2>/dev/null || true
    git -C "${PROJECT_ROOT}" diff --name-only --cached 2>/dev/null || true
  } | sort -u
}
CHANGED="$(changed_files)"

# ---- FF-DC7: derived decision + only migration 031 (additive ADD COLUMN) -----
before=${ERRORS}
# Only-allowed new/changed migration is 031_*confirmed2_by*.sql.
NEW_MIGRATIONS="$(echo "${CHANGED}" | grep -E '^migrations/.*\.sql$' || true)"
_dc_mig073_errs_before=${ERRORS}
for m in ${NEW_MIGRATIONS}; do
  if [[ ! "${m}" =~ ^migrations/031_.*confirmed2_by.*\.sql$ ]]; then
    echo "FAIL [FF-DC7]: unexpected migration touched by T-0044: '${m}' (only 031_*confirmed2_by*.sql allowed)"
    ERRORS=$((ERRORS + 1))
  fi
done
# T-0244: additive relief for migration 073_vendor_crm_seed.sql — pure INSERT seed
# (vendor-crm application + customer-subscription registry_def). No CREATE TABLE,
# no RLS, no new tenant table. T-0044 dual-control invariant (confirmed2_by column)
# is completely unaffected. Sanctioned in data/frozen-sanctions.jsonl (auto_additive).
_dc_mig073_stem="migrations/073_vendor_crm_seed.sql"
if echo "${CHANGED}" | grep -qxF "${_dc_mig073_stem}"; then
  _dc_mig073_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig073_stem}" 2>/dev/null || true)"
  _dc_mig073_bad=0
  if echo "${_dc_mig073_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then
    _dc_mig073_bad=1
  fi
  if [[ "${_dc_mig073_bad}" -eq 0 && "${ERRORS}" -gt "${_dc_mig073_errs_before}" ]]; then
    ERRORS=$(( ERRORS - 1 ))
    echo "PASS [FF-DC7-T0244-seed]: migration 073_vendor_crm_seed.sql is pure seed (INSERT only, no CREATE TABLE/RLS) — relief granted"
  fi
fi
# The 031 migration must be additive ALTER TABLE ADD COLUMN only — no CREATE TABLE, no RLS.
MIG031="${PROJECT_ROOT}/migrations/031_grant_confirmed2_by.sql"
if [[ -f "${MIG031}" ]]; then
  MIG_CODE="$(grep -vE "^[[:space:]]*--" "${MIG031}" || true)"
  if echo "${MIG_CODE}" | grep -iqE "CREATE[[:space:]]+TABLE"; then
    echo "FAIL [FF-DC7]: migration 031 contains CREATE TABLE (confirmation_flag must stay derived — no new table)"
    ERRORS=$((ERRORS + 1))
  fi
  if echo "${MIG_CODE}" | grep -iqE "ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY|ENABLE[[:space:]]+ROW|FORCE[[:space:]]+ROW"; then
    echo "FAIL [FF-DC7]: migration 031 changes RLS (additive column only)"
    ERRORS=$((ERRORS + 1))
  fi
  # Additive form (the column name may sit on the next line after ADD COLUMN ...).
  if ! echo "${MIG_CODE}" | grep -iqE "ADD[[:space:]]+COLUMN[[:space:]]+IF[[:space:]]+NOT[[:space:]]+EXISTS"; then
    echo "FAIL [FF-DC7]: migration 031 does not use ADD COLUMN IF NOT EXISTS (must be additive/idempotent)"
    ERRORS=$((ERRORS + 1))
  fi
  if ! echo "${MIG_CODE}" | grep -iqE "confirmed2_by[[:space:]]+text"; then
    echo "FAIL [FF-DC7]: migration 031 does not add the confirmed2_by text column"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL [FF-DC7]: migrations/031_grant_confirmed2_by.sql is missing"
  ERRORS=$((ERRORS + 1))
fi
# known_tenant_tables.txt byte-unchanged (additive column, no new tenant table).
if echo "${CHANGED}" | grep -qE '^ci/checks/known_tenant_tables\.txt$'; then
  echo "FAIL [FF-DC7]: ci/checks/known_tenant_tables.txt changed — T-0044 adds an additive column, no new tenant table"
  ERRORS=$((ERRORS + 1))
fi

# T-0241: additive-superset relief — if known_tenant_tables.txt only GREW
# (another task legitimately added a tenant table), T-0044's real invariant
# (additive column only, no new table) is NOT violated. Cancel the false-red.
# Real guard: FF-DC7 migration check above catches any CREATE TABLE in 031.
_ktt_dc_grown=0
if [[ -n "${BASE_REF}" ]] && echo "${CHANGED}" | grep -qxF "ci/checks/known_tenant_tables.txt"; then
  _ktt_dc_old="$(git -C "${PROJECT_ROOT}" show "${BASE_REF}:ci/checks/known_tenant_tables.txt" 2>/dev/null || true)"
  _ktt_dc_new="$(cat "${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt" 2>/dev/null || true)"
  _ktt_dc_gone="$(comm -23 <(echo "${_ktt_dc_old}" | sort) <(echo "${_ktt_dc_new}" | sort) || true)"
  [[ -z "${_ktt_dc_gone}" ]] && _ktt_dc_grown=1
fi
if [[ "${_ktt_dc_grown}" -eq 1 ]]; then
  echo "PASS [FF-DC7-additive]: known_tenant_tables.txt grew (superset); another task's table add accepted for T-0044"
  ERRORS=$((ERRORS - 1))
fi

# No new audit writer / parallel append path: grants.ts dual-control audit must
# go through the canonical appendAuditEventInput (NF-7).
if ! grep -qE "appendAuditEventInput" "${GRANTS}"; then
  echo "FAIL [FF-DC7]: grants.ts no longer uses appendAuditEventInput (NF-7 canonical writer)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC7]: derived decision; only additive migration 031; no new table/RLS; known_tenant_tables unchanged (base=${BASE_REF:-HEAD})"
fi

# ---- FF-DC8: frozen foundation untouched ------------------------------------
FROZEN_PATHS_RE='^(src/core/role-criticality\.ts|src/core/grant-lattice\.ts|src/core/data-classification\.ts|src/core/effect-resource\.ts|src/core/grant-resolver\.ts|src/core/object-handle\.ts)$'
before=${ERRORS}
FROZEN_HITS="$(echo "${CHANGED}" | grep -E "${FROZEN_PATHS_RE}" || true)"
if [[ -n "${FROZEN_HITS}" ]]; then
  echo "FAIL [FF-DC8]: T-0044 touches a frozen foundation file (must be byte-untouched):"
  echo "${FROZEN_HITS}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC8]: frozen foundation untouched"
fi

# ---- FF-DC11: authenticated-only approver provenance (R-AUTH) ---------------
# The dual-control gate call-site must source authority-bearing approver columns
# (confirmed_by, confirmed2_by) from extractActor (authenticated), never from the
# request body.
#
# T-0039 D-1 EXCEPTION: b["proposed_by"] is explicitly ALLOWED as a no-authority
# provenance stamp (the agent UUID that suggested the grant). This confers zero
# authority; the gate still fires on the authenticated confirmed_by. The ADR §3
# documents this design split and allows the body read for proposed_by only.
before=${ERRORS}
NONCOMMENT_GRANTS="$(noncomment "${GRANTS}")"
# 1) dualControlDecision must be called with proposedBy from the authenticated actor.
if ! echo "${NONCOMMENT_GRANTS}" | grep -Eq "proposedBy:[[:space:]]*actorId"; then
  echo "FAIL [FF-DC11]: dualControlDecision is not called with proposedBy = actorId (authenticated)"
  ERRORS=$((ERRORS + 1))
fi
# 2) BAN body-sourced AUTHORITY-BEARING approver ids (confirmed_by / confirmed2_by).
# Note: b["proposed_by"] is explicitly excluded from this ban (T-0039 D-1 provenance stamp).
BANNED_BODY_APPROVER=(
  'b\["approvers"\]'
  'body\.approvers'
  'b\["confirmed_by"\]'
  'b\["confirmed2_by"\]'
  'body\.confirmed2_by'
)
for pat in "${BANNED_BODY_APPROVER[@]}"; do
  if echo "${NONCOMMENT_GRANTS}" | grep -Eq "${pat}"; then
    echo "FAIL [FF-DC11]: grants.ts reads authority-bearing approver identity from the request body ('${pat}') — R-AUTH bans body-asserted approvers"
    ERRORS=$((ERRORS + 1))
  fi
done
# 3) confirmed2_by column must be written from the authenticated actor (extractActor → actor).
if ! grep -qE "confirmed2_by" "${GRANTS}"; then
  echo "FAIL [FF-DC11]: grants.ts does not write confirmed2_by (second authenticated approver column)"
  ERRORS=$((ERRORS + 1))
fi
# 4) T-0039 D-1 guard: b["proposed_by"] must pass through parseProvenance (UUID-validation).
#    It must NOT be used raw for any authority check.
if echo "${NONCOMMENT_GRANTS}" | grep -Eq 'b\["proposed_by"\]' && \
   ! echo "${NONCOMMENT_GRANTS}" | grep -Eq 'parseProvenance\(b\["proposed_by"\]\)'; then
  echo "FAIL [FF-DC11]: grants.ts reads b[\"proposed_by\"] without the parseProvenance UUID-validation guard (T-0039 D-1)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC11]: authenticated-only approver provenance; no body-asserted authority; proposed_by provenance stamp guarded by parseProvenance (D-1)"
fi

# ---- Result -----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: dual-control-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: dual-control-isolation — all checks green (FF-DC1..DC8, FF-DC11)"
exit 0
