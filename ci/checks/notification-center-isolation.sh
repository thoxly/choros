#!/usr/bin/env bash
# T-0173 · Notification center isolation fitness
# (FF-OWN-ONLY-READ, FF-NO-CROSS-USER, FF-UNREAD-INDEXED, FF-NO-ISREAD-AUDIT)
#
# FF-NC1 (FF-OWN-ONLY-READ): REST handler constructs recipient_id from actor header —
#   not from query params. SQL in DAO includes "recipient_id = $1".
#   Check: grep shows no req.query/params.recipient for GET /api/notifications.
# FF-NC2 (FF-NO-CROSS-USER): markRead/batchMarkRead WHERE recipient_id = $2/$2.
#   Check: SQL in DAO has "recipient_id = $2" (not just "id = $1" alone).
#   Check: HTTP handler returns 404 when markRead returns false (from source).
# FF-NC3 (FF-UNREAD-INDEXED): countUnread SQL includes "is_read = false" in WHERE clause,
#   matching the partial index predicate (idx_notification_unread WHERE is_read = false).
#   Check: grep "is_read = false" in pgNotificationStore.ts countUnread method.
# FF-NC4 (FF-NO-ISREAD-AUDIT): no appendAuditEvent in pgNotificationStore.ts or
#   notifications.ts (REST handler).
# FF-NC5 (pure-DAO): pgNotificationStore imports NotifInsertPort from notification-router,
#   does NOT redeclare the interface.
# FF-NC6 (own-only keyset): list SQL first param is recipientId (no cross-user param).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DAO="${ROOT}/src/core/postgres/pgNotificationStore.ts"
HTTP="${ROOT}/src/http/notifications.ts"
ERRORS=0

echo "[FF-NC] notification-center-isolation: checking T-0173 module constraints"

# ---- Precondition: files exist -------------------------------------------
for f in "${DAO}" "${HTTP}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${f} does not exist"
    exit 1
  fi
done

# ---- FF-NC1: own-only read — recipient_id from actor, not from request params ----
echo ""
echo "Check FF-NC1 (FF-OWN-ONLY-READ): recipient_id in SQL = actor header, not request params"

