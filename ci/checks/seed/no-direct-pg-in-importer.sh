#!/usr/bin/env bash
# FF-2: seed/*.ts must not import pg or src/db/* (all writes through HTTP).
# AC-13 / NF-2.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

matches=$(grep -REn \
  "from ['\"]pg['\"]|require\(['\"]pg['\"]\)|from ['\"].*src/db" \
  "$REPO_ROOT/seed/" 2>/dev/null || true)

if [[ -n "$matches" ]]; then
  echo "FAIL: direct pg/src/db imports found in seed/:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "FF-2: no-direct-pg-in-importer PASS"
