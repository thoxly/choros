#!/usr/bin/env bash
# T-0169 · Notification routing isolation fitness (FF-NO-SWITCH-CHANNEL, FF-ONE-OUTBOX,
# FF-FANOUT-FAILCLOSED, FF-EVENT-CONTRACT, FF-NO-DELIVERY-AUDIT, FF-RESOLVER-PORT).
#
# FF-N1 (FF-EVENT-CONTRACT): NotificationEvent defined exactly once; publishNotificationEvent
#   exported exactly once.
# FF-N2 (FF-NO-SWITCH-CHANNEL): no switch/case on channel, no 'channel ===' in routing core.
# FF-N3 (FF-ONE-OUTBOX): no new setInterval / startNotificationDispatcher in routing module.
# FF-N4 (FF-NO-DELIVERY-AUDIT): no appendAuditEvent in makeNotificationDeliver or inAppNoOpDriver.
# FF-N5 (pure-core): notification-router.ts imports no IO modules (pg/node:http/node:net/node:https/fetch).
# FF-N6 (FF-RESOLVER-PORT): SmtpSecretResolverPort exists and contains resolveSecret signature.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ROUTER="${ROOT}/src/core/notification-router.ts"
ERRORS=0

echo "[FF-N] notification-isolation: checking T-0169 module constraints"

# ---- Precondition: module exists -------------------------------------------
if [[ ! -f "${ROUTER}" ]]; then
  echo "FAIL: ${ROUTER} does not exist"
  exit 1
fi

# ---- FF-N1: NotificationEvent defined once; publishNotificationEvent exported once ---
echo ""
echo "Check FF-N1 (FF-EVENT-CONTRACT): NotificationEvent one export, publishNotificationEvent one export"

NE_COUNT=$(grep -c "^export interface NotificationEvent" "${ROUTER}" || true)
if [[ "${NE_COUNT}" -ne 1 ]]; then
  echo "FAIL (FF-N1): expected exactly 1 'export interface NotificationEvent', found ${NE_COUNT}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-N1a): exactly 1 export interface NotificationEvent"
fi

PNE_COUNT=$(grep -c "^export async function publishNotificationEvent\|^export function publishNotificationEvent" "${ROUTER}" || true)
if [[ "${PNE_COUNT}" -ne 1 ]]; then
  echo "FAIL (FF-N1): expected exactly 1 'export function publishNotificationEvent', found ${PNE_COUNT}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-N1b): exactly 1 export function publishNotificationEvent"
fi

# Also assert driverMap.get( appears in the module (Map-based routing present)
if ! grep -q "registry.get(" "${ROUTER}" && ! grep -q "driverMap.get(" "${ROUTER}"; then
  echo "FAIL (FF-N1c): no registry.get( / driverMap.get( call found — Map-based routing missing"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-N1c): Map-based routing (registry.get / driverMap.get) present"
fi

# ---- FF-N2: No switch/enum on channel in routing core ----------------------
echo ""
echo "Check FF-N2 (FF-NO-SWITCH-CHANNEL): no switch(channel) / channel === 'email' in routing"

