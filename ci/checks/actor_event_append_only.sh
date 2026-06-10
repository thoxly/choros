#!/usr/bin/env bash
# FF-4 (static half, AC-7 / T-0019 §3.1): actor_event append-only in the DDL.
#
# Over the migration SQL, asserts:
#  - choros_app is NEVER granted UPDATE or DELETE on actor_event (SELECT/INSERT only).
#  - actor_event carries BEFORE UPDATE and BEFORE DELETE no-mutate triggers.
#  - choros_app is NEVER granted DELETE on actor_event_seq (the counter is a bare
#    cursor advanced under FOR UPDATE — SELECT/INSERT/UPDATE only, never DELETE).
#
# Defeating append-only must require a CI-visible schema/privilege diff that BOTH
# grants the privilege AND drops the trigger — never a forgotten runtime guard.
#
# Modelled on the existing ci/checks/audit_append_only.sh. Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations"
ERRORS=0

echo "[FF-4] actor_event_append_only: checking actor_event DDL is append-only"

# One SQL statement per line: strip `--` line comments first (their prose can
# contain words like UPDATE/DELETE that would false-match), then strip newlines,
# collapse whitespace, and split on ';' so each grep sees a single statement.
STMTS="$(sed -E 's/--.*$//' "${MIG}"/*.sql | tr '\n' ' ' | tr -s '[:space:]' ' ' | tr ';' '\n')"
# Single-line form for trigger-presence checks (CREATE TRIGGER spans lines).
ALL_SQL="$(printf '%s' "${STMTS}" | tr '\n' ' ')"

# ---- Check 1: no UPDATE/DELETE grant on actor_event to choros_app ----------
# A GRANT touching actor_event AND choros_app must not carry UPDATE or DELETE.
# (actor_event_seq grants do carry UPDATE — they are filtered out by matching the
# whole-word table token `actor_event` only on grants that do NOT mention _seq.)
if printf '%s\n' "${STMTS}" \
     | grep -iE 'GRANT' | grep -iE 'choros_app' \
     | grep -iE '\bactor_event\b' | grep -ivE 'actor_event_seq' \
     | grep -iqE '\b(UPDATE|DELETE)\b'; then
  echo "FAIL: an UPDATE/DELETE grant on actor_event to choros_app exists"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: choros_app has no UPDATE/DELETE grant on actor_event"
fi

# ---- Check 2: actor_event BEFORE UPDATE + BEFORE DELETE triggers present ----
if printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TRIGGER[^;]*BEFORE UPDATE ON choros\.actor_event\b' \
   && printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TRIGGER[^;]*BEFORE DELETE ON choros\.actor_event\b'; then
  echo "PASS: actor_event has BEFORE UPDATE and BEFORE DELETE no-mutate triggers"
else
  echo "FAIL: actor_event is missing a BEFORE UPDATE/DELETE no-mutate trigger"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 3: no DELETE grant on actor_event_seq to choros_app -------------
if printf '%s\n' "${STMTS}" \
     | grep -iE 'GRANT' | grep -iE 'actor_event_seq' | grep -iE 'choros_app' \
     | grep -iqE '\bDELETE\b'; then
  echo "FAIL: a DELETE grant on actor_event_seq to choros_app exists"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: choros_app has no DELETE grant on actor_event_seq"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: actor_event_append_only found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: actor_event_append_only — all checks green"
exit 0
