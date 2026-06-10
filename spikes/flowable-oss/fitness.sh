#!/usr/bin/env bash
# =============================================================================
# T-0117 SPIKE — BUILD fitness gate (ADR §7). Checks the HARNESS works (smoke +
# structural), NOT the spike's numbers (those feed the founder gate, not CI).
# 8 fitness functions: FF-ISOLATION, FF-SMOKE-UP, FF-SMOKE-SEED, FF-SMOKE-JSON,
# FF-SMOKE-DOWN, FF-ADDENDUM, FF-IMAGES-PINNED, FF-NO-SECRETS.
#
#   ./fitness.sh            run all 8 (uses flowable for the live smoke FFs)
#   ENGINE=operaton ./fitness.sh   run live FFs against operaton instead
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENG="${ENGINE:-flowable}"
BASE_SHA="${BASE_SHA:-ebe5575d5809de982ff1291b6d9b8441f03bc91e}"
PASS=0; FAIL=0
ok()   { echo "  PASS $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL $1 — $2"; FAIL=$((FAIL+1)); }

case "$ENG" in
  flowable) PORT="${FLOWABLE_REST_PORT:-18080}"; HEALTH="http://localhost:$PORT/flowable-rest/service/management/engine"; AUTH="-u admin:test"; PROJ=spike_flowable; VOL=spike_flowable_pg ;;
  operaton) PORT="${OPERATON_REST_PORT:-18081}"; HEALTH="http://localhost:$PORT/engine-rest/engine"; AUTH=""; PROJ=spike_operaton; VOL=spike_operaton_pg ;;
esac

echo "== FF-ISOLATION =="
# diff must not touch anything outside spikes/ + the one addendum + T-0117 contracts
OUT=$(git -C "$REPO" diff --name-only "$BASE_SHA"..HEAD 2>/dev/null | grep -vE '^(spikes/|docs/design/stack-flowable-oss-spike-addendum\.md|docs/design/T-0117)' || true)
# include uncommitted working-tree changes too
OUT2=$(git -C "$REPO" status --porcelain 2>/dev/null | awk '{print $2}' | grep -vE '^(spikes/|docs/design/stack-flowable-oss-spike-addendum\.md|docs/design/T-0117)' || true)
if [ -z "$OUT" ] && [ -z "$OUT2" ]; then ok "FF-ISOLATION"; else bad "FF-ISOLATION" "touches outside spikes/+addendum: $OUT $OUT2"; fi

echo "== FF-IMAGES-PINNED =="
if grep -qE ':latest' "$HERE"/compose.*.yml; then bad "FF-IMAGES-PINNED" ":latest present"; \
elif grep -q 'Apache' "$HERE/measurements.json" 2>/dev/null; then ok "FF-IMAGES-PINNED"; \
else bad "FF-IMAGES-PINNED" "no Apache license recorded in measurements.json yet"; fi

echo "== FF-NO-SECRETS =="
if grep -RiE 'enterprise.?key|license.?key|trial|api[_-]?token' "$HERE" --include='*.sh' --include='*.yml' --include='*.xml' >/dev/null 2>&1; then \
  bad "FF-NO-SECRETS" "secret/trial marker found"; else ok "FF-NO-SECRETS"; fi

echo "== FF-SMOKE-UP =="
"$HERE/run.sh" up "$ENG" >/dev/null 2>&1
if curl -fsS $AUTH -o /dev/null "$HEALTH" 2>/dev/null; then ok "FF-SMOKE-UP"; else bad "FF-SMOKE-UP" "REST not 200 at $HEALTH"; fi

echo "== FF-SMOKE-SEED =="
"$HERE/run.sh" seed "$ENG" 1000 >/dev/null 2>&1
CNT=$(cat "$HERE/.seed.$ENG" 2>/dev/null || echo 0)
if [ "${CNT:-0}" -ge 1000 ]; then ok "FF-SMOKE-SEED (count=$CNT)"; else bad "FF-SMOKE-SEED" "count=$CNT < 1000"; fi

echo "== FF-SMOKE-JSON =="
"$HERE/run.sh" cleanup "$ENG" >/dev/null 2>&1 || true
"$HERE/run.sh" deadletter "$ENG" >/dev/null 2>&1 || true
"$HERE/run.sh" measure "$ENG" >/dev/null 2>&1
if python3 -c "import json;d=json.load(open('$HERE/measurements.json'));assert any(e['engine']=='$ENG' for e in d['engines']);assert 'verdict_engine' in [e for e in d['engines'] if e['engine']=='$ENG'][0]" 2>/dev/null; then \
  ok "FF-SMOKE-JSON"; else bad "FF-SMOKE-JSON" "measurements.json invalid or missing EngineResult"; fi

echo "== FF-SMOKE-DOWN =="
"$HERE/run.sh" down "$ENG" >/dev/null 2>&1
if docker volume ls 2>/dev/null | grep -q "$VOL"; then bad "FF-SMOKE-DOWN" "volume $VOL still present"; \
else
  "$HERE/run.sh" up "$ENG" >/dev/null 2>&1
  if curl -fsS $AUTH -o /dev/null "$HEALTH" 2>/dev/null; then ok "FF-SMOKE-DOWN (re-up clean)"; "$HERE/run.sh" down "$ENG" >/dev/null 2>&1; \
  else bad "FF-SMOKE-DOWN" "re-up did not come healthy"; fi
fi

echo "== FF-ADDENDUM =="
ADD="$REPO/docs/design/stack-flowable-oss-spike-addendum.md"
if [ -f "$ADD" ] && grep -q 'addendum, awaiting ratification' "$ADD" && grep -Eq 'no-go|go' "$ADD"; then \
  ok "FF-ADDENDUM"; else bad "FF-ADDENDUM" "missing/no status/no go-no-go in $ADD"; fi

echo
echo "FITNESS: $PASS/8 pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
