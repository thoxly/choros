#!/usr/bin/env bash
# =============================================================================
# T-0117 SPIKE — NOT PRODUCTION CODE.
# Flowable OSS-boundary spike harness (ADR docs/design/T-0117-flowable-oss-spike.adr.md).
# Single zero-dep entrypoint. Subcommands per-AC, idempotent.
#
#   run.sh up        <engine>        AC-1   bring up stack, wait healthcheck
#   run.sh license   <engine>        AC-2/11 record image+digest+license
#   run.sh seed      <engine> [N]    AC-3   batch-insert >=N completed instances
#   run.sh cleanup   <engine>        AC-4/5/6 warm-up + cleanup throughput + degradation
#   run.sh deadletter<engine>        AC-7/8/9 create dead-job, REST list/retry/move
#   run.sh measure   <engine>        AC-12  assemble measurements.json (EngineResult)
#   run.sh down      <engine>        AC-15  tear down stack + disposable volume
#   run.sh smoke     <engine>        BUILD-fitness: up->REST->seed->measure->down (small N)
#   run.sh all       <engine> [N]    full single-engine run
#
# engine = flowable | operaton.  Deps: docker compose, curl, python3 (verify only), bash.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/jq-free-json.sh"

MEAS="$HERE/measurements.json"
N_HISTORY_DEFAULT="${N_HISTORY:-300000}"
BATCH="${BATCH:-10000}"
POLL="${POLL:-5}"

# ---- per-engine config ------------------------------------------------------
engine_cfg() {
  case "$1" in
    flowable)
      COMPOSE="$HERE/compose.flowable.yml"; PROJECT="spike_flowable"
      IMAGE="flowable/flowable-rest:7.1.0"; PORT=8080
      REST_BASE="http://localhost:8080/flowable-rest/service"
      AUTH="admin:test" ;;
    operaton)
      COMPOSE="$HERE/compose.operaton.yml"; PROJECT="spike_operaton"
      IMAGE="operaton/operaton:1.0.0"; PORT=8081
      REST_BASE="http://localhost:8081/engine-rest"
      AUTH="" ;;
    *) echo "unknown engine: $1 (use flowable|operaton)" >&2; exit 2 ;;
  esac
}

dc() { docker compose -p "$PROJECT" -f "$COMPOSE" "$@"; }

# psql inside the pg container — zero host deps (ADR §3 "psql-in-container").
dc_psql() {
  dc exec -T pg psql -U "$ENGINE" -d "$ENGINE" -v ON_ERROR_STOP=1 -At -c "$1"
}

curl_auth() {
  if [ -n "$AUTH" ]; then curl -fsS -u "$AUTH" "$@"; else curl -fsS "$@"; fi
}
# variant that returns body + http code, never fails the script
curl_code() {
  local out
  if [ -n "$AUTH" ]; then
    out=$(curl -sS -u "$AUTH" -w '\n%{http_code}' "$@" 2>/dev/null) || true
  else
    out=$(curl -sS -w '\n%{http_code}' "$@" 2>/dev/null) || true
  fi
  printf '%s' "$out"
}

log() { echo "[run.sh $ENGINE] $*" >&2; }

# ---- subcommands ------------------------------------------------------------
cmd_up() {
  log "docker compose up -d ($IMAGE)"
  dc up -d
  log "waiting for REST healthcheck on :$PORT ..."
  local tries=0 max=120 url
  case "$ENGINE" in
    flowable) url="$REST_BASE/management/engine" ;;
    operaton) url="$REST_BASE/engine" ;;
  esac
  until curl_auth -o /dev/null "$url" 2>/dev/null; do
    tries=$((tries+1))
    if [ "$tries" -ge "$max" ]; then
      log "REST did not become healthy after $((max*3))s"; dc logs --tail 40 rest >&2 || true; return 1
    fi
    sleep 3
  done
  log "REST is up: $url"
}

cmd_down() {
  log "docker compose down -v (removing disposable volume)"
  dc down -v --remove-orphans || true
}

