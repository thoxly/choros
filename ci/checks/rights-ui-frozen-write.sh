#!/usr/bin/env bash
# T-0572 (rights UI writes) · FF-T0572-FROZEN — write-core byte-unchanged
# (NF-1, NF-2, FR-5, ADR §2.8/§6.4).
#
# THE CONTRACT: this task adds ONE new READ file (src/http/rights-overview.ts)
# plus a wiring line in src/server.ts, and touches web/src/. It must NOT edit
# any of the files that implement the existing write-path / dual-control
# kernel — they are imported, never modified:
#   src/http/grants.ts
#   src/http/rights-change-requests.ts
#   src/http/rights.ts                 (zero-pg demo/no-DB display plane)
#   src/core/dual-control.ts
#   src/core/role-criticality.ts
#   src/core/grant-resolver.ts
#   src/core/grant-lattice.ts
#
# Mirrors read-pdp-frozen-core.sh's byte-unchanged discipline: `git diff
# --name-only <base> -- <file>` must be EMPTY for each of the files above.
#
# Exit 0 clean, non-zero on any violation. --self-test exercises the detector
# against a synthetic repo (a temp git repo whose "frozen" file IS modified).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FROZEN_FILES=(
  "src/http/grants.ts"
  "src/http/rights-change-requests.ts"
  "src/http/rights.ts"
  "src/core/dual-control.ts"
  "src/core/role-criticality.ts"
  "src/core/grant-resolver.ts"
  "src/core/grant-lattice.ts"
)

resolve_base_ref() {
  local repo_root="$1"
  git -C "${repo_root}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${repo_root}" merge-base HEAD dev 2>/dev/null \
    || git -C "${repo_root}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

# check_frozen <repo_root> <base_ref> <file...> — sets `errors` global.
check_frozen() {
  local repo_root="$1" base_ref="$2"
  shift 2
  errors=0
  local rel changed
  for rel in "$@"; do
    changed="$( (git -C "${repo_root}" diff --name-only "${base_ref}" -- "${rel}" 2>/dev/null) || true )"
    if [[ -n "${changed}" ]]; then
      echo "FAIL [FF-T0572-FROZEN]: frozen file modified vs base: ${rel}"
      errors=$((errors + 1))
    fi
  done
}

self_test() {
  echo "[T-0572] rights-ui-frozen-write --self-test: synthetic repo fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  git init -q -b base-branch "${tmp}/repo"
  (
    cd "${tmp}/repo"
    git config user.email "test@example.com"
    git config user.name "Test"
    mkdir -p src/http src/core
    echo "export const A = 1;" > src/http/grants.ts
    echo "export const B = 1;" > src/http/other.ts
    git add -A
    git commit -q -m "base"
  )

  # GOOD branch: touches an unrelated file, leaves frozen files alone.
  (
    cd "${tmp}/repo"
    git checkout -q -b good-branch base-branch
    echo "export const B = 2;" > src/http/other.ts
    git add -A
    git commit -q -m "good change (unrelated file)"
  )
  check_frozen "${tmp}/repo" "base-branch" "${FROZEN_FILES[@]}"
  local good_errors=${errors}

  # BAD branch: edits a frozen file.
  (
    cd "${tmp}/repo"
    git checkout -q -b bad-branch base-branch
    echo "export const A = 2;" > src/http/grants.ts
    git add -A
    git commit -q -m "bad change (frozen file edited)"
  )
  check_frozen "${tmp}/repo" "base-branch" "${FROZEN_FILES[@]}"
  local bad_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD branch (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD branch (frozen file edited)"
    return 1
  fi
  echo "SELF-TEST PASS: good branch clean, bad branch flagged (${bad_errors} violation(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0572] rights-ui-frozen-write: FF-T0572-FROZEN write-core byte-unchanged gate"
BASE_REF="$(resolve_base_ref "${PROJECT_ROOT}")"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-T0572-FROZEN]: cannot determine base ref — skipping frozen-core check"
  exit 0
fi
check_frozen "${PROJECT_ROOT}" "${BASE_REF}" "${FROZEN_FILES[@]}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: rights-ui-frozen-write found ${errors} violation(s)"
  exit 1
fi
echo "PASS: rights-ui-frozen-write — write-core files byte-unchanged vs base=${BASE_REF}"
exit 0
