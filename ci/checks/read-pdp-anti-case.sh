#!/usr/bin/env bash
# T-0570 (D3, READ-PDP) · FF-RP-7 — anti-case gate (D-064 discipline, NF-4/AC-9).
#
# THE CONTRACT (spec NF-4 / AC-9, ADR §2.5): the READ-PDP default-open grant is
# a PLATFORM PRIMITIVE (RESOURCE_ROOT_NODE_ID, role-reader) — it must never
# encode a specific live business case (a specific role slug, a specific
# process/workflow slug, a specific persona). This check greps the ADDED lines
# of `git diff` under src/ for the case-specific literals D-064 names:
#   role-approver, soglasovanie, tel-, Согласование (as a hardcoded string
#   constant), e-larina, e-orlov, e-configurator
#
# GIT-DIFF SCOPED (not whole-repo): the check inspects only lines this task's
# diff ADDS under src/ (a `+` line in `git diff <base>...HEAD -- src/`), never
# pre-existing repo content — other, pre-existing modules legitimately
# reference these case strings elsewhere (e.g. migration 088's e-configurator
# seed, T-0372's e-larina/e-orlov persona comments, T-0373's role-configurator
# slug). This gate is about what THIS task's diff adds, not a repo-wide ban.
#
# Distinguishes grep rc=1 (no match, clean) from rc>=2 (grep error). Exit 0 on
# clean, non-zero on any violation. --self-test exercises the detector against
# a synthetic diff (a temp git repo) so it does not depend on this task's own
# (clean) diff to prove the detector fires.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# The D-064 anti-case literals (case-specific role/slug/persona strings).
FORBIDDEN_LITERALS=(
  "role-approver"
  "soglasovanie"
  "tel-"
  "Согласование"
  "e-larina"
  "e-orlov"
  "e-configurator"
)

# Resolve the base ref to diff against (mirrors agent-instruction-additive.sh
# BASE resolution: origin/dev → dev → HEAD~1, whichever exists first).
resolve_base_ref() {
  git -C "${PROJECT_ROOT}" merge-base HEAD origin/dev 2>/dev/null \
    || git -C "${PROJECT_ROOT}" merge-base HEAD dev 2>/dev/null \
    || git -C "${PROJECT_ROOT}" rev-parse HEAD~1 2>/dev/null \
    || echo ""
}

# Scan the ADDED lines of `git diff <base>...HEAD -- src/` (run inside
# `repo_root`) for any forbidden literal. Sets the `errors` global (bash 3.2
# compatible — no nameref support) and prints violations to stdout.
scan_diff() {
  local repo_root="$1" base_ref="$2"
  errors=0
  local diff_output lit matches
  diff_output="$( (git -C "${repo_root}" diff "${base_ref}" -- src/ 2>/dev/null) || true )"
  # Keep only ADDED lines (leading '+', excluding the '+++' file-header line).
  local added_lines
  added_lines="$(echo "${diff_output}" | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
  # ALSO include brand-new, untracked files under src/ (a `git diff <base>`
  # shows NOTHING for a file git has never seen — every line of a new module
  # like read-visibility.ts/resource-ancestry.ts is "added" relative to base,
  # so it must be scanned too, not silently skipped).
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
  # Strip trailing comments BEFORE any exclusion logic runs (review R-1 fix):
  # a line like `export const X = "role-approver"; // FORBIDDEN: trust me`
  # must NOT be able to launder executable code past the scan just by
  # appending a comment containing an exclusion keyword. We cut each added
  # line at the first `//` or `/*` (keeping the `+` prefix and any CODE that
  # precedes the comment marker), so the exclusion checks below only ever see
  # the code portion of the line — never attacker-controlled comment text.
  local sans_trailing_comments
  sans_trailing_comments="$(echo "${added_lines}" | sed -E 's#^(\+.*[^:/])//.*$#\1#; s#^(\+.*[^:/])/\*.*$#\1#')"
  # Drop comment-only lines (T-0143 lesson, mirrors card-action-broad-scope.sh
  # grep_noncomment): a line whose non-`+`, non-whitespace content starts with
  # `//` or `*` (JSDoc continuation) is PROSE EXPLAINING the ban (this very
  # module's own doc comments legitimately name the banned literals as
  # examples of what NOT to write) — not an actual case-specific hardcode.
  #
  # Also drop the ONE specific legitimate line this task's own RP-10 unit test
  # uses: a `const FORBIDDEN_SANITY_LIST = [...]` declaration (single line,
  # lists every banned literal ONCE to assert NONE of them appear in the
  # platform constants — that is the test asserting the ban, not violating
  # it). This match is intentionally narrow — the EXACT identifier name, not
  # a bare substring match on the word "FORBIDDEN" — precisely so a comment
  # or unrelated identifier containing that word cannot be used to exclude an
  # otherwise-real hardcoded literal from the scan (review R-1: the previous
  # `grep -vE 'FORBIDDEN'` excluded ANY line containing that substring
  # anywhere, including in a trailing comment on an executable line — a
  # one-word bypass of the whole gate).
  local code_lines
  code_lines="$(echo "${sans_trailing_comments}" | grep -vE '^\+[[:space:]]*(//|\*)' | grep -vE '\bFORBIDDEN_SANITY_LIST\b[[:space:]]*=' || true)"
  for lit in "${FORBIDDEN_LITERALS[@]}"; do
    # LEFT word-boundary only: "e-configurator" must NOT match as a substring
    # of the pre-existing, legitimate "role-configurator" slug (T-0373) — the
    # D-064 ban targets the literal appearing as its OWN identifier/slug START
    # (e.g. migration 088's standalone e-configurator employee persona, or a
    # slug literally beginning with "tel-"), not any string that merely
    # CONTAINS it as a tail (role-CONFIGURATOR ⊃ e-configurator). We only
    # require the literal NOT be immediately preceded by an identifier
    # character; we intentionally do NOT require a right boundary, because
    # some of these literals (tel-) are themselves slug PREFIXES that are
    # immediately followed by more identifier characters in a real hit
    # (tel-cross-app, tel-linear, ...).
    matches="$( (echo "${code_lines}" | grep -E -- "^${lit}|[^A-Za-z0-9_-]${lit}") || true )"
    if [[ -n "${matches}" ]]; then
      echo "FAIL [FF-RP-7]: anti-case literal '${lit}' found in an ADDED line under src/:"
      echo "${matches}"
      errors=$((errors + 1))
    fi
  done
}

