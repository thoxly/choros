# ADR · T-0061 — dev + prod docker-compose стеки (choros-app сервис + Dockerfile)

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-06-11
**Task:** E0.6 — docker-compose: dev + prod стеки (choros-app сервис + Dockerfile + prod override +
`.env.prod.example` + CI fitness).
**Spec (input):** `docs/specs/T-0061-dev-prod-stacks.spec.md` (status: ready; FR-1..FR-6, NF-1..NF-7,
AC-1..AC-13; no blocking questions).

**Authoritative sources (consumed, NOT re-decided):**
- `docs/design/tenancy-and-delivery.md` §7 — один артефакт; режим = конфигурация; docker-compose обёртка silo/on-prem поставки.
- `docs/environments.md` §2–§4 — dev vs prod = два независимых compose-стека; dev non-prod данные/креды; prod только фаундер (RL-1).
- `docs/design/T-0054-keycloak-compose.adr.md` §7 seam — «A unified single-command compose including the app server is E0.6 scope».
- Sister tasks `T-0053` (postgres), `T-0054` (keycloak), `T-0058` (flowable) — все три сервиса уже в `docker-compose.yml`; T-0061 additive.

> **This ADR designs the compose topology and Dockerfile shape; it does not write production code.**
> `coder` reads §3–§6 as the source of truth for every file to create/modify.
> `src/` files are NOT touched.

---

## 1. Decision

Deliver Choros E0.6 as **(a) one `choros` service block added to the repo-root `docker-compose.yml`**,
built from a **multi-stage Dockerfile** in the repo root; all env variables supplied with
**dev-only defaults** (no prod secret committed, RL-3); `depends_on` on
`postgres: condition: service_healthy`, `keycloak: condition: service_healthy`,
`flowable: condition: service_healthy`; host port `${APP_PORT:-3000}:3000` (no collision with
55432/8180/9000/8082); **(b) a `docker-compose.prod.yml` override** that requires all sensitive
variables in **required-form** (`${VAR}` without `:-default`, so compose fails on unset var),
switches Keycloak to `start` (prod mode), sets `NODE_ENV=production`, renames volumes with
`_prod` suffix; **(c) `.env.prod.example`** committed in repo with placeholder-only values and
copy-and-fill instructions; **(d) `.gitignore`** extended with `.env.prod`; **(e) CI fitness
script `ci/checks/compose-prod-config.sh`** running `docker compose config -q` on both modes and
static grep/yaml checks for all AC-3..AC-9.

The mechanism is **override-files** (not profiles, not separate `docker-compose.dev.yml`):
- `docker compose up` → dev stack (base file only, all dev defaults).
- `docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up` → prod stack.
This is the Docker Compose standard pattern for a single artifact with mode-as-config (ratified
tenancy ADR §7). No runtime component beyond Docker Compose is introduced.

### 1.1 Multi-stage Dockerfile

The Dockerfile has two stages:

1. **`builder`** (`node:20-alpine`): `WORKDIR /app`, `COPY package*.json .`, `RUN npm ci`,
   `COPY . .`, `RUN npm run build` (runs `tsc`, output to `dist/`). The web frontend is
   pre-built via a prior `npm --prefix web run build` step or a separate stage — see §1.2.
2. **`runtime`** (`node:20-slim`): copies `dist/`, `package*.json`, `web/dist/` (static assets
   served by `src/http/static.ts`); runs `npm ci --omit=dev`; `EXPOSE 3000`; `CMD ["node", "dist/index.js"]`.

Dev and prod use **the same image** — differences are env vars only (`NODE_ENV`, `CHOROS_AUTH_MODE`, etc.).

**`.dockerignore`** must exclude `node_modules/`, `dist/` (rebuilt inside), `.env*`, `.git/`,
`ci/`, `docs/`, `spikes/`, `migrations/` (migrations run via separate step or entrypoint, not
baked in — see §1.3).

### 1.2 Web frontend build inside Dockerfile

`src/http/static.ts` serves `web/dist/` as static assets. The Dockerfile must produce that directory.
Two sub-options:
- **Option A (one extra builder stage, preferred)**: add a `web-builder` stage (`node:20-alpine`,
  `WORKDIR /app/web`, `npm ci`, `npm run build`) before the `app-builder` stage; `runtime` copies
  `--from=web-builder /app/web/dist ./web/dist`.
