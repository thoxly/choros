#!/usr/bin/env bash
# T-0117 SPIKE — NOT PRODUCTION. History seeder (FR-2, AC-3).
# Batch-INSERT into the engine history tables via psql-in-container + generate_series
# (NOT REST starts: 300k real instances on a laptop = hours, ADR §3.1 / R2). Records are
# made immediately cleanup-eligible: Flowable END_TIME_ older than cleaningAfterDays;
# Operaton REMOVAL_TIME_ in the past. Idempotent: TRUNCATE-then-insert => repeat run = same N.
#
# Usage: seed.sh <flowable|operaton> <N> <PROJECT> <BATCH>
# Relies on `dc_psql` exported by run.sh (runs psql inside the pg container, zero host deps).
set -euo pipefail
ENGINE="$1"; N="$2"; PROJECT="$3"; BATCH="${4:-10000}"

# psql inside the pg service of the given compose project. -At = unaligned, tuples-only.
sql() { dc_psql "$@"; }

seed_flowable() {
  echo "[seed] flowable: truncating ACT_HI_PROCINST + ACT_HI_ACTINST" >&2
  sql "TRUNCATE TABLE ACT_HI_ACTINST;" >/dev/null 2>&1 || true
  sql "TRUNCATE TABLE ACT_HI_PROCINST CASCADE;" >/dev/null
  local done=0 lo hi
  while [ "$done" -lt "$N" ]; do
    lo=$((done + 1)); hi=$((done + BATCH)); [ "$hi" -gt "$N" ] && hi="$N"
    sql "INSERT INTO ACT_HI_PROCINST (ID_, REV_, PROC_INST_ID_, PROC_DEF_ID_, START_TIME_, END_TIME_, DURATION_) SELECT 'spike-'||g, 1, 'spike-'||g, 'spikeProc:1:1', now() - interval '401 days', now() - interval '400 days', 86400000 FROM generate_series($lo, $hi) AS g;" >/dev/null
    done="$hi"
    printf '\r[seed] flowable ACT_HI_PROCINST: %d/%d' "$done" "$N" >&2
  done
  echo >&2
  sql "INSERT INTO ACT_HI_ACTINST (ID_, REV_, PROC_DEF_ID_, PROC_INST_ID_, EXECUTION_ID_, ACT_ID_, ACT_TYPE_, START_TIME_, END_TIME_, DURATION_) SELECT 'a-'||g, 1, 'spikeProc:1:1', 'spike-'||g, 'spike-'||g, 'failTask', 'serviceTask', now() - interval '401 days', now() - interval '400 days', 1000 FROM generate_series(1, $N) AS g;" >/dev/null 2>&1 \
    || echo "[seed] WARN: ACT_HI_ACTINST insert skipped (schema mismatch — non-fatal)" >&2
  sql "SELECT count(*) FROM ACT_HI_PROCINST;"
}

seed_operaton() {
  echo "[seed] operaton: truncating ACT_HI_PROCINST + ACT_HI_ACTINST" >&2
  sql "TRUNCATE TABLE ACT_HI_ACTINST;" >/dev/null 2>&1 || true
  sql "TRUNCATE TABLE ACT_HI_PROCINST CASCADE;" >/dev/null
  local done=0 lo hi
  while [ "$done" -lt "$N" ]; do
    lo=$((done + 1)); hi=$((done + BATCH)); [ "$hi" -gt "$N" ] && hi="$N"
    sql "INSERT INTO ACT_HI_PROCINST (ID_, PROC_INST_ID_, PROC_DEF_KEY_, PROC_DEF_ID_, START_TIME_, END_TIME_, REMOVAL_TIME_, STATE_) SELECT 'spike-'||g, 'spike-'||g, 'spikeProc', 'spikeProc:1:1', now() - interval '401 days', now() - interval '400 days', now() - interval '1 days', 'COMPLETED' FROM generate_series($lo, $hi) AS g;" >/dev/null
    done="$hi"
    printf '\r[seed] operaton ACT_HI_PROCINST: %d/%d' "$done" "$N" >&2
  done
  echo >&2
  sql "INSERT INTO ACT_HI_ACTINST (ID_, PROC_DEF_KEY_, PROC_DEF_ID_, ROOT_PROC_INST_ID_, PROC_INST_ID_, EXECUTION_ID_, ACT_ID_, ACT_TYPE_, START_TIME_, END_TIME_, REMOVAL_TIME_) SELECT 'a-'||g, 'spikeProc', 'spikeProc:1:1', 'spike-'||g, 'spike-'||g, 'spike-'||g, 'failTask', 'serviceTask', now() - interval '401 days', now() - interval '400 days', now() - interval '1 days' FROM generate_series(1, $N) AS g;" >/dev/null 2>&1 \
    || echo "[seed] WARN: ACT_HI_ACTINST insert skipped (schema mismatch — non-fatal)" >&2
  sql "SELECT count(*) FROM ACT_HI_PROCINST;"
}

case "$ENGINE" in
  flowable) seed_flowable ;;
  operaton) seed_operaton ;;
  *) echo "unknown engine: $ENGINE" >&2; exit 2 ;;
esac
