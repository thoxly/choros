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
# F-5 fix: use a per-migration flag so relief cancels ONLY the 073 FF-DC7 increment,
# not any other migration's failure. _dc_mig073_failed is set ONLY when migration 073
# itself triggers the "unexpected migration" FAIL in the loop below.
_dc_mig073_failed=0
_dc_mig074_failed=0
_dc_mig075_failed=0
_dc_mig078_failed=0                                                                # T0338-DC-MIG078-GUARD track when 078 triggers the FF-DC7 fail
_dc_mig081_failed=0                                                                # T0346-DC-MIG081-GUARD track when 081 triggers the FF-DC7 fail
_dc_mig082_failed=0                                                                # T0351-DC-MIG082-GUARD track when 082 triggers the FF-DC7 fail
_dc_mig083_failed=0                                                                # T0354-DC-MIG083-GUARD track when 083 triggers the FF-DC7 fail
_dc_mig104_failed=0                                                                # T0475-DC-MIG104-GUARD track when 104 triggers the FF-DC7 fail
_dc_mig106_failed=0                                                                # T0476-DC-MIG106-GUARD track when 106 triggers the FF-DC7 fail
_dc_mig107_failed=0                                                                # T0477-DC-MIG107-GUARD track when 107 triggers the FF-DC7 fail
_dc_mig109_failed=0                                                                # T0397-DC-MIG109-GUARD track when 109 triggers the FF-DC7 fail
_dc_mig115_failed=0                                                                # T0574-DC-MIG115-GUARD track when 115 triggers the FF-DC7 fail
_dc_mig116_failed=0                                                                # T0574-DC-MIG116-GUARD track when 116 triggers the FF-DC7 fail
_dc_mig117_failed=0                                                                # T0570-DC-MIG117-GUARD track when 117 triggers the FF-DC7 fail
_dc_mig118_failed=0                                                                # T0573-DC-MIG118-GUARD track when 118 triggers the FF-DC7 fail
_dc_mig119_failed=0                                                                # T0575-DC-MIG119-GUARD track when 119 triggers the FF-DC7 fail
_dc_mig120_failed=0                                                                # T0594-DC-MIG120-GUARD track when 120 triggers the FF-DC7 fail
_dc_mig121_failed=0                                                                # T0604-DC-MIG121-GUARD track when 121 triggers the FF-DC7 fail
_dc_mig122_failed=0                                                                # T0606-DC-MIG122-GUARD track when 122 triggers the FF-DC7 fail
_dc_mig123_failed=0                                                                # T0619-DC-MIG123-GUARD track when 123 triggers the FF-DC7 fail
for m in ${NEW_MIGRATIONS}; do
  if [[ ! "${m}" =~ ^migrations/031_.*confirmed2_by.*\.sql$ ]]; then
    echo "FAIL [FF-DC7]: unexpected migration touched by T-0044: '${m}' (only 031_*confirmed2_by*.sql allowed)"
    ERRORS=$((ERRORS + 1))
    # Track specifically when 073 triggers this FAIL (and nothing else).
    if [[ "${m}" == "migrations/073_vendor_crm_seed.sql" ]]; then
      _dc_mig073_failed=1
    fi
    # Track specifically when 074 triggers this FAIL (and nothing else).
    if [[ "${m}" == "migrations/074_process_definition.sql" ]]; then
      _dc_mig074_failed=1
    fi
    # Track specifically when 075 triggers this FAIL (and nothing else).
    if [[ "${m}" == "migrations/075_process_app_binding.sql" ]]; then
      _dc_mig075_failed=1
    fi
    # Track specifically when 078 triggers this FAIL (and nothing else).     # T0338-DC-MIG078-GUARD
    if [[ "${m}" == "migrations/078_user_task_claim.sql" ]]; then             # T0338-DC-MIG078-GUARD
      _dc_mig078_failed=1                                                     # T0338-DC-MIG078-GUARD
    fi                                                                        # T0338-DC-MIG078-GUARD
    # Track specifically when 081 triggers this FAIL (and nothing else).     # T0346-DC-MIG081-GUARD
    if [[ "${m}" == "migrations/081_revoke_transition_journal.sql" ]]; then  # T0346-DC-MIG081-GUARD
      _dc_mig081_failed=1                                                     # T0346-DC-MIG081-GUARD
    fi                                                                        # T0346-DC-MIG081-GUARD
    # Track specifically when 082 triggers this FAIL (and nothing else).     # T0351-DC-MIG082-GUARD
    if [[ "${m}" == "migrations/082_process_app_binding_trigger.sql" ]]; then # T0351-DC-MIG082-GUARD
      _dc_mig082_failed=1                                                     # T0351-DC-MIG082-GUARD
    fi                                                                        # T0351-DC-MIG082-GUARD
    # Track specifically when 083 triggers this FAIL (and nothing else).     # T0354-DC-MIG083-GUARD
    if [[ "${m}" == "migrations/083_core_system_registries_seed.sql" ]]; then # T0354-DC-MIG083-GUARD
      _dc_mig083_failed=1                                                     # T0354-DC-MIG083-GUARD
    fi                                                                        # T0354-DC-MIG083-GUARD
    # Track specifically when 104 triggers this FAIL (and nothing else).     # T0475-DC-MIG104-GUARD
    if [[ "${m}" == "migrations/104_capability_grants_l4_seed.sql" ]]; then   # T0475-DC-MIG104-GUARD
      _dc_mig104_failed=1                                                     # T0475-DC-MIG104-GUARD
    fi                                                                        # T0475-DC-MIG104-GUARD
    # Track specifically when 106 triggers this FAIL (and nothing else).     # T0476-DC-MIG106-GUARD
    if [[ "${m}" == "migrations/106_app_secret_store.sql" ]]; then            # T0476-DC-MIG106-GUARD
      _dc_mig106_failed=1                                                     # T0476-DC-MIG106-GUARD
    fi                                                                        # T0476-DC-MIG106-GUARD
    # Track specifically when 107 triggers this FAIL (and nothing else).     # T0477-DC-MIG107-GUARD
    if [[ "${m}" == "migrations/107_spend_ledger_llm_tracking.sql" ]]; then   # T0477-DC-MIG107-GUARD
      _dc_mig107_failed=1                                                     # T0477-DC-MIG107-GUARD
    fi                                                                        # T0477-DC-MIG107-GUARD
    # Track specifically when 109 triggers this FAIL (and nothing else).     # T0397-DC-MIG109-GUARD
    if [[ "${m}" == "migrations/109_dual_control_pdp_backfill.sql" ]]; then   # T0397-DC-MIG109-GUARD
      _dc_mig109_failed=1                                                     # T0397-DC-MIG109-GUARD
    fi                                                                        # T0397-DC-MIG109-GUARD
    # Track specifically when 115 triggers this FAIL (and nothing else).     # T0574-DC-MIG115-GUARD
    if [[ "${m}" == "migrations/115_assistant_agent_card_backfill.sql" ]]; then # T0574-DC-MIG115-GUARD
      _dc_mig115_failed=1                                                     # T0574-DC-MIG115-GUARD
    fi                                                                        # T0574-DC-MIG115-GUARD
    # Track specifically when 116 triggers this FAIL (and nothing else).     # T0574-DC-MIG116-GUARD
    if [[ "${m}" == "migrations/116_composite_fk_set_null_columns.sql" ]]; then # T0574-DC-MIG116-GUARD
      _dc_mig116_failed=1                                                     # T0574-DC-MIG116-GUARD
    fi                                                                        # T0574-DC-MIG116-GUARD
    # Track specifically when 117 triggers this FAIL (and nothing else).     # T0570-DC-MIG117-GUARD
    if [[ "${m}" == "migrations/117_default_read_grant_backfill.sql" ]]; then # T0570-DC-MIG117-GUARD
      _dc_mig117_failed=1                                                     # T0570-DC-MIG117-GUARD
    fi                                                                        # T0570-DC-MIG117-GUARD
    # Track specifically when 118 triggers this FAIL (and nothing else).     # T0573-DC-MIG118-GUARD
    if [[ "${m}" == "migrations/118_assistant_tenant_zero_backfill.sql" ]]; then # T0573-DC-MIG118-GUARD
      _dc_mig118_failed=1                                                     # T0573-DC-MIG118-GUARD
    fi                                                                        # T0573-DC-MIG118-GUARD
    # Track specifically when 119 triggers this FAIL (and nothing else).     # T0575-DC-MIG119-GUARD
    if [[ "${m}" == "migrations/119_process_app_binding_target_registry_slug.sql" ]]; then # T0575-DC-MIG119-GUARD
      _dc_mig119_failed=1                                                     # T0575-DC-MIG119-GUARD
    fi                                                                        # T0575-DC-MIG119-GUARD
    # Track specifically when 120 triggers this FAIL (and nothing else).     # T0594-DC-MIG120-GUARD
    if [[ "${m}" == "migrations/120_ownerless_tenant_zero_unarm.sql" ]]; then # T0594-DC-MIG120-GUARD
      _dc_mig120_failed=1                                                     # T0594-DC-MIG120-GUARD
    fi                                                                        # T0594-DC-MIG120-GUARD
    # Track specifically when 121 triggers this FAIL (and nothing else).     # T0604-DC-MIG121-GUARD
    if [[ "${m}" == "migrations/121_process_app_binding_submit_task_key.sql" ]]; then # T0604-DC-MIG121-GUARD
      _dc_mig121_failed=1                                                     # T0604-DC-MIG121-GUARD
    fi                                                                        # T0604-DC-MIG121-GUARD
    # Track specifically when 122 triggers this FAIL (and nothing else).     # T0606-DC-MIG122-GUARD
    if [[ "${m}" == "migrations/122_approval_registry_guard.sql" ]]; then     # T0606-DC-MIG122-GUARD
      _dc_mig122_failed=1                                                     # T0606-DC-MIG122-GUARD
    fi                                                                        # T0606-DC-MIG122-GUARD
    # Track specifically when 123 triggers this FAIL (and nothing else).     # T0619-DC-MIG123-GUARD
    if [[ "${m}" == "migrations/123_read_grant_all_staff_backfill.sql" ]]; then # T0619-DC-MIG123-GUARD
      _dc_mig123_failed=1                                                     # T0619-DC-MIG123-GUARD
    fi                                                                        # T0619-DC-MIG123-GUARD
  fi
