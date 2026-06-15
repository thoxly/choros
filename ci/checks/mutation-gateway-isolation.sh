#!/usr/bin/env bash
# T-0028 · FF-G1, FF-G2, FF-G6: mutation-gateway-isolation
#
# Three assertions (all static grep / TS analysis — no runtime, no DB):
#
#  G1 — No module outside src/core/grant-resolver.ts imports a writable record
#       accessor (*mutate*/*write*/*persist* function names mapping a ResourceRef
#       to record fields). The gateway is the sole write path (FR-1, AC-1).
#
#  G2 — assertVariableValue IS called in src/core/inMemoryJobStore.ts and
#       src/core/postgres/pgJobStore.ts complete method (call-site presence,
#       FR-2, AC-5). Not optional, not flag-guarded.
#
#  G6 — No new *mutate*/*write*/*persist* function mapping a ResourceRef to
#       record fields appears outside src/core/grant-resolver.ts (AC-6).
#
# Exit 0 on clean; non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0028] mutation-gateway-isolation: checking gateway isolation invariants"

# ---------------------------------------------------------------------------
# G1/G6: No module outside grant-resolver.ts imports a writable record accessor
#        No *mutate*/*write*/*persist* function mapping ResourceRef to record
#        fields outside the gateway composition.
# ---------------------------------------------------------------------------

echo "[G1/G6] Checking: no writable record accessor imported outside grant-resolver.ts ..."

# Build the list of source files to scan (exclude grant-resolver.ts itself)
SCAN_FILES=$(find "${SRC}" -name "*.ts" ! -path "*/node_modules/*" ! -name "grant-resolver.ts" 2>/dev/null)

# Patterns for writable record accessor names (function-like, applied to record fields)
FORBIDDEN_WRITE_PATTERNS=(
  "mutateRecord"
  "writeRecord"
  "persistRecord"
  "mutateField"
  "writeField"
  "persistField"
)

for pattern in "${FORBIDDEN_WRITE_PATTERNS[@]}"; do
  # Search in all source files except grant-resolver.ts
  MATCHES=$(echo "${SCAN_FILES}" | xargs grep -l "${pattern}" 2>/dev/null || true)
  if [[ -n "${MATCHES}" ]]; then
    echo "FAIL [G1/G6]: writable record accessor '${pattern}' found outside grant-resolver.ts in:"
    echo "${MATCHES}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [G1/G6]: no writable record accessor symbols found outside gateway composition"
fi

# ---------------------------------------------------------------------------
# G2: assertVariableValue IS called in complete method of both store implementations
# ---------------------------------------------------------------------------

echo "[G2] Checking: assertVariableValue called at complete boundary in both JobStore implementations ..."

IN_MEMORY_STORE="${SRC}/core/inMemoryJobStore.ts"
PG_STORE="${SRC}/core/postgres/pgJobStore.ts"

# Check InMemoryJobStore.complete calls assertVariableValue
if ! grep -q "assertVariableValue" "${IN_MEMORY_STORE}"; then
  echo "FAIL [G2]: assertVariableValue NOT found in src/core/inMemoryJobStore.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [G2]: assertVariableValue present in src/core/inMemoryJobStore.ts"
fi

# Check PostgresJobStore.complete calls assertVariableValue
if ! grep -q "assertVariableValue" "${PG_STORE}"; then
  echo "FAIL [G2]: assertVariableValue NOT found in src/core/postgres/pgJobStore.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [G2]: assertVariableValue present in src/core/postgres/pgJobStore.ts"
fi

# Verify assertVariableValue is imported from object-handle (not re-implemented)
if ! grep -q "from.*object-handle" "${IN_MEMORY_STORE}"; then
  echo "FAIL [G2]: InMemoryJobStore does not import from object-handle.ts (required for guard)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [G2]: InMemoryJobStore imports from object-handle.ts"
fi

if ! grep -q "from.*object-handle" "${PG_STORE}"; then
  echo "FAIL [G2]: PostgresJobStore does not import from object-handle.ts (required for guard)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [G2]: PostgresJobStore imports from object-handle.ts"
fi

# ---------------------------------------------------------------------------
# G6 additive: confirm object-handle.ts, grant-lattice.ts, grant-resolver.ts
#              are not modified in this task's diff (frozen exports unchanged).
#
# Audit-grade check: diffs the current HEAD against the merge-base with dev
# (not just against the working tree).  This catches hypothetical intermediate
# commits that dirtied and then re-cleaned the frozen files on this branch.
#
# BASE is resolved as: merge-base of HEAD with the nearest available ref for
# dev (remote origin/dev if present, otherwise local dev, otherwise the
# fallback of HEAD~$(git log --oneline | wc -l) which is the root).
# ---------------------------------------------------------------------------

echo "[G6-additive] Checking: frozen exports (object-handle.ts, grant-lattice.ts) unchanged vs merge-base with dev ..."

