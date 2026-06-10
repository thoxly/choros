#!/usr/bin/env bash
# FF-PG-ONCE (AC-18): `pg` is added exactly once, in the root package.json.
#
# - root package.json declares `pg` in "dependencies".
# - NO other manifest in the repo adds a Postgres client (web/package.json or any
#   other package.json) — the single-place seam.
# - migrations/run.mjs imports ONLY node:* builtins + `pg`.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

echo "[FF-PG-ONCE] pg-single-dep: checking single pg dependency + runner imports"

# ---- Check 1: root package.json declares pg in dependencies ----------------
if node -e '
  const p = require("'"${ROOT}"'/package.json");
  const dep = (p.dependencies && p.dependencies.pg) || null;
  if (!dep) { console.error("pg not in root dependencies"); process.exit(1); }
'; then
  echo "PASS: root package.json declares pg in dependencies"
else
  echo "FAIL: root package.json does not declare pg in dependencies"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: no OTHER package.json adds a pg client -----------------------
# Find every package.json except the root one and node_modules; assert none of
# them lists "pg" (or pg-* clients like pg-native) as a dep.
OTHER_PG=""
while IFS= read -r manifest; do
  [[ "${manifest}" == "${ROOT}/package.json" ]] && continue
  if grep -Eq '"pg(-native)?"[[:space:]]*:' "${manifest}"; then
    OTHER_PG="${OTHER_PG}\n  ${manifest}"
  fi
done < <(find "${ROOT}" -name package.json -not -path '*/node_modules/*' 2>/dev/null)

if [[ -n "${OTHER_PG}" ]]; then
  echo "FAIL: a second manifest adds a Postgres client (single-place seam broken):"
  printf "%b\n" "${OTHER_PG}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no other manifest adds a Postgres client"
fi

# ---- Check 3: runner imports only node:* builtins + pg ---------------------
RUNNER="${ROOT}/migrations/run.mjs"
if [[ ! -f "${RUNNER}" ]]; then
  echo "FAIL: ${RUNNER} not found"
  ERRORS=$((ERRORS + 1))
else
  BAD_IMPORTS=$(grep -nE "^\s*import .* from ['\"]" "${RUNNER}" \
    | grep -vE "from ['\"]node:" \
    | grep -vE "from ['\"]pg['\"]" \
    || true)
  if [[ -n "${BAD_IMPORTS}" ]]; then
    echo "FAIL: runner imports something other than node:* or pg:"
    echo "${BAD_IMPORTS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: runner imports only node:* builtins + pg"
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: pg-single-dep found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: pg-single-dep — all checks green"
exit 0
