#!/usr/bin/env bash
# T-0040 · FF-RC1 / FF-RC2 / FF-RC3 / FF-RC4 / FF-RC5 / FF-RC6:
# role-criticality-isolation
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# pure module src/core/role-criticality.ts. Mirrors data-classification-isolation.sh
# and effect-resource-isolation.sh exactly.
#
#  FF-RC1 — No second authority store: role-criticality.ts contains no
#           parallel-authority token (_acl / criticalityRights / critFlags /
#           criticalityAcl / field_visibility / fieldVisibility) in non-comment
#           code. Every bit derives from Grant rows + DataClass only (NF-2, AC-15).
#
#  FF-RC2 — Purity / no IO: role-criticality.ts imports no pg/fs/net/http (DB
#           only via the injected RoleGrantSource port; the Postgres DAO lands in
#           T-0053). NF-1, AC-15.
#
#  FF-RC3 — No Date.now in core: no Date.now( / new Date( — nowMs is a parameter
#           (determinism). NF-7 / FR-6.
#
#  FF-RC4 — T-0044 export seam: the module exports exactly RoleCriticality,
#           RoleCriticalityLevel, RoleGrantSource, roleCriticality,
#           combineCriticality, criticalityLevel, criticalityDiff,
#           SENSITIVE_READ_THRESHOLD; DataClass/deriveClearance are IMPORTED from
#           data-classification.ts (not redeclared). AC-18 / FR-9.
#
#  FF-RC5 — Frozen foundation (byte-level): the change does not touch
#           grant-lattice.ts, data-classification.ts, effect-resource.ts,
#           grant-resolver.ts, object-handle.ts, or any migrations/*.sql.
#           AC-16 / NF-5.
#
#  FF-RC6 — No migration / tenant-table set unchanged: no new migrations/*.sql
#           added; ci/checks/known_tenant_tables.txt byte-unchanged (derived, not
#           stored). AC-17 / NF-6.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/role-criticality.ts"
ERRORS=0

echo "[T-0040] role-criticality-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- FF-RC1: no parallel criticality / field-visibility store ---------------
PARALLEL_AUTHORITY_TOKENS=(
  "_acl"
  "criticalityRights"
  "critFlags"
  "criticalityAcl"
  "field_visibility"
  "fieldVisibility"
)

before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  # Ignore comment lines (// ... or * ...) so prose explaining the ban passes.
  # grep -n output format: "<lineno>:<content>" — strip lines that are comments.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE ":[[:space:]]*(//|\*)" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FF-RC1]: role-criticality.ts references a parallel-authority token '${token}' in non-comment code:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-RC1]: no parallel-authority store tokens in non-comment code (grant rows + DataClass only)"
fi

# ---- FF-RC2: no forbidden pg/fs/net/http import -----------------------------
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
    echo "FAIL [FF-RC2]: role-criticality.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-RC2]: no forbidden imports (grants via injected RoleGrantSource port; DB DAO → T-0053)"
fi

# ---- FF-RC3: no Date.now / new Date in core (determinism) -------------------
before=${ERRORS}
# Strip comment lines so prose may mention Date.now while code may not.
NONCOMMENT="$(grep -vE "^[[:space:]]*(//|\*)" "${MODULE}" || true)"
if echo "${NONCOMMENT}" | grep -Eq "Date\.now\(|new[[:space:]]+Date\("; then
  echo "FAIL [FF-RC3]: role-criticality.ts uses Date.now()/new Date() — nowMs must be a parameter (determinism):"
  echo "${NONCOMMENT}" | grep -nE "Date\.now\(|new[[:space:]]+Date\(" || true
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-RC3]: no Date.now()/new Date() in core (nowMs is a parameter)"
fi

# ---- FF-RC4: T-0044 export seam + imported (not redeclared) DataClass --------
REQUIRED_EXPORTS=(
  "export (type )?type RoleCriticalityLevel"
  "export interface RoleCriticality"
  "export interface RoleGrantSource"
  "export interface CriticalityDiff"
  "export const SENSITIVE_READ_THRESHOLD"
  "export function combineCriticality"
  "export (async )?function roleCriticality"
  "export function criticalityLevel"
  "export function criticalityDiff"
)

before=${ERRORS}
for sym in "${REQUIRED_EXPORTS[@]}"; do
  if ! grep -qE "${sym}" "${MODULE}"; then
    echo "FAIL [FF-RC4]: role-criticality.ts is missing the export '${sym}' (T-0044 seam broken)"
    ERRORS=$((ERRORS + 1))
  fi
done
# DataClass / deriveClearance must be IMPORTED from data-classification, not redeclared.
if ! grep -qE "from[[:space:]]+['\"]\./data-classification(\.js)?['\"]" "${MODULE}"; then
  echo "FAIL [FF-RC4]: role-criticality.ts does not import from ./data-classification (DataClass/deriveClearance must be reused)"
  ERRORS=$((ERRORS + 1))
fi
# A local redeclaration of DataClass would fork the shared axis (NF-2).
if grep -qE "^[[:space:]]*export[[:space:]]+type[[:space:]]+DataClass[[:space:]]*=" "${MODULE}"; then
  echo "FAIL [FF-RC4]: role-criticality.ts redeclares 'type DataClass' (must import from data-classification.ts)"
  ERRORS=$((ERRORS + 1))
