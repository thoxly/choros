# T-0058 · Flowable-сервис + механизм деплоя BPMN Spec

**Title:** E0.5 · Flowable service in docker-compose + BPMN deployment mechanism (container as infra)
**Task type:** infrastructure
**Status:** ready (no blocking questions)
**Authored:** 2026-06-10
**Authoritative sources (do NOT re-open):**
- `docs/design/stack-and-fleet-ops.md` (ratified 2026-06-10) — Flowable 7 (Apache 2.0), single-Postgres substrate, schemas `ACT_*` (Liquibase, engine) + `choros_*` (our migrations); engine = black box, no Java authored.
- `docs/design/stack-flowable-oss-spike-addendum.md` (ratified 2026-06-10) — Flowable 7 primary (`flowable/flowable-rest:7.1.0`), Operaton fallback; OSS capability proven (deploy BPMN via REST, start instance, deadletter list/retry/move, history-cleanup). BPMN deploy mechanism from spike: `POST /flowable-rest/service/repository/deployments` (multipart).
- `CONCEPT.md` §5 (architecture diagram — engine as infra), §6 (Flowable = black box container, external-worker contract only).
- `playbooks/mvp-backlog.md` E0.5 — "Flowable container as infra in compose (dedicated schema in shared Postgres per substrate principle), BPMN deploy mechanism, healthcheck, dev mode."
- `spikes/flowable-oss/` — proven compose shape, env vars, REST API surface, BPMN file deploy pattern.
- Sister tasks:
  - **T-0053** (Postgres compose, done) — owns `docker-compose.yml`; this task adds `flowable` service additively; `postgres` service block MUST remain unmodified.
  - **T-0054** (Keycloak compose, done) — `keycloak` block already in compose; `flowable` block is additive next to it.
  - **T-0028** (engine mutation guard, done) — CI probe `ci/checks/flowable-bridge-contract.sh` (FF-G3) activates when `src/bridge/` or `src/core/flowable*.ts` appear; T-0058 does NOT create those paths, so FF-G3 stays dormant (exits 0).
  - **T-0064** (REST client to Flowable — E6.1): consumes the Flowable endpoint defined here; NOT in scope for T-0058.
  - **T-0067** (external task mapping — E6.2): NOT in scope.
  - **E0.7** (prod provisioning, founder-gated): NOT in scope.

---

## 0. Context and seam

**What already exists (do not break):**

- `docker-compose.yml` at repo root defines `postgres` (T-0053) and `keycloak` (T-0054). This task adds the `flowable` service to the same file. Both existing service blocks MUST remain unmodified; `docker compose up` MUST continue to bring up all three services.
- Postgres `ACT_*` readiness: T-0053 ensures the `choros` database and the `choros_migrator` superuser role exist. Flowable's Liquibase-managed `ACT_*` schema objects land in the same database, schema `public` (Flowable default) OR a dedicated schema supplied via Spring env config. The exact schema/role isolation strategy is an implementation detail (DESIGN/BUILD) as long as `ACT_*` tables do not collide with `choros_*` tables.
- CI workflow `.github/workflows/ci.yml`: already wires Postgres and Keycloak. Flowable must be added to CI in the same pattern (bring-up, healthcheck, probe).

**BPMN deploy mechanism choice (deferred to architect — NOT a BLOCKING question):**

