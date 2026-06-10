# ADR T-0058 · Flowable Service + BPMN Deployment Mechanism

**Status:** ready
**Task:** T-0058 — E0.5 Flowable engine infrastructure substrate
**Authored:** 2026-06-10
**Sources:** spec `docs/specs/T-0058-flowable-service.spec.md` (15 AC), stack ADR
`docs/design/stack-and-fleet-ops.md` (ratified 2026-06-10), spike addendum
`docs/design/stack-flowable-oss-spike-addendum.md` (ratified 2026-06-10).

---

## 1. Decision

Deploy **`flowable/flowable-rest:7.1.0`** (Apache 2.0, pinned) as a new `flowable` service
in the root `docker-compose.yml`, additive alongside the existing `postgres` (T-0053) and
`keycloak` (T-0054) blocks. The service connects to the **existing shared Postgres instance**
via JDBC using a **dedicated schema `flowable`** created by a Postgres init-script
(`config/postgres/002-flowable-schema.sql`) — exactly the same isolation pattern as
Keycloak's `keycloak` schema (`001-keycloak-schema.sql`). BPMN deployment uses the
**REST API only** (`POST /flowable-rest/service/repository/deployments` multipart) — the
spike-proven mechanism, consumed identically by T-0064. No filesystem volume auto-deploy
is configured: keeping deploy explicit avoids ordering surprises in CI and keeps the
T-0064 REST-client contract the sole canonical deploy path. A committed smoke BPMN
(`config/flowable/processes/choros-smoke.bpmn20.xml`) with an external-task step is used
by CI fitness scripts to verify end-to-end readiness.

**Host port:** `FLOWABLE_PORT=8082` (default, env-overridable). No collision: Postgres
`55432`, Keycloak HTTP `8180`, Keycloak management `9000`, Node app `3000`.

No Java is written. No `src/` files are touched. FF-G3 (T-0028) stays dormant.

---

## 2. Rejected Alternatives

### 2a. Filesystem volume auto-deploy (`flowable.process.definition-location-prefix`)

Configure Flowable to auto-deploy BPMN from a mounted volume at startup.

**Rejected:** adds an implicit ordering dependency (BPMN is "deployed" before CI
fitness starts, making the REST path untested by default). The REST path is what T-0064
will use; CI must exercise it explicitly. The REST path is already spike-proven
(`POST /repository/deployments` → HTTP 201). Optionality adds config complexity for
no gain at this stage.

### 2b. Dedicated Flowable Postgres schema via Spring `spring.datasource.schema` property

Point Flowable's datasource at the `public` schema and rely on `ACT_` name-prefix
uniqueness to avoid collisions with `choros_*` tables.

**Rejected:** `ACT_` prefix uniqueness is a naming convention, not a schema boundary —
a future `choros_*` migration naming mistake would silently collide. The `keycloak`
schema isolation pattern (`KC_DB_SCHEMA=keycloak` + `001-keycloak-schema.sql`) is
already proven in-repo and provides a hard schema boundary verifiable by CI. We replicate
it for Flowable with `002-flowable-schema.sql` + Flowable Spring env
`SPRING_DATASOURCE_SCHEMA=flowable` (note: Flowable 7 uses
`SPRING_DATASOURCE_SCHEMA` or the Spring datasource URL schema param). The schema
boundary is also the only isolation available in silo mode before ACT_* gets RLS
treatment.

### 2c. Second Postgres container for Flowable

Run Flowable against its own Postgres instance.

**Rejected immediately** — hard red-line from the stack ADR (§1 NF-3): one Postgres
instance per contour. No further analysis needed.

### 2d. Operaton 1.0.0 instead of Flowable 7.1.0

The spike addendum (ratified 2026-06-10) demonstrated both engines pass all OSS
capabilities. Operaton's cleanup throughput is higher (~13.6k vs ~7.9k rec/s).

