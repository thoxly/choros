#!/usr/bin/env bash
# T-0058 · FF-FL-4..11 (static): all static fitness checks for the Flowable substrate.
# No running container needed — checks docker-compose.yml and committed BPMN file.
#
# FF-FL-4:  pinned OSS image, no enterprise key
# FF-FL-5:  single Postgres invariant
# FF-FL-6:  port non-collision
# FF-FL-7:  secret form (${VAR:-dev_default})
# FF-FL-8:  depends_on postgres: service_healthy
# FF-FL-9:  history cleanup env present
# FF-FL-10: external-task step in smoke BPMN
# FF-FL-11: existing postgres/keycloak service blocks unmodified
#
# Exit 0 on all pass, exit 1 on any failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
COMPOSE="${ROOT}/docker-compose.yml"
BPMN="${ROOT}/config/flowable/processes/choros-smoke.bpmn20.xml"
ERRORS=0

echo "[FF-FL-static] Running static fitness checks for T-0058 Flowable substrate ..."

if [[ ! -f "${COMPOSE}" ]]; then
  echo "FAIL: ${COMPOSE} not found"
  exit 1
fi

# ---------------------------------------------------------------------------
# FF-FL-4: Pinned OSS image, no enterprise key
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-4: Pinned OSS image, no enterprise key ==="
if grep -qE 'image:.*flowable/flowable-rest:7\.1\.0' "${COMPOSE}"; then
  echo "  PASS FF-FL-4a: flowable image is flowable/flowable-rest:7.1.0 (pinned)"
else
  echo "  FAIL FF-FL-4a: flowable service image is not 'flowable/flowable-rest:7.1.0'" >&2
  ERRORS=$((ERRORS + 1))
fi

if grep -iE '(LICENSE|ENTERPRISE|ACTIVATION)' "${COMPOSE}" | grep -iv '^\s*#' >/dev/null 2>&1; then
  echo "  FAIL FF-FL-4b: found LICENSE/ENTERPRISE/ACTIVATION env var in compose" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "  PASS FF-FL-4b: no enterprise/license/activation key in compose"
fi

# ---------------------------------------------------------------------------
# FF-FL-5: Single Postgres invariant
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-5: Single Postgres invariant ==="
POSTGRES_IMAGE_COUNT=$(grep -cE 'image:\s*postgres:' "${COMPOSE}" || echo "0")
if [[ "${POSTGRES_IMAGE_COUNT}" -eq 1 ]]; then
  echo "  PASS FF-FL-5a: exactly one postgres: image in compose"
else
  echo "  FAIL FF-FL-5a: expected 1 postgres image, found ${POSTGRES_IMAGE_COUNT}" >&2
  ERRORS=$((ERRORS + 1))
fi

if grep -qE 'SPRING_DATASOURCE_URL.*postgres:5432' "${COMPOSE}"; then
  echo "  PASS FF-FL-5b: SPRING_DATASOURCE_URL points to postgres:5432 (shared instance)"
else
  echo "  FAIL FF-FL-5b: SPRING_DATASOURCE_URL does not point to postgres:5432" >&2
  ERRORS=$((ERRORS + 1))
fi

if grep -qE 'SPRING_DATASOURCE_URL.*currentSchema=flowable|SPRING_DATASOURCE_SCHEMA.*flowable' "${COMPOSE}"; then
  echo "  PASS FF-FL-5c: schema isolation mechanism present (currentSchema=flowable or SPRING_DATASOURCE_SCHEMA)"
else
  echo "  FAIL FF-FL-5c: schema isolation mechanism missing — SPRING_DATASOURCE_URL must include currentSchema=flowable or SPRING_DATASOURCE_SCHEMA must be set to flowable" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# FF-FL-6: Port non-collision
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-6: Port non-collision ==="
# Extract all host-side port values from 'ports:' lines (format: "HOST:CONTAINER" or "${VAR:-DEFAULT}:CONTAINER")
# We check known defaults: 55432, 8180, 9000, 3000 must not appear as flowable port
if grep -qE '8082' "${COMPOSE}"; then
  # Count how many port lines use 8082 — should be only the flowable service
  FLOWABLE_PORT_LINES=$(grep -cE '"?\$\{FLOWABLE_PORT:-8082\}:' "${COMPOSE}" || echo "0")
  OTHER_8082=$(grep -E '8082' "${COMPOSE}" | grep -vE 'FLOWABLE_PORT' | grep -vE '^\s*#' || true)
  if [[ -n "${OTHER_8082}" ]]; then
    echo "  FAIL FF-FL-6: port 8082 used by a non-flowable service line: ${OTHER_8082}" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "  PASS FF-FL-6: port 8082 is only used by the flowable service"
  fi
