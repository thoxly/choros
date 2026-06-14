#!/usr/bin/env bash
# T-0153 · Enemy Arena — one-shot SEALED bring-up (эпик E-VRG / T-0151 «Враг»)
#
# spec: playbooks/enemy-redteam-backlog.md §5 (репо Demiurge). Stands up an
# ISOLATED, SEALED snapshot of the dev stack for the Враг to attack the invariants
# in docs/design/T-0152-security-invariants-catalog.md. This is the arena ONLY —
# the attacks themselves are the deterministic Враг + corpus (T-0154, downstream).
#
# SEALING (see docker-compose.arena.yml header for the full rationale):
#   * separate compose project (-p choros-arena) + _arena volume — never touches dev
#   * no outbound network — arena_internal is `internal: true`
#   * no real creds — only arena_fake_* placeholders; --env-file /dev/null so no
#     host .env / .env.prod leaks in
#   * ≥2 tenants — seeded from ops/arena/arena-tenants.txt via the public seed API
#   * fake-founder — dev genesis e-owner (migration 026); no founder-trust-root
#
# Usage:  bash ops/arena/arena-up.sh         # bring up + seed
#         bash ops/arena/arena-down.sh        # tear down (-v), leave no state
#
# EXIT: 0 on a fully-up, fully-seeded arena; non-zero (fail-closed) otherwise.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT="choros-arena"
BASE="docker-compose.yml"
ARENA="docker-compose.arena.yml"
TENANTS_FILE="ops/arena/arena-tenants.txt"
APP_PORT="${ARENA_APP_PORT:-3001}"
# Fake-founder principal — dev genesis e-owner, NOT the real founder, NO trust-root.
FAKE_FOUNDER="e-owner"

# --env-file /dev/null: the arena reads NO host .env/.env.prod — sealed from real creds.
compose() {
  docker compose -p "$PROJECT" --env-file /dev/null -f "$BASE" -f "$ARENA" "$@"
}

echo "[T-0153] arena-up: bringing up SEALED arena (project=$PROJECT, fake-founder=$FAKE_FOUNDER)"

# Fail-closed preflight: arena compose must be valid and sealed BEFORE we touch Docker.
docker compose --env-file /dev/null -f "$BASE" -f "$ARENA" config >/dev/null \
  || { echo "[T-0153] FATAL: arena compose config invalid — refusing to bring up"; exit 1; }

compose up -d --wait \
  || { echo "[T-0153] FATAL: arena stack failed to become healthy"; compose logs --tail 50 || true; exit 1; }

# ---------------------------------------------------------------------------
# Seed ≥2 isolated tenants via the PUBLIC seed API (no direct DB writes), each
# under the fake-founder. Reads the tenant registry (anti-hardcode).
# ---------------------------------------------------------------------------
mapfile -t TENANTS < <(grep -vE '^[[:space:]]*(#|$)' "$TENANTS_FILE")
if [ "${#TENANTS[@]}" -lt 2 ]; then
  echo "[T-0153] FATAL: arena requires ≥2 tenants for isolation probing; $TENANTS_FILE has ${#TENANTS[@]}"
  exit 1
fi

for slug in "${TENANTS[@]}"; do
  echo "[T-0153] seeding arena tenant '$slug' (showcase pack, fake-founder=$FAKE_FOUNDER)"
  node "$REPO_ROOT/seed/cli.js" apply \
    --tenant "$slug" \
    --pack showcase \
    --base-url "http://127.0.0.1:${APP_PORT}" \
    --dev-user "$FAKE_FOUNDER" \
    || { echo "[T-0153] FATAL: seeding tenant '$slug' failed"; exit 1; }
done

echo "[T-0153] arena-up: SEALED arena ready — ${#TENANTS[@]} tenants, no egress, fake-founder, no real creds."
echo "[T-0153] app=http://127.0.0.1:${APP_PORT}  (tear down with: bash ops/arena/arena-down.sh)"