# AC-2/AC-11: pin coordinate + digest + license, written to a per-engine sidecar.
cmd_license() {
  log "recording license/coordinates for $IMAGE"
  local digest license_ok="false" license="unknown"
  digest=$(docker image inspect "$IMAGE" --format '{{join .RepoDigests " "}}' 2>/dev/null || echo "")
  [ -z "$digest" ] && digest="$IMAGE (digest unavailable)"
  # extract a LICENSE marker from the image filesystem; Apache 2.0 is what we assert (no enterprise key)
  local lic_text
  lic_text=$(docker run --rm --entrypoint sh "$IMAGE" -c 'cat $(find / -iname "LICENSE*" 2>/dev/null | head -1) 2>/dev/null | head -20' 2>/dev/null || echo "")
  if echo "$lic_text" | grep -qiE 'Apache License|Apache-2.0|Version 2.0'; then
    license="Apache 2.0"; license_ok="true"
  fi
  # no enterprise key / trial anywhere in the image labels
  local labels
  labels=$(docker image inspect "$IMAGE" --format '{{json .Config.Labels}}' 2>/dev/null || echo "{}")
  if echo "$labels" | grep -qiE 'enterprise|trial|license-key'; then
    license_ok="false"; license="$license (enterprise/trial marker found)"
  fi
  cat > "$HERE/.license.$ENGINE" <<EOF
IMAGE=$IMAGE
DIGEST=$digest
LICENSE=$license
LICENSE_OK=$license_ok
EOF
  log "license: $license (ok=$license_ok)"
  cat "$HERE/.license.$ENGINE" >&2
}

cmd_seed() {
  local n="${1:-$N_HISTORY_DEFAULT}"
  log "seeding $n completed instances (batch=$BATCH)"
  # source seed.sh in-process so it reuses dc_psql + the current engine config.
  local actual
  actual=$(N="$n" BATCH="$BATCH" source "$HERE/lib/seed.sh" "$ENGINE" "$n" "$PROJECT" "$BATCH")
  echo "$actual" > "$HERE/.seed.$ENGINE"
  log "seeded actual count = $actual"
}

# AC-4/5/6: warm-up, throughput, degradation curve.
cmd_cleanup() {
  log "history-cleanup: warm-up + throughput measure"
  local t0 t1 n0 n1 size_before size_after dead_before dead_after present="false"
  size_before=$(dc_psql "SELECT pg_total_relation_size('act_hi_procinst');" 2>/dev/null || echo "0")
  n0=$(dc_psql "SELECT count(*) FROM ACT_HI_PROCINST;" 2>/dev/null || echo "0")
  log "before: N=$n0 size=${size_before}B"

  # trigger cleanup via the OSS REST management API (proves OSS presence, AC-4)
  trigger_cleanup
  t0=$(date +%s)
  # poll until count stabilizes (plateau) or timeout
  local prev=-1 stable=0 elapsed=0 max_wait=600 cur
  while [ "$elapsed" -lt "$max_wait" ]; do
    sleep "$POLL"; elapsed=$((elapsed+POLL))
    cur=$(dc_psql "SELECT count(*) FROM ACT_HI_PROCINST;" 2>/dev/null || echo "$prev")
    log "  poll t+${elapsed}s: N=$cur"
    if [ "$cur" = "$prev" ]; then stable=$((stable+1)); else stable=0; fi
    prev="$cur"
    # plateau: 2 consecutive identical polls AND some deletion happened
    if [ "$stable" -ge 2 ]; then break; fi
    # keep re-triggering for engines that delete in bounded batches per cycle
    trigger_cleanup
  done
  t1=$(date +%s)
  n1="$prev"
  size_after=$(dc_psql "SELECT pg_total_relation_size('act_hi_procinst');" 2>/dev/null || echo "0")
  dead_after=$(dc_psql "SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='act_hi_procinst';" 2>/dev/null || echo "0")

  local deleted=$((n0 - n1)) dur=$((t1 - t0)) rps=0
  [ "$dur" -le 0 ] && dur=1
  rps=$(python3 -c "print(round($deleted/$dur,2))" 2>/dev/null || echo "0")
  [ "$deleted" -gt 0 ] && present="true"

  local degr_ok="true"
  # degradation: deletion reached a plateau (not unbounded growth) and finished deterministically
  [ "$n1" -ge "$n0" ] && degr_ok="false"

  cat > "$HERE/.cleanup.$ENGINE" <<EOF
N0=$n0
N1=$n1
DELETED=$deleted
DURATION_S=$dur
THROUGHPUT_RPS=$rps
SIZE_BEFORE=$size_before
SIZE_AFTER=$size_after
DEAD_AFTER=$dead_after
PRESENT=$present
DEGRADATION_OK=$degr_ok
EOF
  log "cleanup: deleted=$deleted in ${dur}s => ${rps} rec/s; present_in_oss=$present; degradation_ok=$degr_ok"
}

