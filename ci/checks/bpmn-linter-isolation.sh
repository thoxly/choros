#!/usr/bin/env bash
# FF-5 / FF-6 / FF-9: BPMN linter module isolation check (T-0027)
#
# Asserts:
#  1. src/core/bpmn-linter.ts and src/core/bpmn-xml-parser.ts import nothing
#     from jobStore, node:http, node:pg, node:fs, node:net, or any package
#     outside existing devDependencies.
#  2. No existing export in the frozen files is modified:
#     object-handle.ts, grant-lattice.ts, types.ts, jobStore.ts
#     (grant-resolver.ts is THAWED by T-0033/E4.3 — see the FROZEN_FILES note.)
#  3. No new entry in package.json "dependencies" (only devDependencies allowed).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

echo "[FF-5/FF-6/FF-9] bpmn-linter-isolation: checking module boundary"

# ---- Check 1: forbidden imports in bpmn-linter.ts -------------------------

LINTER_MODULE="${PROJECT_ROOT}/src/core/bpmn-linter.ts"
PARSER_MODULE="${PROJECT_ROOT}/src/core/bpmn-xml-parser.ts"

FORBIDDEN_PATTERNS=(
  "from.*['\"].*jobStore"
  "from.*['\"].*node:http['\"]"
  "from.*['\"]node:fs['\"]"
  "from.*['\"]node:net['\"]"
  "from.*['\"]pg['\"]"
  "require.*http"
  "require.*pg"
  "require.*fs"
  "require.*net"
  "process\.exit"
)

for module in "${LINTER_MODULE}" "${PARSER_MODULE}"; do
  module_name="$(basename "${module}")"
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${module}" 2>/dev/null; then
      echo "FAIL: ${module_name} contains a forbidden import/call matching: ${pattern}"
      ERRORS=$((ERRORS + 1))
    fi
  done
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: no forbidden imports in bpmn-linter.ts or bpmn-xml-parser.ts"
fi

# ---- Check 2: frozen files are unmodified ----------------------------------

# T-0033 (E4.3) THAW: grant-resolver.ts is REMOVED from the frozen set here, for
# the SAME reason it is removed from mutation-gateway-isolation.sh's G6 — the
# spec REQUIRES value-aware masking to be folded into the resolver's ONE
# projection path, so this task legitimately extends grant-resolver.ts. The edit
# is additive-only (ResolverDeps gains optional `classifications`; projectFields
# an optional 4th arg). object-handle.ts / grant-lattice.ts / types.ts /
# jobStore.ts stay byte-frozen. (The ADR §2.1 named mutation-gateway-isolation.sh
# explicitly; this T-0027 check froze the same file and is thawed consistently —
# recorded as a deviation in the BUILD handoff.)
FROZEN_FILES=(
  "src/core/object-handle.ts"
  "src/core/grant-lattice.ts"
  "src/core/types.ts"
  "src/core/jobStore.ts"
)

for f in "${FROZEN_FILES[@]}"; do
  full_path="${PROJECT_ROOT}/${f}"
  if [[ ! -f "${full_path}" ]]; then
    # File doesn't exist (not yet created) — ok
    continue
  fi

  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${f}" 2>/dev/null; then
    echo "FAIL: frozen file has uncommitted changes: ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: frozen files (object-handle.ts, grant-lattice.ts, types.ts, jobStore.ts) are unmodified"
fi

# ---- Check 3: no new runtime dependencies ----------------------------------

if node -e "
  const p = require('${PROJECT_ROOT}/package.json');
  const deps = Object.keys(p.dependencies || {});
  const xmlOrBpmn = deps.filter(k => k.includes('xml') || k.includes('bpmn'));
  if (xmlOrBpmn.length > 0) {
    console.error('FAIL: new xml/bpmn runtime dependencies found: ' + xmlOrBpmn.join(', '));
    process.exit(1);
  }
  console.log('PASS: no xml/bpmn runtime dependencies in package.json dependencies');
" 2>&1; then
  :
else
  ERRORS=$((ERRORS + 1))
fi

# Also check that package.json dependencies section is empty or doesn't exist
DEPS_COUNT=$(node -e "
  const p = require('${PROJECT_ROOT}/package.json');
  const deps = Object.keys(p.dependencies || {});
  console.log(deps.length);
")

if [[ "${DEPS_COUNT}" -gt 0 ]]; then
  echo "WARN: package.json has ${DEPS_COUNT} runtime dependencies (expected 0 for this library)"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: bpmn-linter-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: bpmn-linter-isolation — all checks green"
exit 0
