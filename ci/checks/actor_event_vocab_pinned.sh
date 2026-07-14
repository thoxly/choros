#!/usr/bin/env bash
# FF-16 (+ FF-9/FF-13/FF-17 structural lints) over the actor_event DDL.
# Covers AC-20 (golden verb set + vocab_version pin), and the static structural
# guards AC-13 (no kind column), AC-17 (no object payload column), AC-21
# (no chain/head, no FK to audit_event).
#
# AC-20 — the day-1 verb set is GOLDEN: {request,prepare,submit,approve,release}.
#   Changing the set requires editing the event CHECK + bumping vocab_version, a
#   deliberate CI-visible diff. This golden fails CI if the set changes silently.
# AC-13 — actor_event has NO `kind` column (human=agent; no SoD discriminator).
# AC-17 — actor_event has NO data/snapshot/view/payload column; only `detail` jsonb.
# AC-21 — actor_event has NO prev_hash/row_hash chain column, no head table, and
#   NO FK between actor_event and audit_event (each independently append-only).
#
# Exit 0 clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations"
ERRORS=0

echo "[FF-16] actor_event_vocab_pinned: verb-set golden + structural lints"

STMTS="$(sed -E 's/--.*$//' "${MIG}"/*.sql | tr '\n' ' ' | tr -s '[:space:]' ' ' | tr ';' '\n')"
ALL_SQL="$(printf '%s' "${STMTS}" | tr '\n' ' ')"

# Isolate the actor_event CREATE TABLE statement (the column/constraint surface).
AE_STMT="$(printf '%s\n' "${STMTS}" | grep -iE 'CREATE TABLE choros\.actor_event\b' | grep -ivE 'actor_event_seq' || true)"
if [[ -z "${AE_STMT}" ]]; then
  echo "FAIL: could not locate the CREATE TABLE choros.actor_event statement"
  exit 1
fi

# ---- AC-20 (golden verb set) -----------------------------------------------
# The event CHECK must enumerate EXACTLY the five GT-1 verbs (order-tolerant).
GOLDEN_VERBS=(request prepare submit approve release)
for v in "${GOLDEN_VERBS[@]}"; do
  if ! printf '%s' "${AE_STMT}" | grep -iqE "event[[:space:]]+text[^,]*CHECK[^)]*'${v}'"; then
    # Fall back to a looser match: the verb must appear quoted in the event CHECK clause.
    if ! printf '%s' "${AE_STMT}" | grep -iqE "'${v}'"; then
      echo "FAIL: golden verb '${v}' missing from the event CHECK set"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done
# No verb OUTSIDE the golden set may appear in the event CHECK. Extract the
# event CHECK clause and assert every quoted token is one of the five.
EVENT_CHECK="$(printf '%s' "${AE_STMT}" | grep -ioE "CHECK[[:space:]]*\([[:space:]]*event IN[[:space:]]*\([^)]*\)" || true)"
if [[ -n "${EVENT_CHECK}" ]]; then
  EXTRA="$(printf '%s' "${EVENT_CHECK}" | grep -oE "'[a-z_]+'" | tr -d "'" \
            | grep -vxE 'request|prepare|submit|approve|release' || true)"
  if [[ -n "${EXTRA}" ]]; then
    echo "FAIL: event CHECK carries non-golden verb(s): ${EXTRA} (bump vocab_version + review)"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL: could not locate the event IN (...) CHECK clause"
  ERRORS=$((ERRORS + 1))
fi
# vocab_version must be a NOT NULL column on the ledger (pins the verb set per row).
if printf '%s' "${AE_STMT}" | grep -iqE 'vocab_version[[:space:]]+smallint[^,]*NOT NULL'; then
  echo "PASS: vocab_version smallint NOT NULL pins the verb set per row"
else
  echo "FAIL: vocab_version NOT NULL column missing (verb set not pinned)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS: verb set is the golden {request,prepare,submit,approve,release}"
fi

# ---- AC-13 (no kind discriminator) -----------------------------------------
if printf '%s' "${AE_STMT}" | grep -iqE '(^|,|\()[[:space:]]*kind[[:space:]]+(text|smallint|int|varchar)'; then
  echo "FAIL: actor_event declares a 'kind' column (human=agent; no discriminator — AC-13)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no 'kind' column on actor_event (human and agent are equal actors)"
fi

# ---- AC-17 (no object payload; only detail jsonb) --------------------------
PAYLOAD_COLS=(data snapshot view payload)
before=${ERRORS}
for col in "${PAYLOAD_COLS[@]}"; do
  if printf '%s' "${AE_STMT}" | grep -iqE "(^|,|\()[[:space:]]*${col}[[:space:]]+(jsonb|json|text|bytea)"; then
    echo "FAIL: actor_event declares a forbidden payload column '${col}' (references-not-values — AC-17)"
    ERRORS=$((ERRORS + 1))
  fi
done
# The only jsonb column must be `detail`.
JSONB_COLS="$(printf '%s' "${AE_STMT}" | grep -oiE '[a-z_]+[[:space:]]+jsonb' | awk '{print tolower($1)}' || true)"
for jc in ${JSONB_COLS}; do
  if [[ "${jc}" != "detail" ]]; then
    echo "FAIL: actor_event has a jsonb column other than 'detail': '${jc}' (AC-17)"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS: no object payload column; the only jsonb is 'detail' (event metadata)"
fi

# ---- AC-21 (no chain/head; no FK to audit_event) ---------------------------
CHAIN_COLS=(prev_hash row_hash)
before=${ERRORS}
for col in "${CHAIN_COLS[@]}"; do
  if printf '%s' "${AE_STMT}" | grep -iqE "(^|,|\()[[:space:]]*${col}\b"; then
    echo "FAIL: actor_event declares a hash-chain column '${col}' (no chain — AC-21)"
    ERRORS=$((ERRORS + 1))
  fi
done
# No actor_event head table.
if printf '%s' "${ALL_SQL}" | grep -iqE 'CREATE TABLE choros\.actor_event_head\b'; then
  echo "FAIL: an actor_event_head table exists (no head snapshot — AC-21)"
  ERRORS=$((ERRORS + 1))
fi
# No FK from actor_event to audit_event (the two ledgers are independent).
if printf '%s' "${AE_STMT}" | grep -iqE 'REFERENCES[[:space:]]+choros\.audit_event\b'; then
  echo "FAIL: actor_event has an FK to audit_event (ledgers must be independently append-only — AC-21)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS: no chain/head columns, no actor_event_head, no FK to audit_event"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: actor_event_vocab_pinned found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: actor_event_vocab_pinned — all checks green"
exit 0
