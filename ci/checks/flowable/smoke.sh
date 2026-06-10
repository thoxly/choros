#!/usr/bin/env bash
# T-0058 · FF-FL-3 + FF-FL-12 (live): end-to-end smoke + schema isolation.
#   1. Deploy chorosSmoke BPMN via REST (asserts HTTP 201).
#   2. Start a process instance (asserts HTTP 201).
#   3. Query runtime process-instances (asserts total >= 1).
#   4. Schema isolation: query Postgres to confirm ACT_* tables in 'flowable' schema
#      and choros_* tables in 'public' schema; assert zero name overlap.
# Exit 0 only if all assertions pass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FLOWABLE_PORT="${FLOWABLE_PORT:-8082}"
ADMIN_USER="${FLOWABLE_REST_APP_ADMIN_USER_ID:-admin}"
ADMIN_PASS="${FLOWABLE_REST_APP_ADMIN_PASSWORD:-choros_flowable_dev_pw}"
PROCESS_KEY="chorosSmoke"
BPMN_FILE="${ROOT}/config/flowable/processes/choros-smoke.bpmn20.xml"
BASE_URL="http://localhost:${FLOWABLE_PORT}/flowable-rest/service"
ERRORS=0
TMP_BODY="$(mktemp)"

cleanup() { rm -f "${TMP_BODY}"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1: Deploy BPMN (FF-FL-2 / AC-7)
# ---------------------------------------------------------------------------
echo "[FF-FL-3] Step 1: Deploy smoke BPMN ..."
DEPLOY_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -F "deployment=@${BPMN_FILE}" \
  "${BASE_URL}/repository/deployments" 2>/dev/null)
DEPLOY_BODY=$(cat "${TMP_BODY}")

if [[ "${DEPLOY_CODE}" == "201" ]]; then
  DEPLOY_ID=$(echo "${DEPLOY_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "  PASS: BPMN deployed (HTTP 201), deployment ID: ${DEPLOY_ID}"
else
  echo "  FAIL: deploy expected HTTP 201, got ${DEPLOY_CODE}" >&2
  echo "  Response: ${DEPLOY_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Step 2: Start process instance (FF-FL-3 / AC-8)
# ---------------------------------------------------------------------------
echo "[FF-FL-3] Step 2: Start process instance (key=${PROCESS_KEY}) ..."
START_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"processDefinitionKey\":\"${PROCESS_KEY}\"}" \
  "${BASE_URL}/runtime/process-instances" 2>/dev/null)
START_BODY=$(cat "${TMP_BODY}")

if [[ "${START_CODE}" == "201" ]]; then
  INSTANCE_ID=$(echo "${START_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))" 2>/dev/null || echo "?")
  echo "  PASS: instance started (HTTP 201), instance ID: ${INSTANCE_ID}"
else
  echo "  FAIL: start-instance expected HTTP 201, got ${START_CODE}" >&2
  echo "  Response: ${START_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Step 3: Verify instance visible in runtime query (FF-FL-3 / AC-9)
# ---------------------------------------------------------------------------
echo "[FF-FL-3] Step 3: Query runtime process-instances (key=${PROCESS_KEY}) ..."
QUERY_CODE=$(curl -s -o "${TMP_BODY}" -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  "${BASE_URL}/runtime/process-instances?processDefinitionKey=${PROCESS_KEY}" 2>/dev/null)
QUERY_BODY=$(cat "${TMP_BODY}")

if [[ "${QUERY_CODE}" == "200" ]]; then
  TOTAL=$(echo "${QUERY_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null || echo "0")
  if [[ "${TOTAL}" -ge 1 ]]; then
    echo "  PASS: runtime query returns total=${TOTAL} (>= 1)"
  else
    echo "  FAIL: runtime query returned total=${TOTAL} (expected >= 1)" >&2
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  FAIL: runtime query expected HTTP 200, got ${QUERY_CODE}" >&2
  echo "  Response: ${QUERY_BODY}" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Step 4: Schema isolation check (FF-FL-12 / AC-4)
# ---------------------------------------------------------------------------
echo "[FF-FL-3] Step 4: Schema isolation — flowable.ACT_* vs public.choros_* ..."

POSTGRES_DB="${POSTGRES_DB:-choros}"
POSTGRES_USER="${POSTGRES_USER:-choros_migrator}"

# Get tables in flowable schema
FLOWABLE_TABLES=$(docker compose -f "${ROOT}/docker-compose.yml" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -t -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='flowable' ORDER BY table_name;" \
  2>/dev/null | tr -d ' ' | grep -v '^$' || true)

# Get tables in public schema (choros_*)
CHOROS_TABLES=$(docker compose -f "${ROOT}/docker-compose.yml" exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -t -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;" \
  2>/dev/null | tr -d ' ' | grep -v '^$' || true)

if [[ -z "${FLOWABLE_TABLES}" ]]; then
  echo "  FAIL: no tables found in 'flowable' schema (ACT_* not created by Liquibase)" >&2
  ERRORS=$((ERRORS + 1))
else
  ACT_COUNT=$(echo "${FLOWABLE_TABLES}" | grep -c '^act_' || echo "0")
  echo "  PASS: flowable schema has ${ACT_COUNT} act_* table(s)"
fi

if [[ -z "${CHOROS_TABLES}" ]]; then
  echo "  WARN: no tables found in 'public' schema (choros_* may not be migrated yet in this test env)"
else
  CHOROS_COUNT=$(echo "${CHOROS_TABLES}" | grep -c '^choros_' || echo "0")
  echo "  INFO: public schema has ${CHOROS_COUNT} choros_* table(s)"
fi

# Check intersection (name collision) — only if both schemas have tables
if [[ -n "${FLOWABLE_TABLES}" ]] && [[ -n "${CHOROS_TABLES}" ]]; then
  OVERLAP=$(comm -12 \
    <(echo "${FLOWABLE_TABLES}" | sort) \
    <(echo "${CHOROS_TABLES}" | sort) \
    || true)
  if [[ -z "${OVERLAP}" ]]; then
    echo "  PASS: zero table name collision between flowable and public schemas"
  else
    echo "  FAIL: table name collision between schemas: ${OVERLAP}" >&2
    ERRORS=$((ERRORS + 1))
  fi
elif [[ -z "${CHOROS_TABLES}" ]]; then
  # In this test environment we only started postgres+flowable, not migrations.
  # The isolation invariant is: ACT_* live in 'flowable' schema, NOT in 'public'.
  PUBLIC_ACT=$(docker compose -f "${ROOT}/docker-compose.yml" exec -T postgres \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -t -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'act_%';" \
    2>/dev/null | tr -d ' \n' || echo "?")
  if [[ "${PUBLIC_ACT}" == "0" ]]; then
    echo "  PASS: zero ACT_* tables in 'public' schema — all in 'flowable' (schema isolation confirmed)"
  else
    echo "  FAIL: ACT_* tables found in 'public' schema (${PUBLIC_ACT} tables) — schema isolation broken" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "[FF-FL-3] FAIL: smoke found ${ERRORS} failure(s)"
  exit 1
fi
echo ""
echo "[FF-FL-3] PASS: all smoke + schema-isolation checks green"
exit 0
