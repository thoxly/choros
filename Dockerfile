# Choros multi-stage Dockerfile (T-0061, E0.6)
#
# Three stages:
#   web-builder  — builds the React/Vite frontend (web/dist/)
#   app-builder  — compiles TypeScript to dist/
#   runtime      — slim Node.js image with dist/, web/dist/, migrations/
#
# Dev and prod use the SAME image; differences are env vars only
# (NODE_ENV, CHOROS_AUTH_MODE, DATABASE_URL, etc.).
#
# EXPOSE 3000 — host-port mapping is in docker-compose.yml (APP_PORT).

# ---------------------------------------------------------------------------
# Stage 1: web frontend
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
# Retry transient network failures (host npmjs resolution flakes over IPv6 — T-0502).
RUN for a in 1 2 3 4 5 6; do NODE_OPTIONS=--dns-result-order=ipv4first npm ci --maxsockets=3 --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000 && exit 0; echo "npm ci attempt $a failed; retry in 12s"; sleep 12; done; exit 1
COPY web/ ./
# Shared pure-core modules the web bundle imports directly (single-source: UI==server,
# BUG-016). web/src/screens/{apps-schema,records-form}.js import ../../../src/core/formula-*.ts;
# the web-builder stage is otherwise isolated to web/, so those specifiers would not resolve
# (D-056 integration honesty — this stage must mirror what the full-tree local build sees).
# src/core is a self-contained, zero-dep cluster (verified: web bundles it standalone), so
# copying it in does not drag server-only code into the browser bundle.
COPY src/core/ /app/src/core/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: app builder (TypeScript → dist/)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS app-builder
WORKDIR /app
COPY package*.json ./
# Retry transient network failures (host npmjs resolution flakes over IPv6 — T-0502).
RUN for a in 1 2 3 4 5 6; do NODE_OPTIONS=--dns-result-order=ipv4first npm ci --maxsockets=3 --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000 && exit 0; echo "npm ci attempt $a failed; retry in 12s"; sleep 12; done; exit 1
COPY src/ ./src/
COPY tsconfig.json ./
# seed/ участвует в npm run build (tsc --project seed/tsconfig.json, T-0140)
COPY seed/ ./seed/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: runtime (node:22-slim — lean production base)
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

# Application JS
COPY --from=app-builder /app/dist ./dist/
COPY --from=app-builder /app/package*.json ./

# Web static assets served by src/http/static.ts
COPY --from=web-builder /app/web/dist ./web/dist/

# Migrations run at container start via entrypoint (silo-upgrade semantics, ADR §1.3).
# entrypoint: node migrations/run.mjs && exec node dist/index.js
# On migration failure → container exits non-zero (intentional: silo-upgrade-by-design).
COPY migrations/ ./migrations/

# Container entrypoint (runs migrations before app start)
COPY ops/docker-entrypoint.sh ./ops/docker-entrypoint.sh
RUN chmod +x /app/ops/docker-entrypoint.sh

# Production-only deps (retry transient IPv6 npmjs flakes — T-0502).
RUN for a in 1 2 3 4 5 6; do NODE_OPTIONS=--dns-result-order=ipv4first npm ci --maxsockets=3 --omit=dev --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000 && exit 0; echo "npm ci attempt $a failed; retry in 12s"; sleep 12; done; exit 1

EXPOSE 3000

ENTRYPOINT ["/app/ops/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