- **Option B (pre-built)**: CI pre-builds web before `docker build`, the context contains `web/dist/`.

ADR chooses **Option A** (multi-stage, fully self-contained build): removes build-order dependency
from caller, satisfies AC-8 (`docker build .` exits 0 without pre-steps), aligns with NF-5
(unattended). `web/` source is in build context (`.dockerignore` does NOT exclude `web/src/`).

### 1.3 Migrations in entrypoint — silo-upgrade semantics

The spec is explicit: migrations run at app startup, not in a separate compose step.
`server.ts` conditionally runs migrations before opening the HTTP port when `DATABASE_URL` is set.
This is the **silo-upgrade semantics** from `tenancy-and-delivery.md §5`: a silo deploy upgrades
schema in-process before serving traffic; no external migration step or init-container.
The `choros` service CMD (`node dist/index.js`) starts `createServer()` which triggers migrations.
**T-0061 does NOT modify `src/` or migration code** — the runner already exists (`migrations/run.mjs`
called from `server.ts` via `DATABASE_URL`). The compose service provides `DATABASE_URL`; the
existing code path is sufficient.

### 1.4 Keycloak prod-mode gap (KC start vs start-dev)

`start-dev` is Keycloak's all-in-one dev mode: no TLS enforcement, relaxed hostname checks,
embedded H2 default. `start` (prod mode) requires:
- `KC_HOSTNAME` or `KC_HOSTNAME_URL` set (or `KC_HOSTNAME_STRICT=false` — acceptable for single-server).
- `KC_HTTP_ENABLED=true` still needed on single-server before Caddy/nginx (E0.7 reverse-proxy is
  out-of-scope for T-0061).
- `KC_DB*` vars in required-form.
- `KC_PROXY=edge` if behind a reverse proxy (deferred to E0.7).

**Gap честно зафиксирован**: T-0061 switches the Keycloak command to `start` in the prod override
and provides `KC_HOSTNAME_STRICT=false` + `KC_HTTP_ENABLED=true` (same as dev-override values but
now required-form creds). Full KC hardening (TLS, `KC_PROXY=edge`, proper `KC_HOSTNAME_URL`)
is **deferred to E0.7 (home-server provisioning, founder-gated)**. The prod override does
the minimum for KC to start in production mode on a single-server without TLS termination.

---

## 2. Rejected Alternatives

| Option | Why not |
|---|---|
| `docker compose --profile prod` (profiles) | Same file, but profile syntax is less visible than a dedicated override file; the "two-file merge" model is the documented standard for dev/prod parity; profiles add a runtime flag but don't force required-form vars naturally. The override-file pattern is already the precedent set by official KC/Postgres docs. |
| Separate `docker-compose.dev.yml` + `docker-compose.prod.yml` (no base) | Requires duplicating all three existing service blocks (postgres/kc/flowable) into both files; violates DRY and makes future additive changes (new service) require two edits; the base+override model keeps each service edited once. |
| Bake Dockerfile into two images (`Dockerfile.dev`, `Dockerfile.prod`) | Contradicts "one artifact, mode=config" (tenancy ADR §7); doubles Dockerfile maintenance; same image with different env vars is cleaner and standard. |
| External migration step / init-container | Adds compose orchestration complexity (init containers in Compose require `condition: service_completed_successfully` hacks or a wrapper script); T-0053's runner already runs via `DATABASE_URL` in-process; the silo-upgrade semantic (§5 of tenancy ADR) maps directly to "migrate then serve". |
| H2 for KC internal store in dev + Postgres in prod | KC uses the shared Postgres in dev (T-0054 §1.1); switching to H2 for dev violates the "same substrate, mode=config" principle and would require a second KC store-mode override in the prod file; already decided in T-0054. |
| `--env-file` as the required-form mechanism (no `:-default` in base file) | The base file MUST have dev defaults for `docker compose up` to work without any `.env`; the override file then overrides those with `${VAR}` (no default) — compose merges the two, the override wins. This is correct standard behaviour. Option of removing defaults from the base file would break AC-1 (dev compose without env file). |

---

## 3. Object Model / File Set

