#!/usr/bin/env bash
# T-0572 (rights UI writes) · FF-T0572-ANTICASE — anti-case gate extended to
# web/src/ (D-064 discipline, NF-4/AC-11).
#
# THE CONTRACT (ADR §2.8/§5, spec NF-4): the existing
# ci/checks/read-pdp-anti-case.sh gate is git-diff-scoped to src/ ONLY. This
# task's diff also touches web/src/ substantially (new screens, forms) — the
# spec/ADR require the SAME anti-case literal ban applied there too, in the
# SAME diff-scoped (added-lines-only) style: no `role-approver`,
# `soglasovanie`, `tel-`, `Согласование` (hardcoded string constant),
# `e-larina`, `e-orlov`, `e-configurator` in lines this task's diff ADDS under
# web/src/. Pre-existing web/src/ content (e.g. `ra-data.jsx`'s existing demo
# constants, `screen-rights.jsx`'s pre-existing "Согласование" seed labels
# BEFORE this task) is untouched context, not scanned.
#
# This is a companion gate, not a replacement — read-pdp-anti-case.sh (src/)
# keeps running unchanged; this script covers ONLY web/src/.
#
# Distinguishes grep rc=1 (no match, clean) from rc>=2 (grep error). Exit 0 on
# clean, non-zero on any violation. --self-test exercises the detector against
# a synthetic diff (temp git repo).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FORBIDDEN_LITERALS=(
  "role-approver"
  "soglasovanie"
  "tel-"
  "Согласование"
  "e-larina"
  "e-orlov"
  "e-configurator"
)

resolve_base_ref() {
  git -C "${PROJECT_ROOT}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${PROJECT_ROOT}" merge-base HEAD dev 2>/dev/null \
    || git -C "${PROJECT_ROOT}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

# scan_diff <repo_root> <base_ref> — sets `errors` global (bash 3.2 compatible).
scan_diff() {
  local repo_root="$1" base_ref="$2"
  errors=0
  local diff_output lit matches
  diff_output="$( (git -C "${repo_root}" diff "${base_ref}" -- web/src/ 2>/dev/null) || true )"
  local added_lines
  added_lines="$(echo "${diff_output}" | grep -E '^\+' | grep -vE '^\+\+\+' || true)"

  local untracked_files f untracked_content
  untracked_files="$(git -C "${repo_root}" ls-files --others --exclude-standard -- web/src/ 2>/dev/null || true)"
  if [[ -n "${untracked_files}" ]]; then
    while IFS= read -r f; do
      [[ -z "${f}" ]] && continue
      untracked_content="$(sed 's/^/+/' "${repo_root}/${f}" 2>/dev/null || true)"
      added_lines="${added_lines}
${untracked_content}"
    done <<< "${untracked_files}"
  fi

  # Strip trailing comments (JSX/JS // or /* ) before exclusions run, mirrors
  # read-pdp-anti-case.sh's R-1 fix (a trailing comment must not launder a
  # real hardcode past the scan).
  local sans_trailing_comments
  sans_trailing_comments="$(echo "${added_lines}" | sed -E 's#^(\+.*[^:/])//.*$#\1#; s#^(\+.*[^:/])/\*.*$#\1#')"

  # Drop comment-only lines (// or JSX-comment continuation / block-comment
  # continuation lines starting with * ) — prose explaining the ban is not a
  # violation.
  local code_lines
  code_lines="$(echo "${sans_trailing_comments}" | grep -vE '^\+[[:space:]]*(//|\*)' || true)"

  for lit in "${FORBIDDEN_LITERALS[@]}"; do
    matches="$( (echo "${code_lines}" | grep -E -- "^${lit}|[^A-Za-z0-9_-]${lit}") || true )"
    if [[ -n "${matches}" ]]; then
      echo "FAIL [FF-T0572-ANTICASE]: anti-case literal '${lit}' found in an ADDED line under web/src/:"
      echo "${matches}"
      errors=$((errors + 1))
    fi
  done
}

self_test() {
  echo "[T-0572] rights-ui-anti-case --self-test: synthetic diff fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  git init -q -b base-branch "${tmp}/repo"
  (
    cd "${tmp}/repo"
    git config user.email "test@example.com"
    git config user.name "Test"
    mkdir -p web/src
    echo "// base file" > web/src/base.jsx
    git add -A
    git commit -q -m "base"
  )

  # GOOD branch: adds a file with only platform-generic labels.
  (
    cd "${tmp}/repo"
    git checkout -q -b good-branch base-branch
    cat > web/src/good.jsx <<'EOF'
export const READER_ROLE_LABEL = "Читатель";
EOF
    git add -A
    git commit -q -m "good addition"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local good_errors=${errors}

  # BAD branch: adds a file with a planted anti-case literal.
  (
    cd "${tmp}/repo"
    git checkout -q -b bad-branch base-branch
    cat > web/src/bad.jsx <<'EOF'
export const SOME_ROLE_LABEL = "role-approver";
EOF
    git add -A
    git commit -q -m "bad addition"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local bad_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD diff (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (anti-case) diff"
    return 1
  fi
  echo "SELF-TEST PASS: good diff clean, bad diff flagged (${bad_errors} violation(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0572] rights-ui-anti-case: FF-T0572-ANTICASE D-064 anti-case gate (web/src/, git-diff scoped)"
BASE_REF="$(resolve_base_ref)"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-T0572-ANTICASE]: cannot determine base ref — skipping diff-scoped anti-case scan"
  exit 0
fi
scan_diff "${PROJECT_ROOT}" "${BASE_REF}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: rights-ui-anti-case found ${errors} violation(s)"
  exit 1
fi
echo "PASS: rights-ui-anti-case — no D-064 anti-case literals added under web/src/ (base=${BASE_REF})"
exit 0
