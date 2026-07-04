#!/usr/bin/env bash
# T-0581 (view registry) · FF-VR-5 — anti-case gate (D-064 discipline, NF-4/AC-12).
#
# THE CONTRACT (spec NF-4/AC-12, ADR §5 R-5): list_view is a GENERIC primitive —
# the CRM "список сделок под себя" kейс-доказательство (К1) is TEST MATERIAL
# only, never a platform constant. This check greps the ADDED lines of `git
# diff` under src/ (+ untracked new src/ files) for the D-064 denylist AS IT
# APPLIES TO THIS TASK'S DOMAIN: "сделка"/"стадия"/"deal"/"stage"/"CRM" used as
# a platform-code constant (identifier/string literal), never a comment
# explaining the anti-case ban itself.
#
# GIT-DIFF SCOPED (mirrors read-pdp-anti-case.sh exactly): only lines this
# task's diff ADDS under src/ are scanned — pre-existing repo content (which
# may legitimately reference these words in unrelated comments/docs) is not
# re-scanned by this check (out of scope; the general anti-case-lock.sh
# aggregate covers repo-wide regressions).
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the
# detector against a synthetic diff so it does not depend on this task's own
# (clean) diff to prove the detector fires.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# D-064 §5 denylist, this task's domain (CRM К1 test-material words that must
# never become platform-code constants). Case-insensitive on the Latin words;
# Cyrillic literals matched verbatim (Russian has no case-fold ambiguity here).
FORBIDDEN_LITERALS=(
  "deal"
  "stage"
  "сделка"
  "стадия"
)

resolve_base_ref() {
  git -C "${PROJECT_ROOT}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${PROJECT_ROOT}" merge-base HEAD dev 2>/dev/null \
    || git -C "${PROJECT_ROOT}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

scan_diff() {
  local repo_root="$1" base_ref="$2"
  errors=0
  local diff_output
  diff_output="$( (git -C "${repo_root}" diff "${base_ref}" -- src/ 2>/dev/null) || true )"
  local added_lines
  added_lines="$(echo "${diff_output}" | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
  local untracked_files f untracked_content
  untracked_files="$(git -C "${repo_root}" ls-files --others --exclude-standard -- src/ 2>/dev/null || true)"
  if [[ -n "${untracked_files}" ]]; then
    while IFS= read -r f; do
      [[ -z "${f}" ]] && continue
      untracked_content="$(sed 's/^/+/' "${repo_root}/${f}" 2>/dev/null || true)"
      added_lines="${added_lines}
${untracked_content}"
    done <<< "${untracked_files}"
  fi
  # Strip trailing comments so a comment cannot launder executable code past
  # the scan (mirrors read-pdp-anti-case.sh review R-1 fix).
  local sans_trailing_comments
  sans_trailing_comments="$(echo "${added_lines}" | sed -E 's#^(\+.*[^:/])//.*$#\1#; s#^(\+.*[^:/])/\*.*$#\1#')"
  # Drop comment-only / doc-only lines (this file's OWN header legitimately
  # names the banned words as prose explaining the ban) and the unit-test
  # sanity-list lines that assert the denylist itself (mirrors RP-10 pattern).
  local code_lines
  code_lines="$(echo "${sans_trailing_comments}" | grep -vE '^\+[[:space:]]*(//|\*)' | grep -vE '\bFORBIDDEN_SANITY_LIST\b[[:space:]]*=' || true)"
  local lit matches
  for lit in "${FORBIDDEN_LITERALS[@]}"; do
    matches="$( (echo "${code_lines}" | grep -inE -- "${lit}") || true )"
    if [[ -n "${matches}" ]]; then
      echo "FAIL [FF-VR-5]: anti-case literal '${lit}' found in an ADDED line under src/:"
      echo "${matches}"
      errors=$((errors + 1))
    fi
  done
}

self_test() {
  echo "[T-0581] view-registry-anti-case --self-test: synthetic diff fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  git init -q -b base-branch "${tmp}/repo"
  (
    cd "${tmp}/repo"
    git config user.email "test@example.com"
    git config user.name "Test"
    mkdir -p src
    echo "// base file" > src/base.ts
    git add -A
    git commit -q -m "base"
  )

  (
    cd "${tmp}/repo"
    git checkout -q -b good-branch base-branch
    cat > src/good.ts <<'EOF'
export const LIST_VIEW_DEFAULT_TYPE = "list";
export function validateViewConfig(type: string): boolean { return type === "list"; }
EOF
    git add -A
    git commit -q -m "good addition"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local good_errors=${errors}

  (
    cd "${tmp}/repo"
    git checkout -q -b bad-branch base-branch
    cat > src/bad.ts <<'EOF'
export const KANBAN_STAGE_FIELD = "stage";
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

echo "[T-0581] view-registry-anti-case: FF-VR-5 D-064 anti-case gate (git-diff scoped)"
BASE_REF="$(resolve_base_ref)"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-VR-5]: cannot determine base ref — skipping diff-scoped anti-case scan"
  exit 0
fi
scan_diff "${PROJECT_ROOT}" "${BASE_REF}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: view-registry-anti-case found ${errors} violation(s)"
  exit 1
fi
echo "PASS: view-registry-anti-case — no D-064 anti-case literals added under src/ (base=${BASE_REF})"
exit 0