self_test() {
  echo "[T-0570] read-pdp-anti-case --self-test: synthetic diff fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  # Build a throwaway git repo with a base commit + src/ dir on an explicitly
  # named branch (base-branch — never relies on the ambient git default-branch
  # name, which varies main/master by environment), then a second commit that
  # adds a GOOD file (platform-primitive only) and check it's clean; then a
  # THIRD commit (branched fresh off base-branch) that adds a BAD file (a
  # planted case-specific literal) and check it's flagged.
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

  # GOOD branch: adds a file with only platform-primitive constants.
  (
    cd "${tmp}/repo"
    git checkout -q -b good-branch base-branch
    cat > src/good.ts <<'EOF'
export const RESOURCE_ROOT_NODE_ID = "00000000-0000-0000-0000-0000000000r0";
export const READER_ROLE_SLUG = "role-reader";
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
    cat > src/bad.ts <<'EOF'
export const SOME_ROLE = "role-approver";
EOF
    git add -A
    git commit -q -m "bad addition"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local bad_errors=${errors}

  # SNEAKY branch (review R-1 regression PoC): a planted anti-case literal on
  # an executable line, followed by a trailing `// FORBIDDEN...` comment
  # designed to abuse the exclusion meant for the RP-10 sanity-list line. The
  # previous exclusion (`grep -vE 'FORBIDDEN'` over the WHOLE line) dropped
  # this line from the scan entirely — a one-word comment bypassed the gate.
  # This is the exact PoC from the T-0570 review verdict; the detector MUST
  # still fire on it.
  (
    cd "${tmp}/repo"
    git checkout -q -b sneaky-branch base-branch
    cat > src/sneaky.ts <<'EOF'
export const SNEAKY_ROLE_SLUG = "role-approver"; // FORBIDDEN: trust me
EOF
    git add -A
    git commit -q -m "sneaky addition"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local sneaky_errors=${errors}

  # SANITY-LIST branch: the legitimate RP-10 pattern this exclusion exists
  # FOR — a `const FORBIDDEN_SANITY_LIST = [...]` line in a test file that
  # lists every banned literal ONCE to assert they're absent from platform
  # constants. Must stay clean (no false positive), proving the narrowed
  # exclusion still does its intended job.
  (
    cd "${tmp}/repo"
    git checkout -q -b sanity-list-branch base-branch
    mkdir -p src/__tests__
    cat > src/__tests__/sanity.test.ts <<'EOF'
const FORBIDDEN_SANITY_LIST = ["role-approver", "soglasovanie", "tel-", "Согласование", "e-larina", "e-orlov", "e-configurator"];
for (const bad of FORBIDDEN_SANITY_LIST) {
  expect(true).toBe(true);
}
EOF
    git add -A
    git commit -q -m "sanity list addition"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local sanity_list_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD diff (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (anti-case) diff"
    return 1
  fi
  if [[ ${sneaky_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the SNEAKY diff (review R-1 regression — trailing '// FORBIDDEN' comment must not launder a real hardcode past the scan)"
    return 1
  fi
  if [[ ${sanity_list_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the legitimate FORBIDDEN_SANITY_LIST diff (${sanity_list_errors} violation(s))"
    return 1
  fi
  echo "SELF-TEST PASS: good diff clean, bad diff flagged (${bad_errors} violation(s)), sneaky R-1 PoC flagged (${sneaky_errors} violation(s)), sanity-list diff clean"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0570] read-pdp-anti-case: FF-RP-7 D-064 anti-case gate (git-diff scoped)"
BASE_REF="$(resolve_base_ref)"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-RP-7]: cannot determine base ref — skipping diff-scoped anti-case scan"
  exit 0
fi
scan_diff "${PROJECT_ROOT}" "${BASE_REF}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: read-pdp-anti-case found ${errors} violation(s)"
  exit 1
fi
echo "PASS: read-pdp-anti-case — no D-064 anti-case literals added under src/ (base=${BASE_REF})"
exit 0