**Rejected** — the stack ADR and the founder's ratification explicitly chose Flowable 7
as primary based on the dedicated deadletter-move REST semantic (AC-9 dedicated `action=move`
vs Operaton's set-retries parity). Operaton remains the documented de-risked fallback.

---

## 3. Object Model / Configuration Contract

This task is infrastructure-only (no TypeScript entities). The "object model" is the
**configuration surface** that downstream tasks (T-0064, T-0067) and CI consume.

### 3.1 Compose service block contract

| Env var | Dev default | Description |
|---|---|---|
| `FLOWABLE_PORT` | `8082` | Host port mapping (`${FLOWABLE_PORT:-8082}:8080`) |
| `SPRING_DATASOURCE_URL` | `jdbc:postgresql://postgres:5432/${POSTGRES_DB:-choros}` | JDBC URL pointing to shared Postgres service |
| `SPRING_DATASOURCE_USERNAME` | `${POSTGRES_USER:-choros_migrator}` | Postgres role — same superuser that owns all schemas |
| `SPRING_DATASOURCE_PASSWORD` | `${POSTGRES_PASSWORD:-choros_dev_pw}` | Dev default; prod value is founder-held (RL-1) |
| `SPRING_DATASOURCE_SCHEMA` | `flowable` | Directs Flowable Liquibase to create `ACT_*` in the `flowable` schema |
| `FLOWABLE_REST_APP_ADMIN_USER_ID` | `admin` | Basic-auth user for REST API (dev only) |
| `FLOWABLE_REST_APP_ADMIN_PASSWORD` | `choros_flowable_dev_pw` | Dev default (RL-1 compliant); see §3.2 for secret-check update |
| `FLOWABLE_ENABLE_HISTORY_CLEANING` | `true` | Enables the OSS scheduled cleanup timer-job |
| `FLOWABLE_HISTORY_CLEANING_CYCLE` | `0 0 0 1 1 ?` | Yearly cron — never fires mid-test; pattern from spike |
| `FLOWABLE_HISTORY_CLEANING_AFTER` | `1` | Cleanup eligible after 1 day |

Additional required Spring env (driver class and Liquibase schema):
```
SPRING_DATASOURCE_DRIVER_CLASS_NAME: org.postgresql.Driver
```

### 3.2 Postgres init-script

`config/postgres/002-flowable-schema.sql`:
```sql
CREATE SCHEMA IF NOT EXISTS flowable;
```
Runs once on Postgres first-init via `docker-entrypoint-initdb.d` (ordered
lexicographically after `001-keycloak-schema.sql`). The schema owner is
`choros_migrator` (POSTGRES_USER). Flowable connects as `choros_migrator` and
Liquibase creates all `ACT_*` tables inside the `flowable` schema.

### 3.3 Smoke BPMN contract

`config/flowable/processes/choros-smoke.bpmn20.xml`:
- Process key: `chorosSmoke`
- Contains: `startEvent` → `serviceTask` (external, topic `smoke-topic`) → `endEvent`
- `flowable:type="external"` + `flowable:topic="smoke-topic"` on the service task
- This is the process T-0064 will use as the first integration target and T-0067 for
  external-task mapping tests.

### 3.4 Fitness script layout

```
ci/checks/flowable/
  wait-ready.sh        # FF-FL-1: poll management/engine until 200 or 120s timeout
  deploy-bpmn.sh       # FF-FL-2: deploy smoke BPMN via REST, assert HTTP 201
  smoke.sh             # FF-FL-3: deploy + start-instance + assert runtime count ≥1
  static-checks.sh     # FF-FL-4..9: grep/parse docker-compose.yml for image pin,
                       #   single-postgres, port collision, secret form, depends_on,
                       #   history-cleanup env, external-task in smoke BPMN
```

The `no-committed-secret.sh` script gains an entry for `choros_flowable_dev_pw` in its
`ALLOWED_DEV_DEFAULTS` list — **additive change** to `ci/checks/no-committed-secret.sh`.

### 3.5 package.json fitness targets (additive-only)

Two new entries are **appended** to existing `package.json` scripts:

- `"fitness:flowable"` — runs live checks (wait-ready + deploy-bpmn + smoke) after
  Flowable is up in CI.
- The existing `"fitness"` script gains `&& bash ci/checks/flowable/static-checks.sh` at
  the end (static-only, no container needed).

**Orchestrator note:** the `fitness` script line is a union-merge target — the coder
appends to the existing bash chain. The `fitness:flowable` key is new; no conflict.

---

## 4. Fitness Functions

### FF-FL-1 · Flowable readiness (live)
**Rule:** After `docker compose up flowable`, `GET /flowable-rest/service/management/engine`
with admin basic-auth returns HTTP 200 within 120 s.
**CI check:** `bash ci/checks/flowable/wait-ready.sh` — polls with `curl -u admin:$FLOWABLE_REST_APP_ADMIN_PASSWORD`, exits 0 on 200, exits 1 on timeout. Pattern mirrors `ci/checks/kc/wait-ready.sh`.

### FF-FL-2 · BPMN deploy via REST (live)
**Rule:** `POST /flowable-rest/service/repository/deployments` with the committed smoke
BPMN returns HTTP 201 and a JSON body containing a deployment ID.
**CI check:** `bash ci/checks/flowable/deploy-bpmn.sh` — uses `curl -u admin:... -F "deployment=@config/flowable/processes/choros-smoke.bpmn20.xml"`, asserts HTTP code 201, extracts and records deployment ID.

### FF-FL-3 · Process instance start + runtime list (live)
**Rule:** After deploy, `POST .../runtime/process-instances {"processDefinitionKey":"chorosSmoke"}` returns HTTP 201; `GET .../runtime/process-instances?processDefinitionKey=chorosSmoke` returns `total >= 1`.
**CI check:** `bash ci/checks/flowable/smoke.sh` — end-to-end: deploy → start → query; exits 0 only if all three HTTP assertions pass.

### FF-FL-4 · Pinned OSS image, no enterprise key (static)
**Rule:** `docker-compose.yml` line `image:` for the `flowable` service is exactly
`flowable/flowable-rest:7.1.0` (no `:latest`, no `:enterprise`, no variant). No env var
named `*LICENSE*`, `*ENTERPRISE*`, or `*ACTIVATION*` is set.
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-4 section): `grep -E 'image:.*flowable/flowable-rest:7\.1\.0'` asserts exact match; `grep -iE '(LICENSE|ENTERPRISE|ACTIVATION)_KEY'` asserts absent.

