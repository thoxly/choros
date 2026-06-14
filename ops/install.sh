#!/usr/bin/env bash
# ops/install.sh — T-0127 (T-0198 impl) — Choros genesis installer + online self-upgrader.
#
# ONE idempotent, fail-closed, online/linux-amd64 (MVP) bash script. It is a
# WRAPPER over the existing primitives (docker-compose.yml + docker-compose.prod.yml
# + migrations/run.mjs + migration 026 genesis-owner) — NOT a fork. It introduces
# NO second owner-creation path: the genesis owner is seeded ONLY by migration 026,
# run by the existing ops/docker-entrypoint.sh -> migrations/run.mjs BEFORE app start.
#
# Activation is OPTIONAL and is NEVER a kill-switch: an absent / expired / invalid
# key simply means the circuit comes up in AUTONOMOUS mode. The activation status
# is computed entirely in the vendor layer (src/vendor/) and is reported in the
# summary; it never gates bring-up, /health, or any core path.
#
# Phases (ADR §1.A):
#   1. preflight   — docker + `docker compose` v2, free default host ports, free disk
#                    (BEFORE any mutation; on failure exit != 0, nothing brought up)
#   2. config      — generate .env.prod from .env.prod.example with `openssl rand`
#                    secrets ONLY when .env.prod is absent; existing file untouched
#   3. activation  — optional --key <path|value> / CHOROS_ACTIVATION_KEY -> activation.key
#   4. bring-up    — docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
#                    (migrations incl. 026 run by the entrypoint before app start)
#   5. verify      — GET /health == 200 else fail-closed
#   6. self-upgrade— --upgrade (or an existing .env.prod) => docker compose pull + up -d --wait
#   7. summary     — endpoint, first-owner login, version, activation status (active|autonomous)
#
# Re-running is safe: secrets are never regenerated, the genesis seed is never
# duplicated (026 is idempotent), and the verify step is the single source of truth.
#
# MVP scope: online, linux/amd64. Air-gapped (preloaded images) and ARM64 are
# Stage-2, explicitly out of scope (ADR §7).

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the repo root (the script lives in ops/). All compose/config paths are
# resolved relative to it so the installer can be invoked from anywhere.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_BASE="${REPO_ROOT}/docker-compose.yml"
COMPOSE_PROD="${REPO_ROOT}/docker-compose.prod.yml"
ENV_PROD="${REPO_ROOT}/.env.prod"
ENV_EXAMPLE="${REPO_ROOT}/.env.prod.example"
ACTIVATION_DIR="${REPO_ROOT}/config/activation"
ACTIVATION_KEY_FILE="${ACTIVATION_DIR}/activation.key"

# Default host ports the stack binds (must be free before bring-up). Kept in sync
# with docker-compose.yml: Postgres 55432, Keycloak 8180, KC-mgmt 9000,
# Flowable 8082, app 3000.
DEFAULT_PORTS="55432 8180 9000 8082 3000"

# App endpoint for the /health verify + summary.
APP_HOST="${CHOROS_INSTALL_HOST:-localhost}"
APP_PORT="${APP_PORT:-3000}"
HEALTH_URL="http://${APP_HOST}:${APP_PORT}/health"
ENDPOINT="http://${APP_HOST}:${APP_PORT}"

# Modes / inputs.
DO_UPGRADE=0
KEY_INPUT=""

# ---------------------------------------------------------------------------
# Structured failure: print the failing step and exit non-zero (fail-closed,
# no partial false-green). Nothing past preflight has mutated the host yet when
# preflight fails.
# ---------------------------------------------------------------------------
fail_closed() {
  local step="$1"
  local msg="$2"
  echo "" >&2
  echo "INSTALL FAILED [step=${step}]: ${msg}" >&2
  echo "  -> Nothing left in a false-green state; fix the precondition and re-run." >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Choros genesis installer (T-0127)

Usage:
  ops/install.sh [--key <path|value>] [--upgrade] [-h|--help]

Options:
  --key <path|value>  Optional activation key. A filesystem path is read; anything
                      else is treated as the literal wire string. If omitted (and
                      CHOROS_ACTIVATION_KEY is unset) the circuit comes up in
                      AUTONOMOUS mode — this is NOT an error.
  --upgrade           Online self-upgrade: `docker compose pull` then `up -d --wait`.
                      (An existing .env.prod also triggers upgrade semantics.)
  -h, --help          Show this help.

The activation key sells the vendor SERVICE layer (updates + agentic maintenance +
support). It is never a kill-switch: an absent/expired/invalid key only changes the
entitlement verdict on vendor-service calls; the circuit always runs.
USAGE
}

