# T-0054 · Keycloak-сервис + realm Spec

**Title:** E0.4 · Keycloak service in docker-compose + dedicated realm (human accounts + agent service accounts)
**Task type:** infrastructure (approved GT-1)
**Status:** ready (no blocking questions)
**Authored:** 2026-06-10
**Authoritative sources (do NOT re-open):**
- `docs/design/tenancy-and-delivery.md` §6 — dedicated realm per silo contour; `iss` alone identifies tenant in silo; tenant RBAC in TS core; validate `iss`/`aud`/`tenant-claim` per-request (day-1 invariant).
- `docs/design/stack-and-fleet-ops.md` §1 — Keycloak dedicated realm per tenant; auth not written, realm = tenant boundary.
- `CONCEPT.md` §6 (Identity = Keycloak, SSO, groups; accounts for humans and agents) + §8 (agents use OAuth 2.0 / A2A; service account per agent).
- `playbooks/mvp-backlog.md` E0.4 raw spec: "Keycloak container; realm; human accounts + agent service accounts. Acceptance: token issued; agent service-account registered."
- Sister task **T-0053** (Postgres-in-compose, done): sets the `docker-compose.yml` ownership model this task extends.
- Sister task boundary **T-0060** (auth of worker endpoints with Keycloak token, `E1.4`): this spec FIXES the JWT contract (issuer / audience / required claims) that T-0060 enforces; T-0060 owns validation logic and is NOT in scope here.

---

## 0. Context and seam

**What already exists (do not break):**

- `docker-compose.yml` at repo root defines the `postgres` service (T-0053, E0.3). This task adds the `keycloak` service to the same file. The Postgres service must remain unmodified; compose still comes up with `docker compose up`.
- **Dev-auth layer (`x-dev-user` header):** `src/http/auth.ts` + `web/src/app-shell/dev-auth.js` implement header-based stub identity for the dev UI. This layer must remain fully functional and unchanged when `CHOROS_AUTH_MODE=dev` (or equivalent env switch). The Keycloak auth path is additive; it does not remove the dev-auth path. Tests that use the dev-auth stub (`src/__tests__/auth.e2e.test.ts`, `inbox.e2e.test.ts`) must stay green.

**Migration seam (dev-auth → Keycloak):**

The switch between dev-auth and Keycloak-auth is controlled by an environment variable (`CHOROS_AUTH_MODE` or equivalent, see AC-11). In `dev` mode, `x-dev-user` header is accepted as before. In `keycloak` mode, the server expects a Bearer JWT validated against the realm JWKS. The seam is defined here (SPEC); the implementation of the runtime middleware is autonomous (DESIGN/BUILD), subject to ACs below.

**T-0060 contract (fixed by this spec, owned by T-0060):**

The JWT issued by the realm created in this task MUST be consumable by T-0060 without changes to the realm. The issuer URL, audience, and claim names are fixed in §4 (JWT contract) and AC-5.

---

## 1. Summary

T-0054 materializes the **Keycloak identity substrate** that every prior Choros auth ADR references. It delivers: (a) a `keycloak` service in `docker-compose.yml`, running Keycloak in dev/standalone mode with dev credentials supplied via environment; (b) a **dedicated realm** (`choros-dev` for dev) provisioned via Keycloak's import-on-start mechanism; (c) **human user accounts** in the realm for the existing dev org fixture; (d) **service-account-enabled confidential clients** for agent identities; (e) a **seam definition** for the dev-auth → Keycloak migration so that dev-auth (`x-dev-user`) stays intact under a feature flag. The task does **not** implement the per-request JWT validation middleware in the TS core (T-0060 owns that); it fixes the JWT contract that T-0060 will validate.

---

## 2. Scope boundary

T-0054 builds **Keycloak infrastructure** only:
- Compose service definition + health readiness.
- Realm definition (realm JSON import, imported on first start).
- Human user accounts (dev fixture matching the existing org).
- Agent service accounts (confidential OIDC clients with `client_credentials` grant, `service_accounts_enabled: true`).
- Dev-auth compatibility flag (env switch, so tests do not break).
- JWT contract specification (issuer URL template, audience, required claims) — frozen for T-0060.

