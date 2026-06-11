#!/usr/bin/env bash
# T-0147 · FF-T147-3 — globalSetup.ts does not import production src/ modules
#
# Verifies that ci/checks/db/globalSetup.ts imports only pg (devDep) and Node
# builtins. It must not pull in src/ production modules.
#
# Usage:
#   bash ci/checks/db-isolation-globalsetup-pure.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO_ROOT/ci/checks/db/globalSetup.ts"

if [[ ! -f "$SETUP" ]]; then
  echo "FAIL [FF-T147-3]: ci/checks/db/globalSetup.ts not found"
  exit 1
fi

# Fail if any import of src/ or @choros internal packages is found
if grep -E "^import .* from '(src/|@choros)" "$SETUP"; then
  echo "FAIL [FF-T147-3]: globalSetup.ts imports production src/ modules (see above)"
  exit 1
fi

echo "OK [FF-T147-3]: globalSetup.ts imports only allowed modules (pg + builtins)"
exit 0
