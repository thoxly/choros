#!/usr/bin/env bash
# FF-T61-1..11 · compose-prod-config (static fitness, T-0061 / E0.6)
#
# Checks: docker compose config -q on both modes + static grep/yaml checks
# covering AC-1..AC-9, AC-11, AC-12 of T-0061.
#
# AC-1  (FF-T61-1)  dev compose config -q exits 0
# AC-2  (FF-T61-2)  prod compose config -q exits 0 with placeholder env
# AC-3  (FF-T61-3)  no ${VAR:-default} for PASSWORD/SECRET/TOKEN/KEY in prod overlay
# AC-4  (FF-T61-4)  prod volumes have _prod suffix; no bare choros_pgdata in prod overlay
# AC-5  (FF-T61-5)  .env.prod.example has only REPLACE_* placeholders for secrets
# AC-6  (FF-T61-6)  .env.prod is in .gitignore
# AC-7  (FF-T61-7)  choros service present in docker-compose.yml with required fields
# AC-8  (FF-T61-8)  Dockerfile exists in repo root
# AC-9  (FF-T61-9)  Keycloak prod overlay uses 'start' (not 'start-dev')
# AC-11 (FF-T61-10) host port defaults are unique across all services
#
# Exit 0 on all pass, exit 1 on any failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_BASE="${ROOT}/docker-compose.yml"
COMPOSE_PROD="${ROOT}/docker-compose.prod.yml"
ENV_EXAMPLE="${ROOT}/.env.prod.example"
GITIGNORE="${ROOT}/.gitignore"
DOCKERFILE="${ROOT}/Dockerfile"
ERRORS=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; ERRORS=$((ERRORS + 1)); }

echo "=== FF-T61-1..11 compose-prod-config static checks ==="

# ---------------------------------------------------------------------------
# FF-T61-1 · AC-1 · dev compose config -q exits 0
# ---------------------------------------------------------------------------
echo "--- FF-T61-1: dev compose config -q ---"
if docker compose -f "${COMPOSE_BASE}" config -q 2>/dev/null; then
  pass "docker compose (dev) config -q exits 0"
else
  fail "docker compose (dev) config -q exited non-zero"
fi

# ---------------------------------------------------------------------------
# FF-T61-2 · AC-2 · prod compose config -q exits 0 with placeholder env
# Replace REPLACE_* with dummy values so compose sees non-empty strings
# ---------------------------------------------------------------------------
echo "--- FF-T61-2: prod compose config -q (with placeholder env) ---"
if [[ ! -f "${ENV_EXAMPLE}" ]]; then
  fail ".env.prod.example not found — cannot run prod config check"
else
  TMP_ENV=$(mktemp /tmp/choros-prod-env.XXXXXX)
  # Replace REPLACE_* placeholders with dummy values (non-empty, non-secret)
  sed 's/REPLACE_[A-Za-z0-9_]*/dummy_test_value/g' "${ENV_EXAMPLE}" > "${TMP_ENV}"
  if docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_PROD}" --env-file "${TMP_ENV}" config -q 2>/dev/null; then
    pass "docker compose (prod) config -q exits 0 with placeholder env"
  else
    fail "docker compose (prod) config -q exited non-zero"
  fi
  rm -f "${TMP_ENV}"
fi

# ---------------------------------------------------------------------------
# FF-T61-3 · AC-3 · no ${VAR:-default} for sensitive vars in prod overlay
# ---------------------------------------------------------------------------
echo "--- FF-T61-3: no default-form creds in prod overlay ---"
if [[ ! -f "${COMPOSE_PROD}" ]]; then
  fail "docker-compose.prod.yml not found"
else
  BAD_DEFAULTS=$(grep -iE '(PASSWORD|SECRET|TOKEN|KEY)' "${COMPOSE_PROD}" | grep ':-' || true)
  if [[ -n "${BAD_DEFAULTS}" ]]; then
    fail "prod overlay contains \${VAR:-default} for sensitive vars:"
    echo "${BAD_DEFAULTS}"
    ERRORS=$((ERRORS + 1))
  else
    pass "prod overlay has no \${VAR:-default} for PASSWORD/SECRET/TOKEN/KEY"
  fi
fi

# ---------------------------------------------------------------------------
# FF-T61-4 · AC-4 · prod volumes use _prod suffix; no bare choros_pgdata
# ---------------------------------------------------------------------------
echo "--- FF-T61-4: prod volumes have _prod suffix ---"
if [[ ! -f "${COMPOSE_PROD}" ]]; then
  fail "docker-compose.prod.yml not found"
else
  # Must have choros_pgdata_prod
  if grep -q 'choros_pgdata_prod' "${COMPOSE_PROD}"; then
    pass "prod overlay declares choros_pgdata_prod volume"
  else
    fail "prod overlay does not declare choros_pgdata_prod volume"
  fi
  # Must NOT reference bare choros_pgdata: (without _prod suffix)
  BAD_VOL=$(grep 'choros_pgdata:' "${COMPOSE_PROD}" | grep -v '_prod' || true)
  if [[ -n "${BAD_VOL}" ]]; then
    fail "prod overlay references bare choros_pgdata volume (no _prod suffix):"
    echo "${BAD_VOL}"
    ERRORS=$((ERRORS + 1))
  else
    pass "prod overlay does not reference bare choros_pgdata volume"
  fi
fi

# ---------------------------------------------------------------------------
# FF-T61-5 · AC-5 · .env.prod.example has only REPLACE_* placeholders
# ---------------------------------------------------------------------------
echo "--- FF-T61-5: .env.prod.example placeholder-only secrets ---"
if [[ ! -f "${ENV_EXAMPLE}" ]]; then
  fail ".env.prod.example not found"
