#!/usr/bin/env bash
# FF-A6: Handle binds to UUIDs not slugs; never cross-tenant
#
# Asserts:
#  1. Every ResourceRef fixture in the test file uses UUID-shaped values
#     (matches the pattern xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx) for id fields.
#  2. No fixture assigns a slug/display-name (non-UUID non-empty-string) to an
#     applicationId / registryId / recordId field.
#  3. The makeHandle cross-tenant test fixture exists and throws
#     CrossTenantHandleError (verified by grep for the test assertion).
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEST_FILE="${PROJECT_ROOT}/src/__tests__/object-handle.test.ts"
ERRORS=0

echo "[FF-A6] handle-uuid-binding: checking UUID-only ref binding"

UUID_PATTERN="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}"

# ---- Check 1: UUID-shaped constants exist in test file -----------------

if ! grep -qE "${UUID_PATTERN}" "${TEST_FILE}"; then
  echo "FAIL: no UUID-shaped constants found in test file ${TEST_FILE}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: UUID-shaped constants present in test fixtures"
fi

# ---- Check 2: all *_ID constants (APP_ID / REG_ID / REC_ID / TENANT_*) are UUIDs ----

ID_CONSTANTS=$(grep -E '^const [A-Z_]+(ID|TENANT)[A-Z_]* = ' "${TEST_FILE}" || true)
if [[ -z "${ID_CONSTANTS}" ]]; then
  echo "PASS: no id constants to slug-check (or pattern not matched — ok)"
else
  # Each constant value must match the UUID pattern
  while IFS= read -r line; do
    value=$(echo "${line}" | grep -oE '"[^"]*"' | head -1 | tr -d '"')
    if [[ -z "${value}" ]]; then
      continue
    fi
    if ! echo "${value}" | grep -qE "^${UUID_PATTERN}$"; then
      echo "FAIL: non-UUID constant value in test fixture: ${line}"
      ERRORS=$((ERRORS + 1))
    fi
  done <<< "${ID_CONSTANTS}"
  if [[ ${ERRORS} -eq 0 ]]; then
    echo "PASS: all id/tenant constants are UUID-shaped"
  fi
fi

# ---- Check 3: cross-tenant throw test exists ---------------------------

if ! grep -q "CrossTenantHandleError" "${TEST_FILE}"; then
  echo "FAIL: no CrossTenantHandleError assertion found in test file"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: CrossTenantHandleError is tested in test suite"
fi

# ---- Check 4: no slug-like literal used as an ID component in fixtures ----
# Slug pattern: a plain kebab-case or camelCase string (not a UUID) assigned to
# applicationId / registryId / recordId / tenantId
# Check that applicationId/registryId/recordId string values look like UUIDs, not slugs.
# Use python3 to avoid ERE bracket-expression portability issues.
SLUG_CHECK=$(python3 - "${TEST_FILE}" "${UUID_PATTERN}" <<'PYEOF'
import sys, re

path = sys.argv[1]
uuid_re = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}')
id_fields = re.compile(r'(applicationId|registryId|recordId)\s*:\s*"([^"]+)"')

with open(path) as f:
    lines = f.readlines()

violations = []
for i, line in enumerate(lines, 1):
    if line.strip().startswith('//'):
        continue
    for m in id_fields.finditer(line):
        val = m.group(2)
        if not uuid_re.match(val):
            violations.append(f"  line {i}: {m.group(0).strip()}")

if violations:
    print("FAIL\n" + "\n".join(violations))
else:
    print("OK")
PYEOF
)

if echo "${SLUG_CHECK}" | grep -q "^FAIL"; then
  echo "FAIL: slug-like (non-UUID) value used for an ID component in test fixture:"
  echo "${SLUG_CHECK}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no slug-like id values in test fixtures"
fi

# ---- Result ------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: handle-uuid-binding found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: handle-uuid-binding — all checks green"
exit 0
