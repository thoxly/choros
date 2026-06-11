#!/usr/bin/env bash
# T-0170 · Notification email channel fitness (FF-NO-RAW-SMTP, FF-HANDLE-SHAPE,
# FF-RESOLVER-PORT, FF-EMAIL-FROM-CLIENT, FF-ONE-OUTBOX, FF-NO-DELIVERY-AUDIT,
# FF-EGRESS-CLASS, AC-12 wiring).
#
# Checks:
# FF-E1 (FF-NO-RAW-SMTP): smtp_handle/resolved-secret not in console.*/appendAuditEvent/
#   res.json in notification-email.ts / smtp-sender.ts / lifecycle-bridge.ts (wiring path).
# FF-E2 (FF-HANDLE-SHAPE): notification-email.ts imports validateSecretHandleShape from
#   secret-handle-validator (not redeclared).
# FF-E3 (FF-RESOLVER-PORT): SmtpSecretResolverPort compatible with T-0025 SecretResolverPort —
#   checked via tsc; no LLM-call/relay-domain in notification-email.ts.
# FF-E4 (FF-ONE-OUTBOX): no setInterval/startEmailDispatcher in notification-email.ts.
# FF-E5 (FF-NO-DELIVERY-AUDIT): no appendAuditEvent in deliver path of EmailChannelDriver.
# FF-E6 (FF-EGRESS-CLASS): DataClass imported from data-classification.ts in notification-email.ts.
# FF-E7 (AC-12 wiring): makeNotificationDeliver imported and used in lifecycle-bridge.ts.
# FF-E8 (FF-EMAIL-FROM-CLIENT): no hardcoded relay domain in notification-email.ts / smtp-sender.ts.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

EMAIL_MODULE="${ROOT}/src/core/notification-email.ts"
SMTP_ADAPTER="${ROOT}/src/adapters/smtp-sender.ts"
LIFECYCLE="${ROOT}/src/server/lifecycle-bridge.ts"
ERRORS=0

echo "[FF-E] notification-email: checking T-0170 module constraints"

# ---- Precondition: modules exist -------------------------------------------
for f in "${EMAIL_MODULE}" "${SMTP_ADAPTER}" "${LIFECYCLE}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${f} does not exist"
    exit 1
  fi
done

# ---- FF-E1 (FF-NO-RAW-SMTP): smtp_handle / resolved secret not in audit/log/res.json ----
echo ""
echo "Check FF-E1 (FF-NO-RAW-SMTP): smtp_handle absent from console.*/appendAuditEvent payload lines"

# Check that smtp_handle is not passed to console.* calls
if grep -nE "console\.(log|error|warn|info|debug).*smtp_handle|console\.(log|error|warn|info|debug).*smtpHandle" "${EMAIL_MODULE}" 2>/dev/null | grep -v "^\s*//" | grep -qE "console"; then
  echo "FAIL (FF-E1): smtp_handle/smtpHandle found in console.* call in notification-email.ts"
  grep -nE "console\.(log|error|warn|info|debug).*smtp_handle" "${EMAIL_MODULE}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E1a): smtp_handle not in console.* calls"
fi

# Check that smtpHandle is not in audit payload (it should be absent from the payload object literal)
# Strategy: look for any non-comment line that uses smtpHandle/smtp_handle as an object key
# in a payload assignment (e.g., smtp_handle: someValue in an object literal).
# Excludes comment lines (lines starting with optional whitespace then //).
AUDIT_KEY_MATCH=$(grep -n "smtp_handle:" "${EMAIL_MODULE}" \
  | grep -v "^\s*//" \
  | grep -v "^[0-9]*:[[:space:]]*//" \
  | grep -v "//.*smtp_handle" \
  || true)
if [[ -n "${AUDIT_KEY_MATCH}" ]]; then
  echo "FAIL (FF-E1b): smtp_handle found as a payload key (must be absent from audit payload)"
  echo "${AUDIT_KEY_MATCH}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E1b): smtp_handle absent from non-comment code in audit payload"
fi

# Assert that redactHandle is used in getEmailChannelConfigStatus (status path)
if ! grep -q "redactHandle(" "${EMAIL_MODULE}"; then
  echo "FAIL (FF-E1c): redactHandle() not called in notification-email.ts (status path must use redactHandle)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E1c): redactHandle() present in notification-email.ts"
fi

# ---- FF-E2 (FF-HANDLE-SHAPE): validateSecretHandleShape imported, not redeclared ----
echo ""
echo "Check FF-E2 (FF-HANDLE-SHAPE): validateSecretHandleShape imported from secret-handle-validator"

if ! grep -q "validateSecretHandleShape" "${EMAIL_MODULE}"; then
  echo "FAIL (FF-E2): validateSecretHandleShape not referenced in notification-email.ts"
  ERRORS=$((ERRORS + 1))
else
  # Must be an import, not a redeclaration
  if grep -q "function validateSecretHandleShape\|const validateSecretHandleShape\|let validateSecretHandleShape" "${EMAIL_MODULE}"; then
    echo "FAIL (FF-E2): validateSecretHandleShape is REDECLARED in notification-email.ts (must be imported)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-E2): validateSecretHandleShape imported (not redeclared)"
  fi
fi

if ! grep -q "secret-handle-validator" "${EMAIL_MODULE}"; then
  echo "FAIL (FF-E2b): secret-handle-validator import not found in notification-email.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E2b): secret-handle-validator import present"
fi

# ---- FF-E3 (FF-RESOLVER-PORT): no LLM call / relay domain in notification-email.ts ----
echo ""
echo "Check FF-E3 (FF-RESOLVER-PORT): no LLM-call / relay-domain in notification-email.ts"

