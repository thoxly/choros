# ADR · T-0054 — Keycloak-in-compose + dedicated realm (human accounts + agent service accounts)

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-06-10
**Task:** E0.4 — Keycloak service in docker-compose + dedicated realm (choros-dev) + human dev
accounts + agent service accounts + JWT contract frozen for T-0060 + env-flag migration seam
preserving x-dev-user dev-auth layer.
**Spec (input):** `docs/specs/T-0054-keycloak-compose.spec.md` + `docs/specs/T-0054.spec.contract.json`
(status: ready; FR-1..FR-6, NF-1..NF-5, AC-1..AC-14; no blocking questions).

**Authoritative sources (consumed, NOT re-decided):**
- `docs/design/tenancy-and-delivery.md` §6 — dedicated realm per silo contour; `iss` alone identifies tenant in silo; tenant RBAC in TS core; validate `iss`/`aud`/`tenant-claim` per-request (day-1 invariant, implemented by T-0060).
- `docs/design/stack-and-fleet-ops.md` §1 — Keycloak dedicated realm per tenant; auth not written by us; realm = tenant boundary.
- `CONCEPT.md` §6 (Identity = Keycloak, SSO, groups; accounts for humans and agents) + §8 (agents use OAuth 2.0 / A2A; service account per agent).
- Sister task **T-0053** (Postgres-in-compose, done): sets the `docker-compose.yml` ownership model this task extends. The `postgres` service block is untouched; `keycloak` is additive.
- Sister task **T-0060** (auth middleware, E1.4): this ADR **fixes** the JWT contract; T-0060 implements the validator and reads the same `CHOROS_AUTH_MODE` env var to branch.
- Sister task **T-0115** (migrations 011+): owns choros_* schema evolution; T-0054 does NOT touch migration files.

> **This ADR designs the Keycloak infrastructure substrate; it does not write application code.**
> It pins the compose service shape, the realm JSON layout, the fixture sets (human users +
> agent clients), the migration seam (env flag), and the JWT contract — then declares the
> fitness functions that gate every implementation detail. `coder` and `tester` read §3–§6
> as source of truth.

---

## 1. Decision

Deliver the Choros Keycloak identity substrate as **(a) one `keycloak:25` service added to the
repo-root `docker-compose.yml`** (additive — the existing `postgres` service block is
unmodified), using Keycloak's **standalone dev mode** (`start-dev`) for the local/CI
use-case; all admin credentials supplied via environment variables with **dev-only defaults**
committed (no prod secret; RL-1); host port `8180` (avoids 5432 / 55432 / 3000); a `depends_on`
healthcheck on `postgres` (Keycloak will store its own config in the same Postgres instance via
JDBC — see §1.1); a Keycloak-native readiness probe on `GET /health/ready` that CI polls;
**(b) a dedicated realm** named `choros` (configurable via `KEYCLOAK_REALM`, default `choros`)
provisioned via **import-on-start** by mounting the realm JSON into
`/opt/keycloak/data/import/` — no manual admin-UI steps, unattended from clean volume; the
realm JSON is committed at `config/keycloak/realm-choros.json` and is the **authoritative realm
definition**; **(c) human user accounts** in the realm matching the existing dev org fixture
from `src/http/org.ts` (all 7 `type:"human"` employees: `e-kravtsova`, `e-mironov`, `e-larina`,
`e-orlov`, `e-savina`, `e-petrov`, `e-belov`) with dev passwords, `actor_type=human` attribute,
and synthetic `<id>@choros.dev` email; ROPC grant enabled on the realm client for AC-3; **(d)
one representative agent service account** — a confidential OIDC client `agent-orchestrator`
with `serviceAccountsEnabled: true`, `client_credentials` grant, dev client secret, and
`actor_type=agent` on its service-account user — establishing the provisioning pattern all
future agent clients follow; **(e) one `actor_type` protocol mapper** on the core API client
that injects the `actor_type` claim (value sourced from user/service-account attribute) into
the access token, satisfying the JWT contract frozen for T-0060; **(f) an env-flag migration
seam** — `CHOROS_AUTH_MODE` env var (default `dev`) read by the application server; in `dev`
mode the existing `x-dev-user` stub in `src/http/auth.ts` is active and no JWT is required —
all existing tests continue to pass unchanged; in `keycloak` mode the `x-dev-user` path is
disabled and Bearer JWT validation is expected (implemented by T-0060); the seam is defined
here and T-0060 consumes it.