FORBIDDEN_PATTERNS=(
  # POSIX-safe: literal '(' via character class [(] avoids the unbalanced-paren
  # trap in ERE on macOS ugrep (was: "switch[[:space:]]*([[:space:]]*channel"
  # which returned exit 2 / pattern-error, silently skipping this sub-check).
  # T-0143 lesson: distinguish grep exit 1 (no match) from exit ≥2 (error).
  "switch[[:space:]]*[(][[:space:]]*channel"
  "channel[[:space:]]*===[[:space:]]*['\"]email['\"]"
  "channel[[:space:]]*===[[:space:]]*['\"]in_app['\"]"
  "case[[:space:]]*['\"]email['\"]"
  "case[[:space:]]*['\"]in_app['\"]"
)
FF_N2_ERRORS=0
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  grep_rc=0
  grep -qE "${pat}" "${ROUTER}" || grep_rc=$?
  if [[ ${grep_rc} -ge 2 ]]; then
    # grep error (bad pattern, I/O error, etc.) — fail loudly rather than skip
    echo "FAIL (FF-N2): grep exited ${grep_rc} (pattern/IO error) for pattern: ${pat}"
    FF_N2_ERRORS=$((FF_N2_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  elif [[ ${grep_rc} -eq 0 ]]; then
    echo "FAIL (FF-N2): forbidden channel-switch pattern found: ${pat}"
    grep -nE "${pat}" "${ROUTER}" || true
    FF_N2_ERRORS=$((FF_N2_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
  # grep_rc == 1 → no match → pass (continue loop)
done
if [[ ${FF_N2_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-N2): no switch/enum patterns on channel key in routing core"
fi

# ---- FF-N3: No new dispatcher/setInterval in routing module ----------------
echo ""
echo "Check FF-N3 (FF-ONE-OUTBOX): no setInterval / startNotificationDispatcher in notification-router.ts"

NEW_DISPATCH_PATTERNS=(
  "setInterval"
  "startNotificationDispatcher"
  "startOutboxDispatcherLoop"
)
FF_N3_ERRORS=0
for pat in "${NEW_DISPATCH_PATTERNS[@]}"; do
  if grep -q "${pat}" "${ROUTER}"; then
    echo "FAIL (FF-N3): forbidden dispatcher pattern '${pat}' found in notification-router.ts"
    grep -n "${pat}" "${ROUTER}" || true
    FF_N3_ERRORS=$((FF_N3_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_N3_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-N3): no new dispatcher/setInterval in notification-router.ts"
fi

# ---- FF-N4: No appendAuditEvent in delivery path ---------------------------
echo ""
echo "Check FF-N4 (FF-NO-DELIVERY-AUDIT): appendAuditEvent absent from notification-router.ts"

if grep -v "^\s*//" "${ROUTER}" | grep -q "appendAuditEvent("; then
  echo "FAIL (FF-N4): appendAuditEvent() CALL found in notification-router.ts (delivery path must not audit)"
  grep -n "appendAuditEvent(" "${ROUTER}" | grep -v "^\s*//" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-N4): no appendAuditEvent() calls in notification-router.ts"
fi

# ---- FF-N5: Pure-core — no IO imports in notification-router.ts ------------
echo ""
echo "Check FF-N5 (pure-core): notification-router.ts must not import IO modules"

IO_PATTERN="^import.*(\"pg\"|'pg'|\"node:pg\"|'node:pg'|\"node:http\"|'node:http'|\"http\"|'http'|\"https\"|'https'|\"node:https\"|'node:https'|\"node:net\"|'node:net'|\"net\"|'net'|\"fetch\"|'fetch'|\"node:fetch\"|'node:fetch'|\"child_process\"|'child_process'|\"node:child_process\"|'node:child_process')"
if grep -qE "${IO_PATTERN}" "${ROUTER}"; then
  echo "FAIL (FF-N5): notification-router.ts contains a forbidden IO import"
  grep -E "${IO_PATTERN}" "${ROUTER}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-N5): no IO imports in notification-router.ts (pure-core)"
fi

# ---- FF-N6: SmtpSecretResolverPort exists and has resolveSecret signature --
echo ""
echo "Check FF-N6 (FF-RESOLVER-PORT): SmtpSecretResolverPort with resolveSecret defined"

if ! grep -q "SmtpSecretResolverPort" "${ROUTER}"; then
  echo "FAIL (FF-N6): SmtpSecretResolverPort not found in notification-router.ts"
  ERRORS=$((ERRORS + 1))
else
  if ! grep -q "resolveSecret" "${ROUTER}"; then
    echo "FAIL (FF-N6): resolveSecret not found in notification-router.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-N6): SmtpSecretResolverPort with resolveSecret signature present"
  fi
fi

# ---- FF-NB-OUTBOX: No new queue/delivery/dispatch tables in E-N.2 scope ----
# (This check is owned by T-0168/T-0169 combined; re-assert for completeness.)
echo ""
echo "Check FF-NB-OUTBOX: No new queue/delivery/dispatch table created in E-N.2 source"
if grep -qE "CREATE TABLE.*(queue|delivery|dispatch)" "${ROUTER}" 2>/dev/null; then
  echo "FAIL (FF-NB-OUTBOX): routing module creates a new queue/delivery/dispatch table"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NB-OUTBOX): no new queue/delivery/dispatch in notification-router.ts"
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: notification-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: notification-isolation — all checks green"
exit 0
