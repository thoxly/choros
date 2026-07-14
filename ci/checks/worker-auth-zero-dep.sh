#!/usr/bin/env bash
# FF-4 (static-now, AC-18): Zero npm JWT dependencies.
# - No imports of jsonwebtoken / jose / jwks-rsa in src/
# - package.json dependencies do not include these packages
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "[FF-4] Checking zero-dep JWT invariant (no jsonwebtoken/jose/jwks-rsa)..."

FAIL=0

# Check src/ imports
if grep -rE 'jsonwebtoken|[^a-z]jose[^a-z]|jwks-rsa' "${ROOT}/src/" 2>/dev/null | grep -v '\.test\.' | grep -q .; then
  echo "  FAIL: JWT library import found in src/:" >&2
  grep -rE 'jsonwebtoken|[^a-z]jose[^a-z]|jwks-rsa' "${ROOT}/src/" 2>/dev/null | grep -v '\.test\.' >&2 || true
  FAIL=1
else
  echo "  [OK] No jsonwebtoken/jose/jwks-rsa imports in src/"
fi

# Check package.json dependencies
if grep -E '"(jsonwebtoken|jose|jwks-rsa)"' "${ROOT}/package.json" 2>/dev/null | grep -q '"dependencies"'; then
  echo "  FAIL: JWT package found in package.json dependencies" >&2
  FAIL=1
else
  # Check in the dependencies section specifically
  if python3 -c "
import json, sys
with open('${ROOT}/package.json') as f:
    pkg = json.load(f)
deps = {**pkg.get('dependencies', {}), **pkg.get('devDependencies', {})}
bad = [k for k in deps if k in ('jsonwebtoken', 'jose', 'jwks-rsa')]
if bad:
    print('FAIL: found JWT packages:', bad)
    sys.exit(1)
print('OK: no JWT packages in package.json')
" 2>/dev/null; then
    echo "  [OK] No JWT packages in package.json"
  else
    FAIL=1
  fi
fi

if [[ $FAIL -ne 0 ]]; then
  echo "[FF-4] FAIL: JWT dependency found." >&2
  exit 1
fi

echo "[FF-4] PASS: zero-dep JWT invariant satisfied."
