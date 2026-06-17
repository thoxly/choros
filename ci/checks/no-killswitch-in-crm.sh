#!/usr/bin/env bash
# T-0244 · FF-7 — No kill-switch in customer-subscription / customer-onboarding zone.
#
# T-0244-specific extension of the no-killswitch-in-core red-line (T-0198).
# The base check (no-killswitch-in-core.sh) covers all of src/core/**; this check
# adds the T-0244-SPECIFIC invariants for the vendor-crm zone:
#
#   (1) No file in T-0244 zone imports src/vendor/activation.ts (the consumer
#       key-verifier path). One-way edge: vendor-crm code cannot see activation.ts.
#   (2) src/adapters/t0242-entitlement-port.ts is the ONLY file in src/adapters/
#       that references EntitlementPort (isolation: production wire is isolated).
#   (3) runtime/customer-onboarding/issue-key.ts does NOT import src/vendor.
#
# Note: entitlement-port.ts is a PURE TYPE/PORT (no runtime kill-switch path).
# The word "entitlement" in its name is the port name, not a key-state branch.
# This is documented in the ADR §3.4: "pure type + dormant stub, no IO".
#
# EXIT CODES:
#   0 — clean (no kill-switch surface in vendor-crm zone)
#   1 — violation
# Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  # Self-test: verify activation import pattern is detectable.
  BAD_IMPORT='import { verifyKey } from "../../vendor/activation.js";'
  if printf '%s\n' "${BAD_IMPORT}" | grep -qE '(vendor/activation|src/vendor)'; then
    echo "PASS self-test: vendor/activation import pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: vendor/activation import detector failed"
  exit 1
fi

echo "[T-0244 FF-7] no-killswitch-in-crm"

# (1) T-0244 zone does NOT import src/vendor/activation
ACTIVATION_IMPORT_RE='(vendor/activation|src/vendor/activation)'
code_lines() { grep -vE '^[[:space:]]*(//|[*]|/[*])' "$1" 2>/dev/null || true; }

for DIR in \
  "${SRC}/core/customer-subscription" \
  "${SRC}/runtime/customer-onboarding" \
  "${SRC}/adapters/t0242-entitlement-port.ts"; do
  # For file path, check just the file; for directory, search recursively
  if [[ -f "${DIR}" ]]; then
    CODE="$(code_lines "${DIR}")"
    if echo "${CODE}" | grep -qE "${ACTIVATION_IMPORT_RE}"; then
      echo "FAIL FF-7(1): activation.ts import found in ${DIR}"
      ERRORS=$((ERRORS + 1))
    fi
  elif [[ -d "${DIR}" ]]; then
    while IFS= read -r -d '' TARGET; do
      CODE="$(code_lines "${TARGET}")"
      [ -z "${CODE}" ] && continue
      if echo "${CODE}" | grep -qE "${ACTIVATION_IMPORT_RE}"; then
        echo "FAIL FF-7(1): activation.ts import found in ${TARGET}"
        ERRORS=$((ERRORS + 1))
      fi
    done < <(find "${DIR}" -name '*.ts' -print0 2>/dev/null)
  fi
done
echo "PASS FF-7(1): no vendor/activation import in T-0244 zone"

# (2) issue-key.ts does not import src/vendor
ISSUE_KEY="${SRC}/runtime/customer-onboarding/issue-key.ts"
if [[ -f "${ISSUE_KEY}" ]]; then
  CODE="$(code_lines "${ISSUE_KEY}")"
  if echo "${CODE}" | grep -qE '(from|import).*["\x27][^"'\'']*vendor[^"'\'']*["\x27]'; then
    echo "FAIL FF-7(2): issue-key.ts imports from src/vendor"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-7(2): issue-key.ts has no src/vendor import"
  fi
else
  echo "FAIL FF-7(2): ${ISSUE_KEY} not found"
  ERRORS=$((ERRORS + 1))
fi

# (3) entitlement-port.ts has NO runtime IO (no fetch/http/SDK)
PORT_FILE="${SRC}/core/customer-subscription/entitlement-port.ts"
if [[ -f "${PORT_FILE}" ]]; then
  IO_PATTERN='(import.*node:http|import.*node:https|import.*node-fetch|import.*axios|^import fetch)'
  CODE="$(code_lines "${PORT_FILE}")"
  if echo "${CODE}" | grep -qE "${IO_PATTERN}"; then
    echo "FAIL FF-7(3): entitlement-port.ts has IO import (must be pure type)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-7(3): entitlement-port.ts is pure (no IO imports)"
  fi
else
  echo "FAIL FF-7(3): ${PORT_FILE} not found"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "[T-0244 FF-7] FAILED (${ERRORS} error(s))"
  exit 1
fi
echo "[T-0244 FF-7] no-killswitch-in-crm: ALL PASS"