# ---------------------------------------------------------------------------
# Arg parse.
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key)
      [ "$#" -ge 2 ] || fail_closed "args" "--key requires a value (path or wire string)"
      KEY_INPUT="$2"
      shift 2
      ;;
    --key=*)
      KEY_INPUT="${1#--key=}"
      shift
      ;;
    --upgrade)
      DO_UPGRADE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail_closed "args" "unknown argument '$1' (see --help)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Compose helper — ALWAYS the existing base + prod overlay, env-file .env.prod.
# This is the wrapper-not-fork invariant (FF-T127-2): no forked stack.
# ---------------------------------------------------------------------------
compose() {
  docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_PROD}" --env-file "${ENV_PROD}" "$@"
}

# ===========================================================================
# PHASE 1 — PREFLIGHT (before ANY mutation; fail-closed)
# ===========================================================================
preflight() {
  echo "[install] phase 1/7: preflight"

  # 1a. docker present.
  command -v docker >/dev/null 2>&1 \
    || fail_closed "preflight" "'docker' not found on PATH (install Docker Engine first)"

  # 1b. `docker compose` v2 present (the v2 plugin, not the legacy v1 binary).
  docker compose version >/dev/null 2>&1 \
    || fail_closed "preflight" "'docker compose' v2 plugin not available (need Compose v2)"

  # 1c. compose files + env example present (wrapper preconditions).
  [ -f "${COMPOSE_BASE}" ] || fail_closed "preflight" "missing ${COMPOSE_BASE}"
  [ -f "${COMPOSE_PROD}" ] || fail_closed "preflight" "missing ${COMPOSE_PROD}"
  [ -f "${ENV_EXAMPLE}" ]  || fail_closed "preflight" "missing ${ENV_EXAMPLE}"

  # 1d. default host ports free. On a re-run/upgrade the stack itself may own a
  # port — only treat a port as a conflict on a FRESH install (no .env.prod yet).
  if [ ! -f "${ENV_PROD}" ]; then
    for port in ${DEFAULT_PORTS}; do
      if port_in_use "${port}"; then
        fail_closed "preflight" "host port ${port} is already in use (free it or override the *_PORT env)"
      fi
    done
  fi

  # 1e. free disk — require at least ~2 GiB on the repo filesystem.
  local avail_kb
  avail_kb="$(df -Pk "${REPO_ROOT}" | awk 'NR==2 {print $4}')"
  if [ -n "${avail_kb}" ] && [ "${avail_kb}" -lt 2097152 ]; then
    fail_closed "preflight" "insufficient free disk on ${REPO_ROOT} (need >=2 GiB, have ~$((avail_kb / 1024)) MiB)"
  fi

  echo "[install] preflight OK (docker + compose v2, ports, disk)"
}

# Portable "is this TCP port listening?" — tries lsof, then ss, then nc, then
# a bash /dev/tcp probe. Returns 0 if in use.
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN -n -P >/dev/null 2>&1 && return 0 || return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$" && return 0 || return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z localhost "${port}" >/dev/null 2>&1 && return 0 || return 1
  fi
  # Last resort: bash /dev/tcp. Connect success => something is listening.
  if (exec 3<>"/dev/tcp/localhost/${port}") >/dev/null 2>&1; then
    exec 3>&- 2>/dev/null || true
    return 0
  fi
  return 1
}

# ===========================================================================
# PHASE 2 — CONFIG (.env.prod, single required source; never regenerate)
# ===========================================================================
gen_secret() { openssl rand -base64 32 | tr -d '/+=' | cut -c1-40; }
gen_hex()    { openssl rand -hex 32; }