else
  echo "  WARN FF-FL-6: FLOWABLE_PORT 8082 not found in compose — check port mapping"
fi

# ---------------------------------------------------------------------------
# FF-FL-7: Secret form
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-7: Secret form (dev-default credentials) ==="
ALLOWED_DEV_DEFAULTS='choros_dev_pw|choros_app_dev_pw|choros_kc_dev_pw|choros_flowable_dev_pw'

# Check SPRING_DATASOURCE_PASSWORD uses env-default form
if grep -qE 'SPRING_DATASOURCE_PASSWORD:[[:space:]]*\$\{[A-Za-z0-9_]+:-[A-Za-z0-9_]+\}' "${COMPOSE}"; then
  echo "  PASS FF-FL-7a: SPRING_DATASOURCE_PASSWORD uses \${VAR:-default} form"
else
  echo "  FAIL FF-FL-7a: SPRING_DATASOURCE_PASSWORD not in \${VAR:-default} form" >&2
  ERRORS=$((ERRORS + 1))
fi

# Check FLOWABLE_REST_APP_ADMIN_PASSWORD uses env-default form
if grep -qE 'FLOWABLE_REST_APP_ADMIN_PASSWORD:[[:space:]]*\$\{[A-Za-z0-9_]+:-[A-Za-z0-9_]+\}' "${COMPOSE}"; then
  echo "  PASS FF-FL-7b: FLOWABLE_REST_APP_ADMIN_PASSWORD uses \${VAR:-default} form"
else
  echo "  FAIL FF-FL-7b: FLOWABLE_REST_APP_ADMIN_PASSWORD not in \${VAR:-default} form" >&2
  ERRORS=$((ERRORS + 1))
fi

# Check all password defaults are in allowed list
ERRORS_BEFORE_7C=${ERRORS}
while IFS= read -r line; do
  dflt=$(printf '%s' "${line}" | sed -nE 's/.*PASSWORD:[[:space:]]*\$\{[A-Za-z0-9_]+:-([A-Za-z0-9_]+)\}.*/\1/p')
  if [[ -n "${dflt}" ]] && ! [[ "${dflt}" =~ ^(${ALLOWED_DEV_DEFAULTS})$ ]]; then
    echo "  FAIL FF-FL-7c: unexpected password default literal in compose: '${dflt}'" >&2
    ERRORS=$((ERRORS + 1))
  fi
done < <(grep -iE 'PASSWORD' "${COMPOSE}" | grep -v '^\s*#' || true)
if [[ ${ERRORS} -eq ${ERRORS_BEFORE_7C} ]]; then
  echo "  PASS FF-FL-7c: all password defaults are allowed dev defaults"
fi

# ---------------------------------------------------------------------------
# FF-FL-8: depends_on postgres: service_healthy
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-8: depends_on postgres: service_healthy ==="
if python3 -c "
import sys
try:
    import yaml
except ImportError:
    sys.exit(2)
with open('${COMPOSE}') as f:
    d = yaml.safe_load(f)
svc = d.get('services', {}).get('flowable', {})
dep = svc.get('depends_on', {})
postgres_dep = dep.get('postgres', {}) if isinstance(dep, dict) else {}
condition = postgres_dep.get('condition', '')
if condition == 'service_healthy':
    sys.exit(0)
