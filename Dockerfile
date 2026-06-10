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
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: app builder (TypeScript → dist/)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS app-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: runtime (node:20-slim — lean production base)
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app

# Application JS
COPY --from=app-builder /app/dist ./dist/
COPY --from=app-builder /app/package*.json ./

# Web static assets served by src/http/static.ts
COPY --from=web-builder /app/web/dist ./web/dist/

# Migrations run at app startup (silo-upgrade semantics, tenancy ADR §5).
# server.ts calls migrations/run.mjs when DATABASE_URL is set.
COPY migrations/ ./migrations/

# Production-only deps
RUN npm ci --omit=dev

EXPOSE 3000

CMD ["node", "dist/index.js"]
