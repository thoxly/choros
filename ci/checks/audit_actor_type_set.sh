#!/usr/bin/env bash
# T-0068 · FF-8 (AC-13): the actorType projection set is exactly {human,agent,service}
# and matches the read-API contract (src/http/audit.ts AuditEvent.type), WITHOUT
# changing the employee schema (migration 016 CHECK stays ('human','agent')).
#
# Asserts:
#   - lifecycle-audit.ts declares ActorType = "human" | "agent" | "service";
#   - src/http/audit.ts carries the same three-value type union;
#   - migration 016_employee.sql keeps the kind CHECK as ('human','agent') only
#     (no 'service' added to the employee schema — service is a channel, not a kind).
#
# Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LIFECYCLE="${ROOT}/src/core/lifecycle-audit.ts"
AUDIT_HTTP="${ROOT}/src/http/audit.ts"
MIG016="${ROOT}/migrations/016_employee.sql"
ERRORS=0

echo "[FF-8] audit_actor_type_set: actorType set = {human,agent,service}, employee schema unchanged"

# ---- Check 1: ActorType union in lifecycle-audit.ts -------------------------
if grep -qE 'export type ActorType[[:space:]]*=' "${LIFECYCLE}" \
   && grep -qE '"human"' "${LIFECYCLE}" \
   && grep -qE '"agent"' "${LIFECYCLE}" \
   && grep -qE '"service"' "${LIFECYCLE}"; then
  echo "PASS: ActorType union = human|agent|service in lifecycle-audit.ts"
else
  echo "FAIL: ActorType union not exactly {human,agent,service} in lifecycle-audit.ts"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: read-API contract carries the same three values ---------------
if grep -qE '"human"[[:space:]]*\|[[:space:]]*"agent"[[:space:]]*\|[[:space:]]*"service"' "${AUDIT_HTTP}"; then
  echo "PASS: src/http/audit.ts type union matches {human,agent,service}"
else
  echo "FAIL: src/http/audit.ts does not carry the human|agent|service type union"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 3: employee schema kind CHECK unchanged (no 'service') -----------
if [[ -f "${MIG016}" ]]; then
  # The migration must reference 'human' and 'agent' but NOT introduce 'service'
  # as an employee kind.
  if grep -iqE "'service'" "${MIG016}"; then
    echo "FAIL: migration 016_employee.sql introduces 'service' kind (schema must stay {human,agent})"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: employee kind schema unchanged (no 'service' kind in 016)"
  fi
else
  echo "FAIL: migration 016_employee.sql not found"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: audit_actor_type_set found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: audit_actor_type_set — all checks green"
exit 0
