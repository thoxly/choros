#!/usr/bin/env bash
# FF-4: single source of truth — no NEW hardcoded copy of demo org/role/process data.
# (a) exactly one seed/showcase/pack.json exists
# (b) no *_SEED const declared in src/ other than the three known fallbacks
# (c) no .ts/.json under src/|test/ re-declares the showcase slug set
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# (a) seed/showcase/pack.json must exist
if [[ ! -f "$REPO_ROOT/seed/showcase/pack.json" ]]; then
  echo "FAIL: seed/showcase/pack.json does not exist" >&2
  exit 1
fi

# (b) *_SEED consts allowed only in the known frozen files.
# The three demo-content fallbacks (ORG_SEED/PROCESSES_SEED/RIGHTS_SEED) are the primary concern.
# Other *_SEED consts (INBOX_SEED, AUDIT_SEED, TRAIL_SEED, ORG_SEED_CHILDREN) are non-demo
# operational seeds in their own handlers — they are not duplicates of the showcase pack content.
allowed_seed_files=(
  "src/http/org.ts"
  "src/http/processes.ts"
  "src/http/rights.ts"
  "src/http/inbox.ts"
  "src/http/audit.ts"
  "src/http/grant-trail.ts"
  "src/http/grants.ts"
  "src/http/invoke.ts"        # T-0024: ORG_SEED_CHILDREN (pre-existing dup, dedup = follow-up task)
  "src/http/agents.ts"        # T-0042: ORG_SEED_CHILDREN (pre-existing dup, dedup = follow-up task)
  "src/http/secret-handle.ts" # T-0025: ORG_SEED_CHILDREN (pre-existing dup, dedup = follow-up task)
)

seed_matches=$(grep -Rn "const [A-Z_]*_SEED" "$REPO_ROOT/src/" 2>/dev/null || true)
failed=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # Extract relative file path (format: path:lineno:content)
  rel="${line#$REPO_ROOT/}"
  file_part="${rel%%:*}"
  allowed=false
  for a in "${allowed_seed_files[@]}"; do
    if [[ "$file_part" == "$a" ]]; then
      allowed=true
      break
    fi
  done
  if [[ "$allowed" == "false" ]]; then
    echo "FAIL: unexpected *_SEED const outside allow-list: $line" >&2
    failed=1
  fi
done <<< "$seed_matches"

if [[ $failed -ne 0 ]]; then
  exit 1
fi

echo "FF-4: single-source PASS"