### FF-FL-5 · Single Postgres invariant (static)
**Rule:** `docker-compose.yml` contains exactly one `image: postgres:16` line. The
`flowable` service's `SPRING_DATASOURCE_URL` contains `postgres:5432` (points to the
compose service named `postgres`, not `localhost` or a separate container).
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-5 section): counts `image: postgres:` occurrences (must be 1); greps `SPRING_DATASOURCE_URL` for `postgres:5432`.

### FF-FL-6 · Port non-collision (static)
**Rule:** All `ports:` host-side values in `docker-compose.yml` are unique. The Flowable
host port (`FLOWABLE_PORT` default `8082`) is not used by any other service.
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-6 section): extracts all
`"hostport:containerport"` host sides via grep/awk, asserts no duplicates. Asserts `8082`
does not appear in non-flowable port mappings.

### FF-FL-7 · Secret form (static)
**Rule:** The `SPRING_DATASOURCE_PASSWORD` and `FLOWABLE_REST_APP_ADMIN_PASSWORD` lines in
compose use the `${VAR:-dev_default}` form. No value other than `choros_dev_pw` or
`choros_flowable_dev_pw` appears as a password literal.
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-7 section) — mirrors the
existing `no-committed-secret.sh` pattern. Also: `no-committed-secret.sh` itself is
updated to allow `choros_flowable_dev_pw` in its `ALLOWED_DEV_DEFAULTS`.