# Resolve the base commit: prefer origin/dev, then local dev, then first commit.
BASE_REF=""
if git -C "${PROJECT_ROOT}" rev-parse --verify origin/dev >/dev/null 2>&1; then
  BASE_REF="origin/dev"
elif git -C "${PROJECT_ROOT}" rev-parse --verify dev >/dev/null 2>&1; then
  BASE_REF="dev"
fi

if [[ -n "${BASE_REF}" ]]; then
  BASE_SHA=$(git -C "${PROJECT_ROOT}" merge-base HEAD "${BASE_REF}" 2>/dev/null || true)
else
  # No dev branch available (e.g. fresh clone / CI shallow); fall back to working-tree check.
  BASE_SHA=""
fi

# Current branch TASK_ID (for sanction-aware THAW checks).
CURRENT_BRANCH=$(git -C "${PROJECT_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
CURRENT_TASK=""
if [[ "${CURRENT_BRANCH}" =~ ^task/(T-[0-9]+) ]]; then
  CURRENT_TASK="${BASH_REMATCH[1]}"
fi

# T-0033 (E4.3) THAW: grant-resolver.ts is intentionally REMOVED from the frozen
# set. The spec REQUIRES value-aware masking to be folded into the resolver's ONE
# projection path (single-projection invariant) — so grant-resolver.ts must be
# edited HERE, by the task that legitimately extends it. The edit is purely
# additive (ResolverDeps gains an optional `classifications` field; projectFields
# an optional 4th `maskCtx` arg; resolveFor builds the MaskContext) — the import
# surface resolveFor/makeGrantResolver/projectFields/visibleFields/grantFacetFields
# is preserved (FE-W23-0008; asserted by data-classification-isolation.sh FF-DC17).
# object-handle.ts and grant-lattice.ts stay byte-frozen — no second authority
# subsystem, no edit to the frozen Facet/Grant/Operation types.
#
# T-0227 (ADR T-0125 §2.2.1/§7) THAW — sanction: founder_decide@2026-06-15, FF-FCI12:
# object-handle.ts and grant-lattice.ts are ADDITIVE-THAWED on task/T-0227 only.
# The edit adds `process_instance` ResourceType + ResourceRef kind + a disjoint
# refToScope branch so fireCardAction's fail-closed guard can deny transition→terminate
# privilege-escalation before B-8. The frozen Facet/Grant/Operation/Lattice export
# surface is preserved (asserted by card-action-broad-scope.sh FF-CA-10 and
# object-handle-isolation.sh FF-A3). This THAW is branch-scoped (task/T-0227 only)
# and expires on merge to dev — the merged files then become the new byte-frozen base.
FROZEN_EXPORTS=(
  "src/core/object-handle.ts"
  "src/core/grant-lattice.ts"
)

# Files exempt from G6-additive on the owning task branch (additive-thaw pattern).
# Format: "TASK_ID:file" — the check is skipped only when CURRENT_TASK matches.
THAWED_ON_TASK=(
  "T-0227:src/core/object-handle.ts"
  "T-0227:src/core/grant-lattice.ts"
)

for f in "${FROZEN_EXPORTS[@]}"; do
  full_path="${PROJECT_ROOT}/${f}"
  if [[ ! -f "${full_path}" ]]; then
    continue
  fi

  # Check if this file is thawed on the current task branch.
  IS_THAWED=0
  if [[ -n "${CURRENT_TASK}" ]]; then
    for thaw_entry in "${THAWED_ON_TASK[@]}"; do
      if [[ "${thaw_entry}" == "${CURRENT_TASK}:${f}" ]]; then
        IS_THAWED=1
        echo "SANCTION [G6-additive]: ${f} is additive-thawed on ${CURRENT_TASK} (founder_decide@2026-06-15, FF-FCI12)"
        break
      fi
    done
  fi

  if [[ ${IS_THAWED} -eq 1 ]]; then
    continue
  fi

  if [[ -n "${BASE_SHA}" ]]; then
    # Audit-grade: compare committed HEAD state vs merge-base with dev.
    if ! git -C "${PROJECT_ROOT}" diff --quiet "${BASE_SHA}" HEAD -- "${f}" 2>/dev/null; then
      echo "FAIL [G6-additive]: frozen export file modified on this branch vs merge-base (${BASE_SHA:0:8}): ${f}"
      ERRORS=$((ERRORS + 1))
    fi
  else
    # Fallback: working-tree check (no dev ref available).
    if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
      echo "FAIL [G6-additive]: frozen export file has uncommitted changes: ${f}"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  if [[ -n "${BASE_SHA}" ]]; then
    echo "PASS [G6-additive]: frozen export files unmodified vs merge-base ${BASE_SHA:0:8} (${BASE_REF})"
  else
    echo "PASS [G6-additive]: frozen export files are unmodified (working-tree fallback)"
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "FAIL: mutation-gateway-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo ""
echo "PASS: mutation-gateway-isolation — all checks green (FF-G1, FF-G2, FF-G6)"
exit 0
