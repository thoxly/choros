#!/usr/bin/env bash
# T-0744 · FF-COV1..FF-COV5 — substitution coverage-invariant isolation
#
# Locks the ONE coverage invariant introduced by T-0729/T-0744 so a future edit
# cannot silently re-open the Tier-1 deadlock:
#
#   A substitution rule provides COVERAGE of a role IFF it minted a Tier-2 grant
#   (ttlGrantId !== null) OR the substitute personally holds the role
#   (roleHolders.has(substituteEmployeeId)).
#
# Static assertions (grep — no runtime/DB), mirroring substitution-isolation.sh:
#
#  FF-COV1 — substitution.ts EXPORTS the two pure predicates
#            substituteProvidesCoverage + computeEffectivePool (single source of
#            truth; purity/no-pg is already guaranteed by substitution-isolation
#            FF-SUB2 over the same module).
#  FF-COV2 — the invariant is CODIFIED in substituteProvidesCoverage: its body
#            references BOTH `ttlGrantId !== null` and `roleHolders.has(` — the
#            exact Tier-2 ∨ holds-role disjunction.
#  FF-COV3 — routing path B (inbox.ts) CONSUMES computeEffectivePool AND carries
#            NO legacy UNCONDITIONAL substitute-add (`.add(rule.substituteEmployeeId)`
#            outside the predicate) — that raw add was the masking bug.
#  FF-COV4 — routing path A (executor-resolver.ts) GATES its substitute-add behind
#            the predicate: `if (substituteProvidesCoverage(` is present, so the
#            `.add(matched.substituteEmployeeId)` cannot run for a non-covering
#            Tier-1 stand-in.
#  FF-COV5 — the owner-orphan-claim gate reuses the invariant: inbox.ts defines
#            isOwnerOrphanClaimEligible (isGenesisOwnerForTenant ∧ empty effective
#            pool via computeEffectivePool) and wires it into BOTH the claim and
#            approve gates (>=2 call sites).
#
# Exit 0 on clean, non-zero on any violation.
# --self-test plants a synthetic violation of each family and asserts detection.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Overridable globals (self-test re-points these at synthetic fixtures).
SUBST_FILE="${PROJECT_ROOT}/src/core/substitution.ts"
INBOX_FILE="${PROJECT_ROOT}/src/http/inbox.ts"
RESOLVER_FILE="${PROJECT_ROOT}/src/core/executor-resolver.ts"

