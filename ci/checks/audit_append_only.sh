#!/usr/bin/env bash
# FF-APPEND (static half, AC-12 / T-0016 §4.6): audit append-only in the DDL.
#
# Over the baseline migration SQL, asserts:
#  - choros_app is NEVER granted UPDATE or DELETE on audit_event (SELECT/INSERT only).
#  - audit_event carries BEFORE UPDATE and BEFORE DELETE no-mutate triggers.
#  - choros_app is NEVER granted DELETE on audit_head.
#  - audit_head carries a BEFORE DELETE no-delete trigger and a BEFORE UPDATE
#    forward-only advance trigger.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations"
ERRORS=0

echo "[FF-APPEND] audit_append_only: checking audit DDL is append-only"

# One SQL statement per line: strip `--` line comments first (their prose can
# contain words like UPDATE/DELETE that would false-match), then strip newlines,
# collapse whitespace, and split on ';' so each grep sees a single statement.
STMTS="$(sed -E 's/--.*$//' "${MIG}"/*.sql | tr '\n' ' ' | tr -s '[:space:]' ' ' | tr ';' '\n')"
# Single-line form for trigger-presence checks (CREATE TRIGGER spans lines).
ALL_SQL="$(printf '%s' "${STMTS}" | tr '\n' ' ')"

# ---- Check 1: no UPDATE/DELETE grant on audit_event to choros_app ----------
# Isolate GRANT statements that touch audit_event AND choros_app; none may carry
# UPDATE or DELETE.
if printf '%s\n' "${STMTS}" \
     | grep -iE 'GRANT' | grep -iE 'audit_event' | grep -iE 'choros_app' \
     | grep -iqE '\b(UPDATE|DELETE)\b'; then
  echo "FAIL: an UPDATE/DELETE grant on audit_event to choros_app exists"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: choros_app has no UPDATE/DELETE grant on audit_event"
fi

# ---- Check 2: audit_event BEFORE UPDATE + BEFORE DELETE triggers present ---
if printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TRIGGER[^;]*BEFORE UPDATE ON choros\.audit_event' \
   && printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TRIGGER[^;]*BEFORE DELETE ON choros\.audit_event'; then
  echo "PASS: audit_event has BEFORE UPDATE and BEFORE DELETE no-mutate triggers"
else
  echo "FAIL: audit_event is missing a BEFORE UPDATE/DELETE no-mutate trigger"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 3: no DELETE grant on audit_head to choros_app ------------------
if printf '%s\n' "${STMTS}" \
     | grep -iE 'GRANT' | grep -iE 'audit_head' | grep -iE 'choros_app' \
     | grep -iqE '\bDELETE\b'; then
  echo "FAIL: a DELETE grant on audit_head to choros_app exists"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: choros_app has no DELETE grant on audit_head"
fi

# ---- Check 4: audit_head BEFORE DELETE + BEFORE UPDATE triggers present ----
if printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TRIGGER[^;]*BEFORE DELETE ON choros\.audit_head' \
   && printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TRIGGER[^;]*BEFORE UPDATE ON choros\.audit_head'; then
  echo "PASS: audit_head has BEFORE DELETE no-delete + BEFORE UPDATE advance triggers"
else
  echo "FAIL: audit_head is missing a BEFORE DELETE / BEFORE UPDATE trigger"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: audit_append_only found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: audit_append_only — all checks green"
exit 0