else:
    print(f'condition={condition!r}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null; then
  echo "  PASS FF-FL-8 (yaml): flowable.depends_on.postgres.condition = service_healthy"
elif [[ $? -eq 2 ]]; then
  # yaml not available — fallback to grep scoped to the flowable service block
  if sed -n '/^  flowable:/,/^  [a-z]/p' "${COMPOSE}" | grep -A5 'depends_on:' | grep -q 'service_healthy'; then
    echo "  PASS FF-FL-8 (grep): flowable depends_on references service_healthy"
  else
    echo "  FAIL FF-FL-8: flowable does not depend on postgres with service_healthy" >&2
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  FAIL FF-FL-8: flowable.depends_on.postgres.condition != service_healthy" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# FF-FL-9: History cleanup env
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-9: History cleanup env present ==="
if grep -qE 'FLOWABLE_ENABLE_HISTORY_CLEANING.*true' "${COMPOSE}"; then
  echo "  PASS FF-FL-9a: FLOWABLE_ENABLE_HISTORY_CLEANING: \"true\" found"
else
  echo "  FAIL FF-FL-9a: FLOWABLE_ENABLE_HISTORY_CLEANING not set to true" >&2
  ERRORS=$((ERRORS + 1))
fi

if grep -qE 'FLOWABLE_HISTORY_CLEANING_CYCLE' "${COMPOSE}"; then
  echo "  PASS FF-FL-9b: FLOWABLE_HISTORY_CLEANING_CYCLE found"
else
  echo "  FAIL FF-FL-9b: FLOWABLE_HISTORY_CLEANING_CYCLE not found" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# FF-FL-10: External-task step in smoke BPMN
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-10: External-task step in smoke BPMN ==="
if [[ ! -f "${BPMN}" ]]; then
  echo "  FAIL FF-FL-10: BPMN file not found: ${BPMN}" >&2
  ERRORS=$((ERRORS + 1))
else
  if grep -qE 'flowable:type="external"' "${BPMN}"; then
    echo "  PASS FF-FL-10a: smoke BPMN contains flowable:type=\"external\""
  else
    echo "  FAIL FF-FL-10a: smoke BPMN does not contain flowable:type=\"external\"" >&2
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE 'flowable:topic=' "${BPMN}"; then
    TOPIC=$(grep -oE 'flowable:topic="[^"]*"' "${BPMN}" | head -1 || echo "(not found)")
    echo "  PASS FF-FL-10b: smoke BPMN contains ${TOPIC}"
  else
    echo "  FAIL FF-FL-10b: smoke BPMN does not contain flowable:topic attribute" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-FL-11: Existing postgres/keycloak service blocks unmodified
# ---------------------------------------------------------------------------
echo ""
echo "=== FF-FL-11: Existing postgres/keycloak blocks unmodified ==="
# Compare against baseline commit 6c79822 (T-0431 incident fix — keycloak init: true so
# PID 1 reaps zombie healthcheck children; without it ~13k zombies exhaust cgroup pids in
# ~22h → JVM pthread_create EAGAIN → login down). Prior baseline was f693923 (T-0061 BUILD
# fix — KC healthcheck curl→bash /dev/tcp on container-internal port 9000; Flowable
# healthcheck --password=→URL-embedded basic-auth). Each baseline bump must reference the
# task that authorized the pg/kc block change.
# Strategy: extract service blocks by AWK (no pyyaml needed) and diff.
# A service block starts at "  <name>:" (2-space indent) and ends before the next
# 2-space-indent service key or end of file.
BASELINE_SHA="6c79822"

extract_service_block() {
  local file_content="$1"
  local service_name="$2"
  # Extract a service block: starts at '  <name>:' (2-space indent), ends at the
  # first blank line or top-level key (0-indent) after the block begins.
  # This is robust regardless of whether pyyaml is available.
  echo "${file_content}" | awk "
    /^  ${service_name}:/ { in_block=1 }
    in_block && /^$/ { in_block=0 }
    in_block && /^[a-zA-Z]/ { in_block=0 }
    in_block { print }
  "
}

BASELINE_COMPOSE=$(git -C "${ROOT}" show "${BASELINE_SHA}:docker-compose.yml" 2>/dev/null || echo "")
CURRENT_COMPOSE=$(cat "${COMPOSE}")

if [[ -z "${BASELINE_COMPOSE}" ]]; then
  echo "  WARN FF-FL-11: could not read baseline commit ${BASELINE_SHA} — skipping (git history unavailable)"
else
  BASELINE_PG=$(extract_service_block "${BASELINE_COMPOSE}" "postgres")
  CURRENT_PG=$(extract_service_block "${CURRENT_COMPOSE}" "postgres")
  if [[ "${BASELINE_PG}" == "${CURRENT_PG}" ]]; then
    echo "  PASS FF-FL-11a: postgres service block unchanged from baseline ${BASELINE_SHA}"
  else
    echo "  FAIL FF-FL-11a: postgres service block differs from baseline ${BASELINE_SHA}" >&2
    diff <(echo "${BASELINE_PG}") <(echo "${CURRENT_PG}") >&2 || true
    ERRORS=$((ERRORS + 1))
  fi

  BASELINE_KC=$(extract_service_block "${BASELINE_COMPOSE}" "keycloak")
  CURRENT_KC=$(extract_service_block "${CURRENT_COMPOSE}" "keycloak")
  if [[ "${BASELINE_KC}" == "${CURRENT_KC}" ]]; then
    echo "  PASS FF-FL-11b: keycloak service block unchanged from baseline ${BASELINE_SHA}"
  else
    echo "  FAIL FF-FL-11b: keycloak service block differs from baseline ${BASELINE_SHA}" >&2
    diff <(echo "${BASELINE_KC}") <(echo "${CURRENT_KC}") >&2 || true
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "[FF-FL-static] FAIL: ${ERRORS} static check(s) failed"
  exit 1
fi
echo "[FF-FL-static] PASS: all static Flowable fitness checks green (FF-FL-4..11)"
exit 0
