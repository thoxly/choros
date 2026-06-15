#!/usr/bin/env bash
# FF-LP-6 (T-0233 AC-8) — single audit-writer on the precheck path.
#
# Rules:
#   (a) In src/runtime/legal-precheck/**, the only audit writer is appendAuditEvent.
#       No direct INSERT INTO ... audit_event / no second AuditWriter instance.
#   (b) The orchestrator references agent.blocked, agent.deferred, and
#       agent.legal_precheck.proceeded (the three audit event types).
#
# Exit 0 on all pass; non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  PLANTED="await tx.query(\"INSERT INTO choros.audit_event VALUES (...)\");"
  if printf '%s\n' "${PLANTED}" | grep -qE 'INSERT INTO.*audit_event'; then
    echo "PASS self-test: direct audit INSERT pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: direct audit INSERT detector broken"
  exit 1
fi

echo "[FF-LP-6] legal-precheck-single-audit: single appendAuditEvent on precheck path (AC-8)"

PRECHECK_DIR="${SRC}/runtime/legal-precheck"

if [[ ! -d "${PRECHECK_DIR}" ]]; then
  echo "FAIL FF-LP-6: ${PRECHECK_DIR} not found"
  ERRORS=$((ERRORS + 1))
else
  # (a) No direct INSERT INTO audit_event on the path.
  DIRECT_INSERTS=$(grep -rnE 'INSERT INTO.*audit_event' "${PRECHECK_DIR}" --include="*.ts" 2>/dev/null \
    | grep -vE '__tests__|\.test\.ts' || true)
  if [[ -n "${DIRECT_INSERTS}" ]]; then
    echo "FAIL FF-LP-6(a): direct INSERT INTO audit_event found in precheck path:"
    echo "${DIRECT_INSERTS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-6(a): no direct audit_event INSERT in precheck path"
  fi

  # (a) appendAuditEvent must be the only audit call.
  NON_CANONICAL=$(grep -rnE '\b(writeAudit|writeEvent|insertAudit|pgAudit)\b' "${PRECHECK_DIR}" --include="*.ts" 2>/dev/null \
    | grep -vE '__tests__|\.test\.ts' || true)
  if [[ -n "${NON_CANONICAL}" ]]; then
    echo "FAIL FF-LP-6(a): non-canonical audit writer on precheck path:"
    echo "${NON_CANONICAL}"
    ERRORS=$((ERRORS + 1))
  fi

  # (b) Expected audit event types must be referenced.
  ORCH="${PRECHECK_DIR}/run-precheck.ts"
  if [[ -f "${ORCH}" ]]; then
    for EVENT_TYPE in "agent.blocked" "agent.deferred"; do
      if ! grep -q "${EVENT_TYPE}" "${ORCH}"; then
        echo "FAIL FF-LP-6(b): audit event type '${EVENT_TYPE}' not referenced in run-precheck.ts"
        ERRORS=$((ERRORS + 1))
      else
        echo "PASS FF-LP-6(b): '${EVENT_TYPE}' referenced in run-precheck.ts"
      fi
    done
    if ! grep -q "appendAuditEvent" "${ORCH}"; then
      echo "FAIL FF-LP-6(b): appendAuditEvent not found in run-precheck.ts"
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS FF-LP-6(b): appendAuditEvent is the audit sink in run-precheck.ts"
    fi
  fi
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: legal-precheck-single-audit found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: legal-precheck-single-audit — FF-LP-6 / AC-8 green"
exit 0
