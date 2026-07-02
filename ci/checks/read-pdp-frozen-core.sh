#!/usr/bin/env bash
# T-0570 (D3, READ-PDP) · FF-RP-8 — frozen-core check (NF-5/FR-7).
#
# THE CONTRACT (ADR §2.5/§4.6): T-0570 introduces the READ-PDP gate WITHOUT
# touching the T-0018/T-0021/T-0081 authority core — it only IMPORTS from
# these modules. Byte-unchanged (vs the branch's base commit) proves no
# second lattice/containment math was smuggled in:
#   - src/core/grant-lattice.ts    (T-0018 latice ⊑/⊓/⊥ — isNarrowerOrEqual/isEffective)
#   - src/core/object-handle.ts    (T-0015 handle/resolver port — refToScope's target type)
#   - src/core/grant-resolver.ts   (T-0021 resolveFor — the action-path PDP; refToScope lives here, UNCHANGED)
#   - src/core/field-visibility.ts (T-0081 roleFieldVisibility — the ONLY field-projection layer)
#
# Mirrors mutation-gateway-isolation.sh's FROZEN_EXPORTS-style byte-unchanged
# discipline: `git diff --name-only <base> -- <file>` must be EMPTY for each
# of the four files above.
#
# Exit 0 clean, non-zero on any violation. --self-test exercises the detector
# against a synthetic repo (a temp git repo whose "frozen" file IS modified).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FROZEN_FILES=(
  "src/core/grant-lattice.ts"
  "src/core/object-handle.ts"
  "src/core/grant-resolver.ts"
  "src/core/field-visibility.ts"
)

resolve_base_ref() {
  local repo_root="$1"
  git -C "${repo_root}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${repo_root}" merge-base HEAD dev 2>/dev/null \
    || git -C "${repo_root}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

# Check each frozen file is byte-unchanged vs base_ref. Sets `errors` global
# (bash 3.2 compatible) and prints violations to stdout.
check_frozen() {
  local repo_root="$1" base_ref="$2"
  shift 2
  errors=0
  local rel changed
  for rel in "$@"; do
    changed="$( (git -C "${repo_root}" diff --name-only "${base_ref}" -- "${rel}" 2>/dev/null) || true )"
    if [[ -n "${changed}" ]]; then
      echo "FAIL [FF-RP-8]: frozen file modified vs base: ${rel}"
      errors=$((errors + 1))
    fi
  done
}

self_test() {
  echo "[T-0570] read-pdp-frozen-core --self-test: synthetic repo fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  git init -q -b base-branch "${tmp}/repo"
  (
    cd "${tmp}/repo"
    git config user.email "test@example.com"
    git config user.name "Test"
    mkdir -p src/core
    echo "export const A = 1;" > src/core/grant-lattice.ts
    echo "export const B = 1;" > src/core/other.ts
    git add -A
    git commit -q -m "base"
  )

  # GOOD branch: touches an unrelated file, leaves the frozen file alone.
  (
    cd "${tmp}/repo"
    git checkout -q -b good-branch base-branch
    echo "export const B = 2;" > src/core/other.ts
    git add -A
    git commit -q -m "good change (unrelated file)"
  )
  check_frozen "${tmp}/repo" "base-branch" "src/core/grant-lattice.ts"
  local good_errors=${errors}

  # BAD branch: modifies the frozen file itself.
  (
    cd "${tmp}/repo"
    git checkout -q -b bad-branch base-branch
    echo "export const A = 2; // regression: edited the frozen core" > src/core/grant-lattice.ts
    git add -A
    git commit -q -m "bad change (edits frozen core)"
  )
  check_frozen "${tmp}/repo" "base-branch" "src/core/grant-lattice.ts"
  local bad_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD (unrelated-file) change (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire when the frozen core file was edited"
    return 1
  fi
  echo "SELF-TEST PASS: unrelated change clean, frozen-core edit flagged (${bad_errors} violation(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0570] read-pdp-frozen-core: FF-RP-8 T-0018/T-0015/T-0021/T-0081 byte-unchanged check"
BASE_REF="$(resolve_base_ref "${PROJECT_ROOT}")"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-RP-8]: cannot determine base ref — skipping frozen-core diff check"
  exit 0
fi
check_frozen "${PROJECT_ROOT}" "${BASE_REF}" "${FROZEN_FILES[@]}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: read-pdp-frozen-core found ${errors} violation(s)"
  exit 1
fi
echo "PASS: read-pdp-frozen-core — grant-lattice.ts/object-handle.ts/grant-resolver.ts/field-visibility.ts byte-unchanged (base=${BASE_REF})"
exit 0
