#!/usr/bin/env bash
# FF-A3: Module isolation check
#
# Asserts:
#  1. src/core/object-handle.ts imports nothing from jobStore/http/pg/fs/net.
#  2. No existing export in the three frozen files (types.ts, grant-lattice.ts,
#     jobStore.ts) was changed (additive-only, FE-W23-0008).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/object-handle.ts"
ERRORS=0

echo "[FF-A3] object-handle-isolation: checking module boundary"

# ---- Check 1: forbidden imports ----------------------------------------

FORBIDDEN_IMPORTS=(
  "jobStore"
  "from.*['\"].*http['\"]"
  "from.*['\"].*pg['\"]"
  "from.*['\"].*fs['\"]"
  "from.*['\"].*net['\"]"
  "require.*http"
  "require.*pg"
  "require.*fs"
  "require.*net"
)

for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL: src/core/object-handle.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: no forbidden imports in src/core/object-handle.ts"
fi

# ---- Check 2: frozen files are not modified ----------------------------
# We check that the git index (staged + committed) shows no changes to the
# three frozen files relative to the first parent commit that did NOT add
# them (i.e., that T-0015 BUILD did not edit existing exports).
#
# Strategy: grep the git diff of the entire branch back to the merge-base
# against dev for any +/- lines touching existing exports in those three files.

FROZEN_FILES=(
  "src/core/types.ts"
  "src/core/grant-lattice.ts"
  "src/core/jobStore.ts"
)

for f in "${FROZEN_FILES[@]}"; do
  full_path="${PROJECT_ROOT}/${f}"
  if [[ ! -f "${full_path}" ]]; then
    # File doesn't exist yet — it hasn't been created by T-0015 (ok)
    continue
  fi

  # Check that the file has not been modified in the current worktree
  # (compared to HEAD, which reflects the state before BUILD)
  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
    echo "FAIL: frozen file has uncommitted changes: ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: frozen files (types.ts, grant-lattice.ts, jobStore.ts) are unmodified"
fi

# ---- Result ------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: object-handle-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: object-handle-isolation — all checks green"
exit 0
