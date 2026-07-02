#!/usr/bin/env bash
# T-0572 (rights UI writes) · FF-T0572-4/5/6 — no new grant/assignment write
# endpoint is introduced by this task.
#
# THE CONTRACT (spec NF-1, ADR §2.5/§2.8, AC-4/AC-5/AC-6): the ONLY new
# endpoint this task adds is the READ (GET /api/rights/tenant-state). Role
# assignment / grant creation, revocation, and the confirm2 second-approval
# phase all continue to run through the EXISTING write API in
# src/http/grants.ts (POST /api/grants(/:id/revoke), POST
# /api/role-assignments(/:id/revoke)). This gate greps the git-diff ADDED
# lines under src/ for any NEW router.register("POST", ...) call whose path
# touches /api/grants or /api/role-assignments — a hit means a second write
# surface was introduced, which this task must never do.
#
# GIT-DIFF SCOPED: only lines this task's diff ADDS under src/ are scanned
# (mirrors read-pdp-anti-case.sh's `+`-line discipline) — the EXISTING
# registrations inside src/http/grants.ts (frozen, unmodified by this task)
# are pre-existing context lines, not additions, and are correctly ignored.
#
# Exit 0 clean, non-zero on any violation. --self-test exercises the detector
# against a synthetic git repo (planted good/bad diffs).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
  local diff_output added_lines
  diff_output="$( (git -C "${repo_root}" diff "${base_ref}" -- src/ 2>/dev/null) || true )"
  added_lines="$(echo "${diff_output}" | grep -E '^\+' | grep -vE '^\+\+\+' || true)"

  # Also scan brand-new untracked files under src/ (never seen by base — every
  # line is "added" relative to base).
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

  # A NEW POST route registration touching grant/role-assignment write paths.
  local matches
  matches="$( (echo "${added_lines}" | grep -E 'router\.register\(\s*"POST"\s*,\s*"[^"]*(grants|role-assignments)') || true )"
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FF-T0572-4/5/6]: a NEW POST route touching grants/role-assignments was added:"
    echo "${matches}"
    errors=$((errors + 1))
  fi
}

self_test() {
  echo "[T-0572] rights-ui-no-new-write --self-test: synthetic diff fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  git init -q -b base-branch "${tmp}/repo"
  (
    cd "${tmp}/repo"
    git config user.email "test@example.com"
    git config user.name "Test"
    mkdir -p src/http
    echo "// base file" > src/http/base.ts
    git add -A
    git commit -q -m "base"
  )

  # GOOD branch: adds a READ-only route (no grants/role-assignments POST).
  (
    cd "${tmp}/repo"
    git checkout -q -b good-branch base-branch
    cat > src/http/good.ts <<'EOF'
export function registerGoodRoutes(router, pool) {
  router.register("GET", "/api/rights/tenant-state", async (req, res) => {});
}
EOF
    git add -A
    git commit -q -m "good addition (read-only)"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local good_errors=${errors}

  # BAD branch: adds a NEW write route for grants.
  (
    cd "${tmp}/repo"
    git checkout -q -b bad-branch base-branch
    cat > src/http/bad.ts <<'EOF'
export function registerBadRoutes(router, pool) {
  router.register("POST", "/api/grants/quick-grant", async (req, res) => {});
}
EOF
    git add -A
    git commit -q -m "bad addition (second write path)"
  )
  scan_diff "${tmp}/repo" "base-branch"
  local bad_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD diff (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD diff"
    return 1
  fi
  echo "SELF-TEST PASS: good diff clean, bad diff flagged (${bad_errors} violation(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0572] rights-ui-no-new-write: FF-T0572-4/5/6 no-new-write-endpoint gate"
BASE_REF="$(resolve_base_ref)"
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-T0572-4/5/6]: cannot determine base ref — skipping diff-scoped scan"
  exit 0
fi
scan_diff "${PROJECT_ROOT}" "${BASE_REF}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: rights-ui-no-new-write found ${errors} violation(s)"
  exit 1
fi
echo "PASS: rights-ui-no-new-write — no new grant/role-assignment write endpoint added (base=${BASE_REF})"
exit 0