The spec defines WHAT: a BPMN XML file MUST be deployable to the running engine and an instance MUST start via REST. The HOW (whether CI uses `POST /repository/deployments` REST deploy in a fitness script, or Flowable's Spring Boot auto-deploy-from-classpath/volume mechanism, or both) is the architect's choice within the boundaries of AC-7..AC-9. Both patterns are proven by the spike.

---

## 1. Summary

T-0058 materializes the **Flowable engine infrastructure substrate** that every prior Choros process-engine ADR references. It delivers: (a) a `flowable` service in `docker-compose.yml`, running the pinned image `flowable/flowable-rest:7.1.0` (Apache 2.0, no enterprise key) with dev credentials via environment; (b) the service uses the **existing shared Postgres instance** via JDBC — `ACT_*` Liquibase-managed tables isolated from `choros_*` tables by schema or naming convention (choice to DESIGN); (c) **a mechanism to deploy BPMN process definitions** — at minimum via the REST API (`POST /flowable-rest/service/repository/deployments`), with optional filesystem/volume pre-seeding (DESIGN choice); (d) a **readiness healthcheck** CI can poll; (e) a **dev-mode profile** appropriate for local / CI use (dev credentials, no prod secrets committed). The task does NOT implement the TS-side REST client (T-0064) nor the external-task mapping (T-0067) nor production provisioning (E0.7).

---

## 2. Scope boundary

T-0058 builds **Flowable engine infrastructure only**:
- Compose service definition (`flowable` block in `docker-compose.yml`).
- Shared-Postgres connectivity (JDBC pointing to the existing `postgres` service, `ACT_*` schema isolation).
- BPMN deployment mechanism (REST deploy path confirmed working; optional filesystem auto-deploy path — DESIGN choice).
- Readiness healthcheck for compose and CI.
- Dev-mode configuration (dev credentials, history-cleanup config, no enterprise key).
- Fitness function scripts under `ci/checks/flowable/` (patterns: `wait-ready.sh`, `deploy-bpmn.sh`, `start-instance.sh` or merged `smoke.sh`).
- CI integration (`.github/workflows/ci.yml` addition).

T-0058 does **NOT**:
- Implement the TS REST client to Flowable — T-0064 (E6.1).
- Implement external-task mapping to JobStore — T-0067 (E6.2).
- Write any Java or JVM code — engine is a black box.
- Write any `src/bridge/` or `src/core/flowable*.ts` files — those are T-0064/T-0067 and will activate FF-G3 (T-0028 contract).
- Configure production credentials or the home-server deployment — E0.7 (founder-gated, RL-1).
- Add a multi-service unified compose file — E0.6.
- Implement history-cleanup operations — fleet-ops scope (ADR §2 note, E0.6+).
- Implement or change the BPMN linter — T-0027 (E2.6, already done).

---

## 3. Functional Requirements

### FR-1 · Flowable service in docker-compose

- `docker-compose.yml` MUST define a `flowable` service running **image `flowable/flowable-rest:7.1.0`** (pinned, Apache 2.0 — no enterprise key; no `:latest`).
- All Flowable credentials and configuration MUST be supplied via **environment variables** with **dev (non-prod) defaults committed**. No production credential is committed (RL-1).
- The service MUST expose an HTTP port configurable via env var (default: non-colliding with `55432` / `8180` / `9000` / `3000`; `8082` is the suggested default). The port MUST be documented as an env var with a sensible default (e.g. `FLOWABLE_PORT=8082`).
- The `flowable` block MUST declare `depends_on: postgres: condition: service_healthy` so compose startup order is guaranteed.

### FR-2 · Shared Postgres substrate (single-Postgres invariant)

- Flowable MUST connect to the **existing `postgres` service** via JDBC (`SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD` — env vars with dev defaults pointing to the `postgres` service).
- Flowable's Liquibase-managed `ACT_*` tables MUST NOT collide with `choros_*` tables. Isolation mechanism (dedicated schema `flowable` via `SPRING_DATASOURCE_SCHEMA` or equivalent Spring/Flowable config, OR rely on `ACT_` prefix uniqueness in `public`) is an implementation detail delegated to DESIGN, but the result MUST be zero naming conflicts verifiable by CI probe.
- No second Postgres instance or separate database container is introduced. The `postgres` service block is unmodified.

### FR-3 · BPMN deployment mechanism

- A BPMN 2.0 XML process definition file MUST be deployable to the running Flowable instance via the **Flowable REST API** (`POST /flowable-rest/service/repository/deployments` with `multipart/form-data`, field name `deployment`). This is the spike-proven mechanism and the path T-0064 will call.
- Optionally, the architect MAY also configure Flowable to auto-deploy BPMN files from a filesystem volume mount at startup (e.g. Spring Boot `flowable.process.definition-location-prefix`). This is additive and does not replace the REST deploy path.
- A **test process definition** (`config/flowable/processes/choros-smoke.bpmn20.xml` or equivalent committed path) MUST be committed to the repository for CI fitness use. The smoke process MUST contain at minimum: a `startEvent`, one `serviceTask` with `flowable:type="external"` and a topic attribute (e.g. `flowable:topic="smoke-topic"`), and an `endEvent` — the simplest valid external-task process.
- REST deploy MUST return HTTP 201 for a valid BPMN XML. REST start-instance (`POST /flowable-rest/service/runtime/process-instances` with `{"processDefinitionKey":"<key>"}`) MUST return HTTP 201 and the instance MUST appear in `/flowable-rest/service/runtime/process-instances`.

### FR-4 · Healthcheck + readiness

- The `flowable` service in compose MUST declare a `healthcheck` that probes the engine's REST management endpoint (e.g. `GET /flowable-rest/service/management/engine` returns HTTP 200 when up, with basic-auth). The probe MUST be executable within the container without additional tooling (e.g. `wget` or `curl` — Flowable REST image ships with `wget`).
- The CI fitness script `ci/checks/flowable/wait-ready.sh` MUST poll the management endpoint until HTTP 200 or 120 s timeout (pattern identical to `ci/checks/kc/wait-ready.sh`).

### FR-5 · Dev mode + no enterprise key

- Flowable MUST start **without any enterprise license key** (Apache 2.0 OSS image only). Any Spring configuration that would require an enterprise feature is not used.
- Admin REST credentials (user/password) MUST be configurable via env vars with dev defaults (e.g. `FLOWABLE_ADMIN_USER=admin`, `FLOWABLE_ADMIN_PASSWORD=<dev-default>`). Dev defaults are committed; no prod secret is committed.
- History cleanup MUST be enabled (idempotent background batch, not a live path). The cleanup schedule MUST be set rare (e.g. yearly cron) so it never fires mid-test — the same pattern proven in the spike (`FLOWABLE_HISTORY_CLEANING_CYCLE="0 0 0 1 1 ?"`).

### FR-6 · CI integration

- `.github/workflows/ci.yml` MUST be extended to start the Flowable service (via compose or direct `docker run`) before the fitness probes run, and wait for readiness.
- The CI job MUST execute the fitness scripts `ci/checks/flowable/wait-ready.sh` + `ci/checks/flowable/deploy-bpmn.sh` (or equivalent single `ci/checks/flowable/smoke.sh`) and fail the job if any exits non-zero.
- `ci/checks/flowable-bridge-contract.sh` (FF-G3, T-0028) MUST continue to exit 0 (bridge not yet present); the CI job already runs this check and it MUST remain green.

---

## 4. Non-Functional Requirements

### NF-1 · Proportionality

The Flowable compose service is infrastructure — identical in principle to the Postgres and Keycloak services already in compose. The deliverable is ~20–30 lines added to `docker-compose.yml`, a committed smoke BPMN file, CI fitness scripts, and CI workflow changes. No application code in `src/` is touched.

### NF-2 · No committed prod secrets (RL-1)

All credentials in `docker-compose.yml` and config files MUST be dev-only values committed for the non-prod environment. Prod credentials are founder-held and injected at deploy (E0.7).

### NF-3 · Single-Postgres invariant (hard constraint from stack ADR)

One Postgres instance per contour. The `flowable` service MUST NOT introduce a second database container. This is a red-line from the stack ADR.

### NF-4 · Unattended startup (CI, no manual steps)

Flowable MUST initialize its `ACT_*` schema objects via Liquibase on first start, automatically, without any DBA or manual SQL steps. The smoke BPMN MUST be deployable and startable by the CI fitness script without any manual intervention.

### NF-5 · Port non-collision

Flowable's host port MUST NOT collide with any already-allocated port: Postgres (`55432`), Keycloak HTTP (`8180`), Keycloak management (`9000`), Node app (`3000`). Suggested default: `FLOWABLE_PORT=8082`.

### NF-6 · Fitness scripts follow established pattern

Fitness scripts under `ci/checks/flowable/` MUST follow the pattern of existing scripts (`ci/checks/kc/wait-ready.sh`, `ci/checks/pg-single-dep.sh`): bash, `set -euo pipefail`, clear PASS/FAIL output, exit 0 on pass, exit 1 on failure.

---

## 5. Out of scope (explicit not-goals)

- TS REST client to Flowable (`src/bridge/`, `src/core/flowable*.ts`) — T-0064.
- External-task to JobStore mapping — T-0067.
- Flowable multi-instance clustering — S3+ (stack ADR §1 path).
- BPMN linter — T-0027 (done).
- Flowable security hardening / RBAC on Flowable REST — not required at E0; Flowable REST is an internal infra endpoint (not exposed externally); engine auth = dev basic-auth only in this task.
- Production server provisioning (E0.7), Tailscale, founder creds.
- Writing Java or JVM code.
- Modifying `src/` application code in any way.
- Operaton fallback container — Flowable 7 is the chosen primary; Operaton remains a de-risked fallback for the future, not implemented here.
- history-cleanup scheduling / autovacuum tuning for `ACT_*` — fleet-ops runbook, out of E0.5 scope.

---

## 6. Acceptance Criteria

### AC-1 · Compose service starts (healthcheck passes)

`docker compose up flowable` (or the full stack) results in the `flowable` service reaching a healthy state, as reported by the compose healthcheck within 120 s. Fitness: `ci/checks/flowable/wait-ready.sh` exits 0.

**verifiable_as:** fitness

### AC-2 · Pinned OSS image, no enterprise key

The `flowable` service in `docker-compose.yml` uses image `flowable/flowable-rest:7.1.0` (exact tag, no `:latest`). No enterprise license key env var is set. Fitness: static grep on `docker-compose.yml` for the exact image and absence of enterprise-license env keys.

**verifiable_as:** fitness

### AC-3 · Shared Postgres, single DB instance

`docker-compose.yml` contains exactly one `postgres` service block (unchanged from T-0053). The `flowable` service's `SPRING_DATASOURCE_URL` points to the `postgres` service (contains `postgres:5432` or `postgres:${POSTGRES_PORT:-5432}`). No second Postgres or database container exists. Fitness: static analysis of `docker-compose.yml` (grep, yaml parse).

**verifiable_as:** fitness

### AC-4 · ACT_* tables created, no collision with choros_*

After `docker compose up` and Flowable startup, the Postgres database contains `ACT_*` tables (created by Flowable Liquibase) AND `choros_*` tables (created by T-0053 migrations). Zero table naming collision between the two sets. Fitness: CI script executes `psql` (or `docker compose exec postgres psql`) and asserts both table families exist and have no name overlap.

**verifiable_as:** fitness

### AC-5 · No prod secret committed

No Flowable password, license key, or credential is committed that matches a prod-pattern (i.e. no value other than obvious dev defaults). Fitness: existing `ci/checks/no-committed-secret.sh` pattern + static check on compose env vars (`FLOWABLE_ADMIN_PASSWORD`, `SPRING_DATASOURCE_PASSWORD`) for presence of a dev-default value.

**verifiable_as:** fitness

### AC-6 · Port non-collision

The Flowable host port (`FLOWABLE_PORT`, default `8082`) does not appear in any other service's port mapping in `docker-compose.yml`. Fitness: parse all host ports from compose; assert uniqueness.

**verifiable_as:** fitness

### AC-7 · BPMN file deployed via REST (HTTP 201)

After Flowable is healthy, `POST /flowable-rest/service/repository/deployments` with the committed smoke BPMN file (`config/flowable/processes/choros-smoke.bpmn20.xml` or equivalent) returns HTTP 201 and a JSON body with a deployment ID. Fitness: `ci/checks/flowable/deploy-bpmn.sh` (or `smoke.sh`) exits 0.

**verifiable_as:** fitness

### AC-8 · Process instance starts via REST (HTTP 201)

After deploy (AC-7), `POST /flowable-rest/service/runtime/process-instances` with `{"processDefinitionKey":"<smoke-process-key>"}` returns HTTP 201. Fitness: same fitness script as AC-7 or `smoke.sh`, checks the HTTP response code.

**verifiable_as:** fitness

### AC-9 · Instance visible in runtime query

After instance start (AC-8), `GET /flowable-rest/service/runtime/process-instances?processDefinitionKey=<smoke-process-key>` returns HTTP 200 and `total >= 1`. Fitness: same fitness script.

**verifiable_as:** fitness

### AC-10 · Smoke BPMN contains external-task step

The committed smoke BPMN file contains at minimum one `serviceTask` with `flowable:type="external"` and a `flowable:topic` attribute. This asserts T-0064 will have a live external-task-producing process to work against. Fitness: XML-parse or grep on the committed BPMN file.

**verifiable_as:** fitness

### AC-11 · FF-G3 (T-0028 flowable-bridge-contract) stays green

`ci/checks/flowable-bridge-contract.sh` exits 0 (no `src/bridge/` or `src/core/flowable*.ts` present — T-0058 does not create those paths). Fitness: CI run of `flowable-bridge-contract.sh`.

**verifiable_as:** fitness

### AC-12 · depends_on postgres: service_healthy

The `flowable` block in `docker-compose.yml` declares `depends_on: postgres: condition: service_healthy`. Fitness: static check / yaml parse.

**verifiable_as:** fitness

### AC-13 · CI workflow extended and green

`.github/workflows/ci.yml` brings up the Flowable service and runs the Flowable fitness scripts. The CI run is green (all prior checks including T-0053 Postgres fitness and T-0054 Keycloak fitness remain green). Fitness: CI pass on branch.

**verifiable_as:** fitness

### AC-14 · History cleanup enabled, cron set rare

Flowable env in `docker-compose.yml` includes `FLOWABLE_ENABLE_HISTORY_CLEANING=true` and `FLOWABLE_HISTORY_CLEANING_CYCLE` set to a rare cron expression (yearly or never-during-tests). Fitness: static grep on `docker-compose.yml`.

**verifiable_as:** fitness

### AC-15 · Existing compose up unbroken

`docker compose up` (all services) completes with all three services (`postgres`, `keycloak`, `flowable`) healthy. The `postgres` and `keycloak` service definitions are byte-identical to the versions merged by T-0053/T-0054 (no regressions). Fitness: diff of those blocks from the baseline commit; compose smoke run in CI.

**verifiable_as:** fitness

---

## 7. Seam summary for downstream tasks

| Consumer task | What it reads from T-0058 |
|---|---|
| T-0064 (E6.1 REST client) | Flowable REST base URL (`http://flowable:8082/flowable-rest/service`), admin creds env vars, smoke BPMN deployed process key |
| T-0067 (E6.2 external-task mapping) | External-task topic in smoke BPMN; runtime process-instances endpoint |
| E0.6 (unified compose) | The `flowable` service block as-is; no change needed here |
| FF-G3 (T-0028) | Will activate when T-0064/T-0067 write `src/bridge/` or `src/core/flowable*.ts` — dormant until then |

---

## 8. Blocking questions

None. The S-1 decision (Flowable vs Operaton) is ratified (2026-06-10, founder). The OSS spike (T-0117) has demonstrated all required capabilities. The stack ADR fixes all architectural decisions. Implementation details (schema isolation strategy, BPMN auto-deploy option, exact port value, fitness script naming) are DESIGN-autonomous per `red-lines.md` ("СУБД-детали, индексация, compose").