T-0054 does **NOT**:
- Implement JWT validation middleware in the TS core — T-0060.
- Implement per-request `iss`/`aud`/`tenant-claim` validation in live HTTP handlers — T-0060.
- Connect to a production Keycloak — E0.7 (founder-gated, RL-1).
- Implement Keycloak Organizations (pooled SaaS) — deferred per tenancy ADR §6.
- Manage realm lifecycle at runtime (CRUD of users/clients via API at runtime) — E2/E5 RBAC tasks.
- Produce the unified multi-service compose (E0.6 includes Flowable) — E0.6.

---

## 3. Functional Requirements

### FR-1 · Keycloak service in docker-compose

- `docker-compose.yml` MUST define a `keycloak` service running **Keycloak 24.x or 25.x** (latest OSS release at time of implementation).
- Keycloak MUST start in a **dev/standalone mode** suitable for local and CI use (no external database required for Keycloak's own store at this stage — the embedded H2 or the existing Postgres instance may be used; the choice is autonomous).
- All Keycloak admin credentials (admin user, admin password) MUST be supplied via **environment variables** with **dev (non-prod) defaults committed only for non-prod**. No production credential is committed (RL-1).
- The service MUST expose an HTTP port configurable via env var (default: `8080` or a non-colliding port; not `3000` / `55432` which are already used); the exact port is an implementation detail, but must be documented via an env var with a sensible default.
- The Keycloak service MUST have a healthcheck or startup condition such that compose-dependent services (in future tasks) can wait for it to be ready. CI MUST be able to poll a `/health/ready` or equivalent well-known Keycloak readiness endpoint.

### FR-2 · Realm provisioned via import on start

- A **dedicated realm** (named `choros` by default, configurable via env) MUST be created when Keycloak first starts, via Keycloak's built-in realm-import-from-JSON mechanism (the `--import-realm` flag or the `/opt/keycloak/data/import/` mount).
- The realm JSON file MUST be committed to the repository in a tracked path (e.g., `config/keycloak/realm-choros.json` or equivalent). It is the authoritative source of truth for the realm definition; Keycloak is not modified manually at runtime during dev or CI.
- The realm MUST configure:
  - Token-based authentication (OpenID Connect).
  - At minimum one **confidential OIDC client** representing the Choros core API (audience: see §4).
  - `service_accounts_enabled: true` on agent clients (FR-4).
  - Token lifetimes appropriate for dev (≥5 min access token, configurable).
  - `iss` (issuer) pattern: `http://<keycloak-host>:<port>/realms/<realm-name>` (OIDC standard; silo contour ⇒ this URL uniquely identifies the tenant per tenancy ADR §6).

### FR-3 · Human user accounts (dev fixture)

- The realm import MUST include at least the **human users from the existing dev org fixture** (the users returned by `GET /api/users` — i.e., the employees in `src/http/org.ts` or equivalent). Each user MUST have:
  - `username` matching the employee `id` (e.g., `e-kravtsova`).
  - A dev-only **password** (committed for dev use; never the same as a prod default).
  - `email` (may be synthetic `<id>@choros.dev`).
  - The user's `type` captured as a Keycloak attribute `actor_type = human`.
- The number of seeded users is not fixed (≥1 is the minimum; seeding the full fixture is preferred). Users MUST be able to obtain a token via **Resource Owner Password Credentials (ROPC)** grant in dev, or via **Authorization Code flow** in browser flows (both configurable in the realm).

### FR-4 · Agent service accounts

- The realm MUST contain at least **one representative agent service account**: a confidential OIDC client with:
  - `service_accounts_enabled: true`.
  - Grant type: `client_credentials`.
  - A `client_id` with a prefix that identifies it as an agent (e.g., `agent-<name>`).
  - A Keycloak attribute (client attribute or service-account user attribute) `actor_type = agent`.
- This proves the **provisioning pattern** that T-0060 (and future agent-card tasks) will follow. Additional agent clients can be added later by the same import-and-restart pattern or via the realm JSON; the pattern is established here.

### FR-5 · Dev-auth compatibility (migration seam)

- The application server MUST read an environment variable (e.g. `CHOROS_AUTH_MODE`, or equivalent) to select the active auth mode:
  - **`dev` (default):** the existing `x-dev-user` header stub is active; no JWT validation is required. All existing tests continue to pass.
  - **`keycloak`:** the `x-dev-user` path is disabled; Bearer JWT validation is active (implemented by T-0060). Setting this mode in dev/CI requires a live Keycloak with the realm provisioned.
- The env var switch MUST be documented (see NF-4). The default MUST be `dev` so that no change is required for existing tests and CI runs that do not bring up Keycloak.
- The introduction of the env var constitutes the **migration seam**: T-0060 reads the same var and implements the `keycloak` path. T-0054 defines the var name and default; T-0060 implements the validator.

### FR-6 · JWT contract (fixed for T-0060)

The following JWT properties are fixed by this spec. T-0060 MUST validate these; the realm MUST issue tokens matching them:

| Property | Value / pattern |
|---|---|
| `iss` | `http://<keycloak-host>:<port>/realms/<realm-name>` (OIDC standard; uniquely identifies tenant in silo) |
| `aud` | MUST include the client-id of the Choros core API client (e.g. `choros-api`; exact value committed in realm JSON and documented in `docs/environments.md` or equivalent) |
| `sub` | Keycloak user UUID (human user) or service-account user UUID (agent) |
| `preferred_username` | matches `username` in realm (= employee `id` for humans; `service-account-<clientId>` for agent service accounts, e.g. `service-account-agent-orchestrator`) — Keycloak 25 emits the service-account user's username, not the `clientId` |
| `actor_type` claim | MUST be included in the access token as a claim (via Keycloak protocol mapper); value: `human` for human users, `agent` for agent service accounts |
| Signature algorithm | `RS256` (Keycloak default; configurable to `ES256` but RS256 is the minimum) |

T-0060 is the consumer of these claims. This spec fixes the names; T-0060 may validate additional optional claims, but MUST NOT require a claim not specified here.

---

## 4. Non-Functional Requirements

### NF-1 · Dev credentials separation

Only **non-prod** Keycloak credentials (admin password, user passwords, client secrets) appear in the repo or compose defaults. Prod credentials are founder-held (RL-1) and injected at deploy time (E0.7). The committed realm JSON is a dev fixture, not the prod realm.

### NF-2 · Reproducible, unattended bring-up

`docker compose up` MUST bring Keycloak up with the realm and all fixture users pre-provisioned from nothing, with **no manual admin-UI steps**. The realm JSON import mechanism is the sole provisioning path. A fresh CI run against a clean volume MUST reach the same state.

### NF-3 · Silo identity model

One realm = one silo contour = one tenant. This is the only deployment pattern built in this task (pooled shared-realm + Organizations is explicitly deferred per tenancy ADR §6). The realm name and the Keycloak host URL uniquely identify the tenant; no additional `tenant_id` claim is injected by Keycloak (the `iss` URL is the tenant discriminator at the infra layer; the TS core maps it to its internal `tenant_id` at the application layer — this mapping is T-0060/identity tasks).

### NF-4 · Documentation

- The env vars introduced (Keycloak port, realm name, admin creds, `CHOROS_AUTH_MODE`) MUST be documented in `docs/environments.md` (which already exists).
- The realm JSON path and the "how to add a user / agent client" procedure MUST be documented (inline README or in `docs/environments.md`).

### NF-5 · CI compatibility

Bringing up Keycloak in CI (for integration tests against the Keycloak path) is optional in this task — the gate is that `CHOROS_AUTH_MODE=dev` CI run stays green (no new failures). If a Keycloak-mode CI job is added, it MUST be additive (non-breaking to the existing `npm run ci` pipeline).

---

## 5. Out of Scope

1. **Per-request JWT validation in TS core** — T-0060 (E1.4). T-0054 defines the contract; T-0060 implements the validator.
2. **`iss`/`aud`/`tenant-claim` validation middleware on live HTTP handlers** — T-0060.
3. **Connecting Keycloak to a corporate AD/LDAP** (IdP brokering) — future task; noted in tenancy ADR §6 as a silo capability.
4. **Keycloak Organizations (shared realm, pooled SaaS)** — explicitly deferred per tenancy ADR §6.
5. **Runtime provisioning of users/clients** (CRUD via Keycloak Admin REST API at runtime) — E2/E5 RBAC tasks (agent-card provisioning, T-0020).
6. **Flowable service / E0.5** — separate founder-gated task (S-1).
7. **Unified multi-service compose (`core + Postgres + Keycloak + Flowable`)** — E0.6.
8. **Production server provisioning or prod Keycloak deploy** — E0.7, founder-gated (GT-4, RL-1).
9. **Caddy / TLS** — E0.6 / E0.7.
10. **Modifying the RBAC / grant data model in Postgres** — T-0013, T-0018 (already done).

---

## 6. Acceptance Criteria

`verifiable_as: test` = CI test against a running compose stack.
`verifiable_as: fitness` = CI lint / static check.
`verifiable_as: manual` = documented manual step (used only when automation is not practical).

---

**AC-1** — Keycloak service starts and becomes healthy
```
test: `docker compose up -d keycloak` (or equivalent); polling
GET http://localhost:<KEYCLOAK_PORT>/health/ready (or the Keycloak-appropriate
liveness endpoint) returns HTTP 200 within a reasonable timeout (≤120 s).
```
`verifiable_as: test`

**AC-2** — Realm is provisioned on first start (no manual admin-UI step)
```
test: after fresh `docker compose up`, GET /realms/<REALM_NAME>/.well-known/openid-configuration
returns HTTP 200 with `issuer` matching the expected pattern
`http://<host>:<port>/realms/<realm-name>`. No manual admin-UI interaction.
```
`verifiable_as: test`

**AC-3** — Human user can obtain an access token via ROPC grant
```
test: POST /realms/<REALM_NAME>/protocol/openid-connect/token
  with grant_type=password, client_id=<choros-api-client>,
  username=<a seeded human username>, password=<dev password>
→ HTTP 200; response body contains `access_token` (non-empty string).
```
`verifiable_as: test`

**AC-4** — Agent service account can obtain a token via client_credentials grant
```
test: POST /realms/<REALM_NAME>/protocol/openid-connect/token
  with grant_type=client_credentials, client_id=<agent-client-id>,
  client_secret=<dev secret>
→ HTTP 200; response body contains `access_token`.
```
`verifiable_as: test`

**AC-5** — Issued token carries required claims (JWT contract)
```
test: decode the access token obtained in AC-3 or AC-4 (base64-decode the payload);
assert ALL of:
  - `iss` matches pattern `http://<host>:<port>/realms/<realm-name>`
  - `aud` contains the Choros core API client-id (e.g. `choros-api`)
  - `sub` is a non-empty string (UUID)
  - `preferred_username` is a non-empty string
  - `actor_type` claim is present; value is `"human"` for a human token, `"agent"`
    for an agent service-account token
  - signature algorithm in the JWT header is `RS256` (or `ES256` if configured)
```
`verifiable_as: test`

**AC-6** — Realm JSON is committed to the repository at a tracked path
```
fitness: a file matching the pattern `config/keycloak/realm-*.json` (or the equivalent
committed path) exists in the repository and is valid JSON. The file is the authoritative
realm definition (not a generated artifact, not gitignored).
```
`verifiable_as: fitness`

**AC-7** — Seeded human users match the dev org fixture
```
test: for each user-id in the dev org fixture (the set returned by GET /api/users
in dev-auth mode), GET /admin/realms/<REALM_NAME>/users?username=<id> (as admin)
returns exactly one user. Minimum: at least one fixture user is present (e.g. e-kravtsova).
```
`verifiable_as: test`

**AC-8** — At least one agent service account is present in the realm
```
test: GET /admin/realms/<REALM_NAME>/clients (as admin) returns at least one client
with `serviceAccountsEnabled: true` and `clientId` matching the `agent-*` prefix pattern
(or the equivalent pattern committed in realm JSON). The service account's user attributes
include `actor_type = agent`.
```
`verifiable_as: test`

**AC-9** — Dev-auth mode remains unbroken (existing tests pass)
```
test: run the full test suite with CHOROS_AUTH_MODE=dev (or the default, when the env
var is absent). ALL existing tests pass, including:
  - src/__tests__/auth.e2e.test.ts (X-Dev-User header, GET /api/me, GET /api/users)
  - src/__tests__/inbox.e2e.test.ts (X-Dev-User header for mine-flag resolution)
No test that previously passed may fail due to this task.
```
`verifiable_as: test`

**AC-10** — CHOROS_AUTH_MODE env var exists and is read by the server
```
fitness/test: the application source reads an env var (CHOROS_AUTH_MODE or
an equivalent name committed in docs/environments.md) and branches on its value.
Default value is `dev`. Setting it to `dev` explicitly produces the same behavior as
the default. The var name and its values are documented in docs/environments.md.
```
`verifiable_as: fitness`

**AC-11** — No prod credential committed
```
fitness: git grep -i 'password\|secret\|clientsecret' on committed files (excluding
test fixtures and the realm JSON dev defaults) does NOT match any string that looks
like a production credential. The realm JSON dev user passwords and admin credentials
are clearly labeled as dev-only in a comment or README note.
```
`verifiable_as: fitness`

**AC-12** — docker-compose.yml still brings up the full stack (Postgres + Keycloak)
```
test: `docker compose up -d` starts BOTH postgres and keycloak services;
both healthchecks pass; GET /health (Choros core, if running) returns 200;
the Keycloak realm endpoint (AC-2) is reachable.
```
`verifiable_as: test`

**AC-13** — Keycloak port does not collide with existing services
```
fitness: the default KEYCLOAK_PORT env var value in docker-compose.yml is NOT
5432, 55432 (Postgres), 3000 (Choros dev server default), or 8080 if that is already
reserved. The chosen default port is documented.
```
`verifiable_as: fitness`

**AC-14** — Realm name and OIDC metadata are documented in docs/environments.md
```
fitness: docs/environments.md is updated to include: KEYCLOAK_PORT, KEYCLOAK_REALM
(or equiv), CHOROS_AUTH_MODE, the Choros core API client-id used for `aud`, and a
one-line note on how to add a new user or agent client (or a reference to a procedure
file). Absence of this update = build failure (fitness check can be a grep for the
var names).
```
`verifiable_as: fitness`

---

## 7. Open items (non-blocking — autonomous implementation)

The following are delegated to DESIGN/BUILD; none require a founder decision:

- **Keycloak version:** 24.x vs 25.x — implementer choice (latest stable OSS at build time).
- **Keycloak internal store:** embedded H2 vs the existing Postgres instance for Keycloak's own tables — implementer choice; H2 is simpler for the silo-dev case; Postgres is more consistent with the stack ADR single-instance principle. Either satisfies the ACs.
- **Keycloak host port default:** must avoid 5432/55432/3000; choice of e.g. 8180 or 9000 is autonomous.
- **Realm JSON file location:** `config/keycloak/realm-choros.json` is suggested; exact path is autonomous.
- **Full vs. minimal fixture seeding:** seeding only a subset of the org fixture (vs. all) is acceptable as long as AC-7's minimum is met.
- **ROPC vs. Authorization Code for human login in dev:** ROPC is the simplest for AC-3; the realm may also enable the Authorization Code flow for browser-based dev — both are valid.
- **Client secret rotation pattern:** for the dev fixture, a committed dev secret is acceptable; the rotation mechanism is E2/E5/E0.7 scope.

---

## 8. Blocking questions

**None.** All high-leverage decisions are founder-ratified:

- Keycloak as the identity layer — ratified in `CONCEPT.md` §6 and `stack-and-fleet-ops.md` §1 (2026-06-10).
- Dedicated realm per silo contour — ratified in `tenancy-and-delivery.md` §6 (GT-1, 2026-06-08).
- Tenant RBAC lives in the TS core, not in Keycloak (Keycloak = auth + federation only) — ratified in `tenancy-and-delivery.md` §6.
- `iss`/`aud`/`tenant-claim` validation is day-1 required (but implemented by T-0060, not this task) — ratified in `tenancy-and-delivery.md` §6.
- `x-dev-user` dev-auth stays intact until T-0060 activates the Keycloak path — this is a migration-seam decision, but it is a direct consequence of the founder's "implementation is autonomous, dev-mode must not break" policy, and does not alter product scope or red lines.
- Pooled / shared-realm is explicitly deferred — ratified in `tenancy-and-delivery.md` §5–§6.
- T-0060 scope boundary (who implements JWT validation) — clearly delimited in the task dependency graph and confirmed by the orchestrator task definition.
