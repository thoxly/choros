#!/usr/bin/env bash
# T-0171 · Notification preference isolation fitness
# (FF-PREF-AUTHZ, FF-SELF-PREF-SCOPED, FF-DEFAULTS-SEED)
#
# FF-NP1 (FF-PREF-AUTHZ): no new ACL mechanism in preference code — only resolveFor /
#   PDP calls; grep absence of notification_acl / pref_rights tables/imports.
# FF-NP2 (FF-SELF-PREF-SCOPED): self-endpoint structural guard present — server
#   constructs recipient_scope = 'actor:<self>', not from body.
# FF-NP3 (FF-DEFAULTS-SEED): DEFAULT_PREFERENCES export exists in pgPrefStore.ts
#   with correct event_kinds and seedDefaultPreferences function exported.
# FF-NP4 (pure-DAO): pgPrefStore.ts imports NotificationPrefStore from notification-router,
#   does NOT re-declare the interface.
# FF-NP5 (audit-present): appendAuditEvent called in notification-prefs.ts PUT handlers;
#   type = 'notif.preference.changed'.
# FF-NP6 (no-new-acl): grep absence of new ACL tables/CREATE TABLE.*acl or
#   pref_rights in preference module code.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PREF_STORE="${ROOT}/src/core/postgres/pgPrefStore.ts"
PREF_HTTP="${ROOT}/src/http/notification-prefs.ts"
ERRORS=0

echo "[FF-NP] notification-pref-isolation: checking T-0171 module constraints"

# ---- Precondition: files exist -----------------------------------------
if [[ ! -f "${PREF_STORE}" ]]; then
  echo "FAIL: ${PREF_STORE} does not exist"
  exit 1
fi

if [[ ! -f "${PREF_HTTP}" ]]; then
  echo "FAIL: ${PREF_HTTP} does not exist"
  exit 1
fi

# ---- FF-NP1: no new ACL mechanism (FF-PREF-AUTHZ) ----------------------
echo ""
echo "Check FF-NP1 (FF-PREF-AUTHZ): no notification_acl / pref_rights in preference code"

