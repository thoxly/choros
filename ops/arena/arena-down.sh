#!/usr/bin/env bash
# T-0153 · Enemy Arena — one-shot SEALED teardown (эпик E-VRG / T-0151 «Враг»)
#
# Tears the arena DOWN and removes its named volume so NO persistent state
# survives a run (spec §5 «одноразовый запечатанный снапшот» — single-use,
# sealed, ephemeral). Idempotent: safe to run when nothing is up.
#
# `down -v` removes the choros_pgdata_arena volume but, because the arena runs
# under its own project (-p choros-arena), it CANNOT touch the dev project's
# choros_pgdata or any other stack.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT="choros-arena"

echo "[T-0153] arena-down: tearing down SEALED arena (project=$PROJECT, removing volumes)"
docker compose -p "$PROJECT" --env-file /dev/null \
  -f docker-compose.yml -f docker-compose.arena.yml down -v --remove-orphans \
  || { echo "[T-0153] arena-down: teardown reported an error (continuing)"; }

echo "[T-0153] arena-down: arena removed — no persistent state left."