### FF-FL-8 · `depends_on: postgres: condition: service_healthy` (static)
**Rule:** The `flowable` block in `docker-compose.yml` declares
`depends_on.postgres.condition: service_healthy`.
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-8 section): yaml-aware
grep (`-A3 'depends_on:' | grep service_healthy`) or python3 yaml parse on the flowable
block.

### FF-FL-9 · History cleanup env (static)
**Rule:** Compose `flowable` environment contains `FLOWABLE_ENABLE_HISTORY_CLEANING: "true"`
and `FLOWABLE_HISTORY_CLEANING_CYCLE` with a non-empty value.
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-9 section): `grep -E 'FLOWABLE_ENABLE_HISTORY_CLEANING.*true'` + `grep -E 'FLOWABLE_HISTORY_CLEANING_CYCLE'`.

### FF-FL-10 · External-task step in smoke BPMN (static)
**Rule:** `config/flowable/processes/choros-smoke.bpmn20.xml` contains a `serviceTask`
with `flowable:type="external"` and a non-empty `flowable:topic` attribute.
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-10 section):
`grep -E 'flowable:type="external"'` + `grep -E 'flowable:topic='` on the BPMN file.

### FF-FL-11 · Existing service blocks unmodified (static)
**Rule:** The `postgres` and `keycloak` service blocks in `docker-compose.yml` are
byte-identical to the versions from the T-0054 merge commit (HEAD of `dev` = `2f749a9`
baseline).
**CI check:** `bash ci/checks/flowable/static-checks.sh` (FF-FL-11 section): extracts the
`postgres:` and `keycloak:` sections from compose and diffs them against a committed
reference snapshot (or against `git show 2f749a9:docker-compose.yml`); exits non-zero if
any diff.

### FF-FL-12 · ACT_* schema isolation — no table-name collision (live)
**Rule:** After `docker compose up` with Flowable healthy, Postgres contains tables in
both the `flowable` schema (`ACT_*`) and the `public`/migration schema (`choros_*`).
Zero table names appear in both sets.
**CI check:** `bash ci/checks/flowable/smoke.sh` (or a dedicated `ci/checks/flowable/schema-isolation.sh`): runs `psql` inside the postgres container to query
`information_schema.tables` for both schemas; asserts `flowable.*` tables exist, `choros_*`
tables exist (in `public`), and the name intersection is empty.

### FF-G3 · Bridge contract (dormant) — preserved
**Rule:** `src/bridge/` and `src/core/flowable*.ts` MUST NOT exist in this task's diff.
T-0028's FF-G3 exits 0 when bridge is absent.
**CI check:** `bash ci/checks/flowable-bridge-contract.sh` — already in `fitness` chain;
T-0058 introduces no `src/bridge/` or `src/core/flowable*.ts`; FF-G3 exits 0 throughout.

---

## 5. Traceability (AC → Design)

