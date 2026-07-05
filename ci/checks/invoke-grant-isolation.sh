#!/usr/bin/env bash
# T-0024 · FF-IG-1..FF-IG-6: invoke-grant-isolation
#
# Static assertions (grep / git diff boundary analysis — no runtime, no DB) over
# the new invoke-grant module src/http/invoke.ts and the migration/registry:
#
#  IG-1 — invoke_proposal is a tenant table: present in known_tenant_tables.txt
#          AND migration 043 has ENABLE+FORCE RLS + isolation policy + choros_app grant.
#
#  IG-2 — Migration number discipline: T-0024 owns ONLY slot 043; no edit to 041/042.
#
#  IG-3 — resolveFor signature is unchanged (AC-14, additive-only).
#
#  IG-4 — grant-lattice.ts is byte-unmodified (AC-13: 122 fitness tests preserved;
#          no union edit).
#
#  IG-5 — No second authority store: src/http/invoke.ts derives the decision from
#          T-0018 grant rows only (no *_acl, field_visibility, record_rights,
#          or a local permission table).
#
#  IG-6 — Audit goes through the canonical seam only: invoke.ts imports
#          appendAuditEvent / makePgAuditWriter (via the grants audit helper or
#          db/audit-writer) and contains NO direct INSERT INTO audit_event / audit_head.
#
#  IG-7 — [T-0610, F-1 fix] Single grant-resolver: invoke.ts's caller-grant
#          lookup (loadCallerInvokeGrants) calls the SAME getGrantsForSubject
#          DAO every other PDP consumer uses (src/db/grants-dao.ts) — no bespoke
#          inline `JOIN choros.role_assignment` / bare `FROM choros."grant"`
#          query living in invoke.ts. This closes the security-review T-0605
#          F-1 finding: the OLD inline query had neither the T-0605 canonical
#          assignment-active predicate nor the T-0397 grant dual-control gate.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INVOKE_MODULE="${PROJECT_ROOT}/src/http/invoke.ts"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
MIGRATION_043="${PROJECT_ROOT}/migrations/043_invoke_proposal.sql"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
LATTICE="${PROJECT_ROOT}/src/core/grant-lattice.ts"
ERRORS=0

echo "[T-0024] invoke-grant-isolation: checking module boundary"

# ---- IG-1: invoke_proposal is a tenant table --------------------------------
echo ""
echo "Check IG-1: invoke_proposal in known_tenant_tables.txt + migration 043 RLS contract"

if ! grep -qx "invoke_proposal" "${KNOWN_TABLES}"; then
  echo "FAIL [IG-1]: 'invoke_proposal' not found in ${KNOWN_TABLES}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [IG-1a]: invoke_proposal listed in known_tenant_tables.txt"
fi

if [[ ! -f "${MIGRATION_043}" ]]; then
  echo "FAIL [IG-1]: ${MIGRATION_043} does not exist"
  ERRORS=$((ERRORS + 1))
else
  # Check ENABLE ROW LEVEL SECURITY (allow extra whitespace between tokens)
  if ! grep -iqE "ENABLE[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY" "${MIGRATION_043}"; then
    echo "FAIL [IG-1]: migration 043 missing ENABLE ROW LEVEL SECURITY"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [IG-1b]: migration 043 has ENABLE ROW LEVEL SECURITY"
  fi

  # Check FORCE ROW LEVEL SECURITY (allow extra whitespace between tokens)
  if ! grep -iqE "FORCE[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY" "${MIGRATION_043}"; then
    echo "FAIL [IG-1]: migration 043 missing FORCE ROW LEVEL SECURITY"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [IG-1c]: migration 043 has FORCE ROW LEVEL SECURITY"
  fi

  # Check tenant isolation policy (GUC reference)
  if ! grep -q "current_setting('choros.tenant_id'" "${MIGRATION_043}"; then
    echo "FAIL [IG-1]: migration 043 missing tenant isolation policy referencing choros.tenant_id"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [IG-1d]: migration 043 has tenant isolation policy"
  fi

  # Check choros_app grant
  if ! grep -iq "TO choros_app" "${MIGRATION_043}"; then
    echo "FAIL [IG-1]: migration 043 missing GRANT ... TO choros_app"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [IG-1e]: migration 043 grants DML to choros_app"
  fi
fi

# ---- IG-2: Migration number discipline: only 043 added, 041/042 untouched ----
echo ""
echo "Check IG-2: T-0024 owns ONLY migration slot 043; 041/042 not modified"

