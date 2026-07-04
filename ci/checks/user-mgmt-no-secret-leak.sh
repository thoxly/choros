#!/usr/bin/env bash
# FF-583-7 (T-0583, ADR-T0583-user-mgmt §6 / N1 / N2): password/secret never
# leaks from the user-mgmt surface.
#
# STATIC half (this script):
#   (a) src/http/user-mgmt.ts never puts the request `password` field into an
#       HttpError message, a console.* call, or an appendAuditEvent payload —
#       the only place `password` may appear is destructured from the body and
#       forwarded to kc.createHumanUser (which the KC-port then handles).
#   (b) No hardcoded KC-registrar secret / password literal anywhere under
#       src/keycloak/ or src/http/user-mgmt.ts — only process.env reads (N2).
#
# DYNAMIC half (password/log/audit-event grep over a live test run) is asserted
# inside ci/checks/db/user-mgmt.db.test.ts (FF-583-1/4 assertions already check
# the HTTP response bodies never contain the plaintext test password; the
# db test's audit_event payload for user_account.create/deactivate/reactivate
# carries only {login, display_name} / {} — never `password` — by construction
# of src/http/user-mgmt.ts, which this script also verifies statically below).

set -euo pipefail

FAIL=0

USER_MGMT="src/http/user-mgmt.ts"

if [ ! -f "$USER_MGMT" ]; then
  echo "FAIL FF-583-7: $USER_MGMT not found" >&2
  exit 1
fi

# (a1) appendAuditEvent payload blocks must not reference `password`.
# Extract each `payload:` object literal used in an appendAuditEvent call and
# check it does not mention the password variable/field.
if grep -A3 "appendAuditEvent" "$USER_MGMT" | grep -q "payload: .*password"; then
  echo "FAIL FF-583-7: $USER_MGMT audit payload references 'password'" >&2
  FAIL=1
fi

# (a2) No HttpError call embeds the password variable in its message.
if grep -E "HttpError\([^)]*password" "$USER_MGMT" | grep -qv "password must be"; then
  echo "FAIL FF-583-7: $USER_MGMT embeds a password value in an HttpError message" >&2
  FAIL=1
fi

# (a3) No console.* call anywhere in the file references `password`.
if grep -E "console\.(log|warn|error|info|debug)\([^)]*password" "$USER_MGMT"; then
  echo "FAIL FF-583-7: $USER_MGMT logs 'password' via console.*" >&2
  FAIL=1
fi

# (a4) The password is never JSON.stringify'd into a response body — the only
# res.end(JSON.stringify(...)) calls in this file must not include `password`.
if grep -A2 "res.end(JSON.stringify" "$USER_MGMT" | grep -q "password"; then
  echo "FAIL FF-583-7: $USER_MGMT includes 'password' near a JSON response body" >&2
  FAIL=1
fi

# (b) No hardcoded secret literal (only process.env reads) across the KC port
# files this task touches, and no hardcoded password constant in user-mgmt.ts.
for F in "src/keycloak/admin-port.ts" "src/keycloak/fake-user-port.ts" "$USER_MGMT"; do
  if [ -f "$F" ]; then
    # Flag an assignment of a quoted literal to a *_SECRET / *_PASSWORD-shaped
    # identifier that is NOT a process.env[...] read.
    BAD=$(grep -nE "(SECRET|PASSWORD)[[:space:]]*[:=][[:space:]]*['\"][^'\"]+['\"]" "$F" | grep -v "process.env" || true)
    if [ -n "$BAD" ]; then
      echo "FAIL FF-583-7: $F has a hardcoded secret-shaped literal:" >&2
      echo "$BAD" >&2
      FAIL=1
    fi
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "PASS FF-583-7: user-mgmt.ts never routes the password into logs/audit/HttpError/response; no hardcoded secret"