fi
# deriveClearance must be the imported computation, not a local re-implementation.
if ! grep -qE "deriveClearance" "${MODULE}"; then
  echo "FAIL [FF-RC4]: role-criticality.ts does not use deriveClearance (axis c must reuse T-0033)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-RC4]: T-0044 export seam present; DataClass/deriveClearance imported (not redeclared)"
fi

# ---- FF-RC5 + FF-RC6: frozen foundation + no migration / tenant-table set ----
# Resolve the base ref to diff against. Prefer the dev base the worktree branched
# from; fall back to the merge-base with origin/dev, else to HEAD (uncommitted).
BASE_REF=""
for cand in "dev" "origin/dev"; do  # rebase-reconciliation rt-choros-s8: динамический merge-base вместо захардкоженного base-sha (после ребейза старый sha ловил чужие легитимные изменения)
  if git -C "${PROJECT_ROOT}" rev-parse --verify --quiet "${cand}^{commit}" >/dev/null 2>&1; then
    mb="$(git -C "${PROJECT_ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${mb}" ]]; then
      BASE_REF="${mb}"
      break
    fi
  fi
done

FROZEN_PATHS_RE='^(src/core/grant-lattice\.ts|src/core/data-classification\.ts|src/core/effect-resource\.ts|src/core/grant-resolver\.ts|src/core/object-handle\.ts|migrations/.*\.sql)$'

# Sibling-migration exclusions are kept in a data file so that future tasks can
# add their own entries without touching this .sh file (which is frozen to T-0040
# per the T-0146 meta-gate on ci/checks/[^/]+\.sh).
# Format: one stem per line, comments/blanks ignored.
# See ci/checks/role-criticality-migration-excludes.txt for current entries.
EXCLUDES_FILE="${SCRIPT_DIR}/role-criticality-migration-excludes.txt"
MIGRATION_EXCLUDE_RE=""
if [[ -f "${EXCLUDES_FILE}" ]]; then
  # Build alternation RE from non-blank, non-comment lines (first word on each line).
  stems=()
  while IFS= read -r line; do
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    stem="$(echo "${line}" | awk '{print $1}')"
    [[ -n "${stem}" ]] && stems+=("${stem}")
  done < "${EXCLUDES_FILE}"
  if [[ ${#stems[@]} -gt 0 ]]; then
    joined="$(IFS='|'; echo "${stems[*]}")"
    MIGRATION_EXCLUDE_RE="^migrations/(${joined})\.sql$"
  fi
fi
# Absent file or empty list → MIGRATION_EXCLUDE_RE="" → no exclusions applied (fail-closed).

before=${ERRORS}
if [[ -n "${BASE_REF}" ]]; then
  # Committed changes since base + any uncommitted working-tree changes.
  CHANGED="$(
    {
      git -C "${PROJECT_ROOT}" diff --name-only "${BASE_REF}" HEAD 2>/dev/null || true
      git -C "${PROJECT_ROOT}" diff --name-only HEAD 2>/dev/null || true
      git -C "${PROJECT_ROOT}" diff --name-only --cached 2>/dev/null || true
    } | sort -u
  )"
else
  # No resolvable base ⇒ check uncommitted only (best effort).
  CHANGED="$(
    {
      git -C "${PROJECT_ROOT}" diff --name-only HEAD 2>/dev/null || true
      git -C "${PROJECT_ROOT}" diff --name-only --cached 2>/dev/null || true
    } | sort -u
  )"
fi

# Remove known-other-task migrations from the diff before checking T-0040's constraints.
# Empty MIGRATION_EXCLUDE_RE → no exclusions (fail-closed: all migrations are flagged).
if [[ -n "${MIGRATION_EXCLUDE_RE}" ]]; then
  CHANGED_FILTERED="$(echo "${CHANGED}" | grep -vE "${MIGRATION_EXCLUDE_RE}" || true)"
else
  CHANGED_FILTERED="${CHANGED}"
fi

FROZEN_HITS="$(echo "${CHANGED_FILTERED}" | grep -E "${FROZEN_PATHS_RE}" || true)"
if [[ -n "${FROZEN_HITS}" ]]; then
  echo "FAIL [FF-RC5/FF-RC6]: T-0040 touches a frozen foundation file or a migration (must be byte-untouched):"
  echo "${FROZEN_HITS}"
  ERRORS=$((ERRORS + 1))
fi

# FF-RC6: no NEW migrations/*.sql added by this change.
NEW_MIGRATIONS="$(echo "${CHANGED_FILTERED}" | grep -E '^migrations/.*\.sql$' || true)"
if [[ -n "${NEW_MIGRATIONS}" ]]; then
  echo "FAIL [FF-RC6]: T-0040 adds/edits a migration (role_criticality is derived, not stored):"
  echo "${NEW_MIGRATIONS}"
  ERRORS=$((ERRORS + 1))
fi

# FF-RC6: known_tenant_tables.txt byte-unchanged (no new tenant table).
if echo "${CHANGED}" | grep -qE '^ci/checks/known_tenant_tables\.txt$'; then
  echo "FAIL [FF-RC6]: ci/checks/known_tenant_tables.txt changed — but role_criticality adds no new tenant table"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-RC5/FF-RC6]: frozen foundation + migrations untouched; tenant-table set unchanged (base=${BASE_REF:-HEAD})"
fi

# ---- Result -----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: role-criticality-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: role-criticality-isolation — all checks green (FF-RC1/RC2/RC3/RC4/RC5/RC6)"
exit 0