config() {
  echo "[install] phase 2/7: config (.env.prod)"

  if [ -f "${ENV_PROD}" ]; then
    # Existing config is authoritative — NEVER regenerate or overwrite (AC-4).
    echo "[install] .env.prod already present — left untouched (idempotent)"
    return 0
  fi

  command -v openssl >/dev/null 2>&1 \
    || fail_closed "config" "'openssl' not found — needed to generate secrets for a fresh .env.prod"

  echo "[install] .env.prod absent — generating from .env.prod.example with secure random secrets"

  local pg_pw kc_pw fl_pw mask_key
  pg_pw="$(gen_secret)"
  kc_pw="$(gen_secret)"
  fl_pw="$(gen_secret)"
  mask_key="$(gen_hex)"

  # Start from the example, then substitute the REPLACE_WITH_* placeholders.
  # DATABASE_URL is wired with the SAME generated Postgres password (consistency
  # invariant) — the example carries REPLACE_WITH_SECURE_PASSWORD in both the
  # POSTGRES_PASSWORD line and the DATABASE_URL, so we replace per-line.
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2016
  awk -v pg="${pg_pw}" -v kc="${kc_pw}" -v fl="${fl_pw}" -v mask="${mask_key}" '
    /^POSTGRES_PASSWORD=/                  { print "POSTGRES_PASSWORD=" pg; next }
    /^KEYCLOAK_ADMIN_PASSWORD=/            { print "KEYCLOAK_ADMIN_PASSWORD=" kc; next }
    /^FLOWABLE_REST_APP_ADMIN_PASSWORD=/   { print "FLOWABLE_REST_APP_ADMIN_PASSWORD=" fl; next }
    /^DATABASE_URL=/ {
      line=$0
      gsub(/REPLACE_WITH_SECURE_PASSWORD/, pg, line)
      print line; next
    }
    /^CHOROS_MASK_DIGEST_KEY=/             { print "CHOROS_MASK_DIGEST_KEY=" mask; next }
    { print }
  ' "${ENV_EXAMPLE}" > "${tmp}"

  # Fail-closed: if any REPLACE_WITH_* survived, do NOT write a half-filled config.
  if grep -q 'REPLACE_WITH_' "${tmp}"; then
    rm -f "${tmp}"
    fail_closed "config" "unfilled REPLACE_WITH_* placeholder remained — refusing to write a partial .env.prod"
  fi

  mv "${tmp}" "${ENV_PROD}"
  chmod 600 "${ENV_PROD}" 2>/dev/null || true
  echo "[install] .env.prod generated (secrets random, never committed — see .gitignore)"
}

# ===========================================================================
# PHASE 3 — ACTIVATION (optional; absent => autonomous, NOT an error)
# ===========================================================================
activation() {
  echo "[install] phase 3/7: activation key (optional)"

  local key_value=""
  if [ -n "${KEY_INPUT}" ]; then
    if [ -f "${KEY_INPUT}" ]; then
      key_value="$(tr -d '\r' < "${KEY_INPUT}" | tr -d '\n')"
    else
      key_value="${KEY_INPUT}"
    fi
  elif [ -n "${CHOROS_ACTIVATION_KEY:-}" ]; then
    key_value="${CHOROS_ACTIVATION_KEY}"
  fi

  if [ -z "${key_value}" ]; then
    echo "[install] no activation key provided — circuit will come up in AUTONOMOUS mode (F-10)"
    return 0
  fi

  mkdir -p "${ACTIVATION_DIR}"
  printf '%s' "${key_value}" > "${ACTIVATION_KEY_FILE}"
  chmod 600 "${ACTIVATION_KEY_FILE}" 2>/dev/null || true
  echo "[install] activation key written to config/activation/activation.key (gitignored)"
}

# ===========================================================================
# PHASE 4 — BRING-UP (wrapper over the existing compose; migrations via entrypoint)
# ===========================================================================
bring_up() {
  echo "[install] phase 4/7: bring-up (docker compose up -d --wait)"
  # Migrations (incl. 026 genesis-owner) are run by ops/docker-entrypoint.sh ->
  # migrations/run.mjs BEFORE the app starts. The installer adds NO second owner
  # path and runs NO genesis SQL itself.
  compose up -d --wait \
    || fail_closed "bring-up" "docker compose up -d --wait failed (inspect: docker compose ... logs)"
  echo "[install] stack up; healthchecks passed"
}