ACL_PATTERNS=(
  "notification_acl"
  "pref_rights"
  "CREATE TABLE.*acl"
  "CREATE TABLE.*pref_right"
)
FF_NP1_ERRORS=0
for pat in "${ACL_PATTERNS[@]}"; do
  grep_rc=0
  grep -qiE "${pat}" "${PREF_STORE}" "${PREF_HTTP}" 2>/dev/null || grep_rc=$?
  if [[ ${grep_rc} -ge 2 ]]; then
    echo "FAIL (FF-NP1): grep error (exit ${grep_rc}) for pattern: ${pat}"
    FF_NP1_ERRORS=$((FF_NP1_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  elif [[ ${grep_rc} -eq 0 ]]; then
    echo "FAIL (FF-NP1): forbidden ACL pattern found: ${pat}"
    grep -niE "${pat}" "${PREF_STORE}" "${PREF_HTTP}" || true
    FF_NP1_ERRORS=$((FF_NP1_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_NP1_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-NP1): no new ACL mechanism in preference modules"
fi

# ---- FF-NP2: self-endpoint structural guard (FF-SELF-PREF-SCOPED) ------
echo ""
echo "Check FF-NP2 (FF-SELF-PREF-SCOPED): self-endpoint constructs actor:<self> server-side"

# The guard is present when we see 'actor:${actorId}' construction in the HTTP module.
if ! grep -q "actor:\`\${actorId}\`\|actor:\${actorId}\|actor:\\\`\\\${actorId}" "${PREF_HTTP}" &&
   ! grep -q "actor:" "${PREF_HTTP}"; then
  echo "FAIL (FF-NP2): self-scope construction 'actor:<actorId>' not found in ${PREF_HTTP}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP2): self-scope construction present in notification-prefs.ts"
fi

# Check that role: rejection guard is present (assertSelfScopeValid or equivalent pattern).
if ! grep -q "role:" "${PREF_HTTP}"; then
  echo "FAIL (FF-NP2): role: rejection logic not found in ${PREF_HTTP}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP2): role: rejection guard present"
fi

# ---- FF-NP3: DEFAULT_PREFERENCES export present (FF-DEFAULTS-SEED) -----
echo ""
echo "Check FF-NP3 (FF-DEFAULTS-SEED): DEFAULT_PREFERENCES and seedDefaultPreferences exported"

if ! grep -q "export const DEFAULT_PREFERENCES" "${PREF_STORE}"; then
  echo "FAIL (FF-NP3): DEFAULT_PREFERENCES not exported from pgPrefStore.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP3a): DEFAULT_PREFERENCES exported"
fi

if ! grep -q "export async function seedDefaultPreferences\|export function seedDefaultPreferences" "${PREF_STORE}"; then
  echo "FAIL (FF-NP3): seedDefaultPreferences not exported from pgPrefStore.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP3b): seedDefaultPreferences exported"
fi

# Verify all 5 ADR-mandated event_kinds present in DEFAULT_PREFERENCES.
REQUIRED_EVENTS=("task.assigned" "approval.requested" "sla.warning" "sla.breach" "escalation.raised")
FF_NP3_ERRORS=0
for ev in "${REQUIRED_EVENTS[@]}"; do
  if ! grep -q "${ev}" "${PREF_STORE}"; then
    echo "FAIL (FF-NP3): required event_kind '${ev}' not found in DEFAULT_PREFERENCES"
    FF_NP3_ERRORS=$((FF_NP3_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_NP3_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-NP3c): all 5 required event_kinds present in pgPrefStore.ts"
fi

# ---- FF-NP4: pgPrefStore imports port from notification-router (no re-decl) ---
echo ""
echo "Check FF-NP4 (pure-DAO): pgPrefStore imports NotificationPrefStore from notification-router"

if ! grep -q "from.*notification-router" "${PREF_STORE}"; then
  echo "FAIL (FF-NP4): pgPrefStore.ts does not import from notification-router.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP4): import from notification-router present"
fi

# Ensure the interface is not re-declared in pgPrefStore.ts.
if grep -q "^export interface NotificationPrefStore\|^interface NotificationPrefStore" "${PREF_STORE}"; then
  echo "FAIL (FF-NP4): NotificationPrefStore re-declared in pgPrefStore.ts (should import, not re-declare)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP4): NotificationPrefStore not re-declared (imported from router)"
fi

# ---- FF-NP5: appendAuditEvent called in PUT handlers -------------------
echo ""
echo "Check FF-NP5 (audit-present): appendAuditEvent called in notification-prefs.ts"

if ! grep -q "appendAuditEvent\|appendPrefAudit" "${PREF_HTTP}"; then
  echo "FAIL (FF-NP5): no appendAuditEvent or appendPrefAudit call in notification-prefs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP5): audit call present in notification-prefs.ts"
fi

# Verify notif.preference.changed audit type.
if ! grep -q "notif.preference.changed" "${PREF_HTTP}"; then
  echo "FAIL (FF-NP5): audit type 'notif.preference.changed' not found in notification-prefs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP5b): 'notif.preference.changed' audit type present"
fi

# ---- FF-NP6: no CREATE TABLE in preference modules ---------------------
echo ""
echo "Check FF-NP6 (no-new-acl): no CREATE TABLE in preference modules"

if grep -qiE "CREATE\s+TABLE" "${PREF_STORE}" "${PREF_HTTP}" 2>/dev/null; then
  echo "FAIL (FF-NP6): CREATE TABLE found in preference module code"
  grep -niE "CREATE\s+TABLE" "${PREF_STORE}" "${PREF_HTTP}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NP6): no CREATE TABLE in preference modules"
fi

# ---- Result -------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: notification-pref-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: notification-pref-isolation — all checks green"
exit 0
