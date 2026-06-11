#!/usr/bin/env bash
# FF-HIRE-4: Additive-only changes to frozen/shared files.
# The four frozen core files must not be modified by T-0042.
# For router.ts and auth.ts (allowed additive additions): assert deleted lines == 0.

set -euo pipefail

# Determine the merge-base with dev (the common ancestor = the base of this branch).
# Fall back to the parent commit if 'dev' branch is not available locally.
BASE=$(git merge-base HEAD origin/dev 2>/dev/null \
       || git merge-base HEAD dev 2>/dev/null \
       || git rev-parse HEAD~1 2>/dev/null \
       || echo "")

if [ -z "$BASE" ]; then
  echo "WARN FF-HIRE-4: cannot determine base commit; skipping frozen-file diff check"
  exit 0
fi

# Fully frozen files — must have 0 diff against base
FROZEN=(
  "src/core/grant-lattice.ts"
  "src/core/grant-resolver.ts"
  "src/core/mcp-tool-registry.ts"
  "src/core/scoped-admin.ts"
)

FAIL=0
for F in "${FROZEN[@]}"; do
  CHANGED=$(git diff --name-only "$BASE" -- "$F" 2>/dev/null || true)
  if [ -n "$CHANGED" ]; then
    echo "FAIL FF-HIRE-4: frozen file $F was modified" >&2
    FAIL=1
  fi
done

# Additive-only files (router.ts, auth.ts) — check deleted lines == 0
ADDITIVE_ONLY=(
  "src/http/auth.ts"
  "src/http/router.ts"
)
for F in "${ADDITIVE_ONLY[@]}"; do
  DELETED=$(git diff "$BASE" -- "$F" 2>/dev/null | grep -c '^-[^-]' || true)
  if [ "${DELETED:-0}" -gt 0 ]; then
    echo "FAIL FF-HIRE-4: $F has $DELETED deleted line(s) — must be additive only" >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS FF-HIRE-4: frozen files unmodified; additive-only files have zero deleted lines"
