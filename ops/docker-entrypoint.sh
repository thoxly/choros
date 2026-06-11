#!/bin/sh
# Choros container entrypoint (T-0061, E0.6 — ADR §1.3 silo-upgrade semantics)
#
# Runs pending migrations BEFORE starting the application server.
# On migration failure: logs a clear message and exits non-zero (container fails,
# compose/orchestrator can inspect logs — silo-upgrade-by-design).
#
# Usage (Dockerfile CMD):
#   ENTRYPOINT ["/app/ops/docker-entrypoint.sh"]
#   CMD ["node", "dist/index.js"]
#
# Any arguments passed to the container replace the default CMD; the script
# always exec's into them so PID 1 is the application process (signal safety).

set -e

if [ -n "${DATABASE_URL}" ]; then
  echo "entrypoint: DATABASE_URL set — running migrations before start"
  if ! node /app/migrations/run.mjs; then
    echo "entrypoint: FATAL — migrations failed; refusing to start application"
    exit 1
  fi
  echo "entrypoint: migrations complete"
else
  echo "entrypoint: DATABASE_URL not set — skipping migrations (dev/test mode)"
fi

exec "$@"
