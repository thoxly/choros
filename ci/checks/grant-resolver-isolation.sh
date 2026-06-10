#!/usr/bin/env bash
# FF-R6 (+ FF-R5 additivity half): grant-resolver isolation / no-second-subsystem
#
# Asserts, for src/core/grant-resolver.ts:
#  1. It imports nothing from pg/fs/net/http/jobStore (pure static-now core —
#     all IO is behind injected ports; the DB ports land in T-0053).
#  2. It introduces no parallel authority store: no *_acl / field_visibility /
#     record_rights token (rights are derived from T-0018 grant rows only).
#  3. It edits no existing export of the frozen modules object-handle.ts /
#     grant-lattice.ts / types.ts (additive-only; the T-0015 seam swap is a
#     composition-root injection, not an export edit) — FF-R5 structural half.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/grant-resolver.ts"
ERRORS=0

echo "[FF-R6] grant-resolver-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- Check 1: forbidden imports ----------------------------------------
# The resolver must reach record/grant data only through injected ports.
FORBIDDEN_IMPORTS=(
  "jobStore"
  "from.*['\"].*node:http['\"]"
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"]net['\"]"
  "require.*['\"](pg|fs|net|http)['\"]"
)

for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL: grant-resolver.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: no forbidden imports (DB/net/fs behind ports, not direct)"
fi

# ---- Check 2: no parallel authority subsystem --------------------------
# Decision + field set derive from T-0018 grant rows ONLY. A second ACL /
# field-visibility / record-rights store would be a divergent source of truth.
PARALLEL_AUTHORITY_TOKENS=(
  "field_visibility"
  "record_rights"
  "_acl"
  "recordAcl"
  "fieldVisibility"
)

before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  # Ignore comment lines (// ...) so the prose explaining "no *_acl store" passes.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*//" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL: grant-resolver.ts references a parallel-authority token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS: no parallel-authority store tokens (grant-rows-only)"
fi

# ---- Check 3: frozen exports unchanged (additive-only) -----------------
# The T-0021 task must not edit object-handle.ts / grant-lattice.ts / types.ts.
FROZEN_FILES=(
  "src/core/object-handle.ts"
  "src/core/grant-lattice.ts"
  "src/core/types.ts"
)

before=${ERRORS}
for f in "${FROZEN_FILES[@]}"; do
  full_path="${PROJECT_ROOT}/${f}"
  [[ -f "${full_path}" ]] || continue
  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
    echo "FAIL: frozen file has uncommitted changes (must be additive): ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS: frozen modules (object-handle.ts, grant-lattice.ts, types.ts) unmodified"
fi

# ---- Result ------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: grant-resolver-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: grant-resolver-isolation — all checks green"
exit 0
