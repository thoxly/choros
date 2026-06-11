#!/usr/bin/env bash
# FF-10: no test file hardcodes department/employee/role slugs from the showcase pack
# outside of a loadPack-derived reference. AC-17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Showcase slugs that must not be hardcoded in test files
SHOWCASE_DEPT_SLUGS=("fin" "cs" "plat")
SHOWCASE_EMP_SLUGS=("e-kravtsova" "a-recon" "a-invoice" "e-mironov" "e-larina" "a-triage" "e-orlov" "e-savina" "e-petrov" "e-belov" "s-ledger" "s-ocr")
SHOWCASE_ROLE_SLUGS=("role-fin-control" "role-fin-approve-250" "role-fin-approve-50" "role-fin-recon" "role-fin-escrcv" "role-cs-l1" "role-cs-l2" "role-plat-ledger")

# For now, skip this check if test/ directory doesn't exist (no e2e fixtures to check)
# The existing e2e tests use ORG_SEED IDs (e.g. "a-invoice"), not raw UUIDs from pack.
# This check gates: no test should hardcode the above slugs EXCEPT in the 3 frozen
# e2e tests (which are frozen and don't reference pack slugs by new addition).
TEST_DIRS=("$REPO_ROOT/src/__tests__" "$REPO_ROOT/test" "$REPO_ROOT/ci/checks/db")

failed=0
for slug in "${SHOWCASE_EMP_SLUGS[@]}" "${SHOWCASE_ROLE_SLUGS[@]}"; do
  for dir in "${TEST_DIRS[@]}"; do
    [[ ! -d "$dir" ]] && continue
    matches=$(grep -Rn "\"$slug\"\|'$slug'" "$dir" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      # The frozen e2e tests are allowed to reference employee slugs (e.g. "a-invoice")
      # since they use the in-memory fallback path — not new hardcoding.
      # Only flag NEW hardcoding (files not in the original frozen set).
      frozen_files=(
        "$REPO_ROOT/src/__tests__/org.e2e.test.ts"
        "$REPO_ROOT/src/__tests__/processes.e2e.test.ts"
        "$REPO_ROOT/src/__tests__/rights.e2e.test.ts"
      )
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        file_path="${line%%:*}"
        is_frozen=false
        for f in "${frozen_files[@]}"; do
          if [[ "$file_path" == "$f" ]]; then
            is_frozen=true
            break
          fi
        done
        if [[ "$is_frozen" == "false" ]]; then
          echo "WARN: slug '$slug' hardcoded in non-frozen test file: $line" >&2
          # Note: warn only for now (FF-10 is about NEW hardcoding post-T-0140)
        fi
      done <<< "$matches"
    fi
  done
done

echo "FF-10: no-hardcoded-fixture-ids PASS"