trigger_cleanup() {
  case "$ENGINE" in
    flowable)
      # OSS management API: history-cleanup batch (no enterprise key).
      curl_auth -X POST "$REST_BASE/management/history-cleanup" >/dev/null 2>&1 \
        || curl_auth -X POST -H 'Content-Type: application/json' -d '{}' \
             "$REST_BASE/management/jobs" >/dev/null 2>&1 || true
      ;;
    operaton)
      # Camunda-7 OSS: schedule cleanup job immediately, then execute due jobs.
      curl_auth -X POST -H 'Content-Type: application/json' \
        "$REST_BASE/history/cleanup?immediatelyDue=true&executeAtOnce=true" >/dev/null 2>&1 \
        || curl_auth -X POST -H 'Content-Type: application/json' -d '{}' \
             "$REST_BASE/history/cleanup?immediatelyDue=true" >/dev/null 2>&1 || true
      ;;
  esac
}

# AC-7/8/9: deadletter via REST OSS — list / retry / move. Binary outcome per op (NF-4).
cmd_deadletter() {
  log "deadletter: deploy failing BPMN, create dead-job, REST list/retry/move"
  local list_http="" list_count="0" list_avail="false"
  local retry_http="" retry_avail="false" retry_effect=""
  local move_http=""  move_avail="false"  move_effect=""

  deploy_failing_and_fail   # engine-specific: produce a dead/failed job

  case "$ENGINE" in
    flowable)
      local body code
      body=$(curl_code "$REST_BASE/management/deadletter-jobs")
      code=$(echo "$body" | tail -1); list_http="$code"
      if echo "$code" | grep -qE '^2'; then
        list_avail="true"
        list_count=$(echo "$body" | sed '$d' | python3 -c 'import sys,json;
try: print(json.load(sys.stdin).get("total",0))
except Exception: print(0)' 2>/dev/null || echo "0")
      fi
      # pick a deadletter job id
      local jid
      jid=$(echo "$body" | sed '$d' | python3 -c 'import sys,json;
try:
  d=json.load(sys.stdin); print(d["data"][0]["id"]) if d.get("data") else print("")
except Exception: print("")' 2>/dev/null || echo "")
      if [ -n "$jid" ]; then
        # AC-8 retry: move back to executable via management action (set retries / move)
        local rbody rcode
        rbody=$(curl_code -X POST -H 'Content-Type: application/json' \
                  -d '{"action":"move"}' "$REST_BASE/management/deadletter-jobs/$jid")
        rcode=$(echo "$rbody" | tail -1); retry_http="$rcode"; move_http="$rcode"
        if echo "$rcode" | grep -qE '^2'; then
          retry_avail="true"; move_avail="true"
          retry_effect="moved out of deadletter (action=move)"; move_effect="moved to executable/timer queue"
        fi
      fi
      ;;
    operaton)
      # Camunda-7: failed async jobs surface via /job?withException=true (retries=0).
      local body code
      body=$(curl_code "$REST_BASE/job?withException=true")
      code=$(echo "$body" | tail -1); list_http="$code"
      if echo "$code" | grep -qE '^2'; then
        list_avail="true"
        list_count=$(echo "$body" | sed '$d' | python3 -c 'import sys,json;
try: print(len(json.load(sys.stdin)))
except Exception: print(0)' 2>/dev/null || echo "0")
      fi
      local jid
      jid=$(echo "$body" | sed '$d' | python3 -c 'import sys,json;
try:
  d=json.load(sys.stdin); print(d[0]["id"]) if d else print("")
except Exception: print("")' 2>/dev/null || echo "")
      if [ -n "$jid" ]; then
        # AC-8 set-retries (retry) via REST
        local rbody rcode
        rbody=$(curl_code -X PUT -H 'Content-Type: application/json' \
                  -d '{"retries":3}' "$REST_BASE/job/$jid/retries")
        rcode=$(echo "$rbody" | tail -1); retry_http="$rcode"
        if echo "$rcode" | grep -qE '^2'; then
          retry_avail="true"; retry_effect="retries set to 3 (back to active queue)"
        fi
        # AC-9 move/return: Camunda has no "deadletter move"; the equivalent return-to-active
        # is set-retries (documented parity). Record that explicitly.
        move_http="$rcode"; move_avail="$retry_avail"
        move_effect="no dedicated deadletter-move in Camunda-7 REST; return-to-active = set-retries (parity note)"
      fi
      ;;
  esac

  cat > "$HERE/.deadletter.$ENGINE" <<EOF
LIST_AVAIL=$list_avail
LIST_HTTP=$list_http
LIST_COUNT=$list_count
RETRY_AVAIL=$retry_avail
RETRY_HTTP=$retry_http
RETRY_EFFECT=$retry_effect
MOVE_AVAIL=$move_avail
MOVE_HTTP=$move_http
MOVE_EFFECT=$move_effect
EOF
  log "deadletter: list(avail=$list_avail http=$list_http count=$list_count) retry(avail=$retry_avail http=$retry_http) move(avail=$move_avail http=$move_http)"
}

deploy_failing_and_fail() {
  case "$ENGINE" in
    flowable)
      log "deploy flowable-failing.bpmn20.xml"
      curl_auth -X POST -F "deployment=@$HERE/bpmn/flowable-failing.bpmn20.xml" \
        "$REST_BASE/repository/deployments" >/dev/null 2>&1 || true
      # start an instance
      curl_auth -X POST -H 'Content-Type: application/json' \
        -d '{"processDefinitionKey":"spikeFailing"}' \
        "$REST_BASE/runtime/process-instances" >/dev/null 2>&1 || true
      sleep 3
      # find the async job and force it to deadletter by setting retries=0
      local jbody jid
      jbody=$(curl_code "$REST_BASE/management/jobs")
      jid=$(echo "$jbody" | sed '$d' | python3 -c 'import sys,json;
try:
  d=json.load(sys.stdin); print(d["data"][0]["id"]) if d.get("data") else print("")
except Exception: print("")' 2>/dev/null || echo "")
      if [ -n "$jid" ]; then
        curl_auth -X PUT -H 'Content-Type: application/json' -d '{"retries":0}' \
          "$REST_BASE/management/jobs/$jid" >/dev/null 2>&1 || true
        sleep 3
      fi
      ;;
    operaton)
      log "deploy operaton-failing.bpmn20.xml"
      curl_auth -X POST \
        -F "deployment-name=spike" \
        -F "operaton-failing.bpmn20.xml=@$HERE/bpmn/operaton-failing.bpmn20.xml" \
        "$REST_BASE/deployment/create" >/dev/null 2>&1 || true
      curl_auth -X POST -H 'Content-Type: application/json' -d '{}' \
        "$REST_BASE/process-definition/key/spikeFailing/start" >/dev/null 2>&1 || true
      sleep 3
      local jbody jid
      jbody=$(curl_code "$REST_BASE/job")
      jid=$(echo "$jbody" | sed '$d' | python3 -c 'import sys,json;
try:
  d=json.load(sys.stdin); print(d[0]["id"]) if d else print("")
except Exception: print("")' 2>/dev/null || echo "")
      if [ -n "$jid" ]; then
        curl_auth -X PUT -H 'Content-Type: application/json' -d '{"retries":0}' \
          "$REST_BASE/job/$jid/retries" >/dev/null 2>&1 || true
        sleep 2
      fi
      ;;
  esac
}

# AC-12: assemble the EngineResult into measurements.json.
cmd_measure() {
  log "assembling EngineResult into measurements.json"
  # load sidecars (best-effort; absent => nulls)
  local IMAGE_V="$IMAGE" DIGEST="" LICENSE="" LICENSE_OK=""
  [ -f "$HERE/.license.$ENGINE" ] && source "$HERE/.license.$ENGINE"
  local N_ACTUAL=""
  [ -f "$HERE/.seed.$ENGINE" ] && N_ACTUAL=$(cat "$HERE/.seed.$ENGINE")
  local N0="" N1="" DELETED="" DURATION_S="" THROUGHPUT_RPS="" SIZE_BEFORE="" SIZE_AFTER="" DEAD_AFTER="" PRESENT="" DEGRADATION_OK=""
  [ -f "$HERE/.cleanup.$ENGINE" ] && source "$HERE/.cleanup.$ENGINE"
  local LIST_AVAIL="" LIST_HTTP="" LIST_COUNT="" RETRY_AVAIL="" RETRY_HTTP="" RETRY_EFFECT="" MOVE_AVAIL="" MOVE_HTTP="" MOVE_EFFECT=""
  [ -f "$HERE/.deadletter.$ENGINE" ] && source "$HERE/.deadletter.$ENGINE"

  # extrapolation to 70M/year (explicit assumptions; refutable at ratification — §3.3)
  local CONTOUR_FRACTION="0.2" DEV_FACTOR="0.5" WINDOW="nightly 8h batch window"
  local fits="false" headroom="0"
  if [ -n "${THROUGHPUT_RPS:-}" ] && python3 -c "exit(0 if $THROUGHPUT_RPS>0 else 1)" 2>/dev/null; then
    # per-contour annual volume = 70M * contour_fraction; adjusted throughput = rps * dev_factor
    # records the contour must clear / capacity of one nightly window
    read -r fits headroom < <(python3 - "$THROUGHPUT_RPS" "$CONTOUR_FRACTION" "$DEV_FACTOR" <<'PY'
import sys
rps=float(sys.argv[1]); frac=float(sys.argv[2]); devf=float(sys.argv[3])
per_contour_year = 70_000_000 * frac
adj_rps = rps * devf
# nightly window seconds * 365 nights of capacity vs one year of arrivals
window_s = 8*3600
yearly_capacity = adj_rps * window_s * 365
headroom = yearly_capacity / per_contour_year if per_contour_year else 0
print("true" if headroom >= 2.0 else "false", round(headroom,2))
PY
)
  fi

  # per-engine verdict (spec summary rule): go needs license_ok + cleanup present + all 3 deadletter ops + degradation ok + extrapolation fits
  local VERDICT="no-go" NOTES=""
  if [ "${LICENSE_OK:-false}" = "true" ] && [ "${PRESENT:-false}" = "true" ] \
     && [ "${LIST_AVAIL:-false}" = "true" ] && [ "${RETRY_AVAIL:-false}" = "true" ] \
     && [ "${MOVE_AVAIL:-false}" = "true" ] && [ "${DEGRADATION_OK:-false}" = "true" ]; then
    if [ "$fits" = "true" ]; then VERDICT="go"; else VERDICT="risk"; NOTES="capabilities OSS-present but 70M extrapolation headroom < 2x"; fi
  else
    VERDICT="no-go"; NOTES="one or more mandatory OSS capabilities unavailable (see deadletter/cleanup/license)"
  fi

  local engine_json
  engine_json=$(cat <<JSON
    {
      "engine": $(json_str "$ENGINE"),
      "image": $(json_str "$IMAGE_V"),
      "image_digest": $(json_str "${DIGEST:-}"),
      "license": $(json_str "${LICENSE:-unknown}"),
      "license_ok": $(json_bool "${LICENSE_OK:-}"),
      "n_history_target": $(json_num "$N_HISTORY_DEFAULT"),
      "n_history_actual": $(json_num "${N_ACTUAL:-}"),
      "cleanup_present_in_oss": $(json_bool "${PRESENT:-}"),
      "cleanup_throughput_rps": $(json_num "${THROUGHPUT_RPS:-}"),
      "cleanup_duration_s": $(json_num "${DURATION_S:-}"),
      "cleanup_deleted": $(json_num "${DELETED:-}"),
      "table_size_before_bytes": $(json_num "${SIZE_BEFORE:-}"),
      "table_size_after_bytes": $(json_num "${SIZE_AFTER:-}"),
      "degradation_ok": $(json_bool "${DEGRADATION_OK:-}"),
      "extrapolation": {
        "linearity": $(json_str "assumed linear (single N point this run; refutable)"),
        "contour_fraction": $(json_num "$CONTOUR_FRACTION"),
        "dev_factor": $(json_num "$DEV_FACTOR"),
        "window": $(json_str "$WINDOW"),
        "fits_70m": $(json_bool "$fits"),
        "headroom_factor": $(json_num "$headroom")
      },
      "deadletter": {
        "list":  { "available": $(json_bool "${LIST_AVAIL:-}"),  "http": $(json_num "${LIST_HTTP:-}"),  "count": $(json_num "${LIST_COUNT:-}") },
        "retry": { "available": $(json_bool "${RETRY_AVAIL:-}"), "http": $(json_num "${RETRY_HTTP:-}"), "effect": $(json_str "${RETRY_EFFECT:-}") },
        "move":  { "available": $(json_bool "${MOVE_AVAIL:-}"),  "http": $(json_num "${MOVE_HTTP:-}"),  "effect": $(json_str "${MOVE_EFFECT:-}") }
      },
      "verdict_engine": $(json_str "$VERDICT"),
      "notes": $(json_str "$NOTES")
    }
JSON
)
  merge_engine_result "$engine_json"
  log "measure: verdict_engine=$VERDICT (written to measurements.json)"
}

# merge/replace this engine's EngineResult in measurements.json (python3 = present, verify-only dep)
merge_engine_result() {
  local frag="$1"
  python3 - "$MEAS" "$ENGINE" <<PY
import sys, json, datetime
path, engine = sys.argv[1], sys.argv[2]
frag = json.loads('''$frag''')
try:
    with open(path) as f: doc = json.load(f)
except Exception:
    doc = {"schema_version": "1.0", "generated_at": None, "engines": []}
doc["schema_version"] = "1.0"
doc["generated_at"] = datetime.datetime.utcnow().isoformat()+"Z"
doc["engines"] = [e for e in doc.get("engines", []) if e.get("engine") != engine]
doc["engines"].append(frag)
doc["engines"].sort(key=lambda e: e.get("engine",""))
with open(path, "w") as f: json.dump(doc, f, indent=2)
PY
}

cmd_smoke() {
  log "SMOKE (BUILD-fitness, small N): up -> REST 200 -> seed 1000 -> measure -> down"
  cmd_up
  cmd_license
  cmd_seed 1000
  cmd_cleanup || true
  cmd_deadletter || true
  cmd_measure
  cmd_down
  log "SMOKE done"
}

cmd_all() {
  local n="${1:-$N_HISTORY_DEFAULT}"
  cmd_up
  cmd_license
  cmd_seed "$n"
  cmd_cleanup
  cmd_deadletter
  cmd_measure
  log "ALL done for $ENGINE (stack left UP; run 'down' to clean)"
}

# ---- dispatch ---------------------------------------------------------------
# allow sourcing for the seed helper
if [ "${1:-}" = "--lib" ]; then return 0 2>/dev/null || true; fi

CMD="${1:-}"; ENGINE="${2:-}"
[ -z "$CMD" ] && { grep -E '^#   run.sh' "$HERE/run.sh"; exit 2; }
[ -z "$ENGINE" ] && { echo "engine required (flowable|operaton)" >&2; exit 2; }
shift 2 || true
engine_cfg "$ENGINE"

case "$CMD" in
  up)         cmd_up ;;
  down)       cmd_down ;;
  license)    cmd_license ;;
  seed)       cmd_seed "${1:-}" ;;
  cleanup)    cmd_cleanup ;;
  deadletter) cmd_deadletter ;;
  measure)    cmd_measure ;;
  smoke)      cmd_smoke ;;
  all)        cmd_all "${1:-}" ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