done
# T-0244: additive relief for migration 073_vendor_crm_seed.sql — pure INSERT seed
# (vendor-crm application + customer-subscription registry_def). No CREATE TABLE,
# no RLS, no new tenant table. T-0044 dual-control invariant (confirmed2_by column)
# is completely unaffected. Sanctioned in data/frozen-sanctions.jsonl (auto_additive).
#
# F-5 fix: relief cancels ONLY the _dc_mig073_failed increment — it CANNOT absorb
# any other migration's FF-DC7 failure. The flag is set exclusively in the loop above
# when migration 073 itself is the unexpected file, so the decrement is scoped exactly.
_dc_mig073_stem="migrations/073_vendor_crm_seed.sql"
if [[ "${_dc_mig073_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig073_stem}"; then
  _dc_mig073_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig073_stem}" 2>/dev/null || true)"
  _dc_mig073_bad=0
  if echo "${_dc_mig073_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then
    _dc_mig073_bad=1
  fi
  if [[ "${_dc_mig073_bad}" -eq 0 ]]; then
    ERRORS=$(( ERRORS - 1 ))
    _dc_mig073_failed=0
    echo "PASS [FF-DC7-T0244-seed]: migration 073_vendor_crm_seed.sql is pure seed (INSERT only, no CREATE TABLE/RLS) — relief granted"
  fi
fi
# T-0252: additive relief for migration 074_process_definition.sql. Unlike 073,
# 074 IS a new tenant table (process_definition) — but it is UNRELATED to the
# dual-control authority domain (grant / confirmation / confirmed2_by). T-0044's
# real invariant — 031 is the ONLY dual-control migration, confirmed2_by stays a
# derived additive column — is NOT touched by a BPMN process-definition store.
# Sanctioned in data/frozen-sanctions.jsonl (auto_additive).
#
# Like the 073 relief, this cancels ONLY the _dc_mig074_failed increment (set in
# the loop above exclusively when migration 074 is the unexpected file), so the
# decrement is scoped exactly and cannot absorb any other migration's FF-DC7 fail.
# Independent guard: the relief fires ONLY after verifying 074 does NOT create or
# alter any grant/confirmation/authority table and does NOT touch confirmed2_by.
_dc_mig074_stem="migrations/074_process_definition.sql"
if [[ "${_dc_mig074_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig074_stem}"; then
  _dc_mig074_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig074_stem}" 2>/dev/null || true)"  # T0252-DC-MIG074-GUARD
  _dc_mig074_bad=0
  # 074 must not create/alter the dual-control authority domain (grant/confirmation/authority),
  # and must not touch the confirmed2_by invariant.
  if echo "${_dc_mig074_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then
    _dc_mig074_bad=1
  fi
  if echo "${_dc_mig074_content}" | grep -iqE "confirmed2_by|confirmed_by"; then
    _dc_mig074_bad=1
  fi
  if [[ "${_dc_mig074_bad}" -eq 0 ]]; then
    ERRORS=$(( ERRORS - 1 ))
    _dc_mig074_failed=0
    echo "PASS [FF-DC7-T0252-procdef]: migration 074_process_definition.sql creates process_definition (BPMN store) — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted"
  fi
fi
# T-0270: additive relief for migration 075_process_app_binding.sql. Like 074, 075
# IS a new tenant table (process_app_binding) — but it is UNRELATED to the
# dual-control authority domain (grant / confirmation / confirmed2_by). T-0044's
# real invariant — 031 is the ONLY dual-control migration, confirmed2_by stays a
# derived additive column — is NOT touched by a process↔application binding store.
# Sanctioned in data/frozen-sanctions.jsonl (auto_additive).
#
# Like the 073/074 reliefs, this cancels ONLY the _dc_mig075_failed increment (set
# in the loop above exclusively when migration 075 is the unexpected file), so the
# decrement is scoped exactly and cannot absorb any other migration's FF-DC7 fail.
# Independent guard: the relief fires ONLY after verifying 075 does NOT create or
# alter any grant/confirmation/authority table and does NOT touch confirmed2_by.
_dc_mig075_stem="migrations/075_process_app_binding.sql"
if [[ "${_dc_mig075_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig075_stem}"; then
  _dc_mig075_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig075_stem}" 2>/dev/null || true)"  # T0270-DC-MIG075-GUARD
  _dc_mig075_bad=0
  # 075 must not create/alter the dual-control authority domain (grant/confirmation/authority),
  # and must not touch the confirmed2_by invariant.
  if echo "${_dc_mig075_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then
    _dc_mig075_bad=1
  fi
  if echo "${_dc_mig075_content}" | grep -iqE "confirmed2_by|confirmed_by"; then
    _dc_mig075_bad=1
  fi
  if [[ "${_dc_mig075_bad}" -eq 0 ]]; then
    ERRORS=$(( ERRORS - 1 ))
    _dc_mig075_failed=0
    echo "PASS [FF-DC7-T0270-procappbind]: migration 075_process_app_binding.sql creates process_app_binding (process↔application store) — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted"
  fi
fi
# T-0338: additive relief for migration 078_user_task_claim.sql.          # T0338-DC-MIG078-GUARD
# 078 IS a new tenant table (user_task_claim — human claim-lock primitive) # T0338-DC-MIG078-GUARD
# but is UNRELATED to the dual-control authority domain.                    # T0338-DC-MIG078-GUARD
# Same class as T-0252/T-0270 migration-074/075 reliefs (auto_additive).  # T0338-DC-MIG078-GUARD
_dc_mig078_stem="migrations/078_user_task_claim.sql"                       # T0338-DC-MIG078-GUARD
if [[ "${_dc_mig078_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig078_stem}"; then # T0338-DC-MIG078-GUARD
  _dc_mig078_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig078_stem}" 2>/dev/null || true)"  # T0338-DC-MIG078-GUARD
  _dc_mig078_bad=0                                                          # T0338-DC-MIG078-GUARD
  if echo "${_dc_mig078_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0338-DC-MIG078-GUARD
    _dc_mig078_bad=1                                                        # T0338-DC-MIG078-GUARD touches authority domain
  fi                                                                        # T0338-DC-MIG078-GUARD
  if echo "${_dc_mig078_content}" | grep -iqE "confirmed2_by|confirmed_by"; then # T0338-DC-MIG078-GUARD
    _dc_mig078_bad=1                                                        # T0338-DC-MIG078-GUARD touches confirmed2_by invariant
  fi                                                                        # T0338-DC-MIG078-GUARD
  if [[ "${_dc_mig078_bad}" -eq 0 ]]; then                                 # T0338-DC-MIG078-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                # T0338-DC-MIG078-GUARD cancel false-red
    _dc_mig078_failed=0                                                     # T0338-DC-MIG078-GUARD
    echo "PASS [FF-DC7-T0338-usertaskclaim]: migration 078_user_task_claim.sql creates user_task_claim (human claim-lock) — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0338-DC-MIG078-GUARD
  fi                                                                        # T0338-DC-MIG078-GUARD
fi                                                                          # T0338-DC-MIG078-GUARD
# T-0346: additive relief for migration 081_revoke_transition_journal.sql.    # T0346-DC-MIG081-GUARD
# 081 DROPS a materialized view and its refresh function — it adds NO TABLE, NO RLS, # T0346-DC-MIG081-GUARD
# NO new rows; it only removes the cross-tenant mat-view leak (security fix).  # T0346-DC-MIG081-GUARD
# UNRELATED to the dual-control authority domain (grant/confirmation/confirmed2_by). # T0346-DC-MIG081-GUARD
# Same class as T-0338 migration-078 relief (auto_additive).                  # T0346-DC-MIG081-GUARD
_dc_mig081_stem="migrations/081_revoke_transition_journal.sql"                 # T0346-DC-MIG081-GUARD
if [[ "${_dc_mig081_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig081_stem}"; then # T0346-DC-MIG081-GUARD
  _dc_mig081_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig081_stem}" 2>/dev/null || true)"  # T0346-DC-MIG081-GUARD
  _dc_mig081_bad=0                                                             # T0346-DC-MIG081-GUARD
  if echo "${_dc_mig081_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0346-DC-MIG081-GUARD
    _dc_mig081_bad=1                                                           # T0346-DC-MIG081-GUARD touches authority domain
  fi                                                                           # T0346-DC-MIG081-GUARD
  if echo "${_dc_mig081_content}" | grep -iqE "confirmed2_by|confirmed_by"; then # T0346-DC-MIG081-GUARD
    _dc_mig081_bad=1                                                           # T0346-DC-MIG081-GUARD touches confirmed2_by invariant
  fi                                                                           # T0346-DC-MIG081-GUARD
  if [[ "${_dc_mig081_bad}" -eq 0 ]]; then                                    # T0346-DC-MIG081-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0346-DC-MIG081-GUARD cancel false-red
    _dc_mig081_failed=0                                                        # T0346-DC-MIG081-GUARD
    echo "PASS [FF-DC7-T0346-revoke-journal]: migration 081_revoke_transition_journal.sql drops the cross-tenant mat-view (security fix) — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0346-DC-MIG081-GUARD
  fi                                                                           # T0346-DC-MIG081-GUARD
fi                                                                             # T0346-DC-MIG081-GUARD
# T-0351: additive relief for migration 082_process_app_binding_trigger.sql.    # T0351-DC-MIG082-GUARD
# 082 ALTERs choros.process_app_binding (known tenant table from migration 075) by # T0351-DC-MIG082-GUARD
# adding 3 columns (trigger_type, start_form_key, field_mapping). No new TABLE,  # T0351-DC-MIG082-GUARD
# no new RLS policy, no confirmed2_by touch. UNRELATED to the dual-control       # T0351-DC-MIG082-GUARD
# authority domain (grant/confirmation/confirmed2_by).                           # T0351-DC-MIG082-GUARD
# Same class as T-0338/T-0346 migration reliefs (auto_additive).                # T0351-DC-MIG082-GUARD
_dc_mig082_stem="migrations/082_process_app_binding_trigger.sql"                 # T0351-DC-MIG082-GUARD
if [[ "${_dc_mig082_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig082_stem}"; then # T0351-DC-MIG082-GUARD
  _dc_mig082_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig082_stem}" 2>/dev/null || true)"  # T0351-DC-MIG082-GUARD
  _dc_mig082_bad=0                                                               # T0351-DC-MIG082-GUARD
  if echo "${_dc_mig082_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0351-DC-MIG082-GUARD
    _dc_mig082_bad=1                                                             # T0351-DC-MIG082-GUARD touches authority domain
  fi                                                                             # T0351-DC-MIG082-GUARD
  if echo "${_dc_mig082_content}" | grep -iqE "confirmed2_by|confirmed_by"; then # T0351-DC-MIG082-GUARD
    _dc_mig082_bad=1                                                             # T0351-DC-MIG082-GUARD touches confirmed2_by invariant
  fi                                                                             # T0351-DC-MIG082-GUARD
  if [[ "${_dc_mig082_bad}" -eq 0 ]]; then                                      # T0351-DC-MIG082-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                     # T0351-DC-MIG082-GUARD cancel false-red
    _dc_mig082_failed=0                                                          # T0351-DC-MIG082-GUARD
    echo "PASS [FF-DC7-T0351-binding-trigger]: migration 082_process_app_binding_trigger.sql adds trigger columns to process_app_binding — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0351-DC-MIG082-GUARD
  fi                                                                             # T0351-DC-MIG082-GUARD
fi                                                                               # T0351-DC-MIG082-GUARD
# T-0354: additive relief for migration 083_core_system_registries_seed.sql.  # T0354-DC-MIG083-GUARD
# 083 is a PURE SEED — only INSERT ... ON CONFLICT DO NOTHING rows into the   # T0354-DC-MIG083-GUARD
# existing application and registry_def tables (migrations 003/004). Zero DDL. # T0354-DC-MIG083-GUARD
# UNRELATED to the dual-control authority domain (grant/confirmation/confirmed2_by). # T0354-DC-MIG083-GUARD
# Same class as T-0244 migration-073 seed relief (auto_additive).             # T0354-DC-MIG083-GUARD
_dc_mig083_stem="migrations/083_core_system_registries_seed.sql"               # T0354-DC-MIG083-GUARD
if [[ "${_dc_mig083_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig083_stem}"; then # T0354-DC-MIG083-GUARD
  _dc_mig083_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig083_stem}" 2>/dev/null || true)"  # T0354-DC-MIG083-GUARD
  _dc_mig083_bad=0                                                             # T0354-DC-MIG083-GUARD
  if echo "${_dc_mig083_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0354-DC-MIG083-GUARD
    _dc_mig083_bad=1                                                           # T0354-DC-MIG083-GUARD touches authority domain
  fi                                                                           # T0354-DC-MIG083-GUARD
  if echo "${_dc_mig083_content}" | grep -iqE "confirmed2_by|confirmed_by"; then # T0354-DC-MIG083-GUARD
    _dc_mig083_bad=1                                                           # T0354-DC-MIG083-GUARD touches confirmed2_by invariant
  fi                                                                           # T0354-DC-MIG083-GUARD
  if [[ "${_dc_mig083_bad}" -eq 0 ]]; then                                    # T0354-DC-MIG083-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0354-DC-MIG083-GUARD cancel false-red
    _dc_mig083_failed=0                                                        # T0354-DC-MIG083-GUARD
    echo "PASS [FF-DC7-T0354-core-registries-seed]: migration 083_core_system_registries_seed.sql is a pure INSERT seed — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0354-DC-MIG083-GUARD
  fi                                                                           # T0354-DC-MIG083-GUARD
fi                                                                             # T0354-DC-MIG083-GUARD
# T-0475: additive relief for migration 104_capability_grants_l4_seed.sql.   # T0475-DC-MIG104-GUARD
# 104 is a PURE SEED — only INSERT ... ON CONFLICT DO NOTHING of two new      # T0475-DC-MIG104-GUARD
# capability-grant rows (confirmed_by='seed') into the EXISTING choros."grant" # T0475-DC-MIG104-GUARD
# table (migration 008). Zero DDL: no CREATE TABLE, no RLS/POLICY change.     # T0475-DC-MIG104-GUARD
# The two seeded rows are CAPABILITY grants (llm_connection:configure,        # T0475-DC-MIG104-GUARD
# system_agent:operate) — they do NOT alter the confirmed2_by/dual-control    # T0475-DC-MIG104-GUARD
# authority machinery and do NOT touch the confirmed2_by invariant.          # T0475-DC-MIG104-GUARD
# UNRELATED to the dual-control authority domain (grant-CONFIRMATION /        # T0475-DC-MIG104-GUARD
# confirmation / confirmed2_by). Same class as T-0244 migration-073 and      # T0475-DC-MIG104-GUARD
# T-0354 migration-083 pure-seed reliefs (auto_additive).                    # T0475-DC-MIG104-GUARD
_dc_mig104_stem="migrations/104_capability_grants_l4_seed.sql"                  # T0475-DC-MIG104-GUARD
if [[ "${_dc_mig104_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig104_stem}"; then # T0475-DC-MIG104-GUARD
  _dc_mig104_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig104_stem}" 2>/dev/null || true)"  # T0475-DC-MIG104-GUARD
  _dc_mig104_bad=0                                                             # T0475-DC-MIG104-GUARD
  # 104 must add NO table/RLS/policy (pure seed) ...                          # T0475-DC-MIG104-GUARD
  if echo "${_dc_mig104_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0475-DC-MIG104-GUARD
    _dc_mig104_bad=1                                                           # T0475-DC-MIG104-GUARD introduces DDL/RLS
  fi                                                                           # T0475-DC-MIG104-GUARD
  # ... and must NOT create/alter the dual-control authority domain ...       # T0475-DC-MIG104-GUARD
  if echo "${_dc_mig104_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0475-DC-MIG104-GUARD
    _dc_mig104_bad=1                                                           # T0475-DC-MIG104-GUARD touches authority domain
  fi                                                                           # T0475-DC-MIG104-GUARD
  # ... and must NOT touch the confirmed2_by invariant.                       # T0475-DC-MIG104-GUARD
  if echo "${_dc_mig104_content}" | grep -iqE "confirmed2_by"; then           # T0475-DC-MIG104-GUARD
    _dc_mig104_bad=1                                                           # T0475-DC-MIG104-GUARD touches confirmed2_by invariant
  fi                                                                           # T0475-DC-MIG104-GUARD
  if [[ "${_dc_mig104_bad}" -eq 0 ]]; then                                    # T0475-DC-MIG104-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0475-DC-MIG104-GUARD cancel false-red
    _dc_mig104_failed=0                                                        # T0475-DC-MIG104-GUARD
    echo "PASS [FF-DC7-T0475-capability-grants-seed]: migration 104_capability_grants_l4_seed.sql is a pure INSERT seed of two capability-grant rows (confirmed_by='seed') — NO CREATE TABLE/RLS/POLICY, does NOT alter confirmed2_by/dual-control authority machinery — relief granted" # T0475-DC-MIG104-GUARD
  fi                                                                           # T0475-DC-MIG104-GUARD
fi                                                                             # T0475-DC-MIG104-GUARD
# T-0476: additive relief for migration 106_app_secret_store.sql. Like 074/075, # T0476-DC-MIG106-GUARD
# 106 IS a new tenant table (app_secret — the app:// encrypted secret store,   # T0476-DC-MIG106-GUARD
# AES-256-GCM ciphertext+nonce, FORCE RLS) — but it is UNRELATED to the         # T0476-DC-MIG106-GUARD
# dual-control authority domain (grant / confirmation / confirmed2_by). T-0044's # T0476-DC-MIG106-GUARD
# real invariant — 031 is the ONLY dual-control migration, confirmed2_by stays  # T0476-DC-MIG106-GUARD
# a derived additive column — is NOT touched by an encrypted-key store. Same     # T0476-DC-MIG106-GUARD
# class as the T-0252 migration-074 / T-0270 migration-075 table-add reliefs.    # T0476-DC-MIG106-GUARD
# Sanctioned in data/frozen-sanctions.jsonl (auto_additive). Cancels ONLY the    # T0476-DC-MIG106-GUARD
# _dc_mig106_failed increment; fires only after independently verifying 106 does # T0476-DC-MIG106-GUARD
# NOT create/alter any grant/confirmation/authority table and does NOT touch     # T0476-DC-MIG106-GUARD
# confirmed2_by.                                                                 # T0476-DC-MIG106-GUARD
_dc_mig106_stem="migrations/106_app_secret_store.sql"                            # T0476-DC-MIG106-GUARD
if [[ "${_dc_mig106_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig106_stem}"; then # T0476-DC-MIG106-GUARD
  _dc_mig106_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig106_stem}" 2>/dev/null || true)"  # T0476-DC-MIG106-GUARD
  _dc_mig106_bad=0                                                             # T0476-DC-MIG106-GUARD
  # 106 must not create/alter the dual-control authority domain (grant/confirmation/authority). # T0476-DC-MIG106-GUARD
  if echo "${_dc_mig106_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0476-DC-MIG106-GUARD
    _dc_mig106_bad=1                                                           # T0476-DC-MIG106-GUARD touches authority domain
  fi                                                                           # T0476-DC-MIG106-GUARD
  # ... and must NOT touch the confirmed2_by invariant.                       # T0476-DC-MIG106-GUARD
  if echo "${_dc_mig106_content}" | grep -iqE "confirmed2_by"; then           # T0476-DC-MIG106-GUARD
    _dc_mig106_bad=1                                                           # T0476-DC-MIG106-GUARD touches confirmed2_by invariant
  fi                                                                           # T0476-DC-MIG106-GUARD
  if [[ "${_dc_mig106_bad}" -eq 0 ]]; then                                    # T0476-DC-MIG106-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0476-DC-MIG106-GUARD cancel false-red
    _dc_mig106_failed=0                                                        # T0476-DC-MIG106-GUARD
    echo "PASS [FF-DC7-T0476-app-secret-store]: migration 106_app_secret_store.sql creates app_secret (app:// encrypted key store, FORCE RLS) — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0476-DC-MIG106-GUARD
  fi                                                                           # T0476-DC-MIG106-GUARD
fi                                                                             # T0476-DC-MIG106-GUARD
# T-0477: additive relief for migration 107_spend_ledger_llm_tracking.sql.   # T0477-DC-MIG107-GUARD
# 107 is an ADDITIVE EXTENSION of the EXISTING spend_ledger table (migration  # T0477-DC-MIG107-GUARD
# 034) for LLM cost-tracking: it ONLY does ALTER TABLE ... DROP NOT NULL on   # T0477-DC-MIG107-GUARD
# reservation_id/employee_id, ADD COLUMN IF NOT EXISTS (llm_connection_id +   # T0477-DC-MIG107-GUARD
# prompt/completion/total token counts), one guarded FK, and CREATE INDEX IF  # T0477-DC-MIG107-GUARD
# NOT EXISTS. NO CREATE TABLE, NO new RLS/POLICY (034's append-only trigger +  # T0477-DC-MIG107-GUARD
# RLS are preserved as-is), NO new tenant table. It is UNRELATED to the        # T0477-DC-MIG107-GUARD
# dual-control authority domain (grant / confirmation / confirmed2_by).        # T0477-DC-MIG107-GUARD
# T-0044's real invariant — 031 is the ONLY dual-control migration,            # T0477-DC-MIG107-GUARD
# confirmed2_by stays a derived additive column — is NOT touched by a spend    # T0477-DC-MIG107-GUARD
# ledger extension. Same PURE-additive class as the T-0244 migration-073 /     # T0477-DC-MIG107-GUARD
# T-0354 migration-083 seeds and the T-0475 migration-104 capability-grant     # T0477-DC-MIG107-GUARD
# seed — no CREATE TABLE, no grant/dual-control mutation. Sanctioned in        # T0477-DC-MIG107-GUARD
# data/frozen-sanctions.jsonl (auto_additive). Cancels ONLY the               # T0477-DC-MIG107-GUARD
# _dc_mig107_failed increment; fires only after independently verifying 107    # T0477-DC-MIG107-GUARD
# has NO CREATE TABLE/RLS/POLICY, does NOT create/alter any                    # T0477-DC-MIG107-GUARD
# grant/confirmation/authority table, and does NOT touch confirmed2_by.        # T0477-DC-MIG107-GUARD
_dc_mig107_stem="migrations/107_spend_ledger_llm_tracking.sql"                  # T0477-DC-MIG107-GUARD
if [[ "${_dc_mig107_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig107_stem}"; then # T0477-DC-MIG107-GUARD
  _dc_mig107_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig107_stem}" 2>/dev/null || true)"  # T0477-DC-MIG107-GUARD
  _dc_mig107_bad=0                                                             # T0477-DC-MIG107-GUARD
  # 107 must add NO table/RLS/policy (additive ALTER + index only) ...        # T0477-DC-MIG107-GUARD
  if echo "${_dc_mig107_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0477-DC-MIG107-GUARD
    _dc_mig107_bad=1                                                           # T0477-DC-MIG107-GUARD introduces DDL/RLS
  fi                                                                           # T0477-DC-MIG107-GUARD
  # ... and must NOT create/alter the dual-control authority domain ...       # T0477-DC-MIG107-GUARD
  if echo "${_dc_mig107_content}" | grep -iqE "(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+[^;]*(grant|confirmation|authority)"; then # T0477-DC-MIG107-GUARD
    _dc_mig107_bad=1                                                           # T0477-DC-MIG107-GUARD touches authority domain
  fi                                                                           # T0477-DC-MIG107-GUARD
  # ... and must NOT touch the confirmed2_by invariant.                       # T0477-DC-MIG107-GUARD
  if echo "${_dc_mig107_content}" | grep -iqE "confirmed2_by"; then           # T0477-DC-MIG107-GUARD
    _dc_mig107_bad=1                                                           # T0477-DC-MIG107-GUARD touches confirmed2_by invariant
  fi                                                                           # T0477-DC-MIG107-GUARD
  if [[ "${_dc_mig107_bad}" -eq 0 ]]; then                                    # T0477-DC-MIG107-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0477-DC-MIG107-GUARD cancel false-red
    _dc_mig107_failed=0                                                        # T0477-DC-MIG107-GUARD
    echo "PASS [FF-DC7-T0477-spend-ledger-llm-tracking]: migration 107_spend_ledger_llm_tracking.sql is an ADDITIVE extension of the existing spend_ledger (ALTER DROP NOT NULL + ADD COLUMN + index, no CREATE TABLE/RLS/POLICY) — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0477-DC-MIG107-GUARD
  fi                                                                           # T0477-DC-MIG107-GUARD
fi                                                                             # T0477-DC-MIG107-GUARD
# T-0397: relief for migration 109_dual_control_pdp_backfill.sql.            # T0397-DC-MIG109-GUARD
# UNLIKE every other relief above (which are UNRELATED stores and must NOT   # T0397-DC-MIG109-GUARD
# touch confirmed2_by), 109 is the PDP dual-control read-hole fix: it is a    # T0397-DC-MIG109-GUARD
# PURE DML BACKFILL that DELIBERATELY writes confirmed2_by (UPDATE … SET      # T0397-DC-MIG109-GUARD
# confirmed2_by = confirmed_by) for pre-existing active critical grants/      # T0397-DC-MIG109-GUARD
# assignments, so tightening the grants-dao.ts read-path is NON-BREAKING.     # T0397-DC-MIG109-GUARD
# This does NOT violate the FF-DC7 invariant — that invariant is "031 is the  # T0397-DC-MIG109-GUARD
# ONLY migration that defines/ALTERS the confirmed2_by COLUMN STRUCTURE, and  # T0397-DC-MIG109-GUARD
# confirmed2_by stays a derived additive column." 109 adds NO column, alters  # T0397-DC-MIG109-GUARD
# NO schema, creates NO table/RLS/policy: it only SETS DATA. The relief       # T0397-DC-MIG109-GUARD
# therefore ALLOWS the confirmed2_by reference (the backfill's whole point)   # T0397-DC-MIG109-GUARD
# but FAIL-CLOSED forbids ANY DDL — CREATE/ALTER/DROP TABLE, ADD/DROP COLUMN, # T0397-DC-MIG109-GUARD
# RLS, or POLICY. Cancels ONLY the _dc_mig109_failed increment (set in the    # T0397-DC-MIG109-GUARD
# loop above exclusively when 109 is the unexpected file), scoped exactly.    # T0397-DC-MIG109-GUARD
_dc_mig109_stem="migrations/109_dual_control_pdp_backfill.sql"                   # T0397-DC-MIG109-GUARD
if [[ "${_dc_mig109_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig109_stem}"; then # T0397-DC-MIG109-GUARD
  _dc_mig109_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig109_stem}" 2>/dev/null || true)"  # T0397-DC-MIG109-GUARD
  _dc_mig109_bad=0                                                             # T0397-DC-MIG109-GUARD
  # 109 must add NO table/RLS/policy (pure DML backfill only).                # T0397-DC-MIG109-GUARD
  if echo "${_dc_mig109_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0397-DC-MIG109-GUARD
    _dc_mig109_bad=1                                                           # T0397-DC-MIG109-GUARD introduces DDL/RLS
  fi                                                                           # T0397-DC-MIG109-GUARD
  # 109 must NOT ALTER any table structure (no ADD/DROP/ALTER COLUMN) — the   # T0397-DC-MIG109-GUARD
  # confirmed2_by COLUMN STRUCTURE belongs to 031 alone; 109 only writes DATA.# T0397-DC-MIG109-GUARD
  if echo "${_dc_mig109_content}" | grep -iqE "ALTER[[:space:]]+TABLE|ADD[[:space:]]+COLUMN|DROP[[:space:]]+COLUMN|DROP[[:space:]]+TABLE"; then # T0397-DC-MIG109-GUARD
    _dc_mig109_bad=1                                                           # T0397-DC-MIG109-GUARD touches column/table structure
  fi                                                                           # T0397-DC-MIG109-GUARD
  if [[ "${_dc_mig109_bad}" -eq 0 ]]; then                                    # T0397-DC-MIG109-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0397-DC-MIG109-GUARD cancel false-red
    _dc_mig109_failed=0                                                        # T0397-DC-MIG109-GUARD
    echo "PASS [FF-DC7-T0397-pdp-dual-control-backfill]: migration 109_dual_control_pdp_backfill.sql is a PURE DML BACKFILL (UPDATE … SET confirmed2_by = confirmed_by for pre-existing active critical rows; no CREATE/ALTER/DROP TABLE, no ADD/DROP COLUMN, no RLS/POLICY) — the confirmed2_by COLUMN STRUCTURE is untouched (still owned by 031); enforcement is the grants-dao.ts read-path change — relief granted" # T0397-DC-MIG109-GUARD
  fi                                                                           # T0397-DC-MIG109-GUARD
fi                                                                             # T0397-DC-MIG109-GUARD
# T-0574: additive relief for 115_assistant_agent_card_backfill.sql — PURE DML     # T0574-DC-MIG115-GUARD
# backfill (INSERT agent_card rows for pre-existing assistant-agent employees).    # T0574-DC-MIG115-GUARD
# Same scoped-relief class as 073/109; sanctioned in data/frozen-sanctions.jsonl.  # T0574-DC-MIG115-GUARD
_dc_mig115_stem="migrations/115_assistant_agent_card_backfill.sql"                 # T0574-DC-MIG115-GUARD
if [[ "${_dc_mig115_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig115_stem}"; then # T0574-DC-MIG115-GUARD
  _dc_mig115_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig115_stem}" 2>/dev/null || true)"  # T0574-DC-MIG115-GUARD
  _dc_mig115_bad=0                                                             # T0574-DC-MIG115-GUARD
  if echo "${_dc_mig115_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0574-DC-MIG115-GUARD
    _dc_mig115_bad=1                                                           # T0574-DC-MIG115-GUARD introduces DDL/RLS
  fi                                                                           # T0574-DC-MIG115-GUARD
  if echo "${_dc_mig115_content}" | grep -iqE "ALTER[[:space:]]+TABLE|ADD[[:space:]]+COLUMN|DROP[[:space:]]+COLUMN|DROP[[:space:]]+TABLE"; then # T0574-DC-MIG115-GUARD
    _dc_mig115_bad=1                                                           # T0574-DC-MIG115-GUARD touches column/table structure
  fi                                                                           # T0574-DC-MIG115-GUARD
  if [[ "${_dc_mig115_bad}" -eq 0 ]]; then                                    # T0574-DC-MIG115-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0574-DC-MIG115-GUARD cancel false-red
    _dc_mig115_failed=0                                                        # T0574-DC-MIG115-GUARD
    echo "PASS [FF-DC7-T0574-assistant-backfill]: migration 115 is a PURE DML BACKFILL (INSERT agent_card for assistant-agent employees; no CREATE/ALTER/DROP TABLE, no ADD/DROP COLUMN, no RLS/POLICY) — dual-control confirmed2_by structure untouched — relief granted" # T0574-DC-MIG115-GUARD
  fi                                                                           # T0574-DC-MIG115-GUARD
fi                                                                             # T0574-DC-MIG115-GUARD
# T-0574: additive relief for 116_composite_fk_set_null_columns.sql —              # T0574-DC-MIG116-GUARD
# CONSTRAINT-ONLY fix: composite ON DELETE SET NULL nulled NOT-NULL tenant_id       # T0574-DC-MIG116-GUARD
# (FKs from 094/107/113) → re-declared with column-scoped SET NULL. ALTER TABLE     # T0574-DC-MIG116-GUARD
# DROP/ADD CONSTRAINT only: no new table, no column add/drop, no RLS — the          # T0574-DC-MIG116-GUARD
# FF-DC7 invariant (derived decision, no new TABLE/RLS) holds. Migration 116 itself # T0574-DC-MIG116-GUARD
# is a rider (chip task_66d8af7a, commit 9efede7) that landed on this branch, not   # T0574-DC-MIG116-GUARD
# authored by the T-0574 coder — sanctioned as honest/additive by review 638901e    # T0574-DC-MIG116-GUARD
# (R-1); this relief block only grants the FF-DC7 exemption, it does not relax the  # T0574-DC-MIG116-GUARD
# content-verification below.                                                       # T0574-DC-MIG116-GUARD
_dc_mig116_stem="migrations/116_composite_fk_set_null_columns.sql"                 # T0574-DC-MIG116-GUARD
if [[ "${_dc_mig116_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig116_stem}"; then # T0574-DC-MIG116-GUARD
  _dc_mig116_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig116_stem}" 2>/dev/null || true)"  # T0574-DC-MIG116-GUARD
  _dc_mig116_bad=0                                                             # T0574-DC-MIG116-GUARD
  if echo "${_dc_mig116_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0574-DC-MIG116-GUARD
    _dc_mig116_bad=1                                                           # T0574-DC-MIG116-GUARD introduces DDL/RLS
  fi                                                                           # T0574-DC-MIG116-GUARD
  if echo "${_dc_mig116_content}" | grep -iqE "ADD[[:space:]]+COLUMN|DROP[[:space:]]+COLUMN|DROP[[:space:]]+TABLE"; then # T0574-DC-MIG116-GUARD
    _dc_mig116_bad=1                                                           # T0574-DC-MIG116-GUARD touches column/table structure
  fi                                                                           # T0574-DC-MIG116-GUARD
  if ! echo "${_dc_mig116_content}" | grep -iqE "(DROP|ADD)[[:space:]]+CONSTRAINT"; then # T0574-DC-MIG116-GUARD
    _dc_mig116_bad=1                                                           # T0574-DC-MIG116-GUARD must actually be a constraint fix
  fi                                                                           # T0574-DC-MIG116-GUARD
  if [[ "${_dc_mig116_bad}" -eq 0 ]]; then                                    # T0574-DC-MIG116-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0574-DC-MIG116-GUARD cancel false-red
    _dc_mig116_failed=0                                                        # T0574-DC-MIG116-GUARD
    echo "PASS [FF-DC7-T0574-composite-fk-fix]: migration 116 is CONSTRAINT-ONLY (DROP/ADD CONSTRAINT with column-scoped SET NULL; no CREATE TABLE, no ADD/DROP COLUMN, no RLS/POLICY) — relief granted" # T0574-DC-MIG116-GUARD
  fi                                                                           # T0574-DC-MIG116-GUARD
fi                                                                             # T0574-DC-MIG116-GUARD
# T-0570: additive relief for migration 117_default_read_grant_backfill.sql.  # T0570-DC-MIG117-GUARD
# 117 is a PURE SEED — INSERT ... SELECT ... FROM choros.tenant rows into the # T0570-DC-MIG117-GUARD
# EXISTING role/role_assignment/grant tables (migrations 019/020/008). Zero   # T0570-DC-MIG117-GUARD
# DDL: no CREATE/ALTER/DROP TABLE, no RLS/POLICY change. The seeded rows use   # T0570-DC-MIG117-GUARD
# plain confirmed_by='migration-117' (ordinary confirmation, same shape as    # T0570-DC-MIG117-GUARD
# every other pre-existing role_assignment/grant seed) — 117 does NOT touch   # T0570-DC-MIG117-GUARD
# confirmed2_by at all (dual-control's own column, owned by 031). Same class  # T0570-DC-MIG117-GUARD
# as the T-0475 migration-104 capability-grant seed relief (auto_additive).   # T0570-DC-MIG117-GUARD
_dc_mig117_stem="migrations/117_default_read_grant_backfill.sql"                 # T0570-DC-MIG117-GUARD
if [[ "${_dc_mig117_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig117_stem}"; then # T0570-DC-MIG117-GUARD
  _dc_mig117_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig117_stem}" 2>/dev/null || true)"  # T0570-DC-MIG117-GUARD
  _dc_mig117_bad=0                                                             # T0570-DC-MIG117-GUARD
  # 117 must add NO table/RLS/policy (pure seed) ...                          # T0570-DC-MIG117-GUARD
  if echo "${_dc_mig117_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0570-DC-MIG117-GUARD
    _dc_mig117_bad=1                                                           # T0570-DC-MIG117-GUARD introduces DDL/RLS
  fi                                                                           # T0570-DC-MIG117-GUARD
  # ... and must NOT touch the confirmed2_by invariant.                       # T0570-DC-MIG117-GUARD
  if echo "${_dc_mig117_content}" | grep -iqE "confirmed2_by"; then           # T0570-DC-MIG117-GUARD
    _dc_mig117_bad=1                                                           # T0570-DC-MIG117-GUARD touches confirmed2_by invariant
  fi                                                                           # T0570-DC-MIG117-GUARD
  if [[ "${_dc_mig117_bad}" -eq 0 ]]; then                                    # T0570-DC-MIG117-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0570-DC-MIG117-GUARD cancel false-red
    _dc_mig117_failed=0                                                        # T0570-DC-MIG117-GUARD
    echo "PASS [FF-DC7-T0570-read-pdp-grant-backfill]: migration 117_default_read_grant_backfill.sql is a pure INSERT…SELECT seed (role-reader + role_assignment + read/record grant rows, confirmed_by='migration-117') — NO CREATE TABLE/RLS/POLICY, does NOT touch confirmed2_by/dual-control authority machinery — relief granted" # T0570-DC-MIG117-GUARD
  fi                                                                           # T0570-DC-MIG117-GUARD
fi                                                                             # T0570-DC-MIG117-GUARD
# T-0573: additive relief for migration 118_assistant_tenant_zero_backfill.sql. # T0573-DC-MIG118-GUARD
# 118 is a PURE SEED — INSERT ... SELECT ... FROM choros.tenant rows into the  # T0573-DC-MIG118-GUARD
# EXISTING role/employee/agent_card/role_assignment/grant tables (migrations   # T0573-DC-MIG118-GUARD
# 008/019/020/032/093). Zero DDL: no CREATE/ALTER/DROP TABLE, no RLS/POLICY    # T0573-DC-MIG118-GUARD
# change. The seeded role_assignment/grant rows use plain confirmed_by=       # T0573-DC-MIG118-GUARD
# 'backfill' (ordinary confirmation, same shape as register.ts's own          # T0573-DC-MIG118-GUARD
# 'registration' marker) — 118 does NOT touch confirmed2_by at all (dual-     # T0573-DC-MIG118-GUARD
# control's own column, owned by 031). Same class as the T-0570 migration-117 # T0573-DC-MIG118-GUARD
# and T-0574 migration-115 pure-seed reliefs (auto_additive).                 # T0573-DC-MIG118-GUARD
_dc_mig118_stem="migrations/118_assistant_tenant_zero_backfill.sql"              # T0573-DC-MIG118-GUARD
if [[ "${_dc_mig118_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig118_stem}"; then # T0573-DC-MIG118-GUARD
  _dc_mig118_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig118_stem}" 2>/dev/null || true)"  # T0573-DC-MIG118-GUARD
  _dc_mig118_bad=0                                                             # T0573-DC-MIG118-GUARD
  # 118 must add NO table/RLS/policy (pure seed) ...                          # T0573-DC-MIG118-GUARD
  if echo "${_dc_mig118_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0573-DC-MIG118-GUARD
    _dc_mig118_bad=1                                                           # T0573-DC-MIG118-GUARD introduces DDL/RLS
  fi                                                                           # T0573-DC-MIG118-GUARD
  # ... must add NO column/ALTER (pure INSERT only) ...                       # T0573-DC-MIG118-GUARD
  if echo "${_dc_mig118_content}" | grep -iqE "ALTER[[:space:]]+TABLE|ADD[[:space:]]+COLUMN|DROP[[:space:]]+COLUMN|DROP[[:space:]]+TABLE"; then # T0573-DC-MIG118-GUARD
    _dc_mig118_bad=1                                                           # T0573-DC-MIG118-GUARD touches column/table structure
  fi                                                                           # T0573-DC-MIG118-GUARD
  # ... and must NOT touch the confirmed2_by invariant.                       # T0573-DC-MIG118-GUARD
  if echo "${_dc_mig118_content}" | grep -iqE "confirmed2_by"; then           # T0573-DC-MIG118-GUARD
    _dc_mig118_bad=1                                                           # T0573-DC-MIG118-GUARD touches confirmed2_by invariant
  fi                                                                           # T0573-DC-MIG118-GUARD
  if [[ "${_dc_mig118_bad}" -eq 0 ]]; then                                    # T0573-DC-MIG118-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0573-DC-MIG118-GUARD cancel false-red
    _dc_mig118_failed=0                                                        # T0573-DC-MIG118-GUARD
    echo "PASS [FF-DC7-T0573-assistant-tenant-zero-backfill]: migration 118_assistant_tenant_zero_backfill.sql is a pure INSERT…SELECT seed (role-configurator + assistant-agent employee + agent_card + role_assignment + grant rows, confirmed_by='backfill') — NO CREATE TABLE/RLS/POLICY, does NOT touch confirmed2_by/dual-control authority machinery — relief granted" # T0573-DC-MIG118-GUARD
  fi                                                                           # T0573-DC-MIG118-GUARD
fi                                                                             # T0573-DC-MIG118-GUARD
# T-0575: additive relief for migration 119_process_app_binding_target_registry_slug.sql. # T0575-DC-MIG119-GUARD
# 119 ALTERs the EXISTING process_app_binding table (075/082 precedent),      # T0575-DC-MIG119-GUARD
# adding ONE nullable column (target_registry_slug) + a keyed, idempotent     # T0575-DC-MIG119-GUARD
# UPDATE completing the ТЭЛ binding row's data. No new TABLE, no new RLS      # T0575-DC-MIG119-GUARD
# policy, no confirmed2_by touch — UNRELATED to the dual-control authority    # T0575-DC-MIG119-GUARD
# domain (grant/confirmation/confirmed2_by). Same class as the 082 relief.    # T0575-DC-MIG119-GUARD
_dc_mig119_stem="migrations/119_process_app_binding_target_registry_slug.sql"     # T0575-DC-MIG119-GUARD
if [[ "${_dc_mig119_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig119_stem}"; then # T0575-DC-MIG119-GUARD
  _dc_mig119_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig119_stem}" 2>/dev/null || true)"  # T0575-DC-MIG119-GUARD
  _dc_mig119_bad=0                                                             # T0575-DC-MIG119-GUARD
  if echo "${_dc_mig119_content}" | grep -iqE "(CREATE|DROP)[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0575-DC-MIG119-GUARD
    _dc_mig119_bad=1                                                           # T0575-DC-MIG119-GUARD introduces DDL/RLS
  fi                                                                           # T0575-DC-MIG119-GUARD
  if echo "${_dc_mig119_content}" | grep -iqE "confirmed2_by"; then           # T0575-DC-MIG119-GUARD
    _dc_mig119_bad=1                                                           # T0575-DC-MIG119-GUARD touches confirmed2_by invariant
  fi                                                                           # T0575-DC-MIG119-GUARD
  if [[ "${_dc_mig119_bad}" -eq 0 ]]; then                                    # T0575-DC-MIG119-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0575-DC-MIG119-GUARD cancel false-red
    _dc_mig119_failed=0                                                        # T0575-DC-MIG119-GUARD
    echo "PASS [FF-DC7-T0575-target-registry-slug]: migration 119_process_app_binding_target_registry_slug.sql adds ONE nullable column to process_app_binding + a keyed data-completion UPDATE — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0575-DC-MIG119-GUARD
  fi                                                                           # T0575-DC-MIG119-GUARD
fi                                                                             # T0575-DC-MIG119-GUARD
# T-0594: additive relief for migration 120_ownerless_tenant_zero_unarm.sql.   # T0594-DC-MIG120-GUARD
# 120 is a PURE DML DELETE (T-0573 review finding R-2): it removes the        # T0594-DC-MIG120-GUARD
# dangling role-configurator armament (assistant-agent role_assignment +     # T0594-DC-MIG120-GUARD
# 4 grants, both migration-118-backfill-marked source/confirmed_by=          # T0594-DC-MIG120-GUARD
# 'backfill') for tenants that have NO confirmed role_assignment on role     # T0594-DC-MIG120-GUARD
# slug='tenant-owner'. Zero DDL: no CREATE/ALTER/DROP TABLE, no ADD/DROP     # T0594-DC-MIG120-GUARD
# COLUMN, no RLS/POLICY — only two DELETE ... USING statements against the   # T0594-DC-MIG120-GUARD
# EXISTING role_assignment/grant tables (008/020/032). 120 does NOT touch    # T0594-DC-MIG120-GUARD
# confirmed2_by at all (dual-control's own column, owned by 031). Same class # T0594-DC-MIG120-GUARD
# as the T-0397 migration-109 pure-DML-over-protected-tables relief (there   # T0594-DC-MIG120-GUARD
# UPDATE, here DELETE — same fail-closed DDL/confirmed2_by guard shape).     # T0594-DC-MIG120-GUARD
_dc_mig120_stem="migrations/120_ownerless_tenant_zero_unarm.sql"                 # T0594-DC-MIG120-GUARD
if [[ "${_dc_mig120_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig120_stem}"; then # T0594-DC-MIG120-GUARD
  _dc_mig120_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig120_stem}" 2>/dev/null || true)"  # T0594-DC-MIG120-GUARD
  _dc_mig120_bad=0                                                             # T0594-DC-MIG120-GUARD
  # 120 must add NO table/RLS/policy (pure DELETE only) ...                   # T0594-DC-MIG120-GUARD
  if echo "${_dc_mig120_content}" | grep -iqE "CREATE[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0594-DC-MIG120-GUARD
    _dc_mig120_bad=1                                                           # T0594-DC-MIG120-GUARD introduces DDL/RLS
  fi                                                                           # T0594-DC-MIG120-GUARD
  # ... must add/alter NO column/table (pure DELETE only) ...                 # T0594-DC-MIG120-GUARD
  if echo "${_dc_mig120_content}" | grep -iqE "ALTER[[:space:]]+TABLE|ADD[[:space:]]+COLUMN|DROP[[:space:]]+COLUMN|DROP[[:space:]]+TABLE"; then # T0594-DC-MIG120-GUARD
    _dc_mig120_bad=1                                                           # T0594-DC-MIG120-GUARD touches column/table structure
  fi                                                                           # T0594-DC-MIG120-GUARD
  # ... and must NOT touch the confirmed2_by invariant.                      # T0594-DC-MIG120-GUARD
  if echo "${_dc_mig120_content}" | grep -iqE "confirmed2_by"; then           # T0594-DC-MIG120-GUARD
    _dc_mig120_bad=1                                                           # T0594-DC-MIG120-GUARD touches confirmed2_by invariant
  fi                                                                           # T0594-DC-MIG120-GUARD
  if [[ "${_dc_mig120_bad}" -eq 0 ]]; then                                    # T0594-DC-MIG120-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0594-DC-MIG120-GUARD cancel false-red
    _dc_mig120_failed=0                                                        # T0594-DC-MIG120-GUARD
    echo "PASS [FF-DC7-T0594-ownerless-tenant-zero-unarm]: migration 120_ownerless_tenant_zero_unarm.sql is a pure DELETE (removes backfill-marked role_assignment/grant rows on role-configurator for tenants without a confirmed tenant-owner) — NO CREATE/ALTER/DROP TABLE, NO ADD/DROP COLUMN, NO RLS/POLICY, does NOT touch confirmed2_by/dual-control authority machinery — relief granted" # T0594-DC-MIG120-GUARD
  fi                                                                           # T0594-DC-MIG120-GUARD
fi                                                                             # T0594-DC-MIG120-GUARD
# T-0604: additive relief for migration 121_process_app_binding_submit_task_key.sql. # T0604-DC-MIG121-GUARD
# 121 ALTERs the EXISTING process_app_binding table (075/082/119 precedent),   # T0604-DC-MIG121-GUARD
# adding ONE nullable column (submit_task_key) + a keyed, idempotent UPDATE    # T0604-DC-MIG121-GUARD
# completing the ТЭЛ binding row's data (submit_task_key='task-submit', the    # T0604-DC-MIG121-GUARD
# real first userTask of tel-linear.bpmn20.xml). No new TABLE, no new RLS     # T0604-DC-MIG121-GUARD
# policy, no confirmed2_by touch — UNRELATED to the dual-control authority    # T0604-DC-MIG121-GUARD
# domain (grant/confirmation/confirmed2_by). Same class as the 119 relief.    # T0604-DC-MIG121-GUARD
_dc_mig121_stem="migrations/121_process_app_binding_submit_task_key.sql"          # T0604-DC-MIG121-GUARD
if [[ "${_dc_mig121_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig121_stem}"; then # T0604-DC-MIG121-GUARD
  _dc_mig121_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig121_stem}" 2>/dev/null || true)"  # T0604-DC-MIG121-GUARD
  _dc_mig121_bad=0                                                             # T0604-DC-MIG121-GUARD
  if echo "${_dc_mig121_content}" | grep -iqE "(CREATE|DROP)[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0604-DC-MIG121-GUARD
    _dc_mig121_bad=1                                                           # T0604-DC-MIG121-GUARD introduces DDL/RLS
  fi                                                                           # T0604-DC-MIG121-GUARD
  if echo "${_dc_mig121_content}" | grep -iqE "confirmed2_by"; then           # T0604-DC-MIG121-GUARD
    _dc_mig121_bad=1                                                           # T0604-DC-MIG121-GUARD touches confirmed2_by invariant
  fi                                                                           # T0604-DC-MIG121-GUARD
  if [[ "${_dc_mig121_bad}" -eq 0 ]]; then                                    # T0604-DC-MIG121-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0604-DC-MIG121-GUARD cancel false-red
    _dc_mig121_failed=0                                                        # T0604-DC-MIG121-GUARD
    echo "PASS [FF-DC7-T0604-submit-task-key]: migration 121_process_app_binding_submit_task_key.sql adds ONE nullable column to process_app_binding + a keyed data-completion UPDATE — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0604-DC-MIG121-GUARD
  fi                                                                           # T0604-DC-MIG121-GUARD
fi                                                                             # T0604-DC-MIG121-GUARD
# T-0606: additive relief for migration 122_approval_registry_guard.sql.       # T0606-DC-MIG122-GUARD
# 122 ALTERs TWO EXISTING tables (process_app_binding: 075/082/119/121         # T0606-DC-MIG122-GUARD
# precedent; registry_def: 004 precedent), adding ONE nullable column to      # T0606-DC-MIG122-GUARD
# each (trigger_registry_id, engine_managed) + a keyed, idempotent UPDATE     # T0606-DC-MIG122-GUARD
# completing the ТЭЛ «Согласование» seed row's engine_managed flag. No new    # T0606-DC-MIG122-GUARD
# TABLE, no new RLS policy, no confirmed2_by touch — UNRELATED to the         # T0606-DC-MIG122-GUARD
# dual-control authority domain (grant/confirmation/confirmed2_by). Same     # T0606-DC-MIG122-GUARD
# class as the 119/121 reliefs.                                              # T0606-DC-MIG122-GUARD
_dc_mig122_stem="migrations/122_approval_registry_guard.sql"                  # T0606-DC-MIG122-GUARD
if [[ "${_dc_mig122_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig122_stem}"; then # T0606-DC-MIG122-GUARD
  _dc_mig122_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig122_stem}" 2>/dev/null || true)"  # T0606-DC-MIG122-GUARD
  _dc_mig122_bad=0                                                             # T0606-DC-MIG122-GUARD
  if echo "${_dc_mig122_content}" | grep -iqE "(CREATE|DROP)[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0606-DC-MIG122-GUARD
    _dc_mig122_bad=1                                                           # T0606-DC-MIG122-GUARD introduces DDL/RLS
  fi                                                                           # T0606-DC-MIG122-GUARD
  if echo "${_dc_mig122_content}" | grep -iqE "confirmed2_by"; then           # T0606-DC-MIG122-GUARD
    _dc_mig122_bad=1                                                           # T0606-DC-MIG122-GUARD touches confirmed2_by invariant
  fi                                                                           # T0606-DC-MIG122-GUARD
  if [[ "${_dc_mig122_bad}" -eq 0 ]]; then                                    # T0606-DC-MIG122-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0606-DC-MIG122-GUARD cancel false-red
    _dc_mig122_failed=0                                                        # T0606-DC-MIG122-GUARD
    echo "PASS [FF-DC7-T0606-approval-registry-guard]: migration 122_approval_registry_guard.sql adds ONE nullable/boolean column to EACH of process_app_binding + registry_def + a keyed data-completion UPDATE — does NOT touch dual-control authority domain (grant/confirmation/confirmed2_by) — relief granted" # T0606-DC-MIG122-GUARD
  fi                                                                           # T0606-DC-MIG122-GUARD
fi                                                                             # T0606-DC-MIG122-GUARD
# T-0619: additive relief for migration 123_read_grant_all_staff_backfill.sql — # T0619-DC-MIG123-GUARD
# pure INSERT…SELECT backfill (ensure role-reader role + read/record grant +    # T0619-DC-MIG123-GUARD
# role_assignment for every kind='human' staff member). No CREATE/DROP TABLE, no # T0619-DC-MIG123-GUARD
# RLS, no confirmed2_by — the T-0044 dual-control invariant (031 is the ONLY     # T0619-DC-MIG123-GUARD
# dual-control migration; confirmed2_by stays derived-additive) is UNTOUCHED.    # T0619-DC-MIG123-GUARD
# Like the sibling reliefs, this cancels ONLY the _dc_mig123_failed increment    # T0619-DC-MIG123-GUARD
# (set exclusively in the loop above when 123 is the unexpected file), scoped so # T0619-DC-MIG123-GUARD
# it cannot absorb any other migration's FF-DC7 failure.                         # T0619-DC-MIG123-GUARD
_dc_mig123_stem="migrations/123_read_grant_all_staff_backfill.sql"            # T0619-DC-MIG123-GUARD
if [[ "${_dc_mig123_failed}" -eq 1 ]] && echo "${CHANGED}" | grep -qxF "${_dc_mig123_stem}"; then # T0619-DC-MIG123-GUARD
  _dc_mig123_content="$(awk '/^[[:space:]]*--/{next}1' "${PROJECT_ROOT}/${_dc_mig123_stem}" 2>/dev/null || true)"  # T0619-DC-MIG123-GUARD
  _dc_mig123_bad=0                                                             # T0619-DC-MIG123-GUARD
  if echo "${_dc_mig123_content}" | grep -iqE "(CREATE|DROP)[[:space:]]+TABLE|ROW[[:space:]]+LEVEL[[:space:]]+SECURITY|CREATE[[:space:]]+POLICY"; then # T0619-DC-MIG123-GUARD
    _dc_mig123_bad=1                                                           # T0619-DC-MIG123-GUARD introduces DDL/RLS
  fi                                                                           # T0619-DC-MIG123-GUARD
  if echo "${_dc_mig123_content}" | grep -iqE "confirmed2_by"; then           # T0619-DC-MIG123-GUARD
    _dc_mig123_bad=1                                                           # T0619-DC-MIG123-GUARD touches confirmed2_by invariant
  fi                                                                           # T0619-DC-MIG123-GUARD
  if [[ "${_dc_mig123_bad}" -eq 0 ]]; then                                    # T0619-DC-MIG123-GUARD
    ERRORS=$(( ERRORS - 1 ))                                                   # T0619-DC-MIG123-GUARD cancel false-red
    _dc_mig123_failed=0                                                        # T0619-DC-MIG123-GUARD
    echo "PASS [FF-DC7-T0619-read-grant-staff]: migration 123_read_grant_all_staff_backfill.sql is pure INSERT…SELECT backfill (role-reader + read grant + human role_assignments, no CREATE TABLE/RLS/confirmed2_by) — does NOT touch dual-control authority domain — relief granted" # T0619-DC-MIG123-GUARD
  fi                                                                           # T0619-DC-MIG123-GUARD
fi                                                                             # T0619-DC-MIG123-GUARD
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
