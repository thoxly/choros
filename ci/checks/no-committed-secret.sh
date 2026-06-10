#!/usr/bin/env bash
# FF-1 (static half, AC-1 / RL-1 / NF-5): no committed prod secret.
#
# Asserts docker-compose.yml supplies every connection parameter via env with a
# ${VAR:-dev_default} form (no bare literal credential), and that no real-looking
# secret is committed in compose or migrations. Dev defaults (choros_dev_pw,
# choros_app_dev_pw) are explicitly allowed; anything else under a password key
# is treated as a leak.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE="${ROOT}/docker-compose.yml"
ERRORS=0

echo "[FF-1] no-committed-secret: checking compose uses env defaults, no leaked secret"

if [[ ! -f "${COMPOSE}" ]]; then
  echo "FAIL: ${COMPOSE} not found"
  exit 1
fi

# Allowed dev-default tokens (the only credential literals permitted in-repo).
# choros_kc_dev_pw added by T-0054 (KEYCLOAK_ADMIN_PASSWORD dev default).
ALLOWED_DEV_DEFAULTS='choros_dev_pw|choros_app_dev_pw|choros_kc_dev_pw'

# ---- Check 1: POSTGRES_PASSWORD is env-driven with a dev default -----------
if grep -Eq 'POSTGRES_PASSWORD:[[:space:]]*\$\{POSTGRES_PASSWORD:-[A-Za-z0-9_]+\}' "${COMPOSE}"; then
  echo "PASS: POSTGRES_PASSWORD uses \${POSTGRES_PASSWORD:-dev_default} form"
else
  echo "FAIL: POSTGRES_PASSWORD is not in \${VAR:-dev_default} env form"
  ERRORS=$((ERRORS + 1))
fi

# ---- Check 2: every password literal in compose is an allowed dev default --
# Extract any default value after :- on a *PASSWORD line; flag unexpected ones.
while IFS= read -r line; do
  dflt=$(printf '%s' "${line}" | sed -nE 's/.*PASSWORD:[[:space:]]*\$\{[A-Za-z0-9_]+:-([A-Za-z0-9_]+)\}.*/\1/p')
  if [[ -n "${dflt}" ]] && ! [[ "${dflt}" =~ ^(${ALLOWED_DEV_DEFAULTS})$ ]]; then
    echo "FAIL: unexpected password default literal in compose: '${dflt}'"
    ERRORS=$((ERRORS + 1))
  fi
done < <(grep -iE 'PASSWORD' "${COMPOSE}" || true)

# ---- Check 3: migrations only ever set the allowed dev-default password ----
# Any PASSWORD '...' literal in a migration must be an allowed dev default or the
# ${...} env placeholder the runner expands.
BAD_MIG_PW=$(grep -rniE "PASSWORD[[:space:]]+'[^']*'" "${ROOT}/migrations" 2>/dev/null \
  | grep -vE "PASSWORD[[:space:]]+'\\\$\{[A-Za-z0-9_]+:-(${ALLOWED_DEV_DEFAULTS})\}'" \
  || true)
if [[ -n "${BAD_MIG_PW}" ]]; then
  echo "FAIL: migration sets a non-dev-default password literal:"
  echo "${BAD_MIG_PW}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: migrations carry only the dev-default password placeholder"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: no-committed-secret found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: no-committed-secret — all checks green"
exit 0
