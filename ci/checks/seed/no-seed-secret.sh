#!/usr/bin/env bash
# FF-3: no credentials/secrets committed under seed/.
# AC-14 / NF-5. Uses same patterns as no-committed-secret.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Credential pattern list (mirrors no-committed-secret.sh patterns)
patterns=(
  'password\s*[:=]\s*["\x27][^"\x27]{4,}'
  'secret\s*[:=]\s*["\x27][^"\x27]{4,}'
  'token\s*[:=]\s*["\x27][^"\x27]{4,}'
  'api_key\s*[:=]\s*["\x27][^"\x27]{4,}'
  'AWS_SECRET'
  'private_key'
)

failed=0
for pattern in "${patterns[@]}"; do
  matches=$(grep -RiEn "$pattern" "$REPO_ROOT/seed/" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    echo "FAIL: potential secret pattern '$pattern' found in seed/:" >&2
    echo "$matches" >&2
    failed=1
  fi
done

if [[ $failed -ne 0 ]]; then
  exit 1
fi

echo "FF-3: no-seed-secret PASS"