| AC | Design location |
|---|---|
| AC-1 · Compose service starts (healthcheck passes) | §3.1 compose block healthcheck; §4 FF-FL-1 `wait-ready.sh` |
| AC-2 · Pinned OSS image, no enterprise key | §3.1 image pin; §4 FF-FL-4 static check |
| AC-3 · Shared Postgres, single DB instance | §3.1 `SPRING_DATASOURCE_URL`; §4 FF-FL-5 |
| AC-4 · ACT_* tables created, no collision with choros_* | §3.2 init-script `002-flowable-schema.sql`; §4 FF-FL-12 |
| AC-5 · No prod secret committed | §3.1 `${VAR:-dev_default}` form; §4 FF-FL-7; `no-committed-secret.sh` update |
| AC-6 · Port non-collision | §3.1 `FLOWABLE_PORT=8082`; §4 FF-FL-6 |
| AC-7 · BPMN deployed via REST (HTTP 201) | §3.3 smoke BPMN; §3.4 `deploy-bpmn.sh`; §4 FF-FL-2 |
| AC-8 · Process instance starts via REST (HTTP 201) | §3.3 smoke BPMN key `chorosSmoke`; §4 FF-FL-3 |
| AC-9 · Instance visible in runtime query | §4 FF-FL-3 `smoke.sh` (GET runtime/process-instances total≥1) |
| AC-10 · Smoke BPMN contains external-task step | §3.3 smoke BPMN (`flowable:type="external"`, topic `smoke-topic`); §4 FF-FL-10 |
| AC-11 · FF-G3 stays green | §4 FF-G3 note; no `src/bridge/` or `src/core/flowable*.ts` in scope |
| AC-12 · depends_on postgres: service_healthy | §3.1 compose contract; §4 FF-FL-8 |
| AC-13 · CI workflow extended and green | §3.5 package.json additions; CI `.github/workflows/ci.yml` new `flowable` job |
| AC-14 · History cleanup enabled, cron set rare | §3.1 `FLOWABLE_ENABLE_HISTORY_CLEANING=true` + cycle; §4 FF-FL-9 |
| AC-15 · Existing compose up unbroken | §3.1 additive compose constraint; §4 FF-FL-11 |

---

## 6. CI Workflow Extension

A new CI job `flowable` is added to `.github/workflows/ci.yml` (additive, does not modify
the existing `ci` or `db` jobs):

```yaml
flowable:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Start Flowable stack (postgres + flowable via compose)
      run: docker compose up -d postgres flowable
    - name: Wait for Flowable readiness
      run: bash ci/checks/flowable/wait-ready.sh
    - name: Static fitness checks
      run: bash ci/checks/flowable/static-checks.sh
    - name: Deploy + smoke BPMN
      run: bash ci/checks/flowable/smoke.sh
    - name: Schema isolation check
      run: docker compose exec -T postgres psql -U choros_migrator -d choros \
             -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='flowable'"
    - name: FF-G3 bridge contract (must remain green)
      run: bash ci/checks/flowable-bridge-contract.sh
```

The Flowable container exposes port `8082` on the CI runner (via compose `ports:` with
`FLOWABLE_PORT=8082` default). The `wait-ready.sh` script polls
`http://localhost:8082/flowable-rest/service/management/engine` with admin basic-auth.

---

## 7. Runtime Target

**Container (docker-compose), local and CI.** The `flowable` service runs as a compose
service on the same host as `postgres` and `keycloak`. All configuration is via env vars
with dev-only defaults committed. Production provisioning (E0.7) is founder-gated (GT-4);
this task delivers dev/CI substrate only.

---

## 8. Seam Contracts for Downstream Tasks

| Consumer | Contract |
|---|---|
| T-0064 (E6.1 REST client) | Base URL `http://flowable:8082/flowable-rest/service` (internal compose DNS) / `http://localhost:8082/flowable-rest/service` (host-side). Admin creds via `FLOWABLE_REST_APP_ADMIN_USER_ID` / `FLOWABLE_REST_APP_ADMIN_PASSWORD`. Smoke process key: `chorosSmoke`. |
| T-0067 (E6.2 external-task mapping) | External-task topic: `smoke-topic` (in `chorosSmoke` BPMN). Runtime endpoint: `GET /flowable-rest/service/runtime/process-instances`. |
| E0.6 (unified compose) | `flowable` service block as-is; no change required in T-0058. |
| `no-committed-secret.sh` | Must allow `choros_flowable_dev_pw` in `ALLOWED_DEV_DEFAULTS`. |

---

## 9. Escalation

None. All architectural decisions are within the ratified stack ADR boundaries. No
product-loop or cross-vendor sparring required. Image, schema strategy, BPMN deploy
mechanism, port, and dev credentials are all implementation details delegated to DESIGN
per `red-lines.md`.