MERGE_BASE="$(git -C "${PROJECT_ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN [IG-2]: could not determine merge-base with dev; skipping migration-discipline diff check"
else
  # 043 must exist
  if [[ ! -f "${MIGRATION_043}" ]]; then
    echo "FAIL [IG-2]: migrations/043_invoke_proposal.sql does not exist"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [IG-2a]: migrations/043_invoke_proposal.sql exists"
  fi

  # 041 and 042 must NOT be modified by this branch
  for slot in 041 042; do
    modified=$(git -C "${PROJECT_ROOT}" diff --name-only "${MERGE_BASE}" -- "migrations/${slot}_*.sql" 2>/dev/null || true)
    if [[ -n "${modified}" ]]; then
      echo "FAIL [IG-2]: migrations slot ${slot} was modified by this branch: ${modified}"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS [IG-2b]: migration slot ${slot} is unmodified"
    fi
  done
fi

# ---- IG-3: resolveFor signature unchanged (AC-14) ---------------------------
echo ""
echo "Check IG-3: resolveFor signature byte-unchanged (AC-14)"

if [[ ! -f "${RESOLVER}" ]]; then
  echo "FAIL [IG-3]: ${RESOLVER} does not exist"
  ERRORS=$((ERRORS + 1))
else
  MERGE_BASE2="$(git -C "${PROJECT_ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
  if [[ -z "${MERGE_BASE2}" ]]; then
    echo "WARN [IG-3]: could not determine merge-base with dev; checking resolveFor signature in current file"
    if grep -q "export async function resolveFor(" "${RESOLVER}"; then
      echo "PASS [IG-3]: resolveFor export present in grant-resolver.ts"
    else
      echo "FAIL [IG-3]: resolveFor not found in grant-resolver.ts"
      ERRORS=$((ERRORS + 1))
    fi
  else
    changed=$(git -C "${PROJECT_ROOT}" diff "${MERGE_BASE2}" -- src/core/grant-resolver.ts 2>/dev/null | grep "^[+-]" | grep -v "^[+-][+-][+-]" | grep "resolveFor(" || true)
    if [[ -n "${changed}" ]]; then
      echo "FAIL [IG-3]: grant-resolver.ts resolveFor signature line changed:"
      echo "${changed}"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS [IG-3]: resolveFor signature unchanged"
    fi
  fi
fi

# ---- IG-4: grant-lattice.ts byte-unmodified (AC-13) -------------------------
echo ""
echo "Check IG-4: grant-lattice.ts byte-unmodified (AC-13)"

if [[ ! -f "${LATTICE}" ]]; then
  echo "FAIL [IG-4]: ${LATTICE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  MERGE_BASE3="$(git -C "${PROJECT_ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
  if [[ -z "${MERGE_BASE3}" ]]; then
    echo "WARN [IG-4]: could not determine merge-base with dev; skipping byte-diff check"
  else
    if git -C "${PROJECT_ROOT}" diff --quiet "${MERGE_BASE3}" -- src/core/grant-lattice.ts; then
      echo "PASS [IG-4]: grant-lattice.ts is byte-unmodified"
    else
      echo "FAIL [IG-4]: grant-lattice.ts was modified (must be frozen-seam)"
      git -C "${PROJECT_ROOT}" diff "${MERGE_BASE3}" -- src/core/grant-lattice.ts | head -20
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

# ---- IG-5: No second authority store in invoke.ts (FF-IG-5) -----------------
echo ""
echo "Check IG-5: no parallel-authority tokens in invoke.ts (no *_acl, field_visibility, etc.)"

if [[ ! -f "${INVOKE_MODULE}" ]]; then
  echo "FAIL [IG-5]: ${INVOKE_MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  PARALLEL_TOKENS=("_acl" "field_visibility" "record_rights" "invoke_acl")
  before_ig5=${ERRORS}
  for token in "${PARALLEL_TOKENS[@]}"; do
    matches=$(grep -nE "${token}" "${INVOKE_MODULE}" | grep -vE ":[[:space:]]*(//|\*)" || true)
    if [[ -n "${matches}" ]]; then
      echo "FAIL [IG-5]: invoke.ts references parallel-authority token '${token}' in non-comment code:"
      echo "${matches}"
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [[ ${ERRORS} -eq ${before_ig5} ]]; then
    echo "PASS [IG-5]: no parallel-authority tokens in invoke.ts"
  fi
fi

# ---- IG-6: Audit via canonical seam only (FF-IG-6) --------------------------
echo ""
echo "Check IG-6: invoke.ts uses canonical audit seam; no direct INSERT INTO audit_event/audit_head"

if [[ ! -f "${INVOKE_MODULE}" ]]; then
  echo "FAIL [IG-6]: ${INVOKE_MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  before_ig6=${ERRORS}

  # Must NOT contain direct INSERT INTO audit tables
  for audit_table in "audit_event" "audit_head"; do
    matches=$(grep -nE "INSERT INTO[^;]*${audit_table}" "${INVOKE_MODULE}" | grep -vE ":[[:space:]]*(//|\*)" || true)
    if [[ -n "${matches}" ]]; then
      echo "FAIL [IG-6]: invoke.ts has direct INSERT INTO ${audit_table}:"
      echo "${matches}"
      ERRORS=$((ERRORS + 1))
    fi
  done

  # Must reference appendAuditEvent (via makePgAuditWriter) or encodeInvokeAuditEvent
  if ! grep -qE "(appendAuditEvent|encodeInvokeAuditEvent|makePgAuditWriter)" "${INVOKE_MODULE}"; then
    echo "FAIL [IG-6]: invoke.ts does not reference the canonical audit seam (appendAuditEvent/encodeInvokeAuditEvent/makePgAuditWriter)"
    ERRORS=$((ERRORS + 1))
  fi

  if [[ ${ERRORS} -eq ${before_ig6} ]]; then
    echo "PASS [IG-6]: audit via canonical seam only in invoke.ts"
  fi
fi

# ---- IG-7: single grant-resolver — no bespoke inline authority query (T-0610, F-1) ----
echo ""
echo "Check IG-7: invoke.ts's caller-grant lookup uses getGrantsForSubject (single resolver, no inline JOIN)"

if [[ ! -f "${INVOKE_MODULE}" ]]; then
  echo "FAIL [IG-7]: ${INVOKE_MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  before_ig7=${ERRORS}

  # Non-comment view (strip // and * prose lines) so header/doc prose mentioning
  # the OLD query shape (explaining what was fixed) does not false-positive.
  # Materialized into a variable (NOT piped straight into `grep -q`): under
  # `set -o pipefail`, `grep -q` closing its read end early on a match can
  # SIGPIPE the upstream `echo` on longer input, turning the pipeline's exit
  # status into 141 instead of grep's real result — a false FAIL. Grepping a
  # captured variable (here-string) sidesteps the pipe entirely.
  NONCOMMENT_IG7="$(grep -vE "^[[:space:]]*(//|\*)" "${INVOKE_MODULE}" || true)"

  # Must import getGrantsForSubject from the shared DAO (grants-dao.ts) — the
  # ONE resolver every other PDP consumer uses.
  if ! grep -qE "import[[:space:]]*\{[^}]*getGrantsForSubject[^}]*\}[[:space:]]*from[[:space:]]*[\"'].*grants-dao(\.js)?[\"']" <<< "${NONCOMMENT_IG7}"; then
    echo "FAIL [IG-7]: invoke.ts does not import getGrantsForSubject from db/grants-dao.js"
    ERRORS=$((ERRORS + 1))
  fi

  # Must NOT contain a bespoke JOIN role_assignment (the old inline authority
  # query's signature shape) in non-comment code.
  join_matches=$(grep -nE "JOIN[[:space:]]+choros\.role_assignment" <<< "${NONCOMMENT_IG7}" || true)
  if [[ -n "${join_matches}" ]]; then
    echo "FAIL [IG-7]: invoke.ts contains a bespoke JOIN choros.role_assignment (should delegate to getGrantsForSubject):"
    echo "${join_matches}"
    ERRORS=$((ERRORS + 1))
  fi

  # Must NOT contain a bare grant-table read (FROM choros."grant") in non-comment
  # code — the only grant reads should flow through getGrantsForSubject.
  grant_matches=$(grep -nE 'FROM[[:space:]]+choros\."grant"' <<< "${NONCOMMENT_IG7}" || true)
  if [[ -n "${grant_matches}" ]]; then
    echo "FAIL [IG-7]: invoke.ts contains a bare FROM choros.\"grant\" read (should delegate to getGrantsForSubject):"
    echo "${grant_matches}"
    ERRORS=$((ERRORS + 1))
  fi

  if [[ ${ERRORS} -eq ${before_ig7} ]]; then
    echo "PASS [IG-7]: invoke.ts resolves caller grants exclusively via getGrantsForSubject (single resolver)"
  fi
fi

# ---- Result ------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: invoke-grant-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: invoke-grant-isolation — all checks green (FF-IG-1..7)"
exit 0
