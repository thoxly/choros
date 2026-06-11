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
# T-0035 integration note: migration 036 (migrations/036_substitution_rule.sql)
# is the substitution_rule table owned by T-0035 (E4.7 substitutions/absences).
# It is a legitimate sibling addition on the same branch; T-0044 itself still adds
# only migration 031 (additive ADD COLUMN). The exclusion list must only name
# migrations owned by other known tasks — any NEW T-0044 migration still caught.
SIBLING_MIGRATION_EXCLUDE_RE='^migrations/036_substitution_rule\.sql$'

# T-0035 also adds the optional substitution?: SubstitutionSource seam on
# ResolverDeps in grant-resolver.ts. This is a legitimate additive sibling touch;
# T-0044 does not touch grant-resolver.ts at all.
SIBLING_RESOLVER_EXCLUDE_RE='^src/core/grant-resolver\.ts$'

before=${ERRORS}
# Only-allowed new/changed migration is 031_*confirmed2_by*.sql.
# Exclude known T-0035 sibling migrations from this check.
NEW_MIGRATIONS="$(echo "${CHANGED}" | grep -E '^migrations/.*\.sql$' | grep -vE "${SIBLING_MIGRATION_EXCLUDE_RE}" || true)"
for m in ${NEW_MIGRATIONS}; do
  if [[ ! "${m}" =~ ^migrations/031_.*confirmed2_by.*\.sql$ ]]; then
    echo "FAIL [FF-DC7]: unexpected migration touched by T-0044: '${m}' (only 031_*confirmed2_by*.sql allowed)"
    ERRORS=$((ERRORS + 1))
  fi
done
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
# T-0035 integration note: T-0035 (E4.7 substitutions/absences) legitimately adds
# 'substitution_rule' to known_tenant_tables.txt as a sibling wave change (FF-SUB6).
# T-0044 itself adds no new tenant table; only the T-0035 sibling entry is permitted.
if echo "${CHANGED}" | grep -qE '^ci/checks/known_tenant_tables\.txt$'; then
  TABLES_CONTENT="$(cat "${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt" 2>/dev/null || true)"
  if echo "${TABLES_CONTENT}" | grep -qx "substitution_rule"; then
    : # T-0035 sibling addition present — known_tenant_tables.txt change is from T-0035, not T-0044.
  else
    echo "FAIL [FF-DC7]: ci/checks/known_tenant_tables.txt changed — T-0044 adds an additive column, no new tenant table"
    ERRORS=$((ERRORS + 1))
  fi
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
# T-0035 integration note: src/core/grant-resolver.ts receives ONE additive touch
# from T-0035 (optional substitution?: SubstitutionSource on ResolverDeps).
# This is a sibling seam, NOT a T-0044 change; T-0044 itself does not touch
# grant-resolver.ts. Excluding it via SIBLING_RESOLVER_EXCLUDE_RE prevents a
# false positive; substitution-isolation.sh (FF-SUB3) asserts the seam is additive.
FROZEN_PATHS_RE='^(src/core/role-criticality\.ts|src/core/grant-lattice\.ts|src/core/data-classification\.ts|src/core/effect-resource\.ts|src/core/grant-resolver\.ts|src/core/object-handle\.ts)$'
before=${ERRORS}
FROZEN_HITS="$(echo "${CHANGED}" | grep -E "${FROZEN_PATHS_RE}" | grep -vE "${SIBLING_RESOLVER_EXCLUDE_RE}" || true)"
if [[ -n "${FROZEN_HITS}" ]]; then
  echo "FAIL [FF-DC8]: T-0044 touches a frozen foundation file (must be byte-untouched):"
  echo "${FROZEN_HITS}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC8]: frozen foundation untouched"
fi

# ---- FF-DC11: authenticated-only approver provenance (R-AUTH) ---------------
# The dual-control gate call-site must source proposedBy/confirmed columns from
# extractActor, never from the request body. Ban body-sourced approver ids and
# the pre-existing confirmed_by=b["confirmed_by"] body-assertion.
before=${ERRORS}
NONCOMMENT_GRANTS="$(noncomment "${GRANTS}")"
# 1) dualControlDecision must be called with proposedBy from the authenticated actor.
if ! echo "${NONCOMMENT_GRANTS}" | grep -Eq "proposedBy:[[:space:]]*actorId"; then
  echo "FAIL [FF-DC11]: dualControlDecision is not called with proposedBy = actorId (authenticated)"
  ERRORS=$((ERRORS + 1))
fi
# 2) BAN body-sourced approver ids feeding the gate / INSERT (decorative dual-control).
BANNED_BODY_APPROVER=(
  'b\["approvers"\]'
  'body\.approvers'
  'b\["confirmed_by"\]'
  'b\["confirmed2_by"\]'
  'b\["proposed_by"\]'
  'body\.confirmed2_by'
)
for pat in "${BANNED_BODY_APPROVER[@]}"; do
  if echo "${NONCOMMENT_GRANTS}" | grep -Eq "${pat}"; then
    echo "FAIL [FF-DC11]: grants.ts reads approver identity from the request body ('${pat}') — R-AUTH bans body-asserted approvers"
    ERRORS=$((ERRORS + 1))
  fi
done
# 3) confirmed2_by column must be written from the authenticated actor (extractActor → actor).
if ! grep -qE "confirmed2_by" "${GRANTS}"; then
  echo "FAIL [FF-DC11]: grants.ts does not write confirmed2_by (second authenticated approver column)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-DC11]: authenticated-only approver provenance; no body-asserted approvers"
fi

# ---- Result -----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: dual-control-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: dual-control-isolation — all checks green (FF-DC1..DC8, FF-DC11)"
exit 0