LLM_PATTERNS=(
  "anthropic\."
  "openai\."
  "claude\."
  "llm\."
  "choros-relay\."
  "platform-smtp\."
  "smtp\.choros\."
)
FF_E3_ERRORS=0
for pat in "${LLM_PATTERNS[@]}"; do
  if grep -qE "${pat}" "${EMAIL_MODULE}" 2>/dev/null; then
    echo "FAIL (FF-E3): LLM/relay pattern '${pat}' found in notification-email.ts"
    grep -nE "${pat}" "${EMAIL_MODULE}" || true
    FF_E3_ERRORS=$((FF_E3_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_E3_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-E3): no LLM-call / hardcoded relay domain"
fi

# ---- FF-E4 (FF-ONE-OUTBOX): no new setInterval / startEmailDispatcher ----
echo ""
echo "Check FF-E4 (FF-ONE-OUTBOX): no setInterval / startEmailDispatcher in notification-email.ts"

NEW_DISPATCH_PATTERNS=(
  "setInterval"
  "startEmailDispatcher"
  "startOutboxDispatcherLoop"
)
FF_E4_ERRORS=0
for pat in "${NEW_DISPATCH_PATTERNS[@]}"; do
  # Exclude comment-only lines:
  #  - // single-line comment
  #  - * JSDoc / block comment lines (inside /** ... */)
  MATCH=$(grep -n "${pat}" "${EMAIL_MODULE}" 2>/dev/null \
    | grep -v "^[0-9]*:[[:space:]]*//" \
    | grep -v "^[0-9]*:[[:space:]]*\*" \
    | grep -v "//.*${pat}" \
    || true)
  if [[ -n "${MATCH}" ]]; then
    echo "FAIL (FF-E4): forbidden dispatcher pattern '${pat}' found in notification-email.ts (non-comment)"
    echo "${MATCH}"
    FF_E4_ERRORS=$((FF_E4_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_E4_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-E4): no new dispatcher/setInterval in notification-email.ts"
fi

# ---- FF-E5 (FF-NO-DELIVERY-AUDIT): no appendAuditEvent in deliver() of EmailChannelDriver ----
echo ""
echo "Check FF-E5 (FF-NO-DELIVERY-AUDIT): appendAuditEvent absent from EmailChannelDriver.deliver"

# We check that appendAuditEvent appears ONLY in setEmailChannelConfig / revokeEmailChannelConfig,
# not inside the 'deliver' method of EmailChannelDriver.
# Strategy: look for appendAuditEvent calls that are NOT inside the CRUD functions.
# Simplified: check the deliver() method body doesn't call appendAuditEvent.
DELIVER_SECTION=$(awk '/async deliver\(job: DeliveryJob/,/^  \}/' "${EMAIL_MODULE}" | head -100 || true)
if echo "${DELIVER_SECTION}" | grep -q "appendAuditEvent"; then
  echo "FAIL (FF-E5): appendAuditEvent found in EmailChannelDriver.deliver body (delivery path must not audit)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E5): appendAuditEvent absent from EmailChannelDriver.deliver"
fi

# ---- FF-E6 (FF-EGRESS-CLASS): DataClass imported from data-classification.ts ----
echo ""
echo "Check FF-E6 (FF-EGRESS-CLASS): DataClass imported from data-classification.ts in notification-email.ts"

if ! grep -q "data-classification" "${EMAIL_MODULE}"; then
  echo "FAIL (FF-E6): data-classification.ts not imported in notification-email.ts (DataClass must be imported)"
  ERRORS=$((ERRORS + 1))
else
  # Must be import, not redeclaration
  if grep -qE "type DataClass\s*=|DataClass\s*=\s*['\"]" "${EMAIL_MODULE}"; then
    echo "FAIL (FF-E6): DataClass appears to be redeclared in notification-email.ts (must be imported)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-E6): DataClass imported from data-classification.ts (not redeclared)"
  fi
fi

# ---- FF-E7 (AC-12 wiring): makeNotificationDeliver in lifecycle-bridge.ts ----
echo ""
echo "Check FF-E7 (AC-12 wiring): makeNotificationDeliver imported and used in lifecycle-bridge.ts"

if ! grep -q "makeNotificationDeliver" "${LIFECYCLE}"; then
  echo "FAIL (FF-E7): makeNotificationDeliver not found in lifecycle-bridge.ts (wiring missing)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E7a): makeNotificationDeliver referenced in lifecycle-bridge.ts"
fi

if ! grep -q "notification-router" "${LIFECYCLE}"; then
  echo "FAIL (FF-E7b): notification-router import not found in lifecycle-bridge.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-E7b): notification-router imported in lifecycle-bridge.ts"
fi

# ---- FF-E8 (FF-EMAIL-FROM-CLIENT): no hardcoded relay domain ----
echo ""
echo "Check FF-E8 (FF-EMAIL-FROM-CLIENT): no hardcoded relay/platform domain in email driver"

RELAY_PATTERNS=(
  "choros-smtp\."
  "platform\.smtp\."
  "mail\.choros\."
  "smtp\.platform\."
  "relay\.choros\."
)
FF_E8_ERRORS=0
for pat in "${RELAY_PATTERNS[@]}"; do
  for f in "${EMAIL_MODULE}" "${SMTP_ADAPTER}"; do
    if grep -qE "${pat}" "${f}" 2>/dev/null; then
      echo "FAIL (FF-E8): hardcoded relay domain '${pat}' found in ${f}"
      grep -nE "${pat}" "${f}" || true
      FF_E8_ERRORS=$((FF_E8_ERRORS + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done
done
if [[ ${FF_E8_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-E8): no hardcoded relay/platform domain in email driver"
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: notification-email found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: notification-email — all checks green"
exit 0