The mechanism is deliberately **proportional** (rubric axis 5): Keycloak OSS standalone dev
mode + one JSON import file + one env flag. No custom Keycloak extensions, no theme
customisation, no custom SPI, no Keycloak Operator. The `coder` adds ~30 lines to
`docker-compose.yml`, one JSON realm file (~200 lines), and one env-var read in `server.ts`
or `auth.ts` — nothing more. Keycloak's built-in import-on-start (`--import-realm`) is the
sole provisioning path; no Admin REST API calls are needed at build time.

### 1.1 Keycloak internal store — Postgres (same instance, separate schema namespace)

The spec delegates the internal-store choice to DESIGN as autonomous. **Decision: Keycloak uses
the existing Postgres instance** (the T-0053 `postgres` service) via JDBC
(`KC_DB=postgres`, `KC_DB_URL`, `KC_DB_USERNAME`, `KC_DB_PASSWORD`). Rationale:

1. **Stack ADR single-instance principle**: one Postgres per silo contour. Adding an embedded
   H2 would be a second persistent store, violating the single-substrate principle.
2. **Schema safety**: Keycloak creates its own tables with a `kc_` prefix in the configured
   schema/namespace (configurable via `KC_DB_SCHEMA`); this task sets `KC_DB_SCHEMA=keycloak`
   (or Keycloak's default schema-per-db) so the `kc_*` tables never collide with `choros_*`
   or `ACT_*`.
3. **Operational simplicity**: one Postgres backup covers everything (data + realm config).
   H2 is dev-only and file-based; it disappears on container restart without a volume, making
   realm state ephemeral in an inconsistent way.

`KC_DB_USERNAME` / `KC_DB_PASSWORD` are supplied as env vars with dev-only defaults. Keycloak
bootstraps its own DB tables on first start; `depends_on: postgres: condition: service_healthy`
ensures Postgres is ready before Keycloak starts.

**Schema collision guard**: Keycloak will NOT be given `DATABASE_URL` pointing at the
`choros` schema. It connects to the same database (`${POSTGRES_DB:-choros}`) but uses a
**separate dedicated schema** (`keycloak`) created by Keycloak's own bootstrap — orthogonal to
the `choros` schema owned by `choros_migrator`. `choros_app` is NOT granted access to the
`keycloak` schema (confirmed in §4 contracts). No `kc_*` table ever appears in
`known_tenant_tables`.

### 1.2 Keycloak version — 25.x

Keycloak **25.x** (quay.io/keycloak/keycloak:25) is the stable OSS release at time of design.
Version 24.x is also acceptable per spec (FR-1) — the choice is `25` for the latest RS256 JWKS
endpoint stability. If a 25.x-specific breaking issue is found at BUILD, the coder may
downgrade to 24.x without escalation (the ACs are version-agnostic). The spec fixed this as
an autonomous detail.

### 1.3 Port — 8180

Port `8180` is chosen as the `KEYCLOAK_PORT` default. It avoids: `5432` (Postgres internal),
`55432` (Postgres host-mapped, T-0053), `3000` (Choros dev server), `8080` (common HTTP
alternative already used by some dev environments). The port is configurable via env var
`KEYCLOAK_PORT` (documented in `docs/environments.md`).

### 1.4 Migration seam — minimal app-code touch

The seam (`CHOROS_AUTH_MODE` branch) requires exactly one additive change to the application
source: `src/http/auth.ts` (or the auth middleware it will grow into for T-0060) reads
`process.env.CHOROS_AUTH_MODE ?? 'dev'`. In `dev` mode: behaviour is identical to today (the
`x-dev-user` header path is active). In `keycloak` mode: the `x-dev-user` path is disabled;
the server expects a Bearer JWT (T-0060 will implement the validator). No route logic, no
existing test, and no public export changes. The flag defaults to `dev` so all existing tests
pass without modification.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Embedded H2 for Keycloak's internal store** | Second persistent store violating single-Postgres principle (stack ADR). H2 is file-based and container-ephemeral without explicit volume management; state is lossy on container restart without a separate volume. A named Postgres schema (`keycloak`) on the existing instance is cleaner, operationally consistent, and aligns with the "one backup covers all" silo model. |
| **Keycloak 24.x instead of 25.x** | 25.x is the latest stable OSS at design time; no feature gap between 24 and 25 for this task. Delegating to 24 would be a downgrade with no benefit. The spec treats 24.x/25.x as equivalent; 25.x is chosen as default. |
| **Port 8080** | Conflicts with a common developer-machine default (many tools bind 8080); Keycloak itself defaults to 8080 in `start-dev`, meaning an ambient Keycloak on the same machine would collide. 8180 is the conventional secondary HTTP port (a 8080+100 offset used by Keycloak's own docs for multi-instance setups). |
| **Keycloak Operator / Helm / external provisioning tool** | Overkill for a dev/silo compose stack. Adds a non-trivial dependency and a new language surface. Keycloak's built-in `--import-realm` mechanism is battle-tested and zero-dep for this use case. |
| **Admin REST API calls at build/start time (a bootstrap script)** | Fragile: depends on Keycloak being fully ready before the script runs, adds a shell/curl dependency, and the provisioning state is not committed to git (no audit trail). JSON realm import is declarative, committed, and applied atomically on first start. |
| **Shared realm (not dedicated)** | Explicitly rejected by the tenancy ADR §6 and the spec §0. One realm = one silo contour. Pooled shared-realm (Keycloak Organizations) is deferred. |
| **Modify dev-auth path to always require JWT (remove x-dev-user)** | Breaks AC-9 (all existing e2e tests use the x-dev-user stub and would require a live Keycloak). The spec mandates the migration seam: dev-auth stays intact under CHOROS_AUTH_MODE=dev. |
| **Put `CHOROS_AUTH_MODE` check in every route handler** | Creates scattered, untestable guard logic. The correct model (spec FR-5 seam contract) is one env-var read at the auth-middleware layer in `src/http/auth.ts` (or a thin wrapper), with the keycloak path being a stub/no-op that T-0060 fills in. One branch point, not N. |
| **Keycloak with direct grant (ROPC) disabled by default** | ROPC is needed for AC-3 (human token in CI/integration tests without a browser). The realm commits ROPC enabled for dev; this is a dev-fixture decision. Prod realm configuration (E0.7) may disable ROPC. |

---

## 3. Object model (realm JSON entities — what the realm file commits)

All realm entities are in `config/keycloak/realm-choros.json` (the authoritative source).
The `coder` generates the realm JSON from the contracts below; the shapes are fixed here.

### 3.1 Realm root

| Field | Value / pattern | Notes |
|---|---|---|
| `realm` | `${KEYCLOAK_REALM:-choros}` → literal `choros` in the committed JSON (configurable only via recreating the realm for a different name in non-default envs) | Uniquely identifies silo; `iss` = `http://<host>:<port>/realms/choros` |
| `enabled` | `true` | — |
| `accessTokenLifespan` | `300` (5 min) | Dev default; configurable upward in prod |
| `directAccessGrantsEnabled` | `true` | Enables ROPC for human token tests (AC-3) |
| `resetPasswordAllowed` | `true` (dev convenience) | — |

### 3.2 Core API client (audience source)

| Field | Value |
|---|---|
| `clientId` | `choros-api` |
| `protocol` | `openid-connect` |
| `publicClient` | `false` (confidential) |
| `serviceAccountsEnabled` | `false` (this is the resource-server client, not an agent) |
| `directAccessGrantsEnabled` | `true` (enables ROPC with this client) |
| `secret` | `choros-api-dev-secret` (DEV ONLY — clearly labeled in realm JSON comment) |

### 3.3 Protocol mapper — `actor_type` claim

Attached to `choros-api` client (affects all tokens issued against it):

| Field | Value |
|---|---|
| `name` | `actor-type-mapper` |
| `protocol` | `openid-connect` |
| `protocolMapper` | `oidc-usermodel-attribute-mapper` |
| `config.user.attribute` | `actor_type` |
| `config.claim.name` | `actor_type` |
| `config.jsonType.label` | `String` |
| `config.id.token.claim` | `true` |
| `config.access.token.claim` | `true` |
| `config.userinfo.token.claim` | `true` |

For service-account tokens (agent clients), Keycloak uses the service-account user's
attributes; `actor_type=agent` set on the service-account user of each agent client means the
same mapper emits `actor_type: "agent"` in the `client_credentials` token.

### 3.4 Human users (dev fixture — 7 from org.ts)

All `type: "human"` persons in `ORG_SEED` (`src/http/org.ts`):

| `username` | `email` | `actor_type` attribute | Dev password |
|---|---|---|---|
| `e-kravtsova` | `e-kravtsova@choros.dev` | `human` | `dev-pw-kravtsova` |
| `e-mironov` | `e-mironov@choros.dev` | `human` | `dev-pw-mironov` |
| `e-larina` | `e-larina@choros.dev` | `human` | `dev-pw-larina` |
| `e-orlov` | `e-orlov@choros.dev` | `human` | `dev-pw-orlov` |
| `e-savina` | `e-savina@choros.dev` | `human` | `dev-pw-savina` |
| `e-petrov` | `e-petrov@choros.dev` | `human` | `dev-pw-petrov` |
| `e-belov` | `e-belov@choros.dev` | `human` | `dev-pw-belov` |

Passwords are dev-only fixtures, clearly labeled in the realm JSON and documented in
`docs/environments.md`. They are NOT reused across environments (RL-1).
`emailVerified: true`, `enabled: true` on each user.

### 3.5 Agent service-account client (representative pattern)

| Field | Value |
|---|---|
| `clientId` | `agent-orchestrator` |
| `protocol` | `openid-connect` |
| `publicClient` | `false` (confidential) |
| `serviceAccountsEnabled` | `true` |
| `directAccessGrantsEnabled` | `false` |
| `secret` | `agent-orchestrator-dev-secret` (DEV ONLY) |

The service-account user auto-created by Keycloak for `agent-orchestrator` receives attribute
`actor_type=agent`. The same `actor-type-mapper` (§3.3) emits `actor_type: "agent"` in the
token.

Additional agent clients (`agent-recon`, `agent-invoice`, `agent-triage`) follow the same
pattern and are included in the realm JSON to cover all `type:"agent"` persons in the org
fixture. The pattern is established by `agent-orchestrator`; the others are additive.

### 3.6 Compose service shape

```yaml
# Additive to existing docker-compose.yml (postgres block unchanged)
keycloak:
  image: quay.io/keycloak/keycloak:25
  command: start-dev --import-realm
  environment:
    KEYCLOAK_ADMIN:          ${KEYCLOAK_ADMIN:-choros_kc_admin}       # DEV default (RL-1)
    KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:-choros_kc_dev_pw}  # DEV default (RL-1)
    KC_HTTP_PORT:            ${KEYCLOAK_PORT:-8180}
    KC_DB:                   postgres
    KC_DB_URL:               jdbc:postgresql://postgres:5432/${POSTGRES_DB:-choros}
    KC_DB_SCHEMA:            keycloak
    KC_DB_USERNAME:          ${POSTGRES_USER:-choros_migrator}
    KC_DB_PASSWORD:          ${POSTGRES_PASSWORD:-choros_dev_pw}
    KC_HOSTNAME_STRICT:      false
    KC_HTTP_ENABLED:         true
    KC_HEALTH_ENABLED:       true
  ports:
    - "${KEYCLOAK_PORT:-8180}:8180"
    - "${KEYCLOAK_MGMT_PORT:-9000}:9000"
  volumes:
    - "./config/keycloak:/opt/keycloak/data/import:ro"
  depends_on:
    postgres:
      condition: service_healthy
  healthcheck:
    # KC 25 exposes health on the management port (9000/KEYCLOAK_MGMT_PORT), NOT on the
    # HTTP app port (8180/KEYCLOAK_PORT). These are separate interfaces in KC 25.
    test: ["CMD-SHELL", "curl -sf http://localhost:${KEYCLOAK_MGMT_PORT:-9000}/health/ready || exit 1"]
    interval: 5s
    timeout: 5s
    retries: 24   # up to 120 s
    start_period: 30s
```

`KC_HOSTNAME_STRICT: false` and `KC_HTTP_ENABLED: true` are required for `start-dev` mode to
accept `localhost` requests without TLS configuration. These are dev-mode settings only; prod
Keycloak (E0.7) will use TLS + hostname pinning (Caddy termination).

**Note on KC schema isolation:** Keycloak's schema namespace is set via `KC_DB_SCHEMA=keycloak`
(a separate env var), not via a JDBC `?currentSchema=keycloak` query parameter. Keycloak
bootstraps this schema on first start. The `choros_migrator` role (which owns the Postgres
database) is used here for dev simplicity; in prod, a dedicated `choros_keycloak` DB role
(with rights only to the `keycloak` schema) is the recommended pattern — this is E0.7 scope.

**Note on KC 25 port split:** Keycloak 25 runs two distinct listeners in `start-dev`:
- HTTP app port (`KC_HTTP_PORT`, default `8180`) — handles OIDC/auth traffic (`/realms/...`).
- Management port (always `9000`, configurable via `KEYCLOAK_MGMT_PORT`) — serves
  `/health/ready`, `/health/live`, `/metrics`. The healthcheck MUST use the management port.

---

## 4. Contracts

### 4.1 JWT contract (frozen for T-0060)

The following properties are FIXED. T-0060 MUST validate these; the realm MUST issue tokens
matching them. No T-0054 code change is required for T-0060 to consume the tokens.

| Property | Value / pattern | Source |
|---|---|---|
| `iss` | `http://<keycloak-host>:<port>/realms/<realm-name>` (e.g. `http://localhost:8180/realms/choros`) | OIDC standard; uniquely identifies tenant in silo (tenancy ADR §6) |
| `aud` | MUST include `choros-api` (the committed client-id of the core API client, §3.2) | Set by Keycloak audience mapper on the `choros-api` client |
| `sub` | Keycloak user UUID (human) or service-account user UUID (agent) — non-empty string | OIDC standard |
| `preferred_username` | `username` in realm: employee id for humans (e.g. `e-kravtsova`); **`service-account-<clientId>`** for agent service accounts (e.g. `service-account-agent-orchestrator`) — this is the Keycloak 25 service-account user's username, NOT the `clientId` itself | OIDC standard |
| `actor_type` | `"human"` for human users; `"agent"` for agent service-account tokens | Via `actor-type-mapper` protocol mapper (§3.3) |
| `alg` (JWT header) | `RS256` (Keycloak default; `ES256` allowed if configured) | Keycloak default; configurable |

T-0060 MUST validate all six properties; it MAY validate additional optional claims but MUST
NOT require any claim not in this table.

### 4.2 `CHOROS_AUTH_MODE` seam contract

```typescript
// src/http/auth.ts (additive only — existing exports unchanged)
const AUTH_MODE = (process.env.CHOROS_AUTH_MODE ?? 'dev') as 'dev' | 'keycloak';

// In dev mode: x-dev-user stub is active (existing behaviour, no change)
// In keycloak mode: x-dev-user stub is DISABLED; Bearer JWT expected (T-0060 implements)
//
// T-0060 reads the same AUTH_MODE constant and activates the JWT validator branch.
// This file defines the constant; T-0060 fills the 'keycloak' branch.
```

The constant name `AUTH_MODE` (or `CHOROS_AUTH_MODE`) is not a public export — it is internal
to the auth middleware. No existing test imports it. The `DEV_USER_HEADER` export
(`"x-dev-user"`) is unchanged (FE-W23-0008 compat).

### 4.3 Compose env-var contract (documented in `docs/environments.md`)

| Variable | Default | Owner | Notes |
|---|---|---|---|
| `KEYCLOAK_PORT` | `8180` | T-0054 | Host-mapped port; avoids 5432/55432/3000 |
| `KEYCLOAK_REALM` | `choros` | T-0054 | Realm name; encoded in the realm JSON `realm` field |
| `KEYCLOAK_ADMIN` | `choros_kc_admin` | T-0054 | Dev admin user (DEV ONLY) |
| `KEYCLOAK_ADMIN_PASSWORD` | `choros_kc_dev_pw` | T-0054 | Dev admin password (DEV ONLY, RL-1) |
| `CHOROS_AUTH_MODE` | `dev` | T-0054 (seam) | `dev` = x-dev-user stub; `keycloak` = JWT (T-0060 implements) |
| Core API client-id | `choros-api` | T-0054 | Committed in realm JSON; used as `aud` claim |

Human dev passwords (`dev-pw-<username>`) and agent client secret (`agent-orchestrator-dev-secret`)
are committed in the realm JSON with a DEV-ONLY label and documented in `docs/environments.md`
under "Dev credentials (non-production only)".

### 4.4 Scope boundary vs T-0115 (migrations)

T-0054 does NOT modify any file in `migrations/`. The `keycloak` DB schema is bootstrapped
by Keycloak itself via JDBC (not by our migration runner). T-0115 owns `choros_*` migrations
011+. No schema migration file is created, modified, or referenced by T-0054.

### 4.5 Scope boundary vs T-0060 (JWT validation)

T-0054 defines `CHOROS_AUTH_MODE` and the JWT contract (§4.1). It does NOT implement the JWT
validator, the JWKS fetch, or per-request `iss`/`aud`/`actor_type` checks. The `keycloak`
branch of `AUTH_MODE` in `src/http/auth.ts` is a no-op stub (or a `501 Not Implemented`
response) until T-0060 activates it. T-0060 reads `CHOROS_AUTH_MODE` from the same env var
and fills the validator.

### 4.6 Compat-check (FE-W23-0008) — public-surface impact

**No existing public export is changed, moved, or removed.** `DEV_USER_HEADER` remains
exported from `src/http/auth.ts`. `createServer`, `handleRequest`, `registerAuthRoutes`,
`findEmployee`, `listSelectableUsers` — all unchanged. The only source-level addition is the
`CHOROS_AUTH_MODE` env-var read (internal constant, not exported). Zero importers break.

The frozen test files (`src/__tests__/auth.e2e.test.ts`, `src/__tests__/inbox.e2e.test.ts`)
use `x-dev-user` and do not set `CHOROS_AUTH_MODE` — they default to `dev` mode, which is
identical to today's behaviour.

---

## 5. Traceability (AC-1..AC-14 → design)

| AC | Covered by |
|---|---|
| AC-1 (Keycloak starts, /health/ready returns 200 within 120 s) | §3.6 compose healthcheck (24 × 5s retries = 120 s) · **FF-1** |
| AC-2 (realm provisioned on first start, no manual admin-UI) | §1 import-on-start mechanism · §3.1 realm root · **FF-2** |
| AC-3 (human ROPC token) | §3.1 `directAccessGrantsEnabled:true` · §3.4 human users with passwords · §3.2 core-API client · **FF-3** |
| AC-4 (agent client_credentials token) | §3.5 agent client `serviceAccountsEnabled:true` · **FF-4** |
| AC-5 (JWT claims: iss/aud/sub/preferred_username/actor_type/RS256) | §4.1 JWT contract · §3.3 protocol mapper · §3.4/3.5 user attributes · **FF-5** |
| AC-6 (realm JSON committed at tracked path, valid JSON) | §1 `config/keycloak/realm-choros.json` · **FF-6** |
| AC-7 (seeded users match dev org fixture) | §3.4 all 7 human users · **FF-7** |
| AC-8 (at least one agent service account present) | §3.5 `agent-orchestrator` · **FF-8** |
| AC-9 (dev-auth tests pass with CHOROS_AUTH_MODE=dev or default) | §1.4 seam · §4.2 AUTH_MODE default · **FF-9** |
| AC-10 (CHOROS_AUTH_MODE env var read, default dev, documented) | §4.2 seam contract · §4.3 env-var contract · **FF-10** |
| AC-11 (no prod credential committed) | §1 RL-1 dev-only defaults · §4.3 DEV ONLY label · **FF-11** |
| AC-12 (docker compose up -d brings up postgres + keycloak, both healthy) | §3.6 `depends_on` + healthcheck · **FF-12** |
| AC-13 (KEYCLOAK_PORT default not 5432/55432/3000) | §1.3 port 8180 · §4.3 env table · **FF-13** |
| AC-14 (docs/environments.md updated with all vars) | §4.3 env-var contract · **FF-14** |

---

## 6. Fitness functions

Each is an executable CI rule. **static-now** = lint/script runnable in today's `npm run fitness`
(no live service needed). **live-kc** = requires Keycloak running (an optional new `kc` CI job,
additive). **live-dev** = runs with `CHOROS_AUTH_MODE=dev` (existing CI job, no Keycloak
needed).

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | Keycloak health endpoint returns 200 within 120 s of `docker compose up -d keycloak` | live-kc: `ci/checks/kc/wait-ready.sh` — polls `GET http://localhost:${KEYCLOAK_PORT:-8180}/health/ready` every 5 s for ≤120 s; non-200 after timeout = fail | live-kc |
| **FF-2** | Realm provisioned on first start (no manual step); `GET /realms/choros/.well-known/openid-configuration` returns 200 with `issuer` matching `http://localhost:8180/realms/choros` | live-kc: `ci/checks/kc/realm-ready.sh` — curl the OIDC discovery URL after FF-1 passes; assert `issuer` field matches pattern | live-kc |
| **FF-3** | Human ROPC token: POST to token endpoint with `e-kravtsova` credentials → HTTP 200 + non-empty `access_token` | live-kc: `ci/checks/kc/human-token.sh` — curl ROPC with committed dev credentials; assert 200 + `access_token` field present | live-kc |
| **FF-4** | Agent `client_credentials` token: POST with `agent-orchestrator` client_id/secret → HTTP 200 + non-empty `access_token` | live-kc: `ci/checks/kc/agent-token.sh` — curl client_credentials; assert 200 + `access_token` | live-kc |
| **FF-5** | JWT claims contract: decode access token from FF-3 (human) and FF-4 (agent); assert `iss` matches realm URL pattern; `aud` contains `choros-api`; `sub` non-empty; `preferred_username` non-empty; `actor_type` = `human` for human token and `agent` for agent token; JWT header `alg` = `RS256` | live-kc: `ci/checks/kc/jwt-claims.sh` — base64-decode the payload and header of tokens from FF-3/FF-4; jq assertions on all six required fields | live-kc |
| **FF-6** | Realm JSON committed at `config/keycloak/realm-*.json`, is valid JSON, not gitignored | static-now: `ci/checks/kc/realm-json-exists.sh` — `test -f config/keycloak/realm-choros.json && python3 -c "import json,sys; json.load(open('config/keycloak/realm-choros.json'))" && git check-ignore -q config/keycloak/realm-choros.json && echo "ERROR: realm JSON is gitignored" >&2 || true` | static-now |
| **FF-7** | All 7 human users from org fixture are present in the realm JSON (`username` field); minimum `e-kravtsova` present | static-now: `ci/checks/kc/fixture-users.sh` — `jq '.users[].username' config/keycloak/realm-choros.json` asserts all 7 usernames present | static-now |
| **FF-8** | At least one client with `serviceAccountsEnabled:true` and `clientId` matching `agent-*` pattern present in realm JSON | static-now: `ci/checks/kc/agent-client.sh` — `jq '[.clients[] | select(.serviceAccountsEnabled==true and (.clientId | startswith("agent-")))] | length' config/keycloak/realm-choros.json` ≥ 1 | static-now |
| **FF-9** | Full test suite passes with `CHOROS_AUTH_MODE=dev` (or unset default); zero test failures | live-dev: `CHOROS_AUTH_MODE=dev npm test` (or existing `npm run ci` — inherits default); all tests in `auth.e2e.test.ts` and `inbox.e2e.test.ts` pass | live-dev (existing CI) |
| **FF-10** | `CHOROS_AUTH_MODE` env var is read in `src/http/auth.ts` (or server entry); default branch is `dev`; setting it to `dev` explicitly is a no-op | static-now: `grep -r 'CHOROS_AUTH_MODE' src/` returns at least one match in `src/http/auth.ts` or `src/server.ts`; `grep` for the default `'dev'` fallback pattern confirms the default is `dev` | static-now |
| **FF-11** | No prod credential committed; dev credentials in realm JSON are labeled dev-only | static-now: `ci/checks/kc/no-prod-secret.sh` — (a) `git grep -i 'choros_kc_dev_pw\|choros_dev_pw\|dev-pw-\|dev-secret' src/` returns 0 matches (creds only in compose + realm JSON, not in TS source); (b) `grep -i 'DEV ONLY\|dev-only\|dev only' config/keycloak/realm-choros.json` returns ≥ 1 match (label present); (c) compose vars use `${VAR:-dev_default}` form (no literal secret in compose YAML) | static-now |
| **FF-12** | `docker compose up -d` starts both `postgres` and `keycloak`; both healthchecks pass | live-kc: `docker compose ps` after FF-1 shows both services `healthy`; `docker compose up -d` exit code 0 | live-kc |
| **FF-13** | `KEYCLOAK_PORT` default in docker-compose.yml is not 5432, 55432, or 3000 | static-now: `grep 'KEYCLOAK_PORT' docker-compose.yml \| grep -v '8180'` returns 0 lines (confirming 8180 default); and `grep ':-5432\|:-55432\|:-3000' docker-compose.yml \| grep -i keycloak` returns 0 | static-now |
| **FF-14** | `docs/environments.md` updated to include `KEYCLOAK_PORT`, `KEYCLOAK_REALM`, `CHOROS_AUTH_MODE`, core API client-id (`choros-api`), and a note on adding users/agents | static-now: `grep -E 'KEYCLOAK_PORT|KEYCLOAK_REALM|CHOROS_AUTH_MODE|choros-api' docs/environments.md` returns ≥ 4 distinct matches | static-now |

**CI wiring.** All `static-now` fitness functions join `npm run fitness` (existing script) and
gate on the existing CI job — no new infrastructure required. The `live-kc` functions are
collected in an optional new `kc` CI job in `.github/workflows/ci.yml` that spins up the
compose stack (`docker compose up -d`), waits for Keycloak readiness (FF-1), then runs the
`ci/checks/kc/*.sh` scripts. The `kc` job is **additive** (does not modify the existing `ci`
job; AC-9 / NF-5). The existing `ci` job retains `CHOROS_AUTH_MODE=dev` (or the default) and
stays green without Keycloak.

---

## 7. Runtime target

**Local dev + silo docker-compose stack.** `docker compose up` on the developer's machine or
in CI (ephemeral runner with Docker available). The same compose file is the basis of a silo
deploy to the founder's server (`/srv/choros`, Tailscale) — but that provisioning is
**E0.7, founder-gated (GT-4)**. T-0054 commits no prod secret and provisions no server.

The dev stack after this task: `postgres` (T-0053) + `keycloak` (T-0054) + the Choros core
server (run separately as `node dist/index.js`). A unified single-command compose including the
app server is E0.6 scope.

---

## 8. Escalation

None. All high-leverage forks are founder-ratified:
- Keycloak as the identity layer — ratified `CONCEPT.md` §6 + `stack-and-fleet-ops.md` §1 (2026-06-10).
- Dedicated realm per silo contour — ratified `tenancy-and-delivery.md` §6 (GT-1, 2026-06-08).
- Tenant RBAC in TS core, not in Keycloak — ratified `tenancy-and-delivery.md` §6.
- `iss`/`aud`/`tenant-claim` validation day-1 required, implemented by T-0060 — ratified `tenancy-and-delivery.md` §6.
- Pooled shared realm / Keycloak Organizations — explicitly deferred.
- x-dev-user stays intact until T-0060 — consequence of founder's "implementation is autonomous, dev-mode must not break" policy.

Decisions made here (Keycloak 25.x, port 8180, Postgres internal store, single `keycloak` DB
schema, realm JSON import-on-start, `actor_type` mapper design, 7 human users, representative
`agent-orchestrator` client) are all **infra / compose / realm-config details** the spec marks
as autonomous (spec §7). No product-direction fork is opened; `status: ready`.