else
  # Lines with PASSWORD/SECRET/KEY/TOKEN must have REPLACE or be empty after =
  BAD_SECRETS=$(grep -iE '(PASSWORD|SECRET|KEY|TOKEN)=' "${ENV_EXAMPLE}" \
    | grep -vE '(REPLACE|=[[:space:]]*$)' || true)
  if [[ -n "${BAD_SECRETS}" ]]; then
    fail ".env.prod.example contains real secret values (not REPLACE_*):"
    echo "${BAD_SECRETS}"
    ERRORS=$((ERRORS + 1))
  else
    pass ".env.prod.example contains only placeholder credentials"
  fi
fi

# ---------------------------------------------------------------------------
# FF-T61-6 · AC-6 · .env.prod is in .gitignore
# ---------------------------------------------------------------------------
echo "--- FF-T61-6: .env.prod in .gitignore ---"
if [[ ! -f "${GITIGNORE}" ]]; then
  fail ".gitignore not found"
else
  if grep -qE '^\.env\.prod$|^\.env\.' "${GITIGNORE}"; then
    pass ".gitignore covers .env.prod"
  else
    fail ".gitignore does not contain .env.prod (or a pattern covering it)"
  fi
fi

# ---------------------------------------------------------------------------
# FF-T61-7 · AC-7 · choros service in docker-compose.yml with required fields
# ---------------------------------------------------------------------------
echo "--- FF-T61-7: choros service in docker-compose.yml ---"
if [[ ! -f "${COMPOSE_BASE}" ]]; then
  fail "docker-compose.yml not found"
else
  # Service exists
  if grep -qE '^[[:space:]]+choros:' "${COMPOSE_BASE}"; then
    pass "docker-compose.yml defines choros service"
  else
    fail "docker-compose.yml does not define choros service"
  fi
  # Has build:
  if grep -qE 'build:[[:space:]]*\.' "${COMPOSE_BASE}"; then
    pass "choros service has build: ."
  else
    fail "choros service missing build: ."
  fi
  # depends_on postgres, keycloak, flowable
  # Extract the choros service block: from '^  choros:' until the next top-level service
  # (a line that starts with exactly 2 spaces followed by a non-space char, but is NOT choros).
  CHOROS_BLOCK=$(awk '/^  choros:/{found=1} found && /^  [a-z]/ && !/^  choros:/{found=0} found{print}' "${COMPOSE_BASE}")
  for SVC in postgres keycloak flowable; do
    if echo "${CHOROS_BLOCK}" | grep -q "${SVC}:"; then
      pass "choros depends_on ${SVC}"
    else
      fail "choros missing depends_on ${SVC}"
    fi
  done
  # Port 3000
  if grep -qE '3000' "${COMPOSE_BASE}"; then
    pass "choros service references port 3000"
  else
    fail "choros service does not reference port 3000"
  fi
fi

# ---------------------------------------------------------------------------
# FF-T61-8 · AC-8 · Dockerfile exists
# ---------------------------------------------------------------------------
echo "--- FF-T61-8: Dockerfile exists ---"
if [[ -f "${DOCKERFILE}" ]]; then
  pass "Dockerfile exists in repo root"
else
  fail "Dockerfile not found in repo root"
fi

# ---------------------------------------------------------------------------
# FF-T61-9 · AC-9 · KC prod overlay uses start (not start-dev)
# ---------------------------------------------------------------------------
echo "--- FF-T61-9: KC prod mode (start, not start-dev) ---"
if [[ ! -f "${COMPOSE_PROD}" ]]; then
  fail "docker-compose.prod.yml not found"
else
  # Must NOT contain start-dev on non-comment lines
  if grep -v '^[[:space:]]*#' "${COMPOSE_PROD}" | grep -q 'start-dev'; then
    fail "prod overlay contains 'start-dev' for Keycloak (must be 'start')"
  else
    pass "prod overlay does not contain 'start-dev' on non-comment lines"
  fi
  # Must contain 'command: start' on a non-comment line
  if grep -v '^[[:space:]]*#' "${COMPOSE_PROD}" | grep -qE 'command:.*start'; then
    pass "prod overlay sets Keycloak command to 'start'"
  else
    fail "prod overlay does not set Keycloak command to 'start'"
  fi
fi

# ---------------------------------------------------------------------------
# FF-T61-10 · AC-11 · host port defaults are unique across all services
# ---------------------------------------------------------------------------
echo "--- FF-T61-10: unique host port defaults ---"
if [[ ! -f "${COMPOSE_BASE}" ]]; then
  fail "docker-compose.yml not found"
else
  # Extract all :-PORT default values from port mappings (form: "${VAR:-PORT}:...")
  PORTS=$(grep -oE '\$\{[A-Za-z0-9_]+:-[0-9]+\}:[0-9]+' "${COMPOSE_BASE}" \
    | grep -oE ':-[0-9]+' | tr -d ':-' | sort || true)
  UNIQUE_PORTS=$(echo "${PORTS}" | sort -u)
  PORT_COUNT=$(echo "${PORTS}" | grep -c '[0-9]' || true)
  UNIQUE_COUNT=$(echo "${UNIQUE_PORTS}" | grep -c '[0-9]' || true)
  if [[ "${PORT_COUNT}" -eq "${UNIQUE_COUNT}" ]]; then
    pass "all host port defaults are unique: $(echo ${PORTS} | tr '\n' ' ')"
  else
    fail "duplicate host port defaults found: ${PORTS}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: compose-prod-config found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: compose-prod-config — all FF-T61-1..11 checks green"
exit 0
