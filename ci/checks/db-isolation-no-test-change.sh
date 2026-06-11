#!/usr/bin/env bash
# T-0147 · FF-T147-2 — existing db test-files are not modified
#
# Verifies that ci/checks/db/*.test.ts files are unchanged relative to HEAD
# (AC-4: isolation implemented outside tests, not inside them).
#
# Usage:
#   bash ci/checks/db-isolation-no-test-change.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

changed=$(git -C "$REPO_ROOT" diff HEAD -- 'ci/checks/db/*.test.ts' 2>/dev/null)
if [ -z "$changed" ]; then
  echo "OK [FF-T147-2]: no ci/checks/db/*.test.ts files modified"
  exit 0
else
  echo "FAIL [FF-T147-2]: the following db test-files were modified (AC-4 violation):"
  git -C "$REPO_ROOT" diff --name-only HEAD -- 'ci/checks/db/*.test.ts'
  exit 1
fi