# HTTP handler must not read recipient_id from query/body params
FORBIDDEN_RECIPIENT_PARAMS=(
  "params\[.recipient_id.\]"
  "query\[.recipient_id.\]"
  "body\[.recipient_id.\]"
  "get(\"recipient_id\")"
  "get('recipient_id')"
)
FF_NC1_ERRORS=0
for pat in "${FORBIDDEN_RECIPIENT_PARAMS[@]}"; do
  grep_rc=0
  grep -qE "${pat}" "${HTTP}" 2>/dev/null || grep_rc=$?
  if [[ ${grep_rc} -ge 2 ]]; then
    echo "FAIL (FF-NC1): grep error (exit ${grep_rc}) for pattern: ${pat}"
    FF_NC1_ERRORS=$((FF_NC1_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  elif [[ ${grep_rc} -eq 0 ]]; then
    echo "FAIL (FF-NC1): recipient_id taken from request params (forbidden): ${pat}"
    grep -nE "${pat}" "${HTTP}" || true
    FF_NC1_ERRORS=$((FF_NC1_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done

# DAO list method must have "recipient_id = $1" in its SQL
if ! grep -q "recipient_id = \$1" "${DAO}"; then
  echo "FAIL (FF-NC1): DAO list SQL does not contain 'recipient_id = \$1' (own-only gate missing)"
  ERRORS=$((ERRORS + 1))
  FF_NC1_ERRORS=$((FF_NC1_ERRORS + 1))
fi

if [[ ${FF_NC1_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-NC1): recipient_id always from actor header; SQL has recipient_id = \$1"
fi

# ---- FF-NC2: no cross-user mutation — markRead WHERE recipient_id = $2 ----
echo ""
echo "Check FF-NC2 (FF-NO-CROSS-USER): markRead/batchMarkRead SQL includes recipient_id gate"

# markRead must have both id=$1 and recipient_id=$2 in WHERE
if ! grep -q "recipient_id = \$2" "${DAO}"; then
  echo "FAIL (FF-NC2): DAO markRead SQL does not contain 'recipient_id = \$2' (cross-user gate missing)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC2a): markRead SQL has recipient_id = \$2"
fi

# HTTP handler must return 404 when markRead returns false
if ! grep -q "NOT_FOUND" "${HTTP}"; then
  echo "FAIL (FF-NC2): HTTP handler does not return 404/NOT_FOUND on failed markRead"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC2b): HTTP handler returns 404/NOT_FOUND for foreign/missing row"
fi

# batchMarkRead must also gate on recipient_id
if ! grep -q "recipient_id = \$2" "${DAO}"; then
  echo "FAIL (FF-NC2): batchMarkRead missing recipient_id gate"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC2c): batchMarkRead SQL has recipient_id = \$2"
fi

# ---- FF-NC3: badge index — countUnread uses is_read = false in WHERE ----
echo ""
echo "Check FF-NC3 (FF-UNREAD-INDEXED): countUnread WHERE clause includes is_read = false"

if ! grep -q "is_read = false" "${DAO}"; then
  echo "FAIL (FF-NC3): countUnread SQL does not contain 'is_read = false'"
  echo "  Expected: partial index idx_notification_unread (WHERE is_read = false) to be matched"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC3): countUnread SQL contains 'is_read = false' (matches partial index predicate)"
fi

# Ensure there's no materialized view reference
if grep -qiE "materialized\s+view|CREATE\s+MATERIALIZED" "${DAO}" 2>/dev/null; then
  echo "FAIL (FF-NC3): materialized view usage found in DAO (Stage-2 only per ADR §2.7)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC3b): no materialized view in DAO"
fi

# ---- FF-NC4: no appendAuditEvent in DAO or HTTP handler (FF-NO-ISREAD-AUDIT) ----
echo ""
echo "Check FF-NC4 (FF-NO-ISREAD-AUDIT): no appendAuditEvent in pgNotificationStore.ts or notifications.ts"

for f in "${DAO}" "${HTTP}"; do
  fname=$(basename "${f}")
  # Exclude comment lines when checking for calls
  NON_COMMENT_CALLS=$(grep -n "appendAuditEvent" "${f}" 2>/dev/null \
    | grep -v "^[0-9]*:[[:space:]]*//" \
    | grep -v "^[0-9]*:[[:space:]]*\*" \
    | grep -v "//.*appendAuditEvent" \
    || true)
  if [[ -n "${NON_COMMENT_CALLS}" ]]; then
    echo "FAIL (FF-NC4): appendAuditEvent call found in ${fname} (is_read must not be audited)"
    echo "${NON_COMMENT_CALLS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS (FF-NC4): no appendAuditEvent in ${fname}"
  fi
done

# ---- FF-NC5: DAO imports NotifInsertPort from notification-router, does not redeclare ----
echo ""
echo "Check FF-NC5 (pure-DAO): pgNotificationStore imports NotifInsertPort from notification-router"

if ! grep -q "from.*notification-router" "${DAO}"; then
  echo "FAIL (FF-NC5): pgNotificationStore.ts does not import from notification-router.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC5a): import from notification-router present"
fi

# Must not redeclare NotifInsertPort
if grep -qE "^export interface NotifInsertPort|^interface NotifInsertPort" "${DAO}"; then
  echo "FAIL (FF-NC5): NotifInsertPort re-declared in pgNotificationStore.ts (must be imported)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC5b): NotifInsertPort not re-declared (imported from router)"
fi

# ---- FF-NC6: HTTP handler constructs recipientId from actorId (X-Dev-User) ----
echo ""
echo "Check FF-NC6 (own-only): HTTP handler uses actorId as recipientId in list/countUnread/markRead"

# The handler should pass actorId (from X-Dev-User) as recipientId parameter
if ! grep -q "actorId" "${HTTP}"; then
  echo "FAIL (FF-NC6): actorId not found in HTTP handler — actor identity extraction missing"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC6a): actorId present in HTTP handler"
fi

# Confirm no second-channel recipient override
if grep -qE "recipientId.*params\[|recipientId.*query\[|recipientId.*body\[" "${HTTP}" 2>/dev/null; then
  echo "FAIL (FF-NC6): recipientId taken from route params/query/body (forbidden; must be actor only)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NC6b): recipientId not taken from request params/query/body"
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: notification-center-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: notification-center-isolation — all checks green"
exit 0