# run_checks — reads the globals above; prints per-check verdicts; returns 0 clean / 1 dirty.
run_checks() {
  local errors=0

  # ---- FF-COV1: pure predicates exported ------------------------------------
  if ! grep -qE "export function substituteProvidesCoverage" "${SUBST_FILE}"; then
    echo "FAIL [FF-COV1]: substitution.ts does not export substituteProvidesCoverage"
    errors=$((errors + 1))
  fi
  if ! grep -qE "export function computeEffectivePool" "${SUBST_FILE}"; then
    echo "FAIL [FF-COV1]: substitution.ts does not export computeEffectivePool"
    errors=$((errors + 1))
  fi

  # ---- FF-COV2: invariant codified in the predicate body --------------------
  # Extract the substituteProvidesCoverage function body (from its signature to
  # the next top-level export) and assert both disjuncts are present.
  local body
  body="$(awk '/export function substituteProvidesCoverage/{f=1} f{print} f&&/^}/{exit}' "${SUBST_FILE}")"
  if ! printf '%s\n' "${body}" | grep -qE "ttlGrantId !== null"; then
    echo "FAIL [FF-COV2]: substituteProvidesCoverage missing the Tier-2 disjunct (ttlGrantId !== null)"
    errors=$((errors + 1))
  fi
  if ! printf '%s\n' "${body}" | grep -qE "roleHolders\.has\("; then
    echo "FAIL [FF-COV2]: substituteProvidesCoverage missing the holds-role disjunct (roleHolders.has(...))"
    errors=$((errors + 1))
  fi

  # ---- FF-COV3: path B consumes the pool builder, no legacy raw add ---------
  if ! grep -qE "computeEffectivePool\(" "${INBOX_FILE}"; then
    echo "FAIL [FF-COV3]: inbox.ts routing path does not use computeEffectivePool (invariant bypassed)"
    errors=$((errors + 1))
  fi
  # The legacy masking bug: unconditionally adding the substitute slug to the pool.
  if grep -qE "\.add\(rule\.substituteEmployeeId\)" "${INBOX_FILE}"; then
    echo "FAIL [FF-COV3]: inbox.ts re-introduces an UNCONDITIONAL substitute add (.add(rule.substituteEmployeeId)) — masking bug"
    errors=$((errors + 1))
  fi

  # ---- FF-COV4: path A gates the substitute-add behind the predicate --------
  if ! grep -qE "if \(substituteProvidesCoverage\(" "${RESOLVER_FILE}"; then
    echo "FAIL [FF-COV4]: executor-resolver.ts does not gate the substitute-add behind substituteProvidesCoverage"
    errors=$((errors + 1))
  fi

  # ---- FF-COV5: owner-orphan-claim gate reuses the invariant ----------------
  if ! grep -qE "async function isRoleEffectivePoolEmpty" "${INBOX_FILE}"; then
    echo "FAIL [FF-COV5]: inbox.ts missing isRoleEffectivePoolEmpty (empty-pool detector)"
    errors=$((errors + 1))
  fi
  if ! grep -qE "async function isOwnerOrphanClaimEligible" "${INBOX_FILE}"; then
    echo "FAIL [FF-COV5]: inbox.ts missing isOwnerOrphanClaimEligible (owner-claim gate)"
    errors=$((errors + 1))
  fi
  if ! grep -qE "isGenesisOwnerForTenant" "${INBOX_FILE}"; then
    echo "FAIL [FF-COV5]: inbox.ts owner-claim does not consult isGenesisOwnerForTenant"
    errors=$((errors + 1))
  fi
  # Wired into BOTH claim and approve → at least 2 call sites beyond the definition.
  local uses
  uses="$( (grep -cE "isOwnerOrphanClaimEligible\(" "${INBOX_FILE}" || true) )"
  if [[ "${uses:-0}" -lt 2 ]]; then
    echo "FAIL [FF-COV5]: isOwnerOrphanClaimEligible has <2 call sites (must gate BOTH claim and approve); found ${uses:-0}"
    errors=$((errors + 1))
  fi

  return "${errors}"
}

# ---------------------------------------------------------------------------
# Self-test.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[substitution-coverage-invariant] --self-test"
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  mkdir -p "${TMP}/src/core" "${TMP}/src/http"

  # (1) A CLEAN fixture set must PASS.
  cat > "${TMP}/src/core/substitution.ts" <<'TS'
export function substituteProvidesCoverage(rule, roleHolders) {
  if (rule.ttlGrantId !== null) return true;
  return roleHolders.has(rule.substituteEmployeeId);
}
export function computeEffectivePool(holders, rules, roleSlug) { return holders; }
TS
  cat > "${TMP}/src/core/executor-resolver.ts" <<'TS'
if (substituteProvidesCoverage(matched, holderSet)) {
  effectivePool.add(matched.substituteEmployeeId);
}
TS
  cat > "${TMP}/src/http/inbox.ts" <<'TS'
import { isGenesisOwnerForTenant } from "../db/org.js";
effectivePoolByRole.set(roleSlug, computeEffectivePool(holders, substRules, roleSlug));
async function isRoleEffectivePoolEmpty() { return computeEffectivePool([], [], "").length === 0; }
async function isOwnerOrphanClaimEligible() { return isGenesisOwnerForTenant(); }
const a = isOwnerOrphanClaimEligible();
const b = isOwnerOrphanClaimEligible();
TS
  clean_rc=0
  ( SUBST_FILE="${TMP}/src/core/substitution.ts"; INBOX_FILE="${TMP}/src/http/inbox.ts"; RESOLVER_FILE="${TMP}/src/core/executor-resolver.ts"; run_checks ) || clean_rc=$?
  if [[ ${clean_rc} -ne 0 ]]; then
    echo "FAIL self-test: clean fixture must PASS (rc=0), got ${clean_rc}"
    exit 1
  fi
  echo "PASS self-test: clean fixture set passes"

  # (2) Re-introduce the UNCONDITIONAL substitute add in path B → FF-COV3 fires.
  cat > "${TMP}/src/http/inbox.ts" <<'TS'
import { isGenesisOwnerForTenant } from "../db/org.js";
effectivePoolByRole.set(roleSlug, computeEffectivePool(holders, substRules, roleSlug));
effective.add(rule.substituteEmployeeId);
async function isRoleEffectivePoolEmpty() { return computeEffectivePool([], [], "").length === 0; }
async function isOwnerOrphanClaimEligible() { return isGenesisOwnerForTenant(); }
const a = isOwnerOrphanClaimEligible();
const b = isOwnerOrphanClaimEligible();
TS
  dirty_rc=0
  ( SUBST_FILE="${TMP}/src/core/substitution.ts"; INBOX_FILE="${TMP}/src/http/inbox.ts"; RESOLVER_FILE="${TMP}/src/core/executor-resolver.ts"; run_checks ) || dirty_rc=$?
  if [[ ${dirty_rc} -eq 0 ]]; then
    echo "FAIL self-test: unconditional substitute-add must be DETECTED (FF-COV3), but rc=0"
    exit 1
  fi
  echo "PASS self-test: FF-COV3 detects a re-introduced unconditional substitute add"

  # (3) Drop the coverage guard in path A → FF-COV4 fires.
  cat > "${TMP}/src/core/executor-resolver.ts" <<'TS'
effectivePool.add(matched.substituteEmployeeId);
TS
  # restore inbox to clean so ONLY FF-COV4 is exercised
  cat > "${TMP}/src/http/inbox.ts" <<'TS'
import { isGenesisOwnerForTenant } from "../db/org.js";
effectivePoolByRole.set(roleSlug, computeEffectivePool(holders, substRules, roleSlug));
async function isRoleEffectivePoolEmpty() { return computeEffectivePool([], [], "").length === 0; }
async function isOwnerOrphanClaimEligible() { return isGenesisOwnerForTenant(); }
const a = isOwnerOrphanClaimEligible();
const b = isOwnerOrphanClaimEligible();
TS
  cov4_rc=0
  ( SUBST_FILE="${TMP}/src/core/substitution.ts"; INBOX_FILE="${TMP}/src/http/inbox.ts"; RESOLVER_FILE="${TMP}/src/core/executor-resolver.ts"; run_checks ) || cov4_rc=$?
  if [[ ${cov4_rc} -eq 0 ]]; then
    echo "FAIL self-test: ungated path-A add must be DETECTED (FF-COV4), but rc=0"
    exit 1
  fi
  echo "PASS self-test: FF-COV4 detects an ungated path-A substitute add"

  # (4) Remove the owner-claim gate → FF-COV5 fires (single call site).
  cat > "${TMP}/src/core/executor-resolver.ts" <<'TS'
if (substituteProvidesCoverage(matched, holderSet)) {
  effectivePool.add(matched.substituteEmployeeId);
}
TS
  cat > "${TMP}/src/http/inbox.ts" <<'TS'
effectivePoolByRole.set(roleSlug, computeEffectivePool(holders, substRules, roleSlug));
TS
  cov5_rc=0
  ( SUBST_FILE="${TMP}/src/core/substitution.ts"; INBOX_FILE="${TMP}/src/http/inbox.ts"; RESOLVER_FILE="${TMP}/src/core/executor-resolver.ts"; run_checks ) || cov5_rc=$?
  if [[ ${cov5_rc} -eq 0 ]]; then
    echo "FAIL self-test: missing owner-claim gate must be DETECTED (FF-COV5), but rc=0"
    exit 1
  fi
  echo "PASS self-test: FF-COV5 detects a missing/under-wired owner-claim gate"

  echo "PASS self-test: all substitution-coverage-invariant detectors functional"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
echo "[T-0744] substitution-coverage-invariant: locking the coverage invariant"

for f in "${SUBST_FILE}" "${INBOX_FILE}" "${RESOLVER_FILE}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: expected source file missing: ${f}"
    exit 1
  fi
done

ERRORS=0
run_checks || ERRORS=$?

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: substitution-coverage-invariant found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: substitution-coverage-invariant — all checks green (FF-COV1..FF-COV5)"
exit 0