### 3.1 Files created/modified by this task

| File | Action | Owner (rule) |
|---|---|---|
| `docker-compose.yml` | **ADD** `choros` service block (additive; existing postgres/kc/flowable untouched) + `choros_app_data` named volume entry if needed | coder |
| `Dockerfile` | **CREATE** (multi-stage: web-builder → app-builder → runtime) | coder |
| `.dockerignore` | **CREATE** | coder |
| `docker-compose.prod.yml` | **CREATE** (override: required-form creds, `_prod` volumes, KC start mode, NODE_ENV=production) | coder |
| `.env.prod.example` | **CREATE** (placeholder values only, RL-3) | coder |
| `.gitignore` | **EXTEND** (add `.env.prod` and `.env.*.local` if absent) | coder |
| `docs/environments.md` | **EXTEND** §3 — add choros-app env vars table (§7 new section) | coder |
| `ci/checks/compose-prod-config.sh` | **CREATE** (fitness: compose config -q both modes + static checks AC-3..AC-9) | coder |

### 3.2 `choros` service block in `docker-compose.yml` (contracts for coder)

```yaml
choros:
  build: .
  environment:
    DATABASE_URL:       ${DATABASE_URL:-postgres://choros_migrator:choros_dev_pw@postgres:5432/choros}
    CHOROS_AUTH_MODE:   ${CHOROS_AUTH_MODE:-dev}
    KEYCLOAK_PORT:      ${KEYCLOAK_PORT:-8180}
    KEYCLOAK_REALM:     ${KEYCLOAK_REALM:-choros}
    KC_ISSUER:          ${KC_ISSUER:-http://keycloak:8180/realms/choros}
    NODE_ENV:           ${NODE_ENV:-development}
    PORT:               ${PORT:-3000}
  ports:
    - "${APP_PORT:-3000}:3000"
  depends_on:
    postgres:
      condition: service_healthy
    keycloak:
      condition: service_healthy
    flowable:
      condition: service_healthy
  healthcheck:
    test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost:${PORT:-3000}/health || exit 1"]
    interval: 5s
    timeout: 5s
    retries: 24
    start_period: 30s
```

Note: `DATABASE_URL` internal host is `postgres` (compose service name), NOT `localhost`.
`KC_ISSUER` may or may not be consumed by T-0060 — the env var is provided as a seam.
`index.ts` reads `PORT ?? 8080` — the compose env overrides this to `3000`.

### 3.3 `docker-compose.prod.yml` (override contract)

```yaml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}      # required — no default
      POSTGRES_USER:     ${POSTGRES_USER}           # required
      POSTGRES_DB:       ${POSTGRES_DB}             # required

  keycloak:
    command: start --import-realm
    environment:
      KEYCLOAK_ADMIN:          ${KEYCLOAK_ADMIN}           # required
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}  # required
      KC_DB_PASSWORD:          ${POSTGRES_PASSWORD}        # required (same as postgres)
      KC_DB_USERNAME:          ${POSTGRES_USER}            # required
      KC_HOSTNAME_STRICT:      "false"                     # prod single-server: relaxed (E0.7 gap)
      KC_HTTP_ENABLED:         "true"                      # HTTP until TLS/proxy in E0.7
    # Full TLS / KC_PROXY=edge deferred to E0.7

  flowable:
    environment:
      SPRING_DATASOURCE_PASSWORD:       ${POSTGRES_PASSWORD}                    # required
      SPRING_DATASOURCE_USERNAME:       ${POSTGRES_USER}                        # required
      FLOWABLE_REST_APP_ADMIN_PASSWORD: ${FLOWABLE_REST_APP_ADMIN_PASSWORD}     # required

  choros:
    environment:
      DATABASE_URL:     ${DATABASE_URL}       # required
      CHOROS_AUTH_MODE: ${CHOROS_AUTH_MODE}   # required (expected: keycloak)
      NODE_ENV:         production
      PORT:             ${PORT}               # required

volumes:
  choros_pgdata_prod: {}     # physically isolated from choros_pgdata (dev)
  # keycloak and flowable volumes use _prod suffix analogously
```

**Key invariant**: every `${VAR}` in `docker-compose.prod.yml` must have NO `:-default`. Compose
merges base + override; the override wins. If `POSTGRES_PASSWORD` is unset in the environment,
compose aborts with an error. This is the RL-3 / AC-3 guarantee.