# ===========================================================================
# PHASE 5 — VERIFY (GET /health == 200 else fail-closed)
# ===========================================================================
verify() {
  echo "[install] phase 5/7: verify (${HEALTH_URL})"
  local code
  code="$(health_status_code)"
  if [ "${code}" != "200" ]; then
    fail_closed "verify" "GET /health returned '${code}' (expected 200) — circuit not healthy"
  fi
  echo "[install] /health == 200"
}

# Return the HTTP status code of GET /health (curl preferred, wget fallback).
health_status_code() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${HEALTH_URL}" 2>/dev/null || echo "000"
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -T 10 -O /dev/null "${HEALTH_URL}" 2>/dev/null; then echo "200"; else echo "000"; fi
  else
    echo "000"
  fi
}

# ===========================================================================
# PHASE 6 — SELF-UPGRADE (online; same script)
# ===========================================================================
self_upgrade() {
  echo "[install] self-upgrade: docker compose pull + up -d --wait (online)"
  compose pull \
    || fail_closed "self-upgrade" "docker compose pull failed (no egress to the image registry?)"
  compose up -d --wait \
    || fail_closed "self-upgrade" "docker compose up -d --wait failed after pull"
  echo "[install] images pulled; stack reconciled; migrations caught up idempotently via entrypoint"
}

# ===========================================================================
# PHASE 7 — SUMMARY (structured: endpoint, first-owner login, version, activation)
# ===========================================================================
image_version() {
  # Best-effort image tag for the app service; falls back to 'unknown'.
  local v
  v="$(compose images app 2>/dev/null | awk 'NR==2 {print $3":"$4}')" || true
  if [ -z "${v}" ] || [ "${v}" = ":" ]; then
    v="${CHOROS_IMAGE_TAG:-unknown}"
  fi
  echo "${v}"
}

# Activation status for the summary is computed by the VENDOR layer only, never
# by core. We shell out to a tiny node one-liner that imports the compiled vendor
# entitlement module; if dist isn't present yet we degrade to 'autonomous'
# (reporting is best-effort and never gates anything).
activation_status() {
  local dist_mod="${REPO_ROOT}/dist/vendor/entitlement.js"
  if [ -f "${dist_mod}" ] && command -v node >/dev/null 2>&1; then
    ( cd "${REPO_ROOT}" && node -e "
        import('./dist/vendor/entitlement.js')
          .then(m => { const s = m.currentActivationStatus(); process.stdout.write(s.state === 'active' ? 'active' : 'autonomous'); })
          .catch(() => process.stdout.write('autonomous'));
      " 2>/dev/null ) || echo "autonomous"
  else
    # No compiled vendor module on the host: a present, non-empty activation.key
    # means an intended-active subscription; otherwise autonomous. The live verdict
    # is always available at GET /vendor/activation inside the running app.
    if [ -s "${ACTIVATION_KEY_FILE}" ]; then echo "active"; else echo "autonomous"; fi
  fi
}

summary() {
  local act_status ver
  act_status="$(activation_status)"
  ver="$(image_version)"

  echo ""
  echo "==================== Choros install complete ===================="
  echo "  endpoint           : ${ENDPOINT}"
  echo "  first-owner login  : sign in as the genesis e-owner (tenant-owner role,"
  echo "                       seeded by migration 026 — no second owner path)"
  echo "  version            : ${ver}"
  echo "  activation status  : ${act_status}    (active | autonomous)"
  echo "================================================================="
  if [ "${act_status}" = "autonomous" ]; then
    echo "  Note: AUTONOMOUS mode — the circuit is fully functional. Vendor services"
    echo "        (updates / agentic-ops / support) require an active activation key."
  fi
}

# ===========================================================================
# MAIN — preflight ALWAYS first, before any mutation.
# ===========================================================================
main() {
  echo "[install] Choros genesis installer (T-0127) — online/linux-amd64 (MVP)"

  preflight

  # Re-run with an existing .env.prod (or explicit --upgrade) => upgrade semantics.
  if [ "${DO_UPGRADE}" -eq 1 ] || [ -f "${ENV_PROD}" ]; then
    config        # no-op on existing config; generates only if somehow absent
    activation
    self_upgrade
    verify
    summary
    echo "[install] upgrade path complete (exit 0)"
    exit 0
  fi

  # Fresh install.
  config
  activation
  bring_up
  verify
  summary
  echo "[install] genesis install complete (exit 0)"
}

main "$@"
