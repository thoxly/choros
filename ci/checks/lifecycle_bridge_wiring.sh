#!/usr/bin/env bash
# T-0068 · FF-9 (grep half, AC-14) + FF-12 (compat contract):
#
#   FF-9 grep : createServer() must NOT start the bridge poll loop — the wiring
#               lives in the index.ts main block (lockReclaimer pattern), so test
#               imports of the server never start a loop.
#   FF-12     : AuditEventInput stays exported from audit-grant-encoder.ts (the
#               T-0031/T-0030 import seam); resolveFor's signature is unchanged
#               (guardCtx remains the 6th optional param).
#
# Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER="${ROOT}/src/server.ts"
INDEX="${ROOT}/src/index.ts"
MAIN="${ROOT}/src/main.ts"
ENCODER="${ROOT}/src/core/audit-grant-encoder.ts"
RESOLVER="${ROOT}/src/core/grant-resolver.ts"
ERRORS=0

echo "[FF-9/FF-12] lifecycle_bridge_wiring: loop in main-block only + compat contract"

# ---- FF-9: createServer / server.ts does NOT start the bridge loop ----------
if grep -qE 'startBridgePollLoop|startLifecycleBridge|startOutboxDispatcherLoop' "${SERVER}"; then
  echo "FAIL: src/server.ts references a bridge/dispatcher loop (must be in the main composition root)"
  grep -nE 'startBridgePollLoop|startLifecycleBridge|startOutboxDispatcherLoop' "${SERVER}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: src/server.ts does not start any bridge/dispatcher loop"
fi

# ---- FF-9: the main composition root (main.ts) wires the bridge -------------
if grep -qE 'startLifecycleBridge' "${MAIN}"; then
  echo "PASS: main.ts wires startLifecycleBridge (composition root)"
else
  echo "FAIL: main.ts does not wire startLifecycleBridge"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-9: index.ts main block delegates to startMain ----------------------
if grep -qE 'startMain' "${INDEX}"; then
  echo "PASS: index.ts main block delegates to startMain"
else
  echo "FAIL: index.ts does not delegate to startMain"
  ERRORS=$((ERRORS + 1))
fi

# ---- R-1 fix: the dispatcher loop (the REAL onDispatched firing point) is
#      actually started and fed the audit callback in the composition root. ---
if grep -qE 'startOutboxDispatcherLoop' "${ROOT}/src/server/lifecycle-bridge.ts" \
   && grep -qE 'onDispatched:[[:space:]]*auditOnDispatched' "${ROOT}/src/server/lifecycle-bridge.ts"; then
  echo "PASS: lifecycle-bridge starts the outbox dispatcher with onDispatched=audit callback"
else
  echo "FAIL: lifecycle-bridge does not start a dispatcher loop wired to the audit callback (R-1)"
  ERRORS=$((ERRORS + 1))
fi

# ---- R-2 fix: no void-ed dead wiring touch remains -------------------------
if grep -qE 'void[[:space:]]+buildAuditOnDispatched' "${ROOT}/src/server/lifecycle-bridge.ts"; then
  echo "FAIL: dead 'void buildAuditOnDispatched(...)' touch still present (R-2)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no void-ed buildAuditOnDispatched dead-code touch"
fi

# ---- FF-12: AuditEventInput stays exported from audit-grant-encoder.ts ------
if grep -qE 'export type AuditEventInput' "${ENCODER}"; then
  echo "PASS: AuditEventInput is exported from audit-grant-encoder.ts"
else
  echo "FAIL: AuditEventInput export removed from audit-grant-encoder.ts (T-0031/T-0030 seam)"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-12: resolveFor signature unchanged (guardCtx 6th optional param) ----
if grep -qE 'guardCtx\?:[[:space:]]*GuardContext' "${RESOLVER}"; then
  echo "PASS: resolveFor retains the optional guardCtx param (signature unchanged)"
else
  echo "FAIL: resolveFor guardCtx?: GuardContext param missing (signature changed)"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: lifecycle_bridge_wiring found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: lifecycle_bridge_wiring — all checks green"
exit 0