### 3.4 `.env.prod.example` structure

```
# Choros prod env — copy to .env.prod and replace ALL REPLACE_* placeholders
# .env.prod is in .gitignore — NEVER commit it (RL-3)

POSTGRES_DB=choros
POSTGRES_USER=choros_migrator
POSTGRES_PASSWORD=REPLACE_WITH_SECURE_PASSWORD

KEYCLOAK_ADMIN=choros_kc_admin
KEYCLOAK_ADMIN_PASSWORD=REPLACE_WITH_SECURE_PASSWORD

FLOWABLE_REST_APP_ADMIN_PASSWORD=REPLACE_WITH_SECURE_PASSWORD

DATABASE_URL=postgres://choros_migrator:REPLACE_WITH_SECURE_PASSWORD@postgres:5432/choros
CHOROS_AUTH_MODE=keycloak
PORT=3000
APP_PORT=3000
```

Every sensitive value matches pattern `REPLACE_*` (contains "REPLACE") — satisfies AC-5 grep check.

### 3.5 Dockerfile stages (contract for coder)

```
# Stage 1: web frontend
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build          # outputs web/dist/

# Stage 2: app builder
FROM node:20-alpine AS app-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build          # tsc → dist/

# Stage 3: runtime
FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=app-builder /app/dist ./dist/
COPY --from=app-builder /app/package*.json ./
COPY --from=web-builder /app/web/dist ./web/dist/
RUN npm ci --omit=dev
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Note: `migrations/` is NOT copied into the image. Migrations run from the host/volume or via a
separate compose `migrate` service (out of scope for T-0061). If `DATABASE_URL` is set inside the
container, `server.ts` runs `migrations/run.mjs` — but `migrations/` must be in the image for
this to work. **coder decision**: either COPY migrations/ in runtime stage, or treat migration
as a separate step. Since `server.ts` imports the runner at startup (silo-upgrade semantic), the
`migrations/` directory and `run.mjs` must be present in the image. The coder MUST include:
`COPY migrations/ ./migrations/` in the runtime stage (or app-builder stage).

### 3.6 `.dockerignore` essentials (contract for coder)

Must exclude (to keep image lean and avoid secrets bake-in):
```
node_modules
dist
.env*
.git
ci
docs
spikes
.claude
web/node_modules
```

Must NOT exclude `web/src/` or `web/package*.json` (needed by web-builder stage).

---

## 4. Fitness Functions

### FF-T61-1 · Dev compose config parses (AC-1)
**Rule**: `docker compose -f docker-compose.yml config -q` exits 0 without any additional env file.
**CI check**: `ci/checks/compose-prod-config.sh` step 1 — `docker compose -f docker-compose.yml config -q`; exit non-zero fails CI. Static check (no Docker daemon needed if compose handles interpolation without daemon).

### FF-T61-2 · Prod compose config parses with placeholders (AC-2)
**Rule**: `docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q` exits 0 when all required vars are provided via `--env-file .env.prod.example` (after sed-replacing `REPLACE_*` with dummy values).
**CI check**: `ci/checks/compose-prod-config.sh` step 2 — create temp env file with `REPLACE_*` values substituted for real dummy strings; `docker compose ... --env-file $tmp config -q`; exit non-zero fails CI.

### FF-T61-3 · No default-form creds in prod overlay (AC-3)
**Rule**: `docker-compose.prod.yml` must NOT contain `${VAR:-...}` form for any PASSWORD, SECRET, KEY, TOKEN variable.
**CI check**: `ci/checks/compose-prod-config.sh` — `grep -E 'PASSWORD|SECRET|TOKEN|KEY' docker-compose.prod.yml | grep ':-'`; if any match → FAIL. Zero matches → PASS.

### FF-T61-4 · Prod volumes have `_prod` suffix, no dev-named volumes (AC-4)
**Rule**: `docker-compose.prod.yml` must declare at least one volume with `_prod` suffix. Must NOT reference `choros_pgdata:` without `_prod` suffix.
**CI check**: `ci/checks/compose-prod-config.sh` — `grep 'choros_pgdata:' docker-compose.prod.yml | grep -v _prod`; if match → FAIL. `grep 'choros_pgdata_prod' docker-compose.prod.yml`; if absent → FAIL.

### FF-T61-5 · `.env.prod.example` has only placeholder credentials (AC-5)
**Rule**: `.env.prod.example` must exist. Every line matching `PASSWORD|SECRET|KEY|TOKEN` must have value containing `REPLACE` or be empty.
**CI check**: `ci/checks/compose-prod-config.sh` — `grep -iE '(PASSWORD|SECRET|KEY|TOKEN)=' .env.prod.example | grep -vE '(REPLACE|^[^=]+=\s*$)'`; if match → FAIL. Absence of file → FAIL.

### FF-T61-6 · `.env.prod` is gitignored (AC-6)
**Rule**: `.gitignore` contains `.env.prod` (or a glob covering it).
**CI check**: `ci/checks/compose-prod-config.sh` — `grep -E '^\.env\.prod$|^\.env\.' .gitignore`; no match → FAIL.

### FF-T61-7 · `choros` service present in dev compose with required fields (AC-7)
**Rule**: `docker-compose.yml` has a `choros:` service with `build:`, `depends_on:` keys (postgres, keycloak, flowable), port mapping containing `3000`.
**CI check**: `ci/checks/compose-prod-config.sh` — Python/grep YAML parse: assert `services.choros` exists, has `build`, has `depends_on` with postgres/keycloak/flowable, has port `3000`.

### FF-T61-8 · Dockerfile exists and image builds (AC-8)
**Rule**: `Dockerfile` exists in repo root. `docker build -t choros-ci-test .` exits 0.
**CI check**: `ci/checks/compose-prod-config.sh` (static part) or separate CI step — existence check is static; full `docker build` is a CI job step (gated by CI build time: under 10 min on a clean runner with layer caching). **coder** adds `docker build -t choros-ci-test .` step to `.github/workflows/ci.yml`. Static check in compose-prod-config.sh: `[[ -f Dockerfile ]] || { echo FAIL; exit 1; }`.

### FF-T61-9 · KC prod mode in overlay (AC-9)
**Rule**: `docker-compose.prod.yml` must NOT contain `start-dev`; must contain `start` (without `-dev`) for keycloak command.
**CI check**: `ci/checks/compose-prod-config.sh` — `grep 'start-dev' docker-compose.prod.yml | grep -i keycloak`; if match → FAIL. `grep 'command:.*start' docker-compose.prod.yml`; if absent → FAIL.

### FF-T61-10 · Host port uniqueness across all services (AC-11)
**Rule**: All host port values in `docker-compose.yml` are distinct (no two services bind the same host port default).
**CI check**: `ci/checks/compose-prod-config.sh` — extract all `:-<port>` default values from port mappings; assert set of ports is unique. Known expected defaults: `55432`, `8180`, `9000`, `8082`, `3000`.

### FF-T61-11 · no-committed-secret.sh passes on new files (AC-12)
**Rule**: `ci/checks/no-committed-secret.sh` continues to exit 0 after adding `docker-compose.prod.yml` and `.env.prod.example`.
**CI check**: `npm run fitness` (already includes `no-committed-secret.sh`). **coder** must ensure no new password literal (outside the known `ALLOWED_DEV_DEFAULTS` set) appears in `docker-compose.yml` — new `choros` service uses `:-choros_dev_pw` (already allowed) for DATABASE_URL inline credential. For clarity and to avoid unexpected grep matches, DATABASE_URL default should embed the known dev password only.

### FF-T61-12 · Dev full stack healthy (AC-13, integration)
**Rule**: `docker compose up -d && docker compose ps` shows all 4 services (postgres, keycloak, flowable, choros) healthy/running.
**CI check**: CI integration job (`.github/workflows/ci.yml`): `docker compose up -d --wait`, then `docker compose ps --format json | jq` assert all 4 services healthy. This extends the existing integration job that already does `docker compose up` for KC/flowable smokes — adds choros service. **Build time gate**: if building the image in CI adds >5 min, the coder may gate AC-13 as a manual/smoke check documented in `docs/environments.md`; the static checks (FF-T61-1..FF-T61-11) remain CI-gated without Docker daemon.

---

## 5. Traceability (AC → Design)

| AC | Covered by |
|---|---|
| AC-1 · dev config -q exits 0 | §3.2 `choros` service block with dev defaults; FF-T61-1 |
| AC-2 · prod config -q exits 0 with placeholders | §3.3 prod overlay; §3.4 `.env.prod.example`; FF-T61-2 |
| AC-3 · required-form creds in prod overlay | §3.3 contract (no `:-`); FF-T61-3 |
| AC-4 · prod volumes `_prod` suffix | §3.3 volumes; FF-T61-4 |
| AC-5 · `.env.prod.example` no real secrets | §3.4 structure; FF-T61-5 |
| AC-6 · `.env.prod` in `.gitignore` | §3.1 file set (.gitignore extend); FF-T61-6 |
| AC-7 · choros service in docker-compose.yml | §3.2 service block; FF-T61-7 |
| AC-8 · Dockerfile exists + builds | §1.1/1.2/3.5 Dockerfile multi-stage; FF-T61-8 |
| AC-9 · KC prod mode in overlay | §1.4 gap; §3.3 command override; FF-T61-9 |
| AC-10 · existing KC + flowable smokes pass | §3.2 additive (no destructive change to existing blocks); existing CI smokes unchanged |
| AC-11 · port uniqueness | §3.2 port `3000` (unique vs 55432/8180/9000/8082); FF-T61-10 |
| AC-12 · no-committed-secret.sh passes | §3.3 required-form only; §3.4 placeholders; FF-T61-11 |
| AC-13 · full stack healthy | §3.2 depends_on + healthcheck; FF-T61-12 |

---

## 6. Contracts Summary (for coder/tester)

1. **`docker-compose.yml` choros block**: `build: .`, env with dev defaults, `depends_on` postgres+keycloak+flowable (condition: service_healthy), port `${APP_PORT:-3000}:3000`, healthcheck on `/health` or TCP.
2. **`docker-compose.prod.yml`**: every sensitive var in `${VAR}` form (no `:-`); `keycloak.command: start --import-realm`; volumes with `_prod` suffix; `NODE_ENV: production` for choros.
3. **`Dockerfile`**: 3 stages (web-builder, app-builder, runtime); `EXPOSE 3000`; `CMD ["node","dist/index.js"]`; `migrations/` included in runtime stage; no `.env*` copied.
4. **`.env.prod.example`**: all sensitive defaults contain `REPLACE`; committed to repo.
5. **`.gitignore`**: `.env.prod` added (and `.env.*.local` if absent).
6. **`ci/checks/compose-prod-config.sh`**: `set -euo pipefail`; covers FF-T61-1..FF-T61-11 static checks; PASS/FAIL output; exit 0/1.
7. **No `src/` files modified** (T-0068 owns index.ts concurrently — strict non-interference).
8. **`docs/environments.md`** §3 extended with choros-app env var table.

---

## 7. Runtime Target

Dev: Docker Compose on developer machine / ephemeral CI runner (unattended, `docker compose up`).
Prod: Docker Compose on founder's home server (`/srv/choros`, Tailscale) — **GT-4 scope is E0.7
(founder-gated); T-0061 commits NO prod secret and provisions NO server**. T-0061 delivers the
compose artefacts that E0.7 picks up as-is.

---

## 8. Open Gaps (not escalations — impl details deferred to E0.7)

| Gap | Deferred to |
|---|---|
| KC `KC_PROXY=edge` + `KC_HOSTNAME_URL` for TLS | E0.7 (home-server provisioning, founder-gated) |
| Reverse proxy (nginx / Caddy) before choros-app | E0.7 infra |
| Secrets management (Vault / Doppler) | Post-MVP |
| Flowable TLS hardening | E0.7 infra |
| POSTGRES_APP_PASSWORD in prod overlay (choros_app runtime role) | T-0053/T-0061 coder: if server.ts uses choros_app (not migrator) at runtime, DATABASE_URL in prod must reference choros_app. Current code uses DATABASE_URL as-is; the prod cred injection covers migrator. If T-0115 switches runtime role, DATABASE_URL must be updated. Coder note: flag in `.env.prod.example`. |

These gaps are documented here so E0.7 / coder picks them up explicitly. No founder escalation required.
