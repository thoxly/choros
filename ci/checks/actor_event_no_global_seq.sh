#!/usr/bin/env bash
# FF-6 (static half, AC-9 / T-0019 §3.2): the actor_event ordinal is per-tenant,
# never a global serialization point.
#
# Over the migration SQL, asserts:
#  - the per-tenant counter-row primitive exists: a table actor_event_seq keyed on
#    tenant_id (PRIMARY KEY (tenant_id)) — serialization is keyed exactly on tenant;
#  - no global SEQUENCE backs actor_event's seq (no CREATE SEQUENCE … actor_event…,
#    no `seq … bigserial/serial`, no nextval(...) default on the seq column);
#  - no global (non-tenant-keyed) advisory lock is used for the ordinal
#    (pg_advisory_xact_lock / pg_advisory_lock with a constant key).
#
# A global SEQUENCE or one global advisory lock would couple every tenant's write
# throughput onto one contention point and make seq tenant-global (breaks AC-8).
#
# Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations"
ERRORS=0

echo "[FF-6] actor_event_no_global_seq: checking the ordinal is per-tenant, not global"

# Strip line comments, collapse to single-line statements (see audit_append_only.sh).
STMTS="$(sed -E 's/--.*$//' "${MIG}"/*.sql | tr '\n' ' ' | tr -s '[:space:]' ' ' | tr ';' '\n')"
ALL_SQL="$(printf '%s' "${STMTS}" | tr '\n' ' ')"

# ---- Check 1: per-tenant counter row exists, keyed on tenant_id -------------
# CREATE TABLE choros.actor_event_seq ( … tenant_id … PRIMARY KEY (tenant_id) … )
if printf '%s' "${ALL_SQL}" \
     | grep -iqE 'CREATE TABLE choros\.actor_event_seq\b'; then
  # The counter must be keyed on tenant_id (per-tenant serialization), via either
  # an inline column PRIMARY KEY or a table-level PRIMARY KEY (tenant_id).
  SEQ_STMT="$(printf '%s\n' "${STMTS}" | grep -iE 'CREATE TABLE choros\.actor_event_seq\b' || true)"
  if printf '%s' "${SEQ_STMT}" | grep -iqE 'PRIMARY KEY[[:space:]]*\([[:space:]]*tenant_id[[:space:]]*\)' \
     || printf '%s' "${SEQ_STMT}" | grep -iqE 'tenant_id[^,]*PRIMARY KEY'; then
    echo "PASS: actor_event_seq counter row is keyed per-tenant (PRIMARY KEY tenant_id)"
  else
    echo "FAIL: actor_event_seq exists but is not keyed on tenant_id (per-tenant required)"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL: no per-tenant actor_event_seq counter row found (per-tenant ordinal primitive missing)"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: no global SEQUENCE / serial backing actor_event.seq ----------
if printf '%s\n' "${STMTS}" | grep -iE 'CREATE SEQUENCE' | grep -iqE 'actor_event'; then
  echo "FAIL: a CREATE SEQUENCE references actor_event (global ordinal forbidden)"
  ERRORS=$((ERRORS + 1))
fi
# `seq ... bigserial`/`serial` would create an implicit global sequence.
if printf '%s\n' "${STMTS}" | grep -iE 'CREATE TABLE choros\.actor_event\b' \
     | grep -iqE '\bseq\b[[:space:]]+(big)?serial\b'; then
  echo "FAIL: actor_event.seq is declared serial/bigserial (implicit global sequence)"
  ERRORS=$((ERRORS + 1))
fi
# A nextval() default on the seq column would bind it to a global sequence.
if printf '%s\n' "${STMTS}" | grep -iE 'CREATE TABLE choros\.actor_event\b' \
     | grep -iqE 'nextval[[:space:]]*\('; then
  echo "FAIL: actor_event uses nextval() (global sequence) for an ordinal"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 3: no global advisory lock for the ordinal ----------------------
# Any advisory lock keyed on a bare constant (not tenant-derived) is global.
if printf '%s' "${ALL_SQL}" | grep -iqE 'pg_advisory(_xact)?_lock[[:space:]]*\([[:space:]]*[0-9]'; then
  echo "FAIL: a constant-keyed (global) advisory lock is used for the ordinal"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: no global sequence / global advisory lock backs actor_event's seq"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: actor_event_no_global_seq found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: actor_event_no_global_seq — all checks green"
exit 0
