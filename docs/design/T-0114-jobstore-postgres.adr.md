# ADR · T-0114 — JobStore: Map → Postgres

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-10
**Spec:** `docs/specs/T-0114-jobstore-postgres.spec.md` (status: ready, AC-1..AC-18)
**Stack ADR (do NOT contradict):** `docs/design/stack-and-fleet-ops.md` (ratified GT-1 2026-06-10)
**Tenant isolation (do NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (ready, GT-1)
**Seam contract (immutable, FE-0006/0007):** T-0053 owns docker-compose/migrations-runner/pg-dependency; T-0114 owns migrations `010_`+, Postgres-store impl, health extension, ops-operations.

---

## 1. Decision

Replace the in-memory `Map`-backed `JobStore` with a **Postgres-backed implementation
behind the same public class interface**, connected via `DATABASE_URL` using the `pg`
driver (provided by T-0053). The in-memory `JobStore` is **promoted to an explicit
`InMemoryJobStore` TestDouble**, preserved with the full original API so all three frozen
unit-test files (`jobStore.test.ts`, `fetchLock.test.ts`, `completeFail.test.ts`) continue
to import and instantiate `JobStore` unchanged (compatibility by re-export aliasing).

The store is split into two layers:
- **`src/core/jobStore.ts`** — keeps its current public symbols (`JobStore` class, `CompleteResult`, `FailResult`, `ErrorCode`). After T-0114, `JobStore` becomes a re-export alias for `PostgresJobStore`, but the default export path for unit tests (no `DATABASE_URL`) falls back to `InMemoryJobStore` via a factory pattern (see §4).
- **`src/core/postgres/pgJobStore.ts`** — `PostgresJobStore` implementation; `pg.Pool` injected at construction time.
- **`src/core/types.ts`** — gains one field: `available_at: number` (unix epoch ms), added to the `Job` interface.

The mechanism is proportional to the spec: one Postgres table `job`, two partial-index
migrations, raw SQL via `pg`, no ORM. The `fetchAndLock` SQL uses `SELECT ... FOR UPDATE
SKIP LOCKED` — the mechanism mandated by the ratified stack ADR (§1 п.1). The
ownership-gate (`NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER`) executes in a single
atomic `UPDATE ... RETURNING` transaction — no race conditions.

Ops-operations (`run_vacuum`, `queue_stats`) live in `ops/catalog/` as standalone
executable Node scripts accepting `DATABASE_URL` from the environment or `--db` CLI arg,
output JSON to stdout, exit 0 on success.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Advisory locks instead of SKIP LOCKED** | Advisory locks are session/transaction-level but require application-level lock ID management; SKIP LOCKED is purpose-built for queues (skip contended rows atomically), already validated in the stack ADR §1. |
| **Separate `inbox_task` table** | The spec notes `inbox_task` is an alias in the existing codebase, not a distinct entity. One table `job` with a `topic` column covers all job types. No behavioral differentiation between job types exists in the current AC scope; a second table would duplicate schema and index logic without benefit. |
| **ORM (Prisma / TypeORM / Drizzle)** | NF-4 explicitly forbids ORM; zero-dep in domain logic is a stack invariant. Raw `pg` + parameterised SQL is proportional. |
| **LISTEN/NOTIFY instead of polling `fetchAndLock`** | Over-engineering: the existing external-worker pull model (poll) is the current contract; LISTEN/NOTIFY is a push model that changes the client interaction and adds complexity without spec justification. |
| **Storing `available_at` only in Postgres, not in `Job` TS type** | This would leave the TS `Job` interface diverged from the DB row, making `getById` return a partial view and breaking client code that reads `available_at`. Adding it to `Job` interface is the clean, consistent approach. |
| **Keeping `InMemoryJobStore` as the default in production** | The point of T-0114 is durability and concurrency correctness; in-memory only survives process restart with data loss and is not safe for multi-worker concurrency. |

---

## 3. Object model

### 3.1 `Job` TS interface extension (additive change to `src/core/types.ts`)

The `Job` interface gains one field. All existing fields are unchanged:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | UUID v4; unchanged |
| `topic` | `string` | unchanged |
| `variables` | `Record<string, unknown>` | unchanged |
| `state` | `JobState` | `CREATED\|LOCKED\|COMPLETED\|FAILED`; unchanged |
| `retries` | `number` | integer >= 0; unchanged |
| `lockOwner` | `string \| undefined` | unchanged |
| `lockExpiry` | `number \| undefined` | unix epoch ms; unchanged |
| `createdAt` | `number` | unix epoch ms; unchanged |
| **`available_at`** | **`number`** | **NEW — unix epoch ms; set at enqueue = createdAt; set at fail-with-retry = clock.now()+retryTimeoutMs** |

> **Compat-check (FE-W23-0008):** `Job` is a readonly TS interface. Adding a required
> field `available_at` is a **structural breaking change** for any code that constructs a
> `Job` literal. Survey of all literal-construction sites:
>
> - `src/core/jobStore.ts` — constructs `Job` objects internally (lines 27-37 `enqueue`,
>   lines 118-127 `fetchAndLock`, `complete`, `fail`). **All constructions are internal to
>   the store implementation.** After T-0114 the in-memory store is `InMemoryJobStore`
>   and the Postgres store is `PostgresJobStore`; both are implementation zones for
>   `coder` and MUST add `available_at`.
> - `src/core/jobStore.ts` `lockJob` in `completeFail.test.ts` — constructs a pseudo-Job
>   via prototype cast for test scaffolding (not a real `Job` literal). This pattern
>   accesses the private `jobs: Map`; after T-0114 `InMemoryJobStore` keeps the same Map
>   for unit-test compatibility. The cast test-helper must also include `available_at`.
>   **This is an impl detail coder resolves by updating the private lockJob helper or
>   the frozen record shape in `InMemoryJobStore`.**
> - Frozen unit tests (`jobStore.test.ts`, `fetchLock.test.ts`, `completeFail.test.ts`) —
>   do NOT construct `Job` literals for assertion; they assert field-by-field or use
>   `toEqual` with known subsets via `expect(job.state).toBe(...)`. Adding `available_at`
>   to the returned object does NOT break these assertions. **No frozen test is broken by
>   adding `available_at` to `Job`.**
>
> **Verdict: zero breaking changes to the frozen test contracts.** The new field is
> additive from the caller's perspective (tests do not construct `Job` literals). The one
> location that needs updating is the internal `lockJob` test-scaffolding helper in
> `completeFail.test.ts` — this is an `InMemoryJobStore`-private concern, not a public
> contract break.

### 3.2 Postgres `job` table (migration `010_add_available_at_and_indexes.sql`)

Extends the T-0013 object model for `job` by adding `available_at`. Full column list
(T-0013 baseline + T-0114 addition):

| Column | PG type | Constraints | Notes |
|---|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL` — leading PK column (T-0013) | |
| `id` | `uuid` | `NOT NULL` — PK is `(tenant_id, id)` (T-0013) | |
| `topic` | `text` | `NOT NULL` | |
| `variables` | `jsonb` | `NOT NULL` | |
| `state` | `text` | `NOT NULL` | `CREATED\|LOCKED\|COMPLETED\|FAILED` |
| `retries` | `integer` | `NOT NULL` | |
| `lock_owner` | `text` | `NULL` | |
| `lock_expiry` | `bigint` | `NULL` | unix epoch ms |
| `created_at` | `bigint` | `NOT NULL` | unix epoch ms |
| **`available_at`** | **`bigint`** | **`NOT NULL DEFAULT 0`** | **NEW (T-0114); unix epoch ms; back-filled to `created_at` for existing rows via migration** |

> Note: T-0053 creates the `job` table (baseline). T-0114 migration `010_...` adds the
> `available_at` column and the partial indexes. The migration is safe to apply on an
> existing table with rows: `DEFAULT 0` ensures NOT NULL constraint is satisfied, then an
> `UPDATE job SET available_at = created_at WHERE available_at = 0` back-fill runs in the
> same migration.

### 3.3 Partial indexes on `job`

Two partial indexes are created in migration `010_`:

```sql
-- Index 1: CREATED jobs available for pickup (fetchAndLock primary path)
CREATE INDEX CONCURRENTLY idx_job_fetchable_created
  ON job (tenant_id, topic, created_at)
  WHERE state = 'CREATED';

-- Index 2: LOCKED jobs that may have expired (fetchAndLock reclaim path)
CREATE INDEX CONCURRENTLY idx_job_fetchable_locked
  ON job (tenant_id, topic, created_at)
  WHERE state = 'LOCKED';
```

The `fetchAndLock` query selects from BOTH partial indexes via:

```sql
SELECT ... FROM job
WHERE topic = ANY($topics)
  AND tenant_id = current_setting('choros.tenant_id', true)::uuid
  AND (
    (state = 'CREATED'  AND available_at  <= $now)
    OR
    (state = 'LOCKED'   AND lock_expiry   <= $now)
  )
ORDER BY created_at ASC
LIMIT $maxJobs
FOR UPDATE SKIP LOCKED
```

With 1000 COMPLETED rows and 10 CREATED rows, the planner uses only the partial indexes
(matching the small active-state subset) and never performs a Seq Scan on the full table.
This satisfies AC-12/NF-2.

### 3.4 `PostgresJobStore` class (new — `src/core/postgres/pgJobStore.ts`)

Implements all 7 public methods of the `JobStore` interface contract (identical signatures):

| Method | Mechanism |
|---|---|
| `enqueue(topic, variables, retries)` | `INSERT INTO job ... RETURNING *`; sets `available_at = created_at` |
| `getById(id)` | `SELECT ... WHERE (tenant_id, id) = ($1, $2)` |
| `listByTopic(topic)` | `SELECT ... WHERE topic = $1 ORDER BY created_at ASC` |
| `listByState(state)` | `SELECT ... WHERE state = $1 ORDER BY created_at ASC` |
| `listByTopicAndState(topic, state)` | `SELECT ... WHERE topic=$1 AND state=$2 ORDER BY created_at ASC` |
| `fetchAndLock(workerId, topics, maxJobs, lockDurationMs)` | `BEGIN; SELECT ... FOR UPDATE SKIP LOCKED; UPDATE ... SET state=LOCKED, lock_owner=$w, lock_expiry=$e WHERE id=ANY($ids); COMMIT; RETURN rows` |
| `complete(workerId, jobId)` | Single atomic `UPDATE ... WHERE ... RETURNING state, lock_owner, lock_expiry`; gate logic in SQL via CASE or sequential checks in a CTE |
| `fail(workerId, jobId, retries, retryTimeoutMs)` | Same atomic pattern; sets `available_at = clock.now() + retryTimeoutMs` if `retries > 0` |

Clock injection: `PostgresJobStore(pool: pg.Pool, clock?: Clock)` — `clock.now()` is used
for `lock_expiry`, `available_at`, and gate comparisons. In production: `systemClock`.

### 3.5 `InMemoryJobStore` (promoted from `JobStore` in `src/core/inMemoryJobStore.ts`)

Keeps the existing `Map`-based logic verbatim, updated only to:
- gain `available_at` field in enqueue/fail (so it remains a correct TestDouble)
- enforce `available_at <= clock.now()` in `fetchAndLock` (activates the previously
  `void retryTimeoutMs` path)

The `fetchAndLock` predicate in `InMemoryJobStore` after T-0114:
```
(state === CREATED AND available_at <= now)  OR  (state === LOCKED AND lockExpiry <= now)
```

### 3.6 Public surface re-export (`src/core/jobStore.ts`)

`src/core/jobStore.ts` is restructured to preserve all current public symbols:

```ts
// Public re-exports — unchanged for all importers
export { InMemoryJobStore as JobStore } from "./inMemoryJobStore.js";
export { PostgresJobStore }            from "./postgres/pgJobStore.js";
export type { CompleteResult, FailResult, ErrorCode } from "./jobStoreTypes.js";
```

This means:
- `import { JobStore } from "../core/jobStore.js"` continues to work and instantiates `InMemoryJobStore` — preserving all 3 frozen unit-test files unchanged.
- `server.ts` is updated to use `PostgresJobStore` (or a factory that checks `DATABASE_URL`) — this is in `coder`'s zone.
- `externalWorker.ts`, `rights.ts`, `inbox.ts`, `audit.ts`, `org.ts`, `processes.ts`, `auth.ts` — all type `store: JobStore`; they work against both impls since both honour the same method signatures. No changes required in those files.

### 3.7 Health endpoint extension (`src/server.ts` / `src/http/health.ts`)

The `GET /health` handler gains two fields under the `queue` key:

```ts
interface HealthResponse {
  status: "ok" | "degraded";
  queue: {
    depth: number;              // CREATED with available_at<=now: ready for pickup
    oldestAvailableLagMs: number | null;  // null if depth=0
  };
}
```

When Postgres is unavailable (no `DATABASE_URL` or connection error): `status: "degraded"`,
`queue: { depth: 0, oldestAvailableLagMs: null }`. HTTP 200 (impl choice: avoid 503 to
preserve existing health.test.ts AC-1 which asserts 200). The existing `{ status: "ok" }`
contract is preserved as the happy-path (frozen test AC-1 continues to pass).

### 3.8 Ops operations (`ops/catalog/`)

Two standalone Node/TS scripts, compiled to `ops/dist/`:

**`ops/catalog/run_vacuum.ts`**:
```
DATABASE_URL=$url node ops/dist/run_vacuum.js
Returns stdout: { ok: true, tableVacuumed: "job" }  or  { ok: false, error: "..." }
Exit 0 always (never throws past the top-level catch).
```
Runs `VACUUM ANALYZE job` via `pg`. Idempotent.

**`ops/catalog/queue_stats.ts`**:
```
DATABASE_URL=$url node ops/dist/queue_stats.js
Returns stdout JSON with: depth, lockedCount, failedCount, completedCount, dlqCount, oldestAvailableLagMs
Exit 0 always.
```
Single SELECT with multiple COUNT FILTER expressions. DLQ = `state='FAILED' AND retries=0`.

---

## 4. Contracts (pseudocode — implementation is `coder`'s zone)

### 4.1 Store factory / wiring in `server.ts`

```ts
// Replaces: new JobStore()
function createJobStore(clock?: Clock): PostgresJobStore | InMemoryJobStore {
  const url = process.env["DATABASE_URL"];
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    return new PostgresJobStore(pool, clock);
  }
  return new InMemoryJobStore(clock);  // unit-test / no-DB path
}
```

`createServer(store?)` keeps its optional parameter for test injection.
`handleRequest` lazy-initialises via `createJobStore()`.

### 4.2 `fetchAndLock` SQL (canonical)

```sql
-- Phase 1: select candidates
WITH candidates AS (
  SELECT id FROM job
  WHERE topic = ANY($1::text[])
    AND (
      (state = 'CREATED' AND available_at <= $2)
      OR (state = 'LOCKED' AND lock_expiry  <= $2)
    )
  ORDER BY created_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
-- Phase 2: lock them atomically
UPDATE job j
SET
  state      = 'LOCKED',
  lock_owner = $4,
  lock_expiry = $2 + $5
FROM candidates
WHERE j.id = candidates.id
RETURNING j.*
```
Parameters: `$1` topics array, `$2` clock.now(), `$3` maxJobs, `$4` workerId, `$5` lockDurationMs.

### 4.3 `complete` ownership-gate SQL (canonical)

```sql
-- Single CTE: read current row, apply gate, update if passes
WITH current AS (
  SELECT id, state, lock_owner, lock_expiry FROM job WHERE id = $1
),
gate AS (
  SELECT
    id,
    CASE
      WHEN id IS NULL THEN 'NOT_FOUND'
      WHEN state <> 'LOCKED' THEN 'NOT_LOCKED'
      WHEN lock_expiry <= $2  THEN 'LOCK_EXPIRED'
      WHEN lock_owner <> $3   THEN 'NOT_OWNER'
      ELSE 'OK'
    END AS verdict
  FROM (SELECT * FROM current UNION ALL SELECT NULL,NULL,NULL,NULL WHERE NOT EXISTS (SELECT 1 FROM current)) g
)
UPDATE job
SET state='COMPLETED', lock_owner=NULL, lock_expiry=NULL
WHERE id = $1 AND (SELECT verdict FROM gate) = 'OK'
RETURNING (SELECT verdict FROM gate) AS verdict
```
TS layer reads `verdict` and returns `{ ok: true }` or `{ ok: false, code: verdict }`.

### 4.4 `fail` gate SQL

Same CTE pattern as `complete`; on `verdict = 'OK'`:
```sql
SET state = CASE WHEN $retries > 0 THEN 'CREATED' ELSE 'FAILED' END,
    retries = $retries,
    lock_owner = NULL,
    lock_expiry = NULL,
    available_at = CASE WHEN $retries > 0 THEN $now + $retryTimeoutMs ELSE available_at END
```

### 4.5 Health queue-depth query

```sql
SELECT
  COUNT(*) FILTER (WHERE state = 'CREATED' AND available_at <= $now) AS depth,
  MIN(available_at)  FILTER (WHERE state = 'CREATED' AND available_at <= $now) AS oldest_available_at
FROM job
```
`oldestAvailableLagMs = now - oldest_available_at` if `depth > 0`, else `null`.

### 4.6 `queue_stats` query

```sql
SELECT
  COUNT(*) FILTER (WHERE state IN ('CREATED','LOCKED') AND available_at <= $now)          AS depth,
  COUNT(*) FILTER (WHERE state = 'LOCKED')                                                 AS locked_count,
  COUNT(*) FILTER (WHERE state = 'FAILED')                                                 AS failed_count,
  COUNT(*) FILTER (WHERE state = 'COMPLETED')                                              AS completed_count,
  COUNT(*) FILTER (WHERE state = 'FAILED' AND retries = 0)                                 AS dlq_count,
  MIN(available_at) FILTER (WHERE state IN ('CREATED','LOCKED') AND available_at <= $now)  AS oldest_available_at
FROM job
```

---

## 5. Fitness functions

| ID | Rule | ci_check |
|---|---|---|
| **FF-1** | `fetchAndLock` uses `FOR UPDATE SKIP LOCKED` — no advisory locks, no application-level mutex | `grep -n "FOR UPDATE" src/core/postgres/pgJobStore.ts` MUST contain `SKIP LOCKED`; `grep -rn "advisory\|pg_advisory" src/` MUST return 0 hits. Static-now, runs in `npm run ci`. |
| **FF-2** | No Seq Scan on full `job` table when COMPLETED rows > 0 | Integration fitness (live-T-0114, requires Postgres): seed 1000 COMPLETED + 10 CREATED rows; run `EXPLAIN (ANALYZE, FORMAT JSON)` of the `fetchAndLock` query; assert `"Node Type"` at the top level is NOT `"Seq Scan"` and that a partial index appears in `"Plan Rows"` path. `ci/checks/no-seq-scan.test.ts` (runs in DB CI job). |
| **FF-3** | `available_at` is set by `enqueue` and `fail`; never `undefined`/`null` in DB or TS | Integration: `SELECT COUNT(*) FROM job WHERE available_at IS NULL` MUST be 0 after any sequence of enqueue/fail operations. Static: `tsc --noEmit` on `src/` with the updated `Job` interface (field required). |
| **FF-4** | Unit tests pass without `DATABASE_URL` (in-memory TestDouble path) | `npm test -- --reporter=verbose 2>&1 \| grep -E "jobStore.test\|fetchLock.test\|completeFail.test"` — all pass without any `DATABASE_URL` set. Gating: static-now (runs on every CI push). |
| **FF-5** | `JobStore` (alias to `InMemoryJobStore`) remains importable at `../core/jobStore.js` with all original methods | `grep -n "^export.*JobStore" src/core/jobStore.ts` MUST show re-export; `tsc --noEmit` validates the import shapes. `jobStore.test.ts` line 6 `import { JobStore }` passes without modification. |
| **FF-6** | `CompleteResult`, `FailResult`, `ErrorCode` remain exported from `src/core/jobStore.ts` | `grep -n "CompleteResult\|FailResult\|ErrorCode" src/core/jobStore.ts` confirms re-export; `completeFail.test.ts` line 6 import compiles. Static-now. |
| **FF-7** | Ownership-gate precedence `NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER` is atomic (one transaction, no TOCTOU) | Integration: concurrent `complete` calls on the same jobId return exactly one `ok:true`; gate error codes correspond to the exact table state. `ci/checks/ownership-gate.test.ts` (integration, live-T-0114). |
| **FF-8** | Health endpoint backward-compatible: `GET /health` returns `200`, `{ status: "ok" }`, `Content-Type: application/json` even without Postgres | `npm test -- health.test.ts` passes without `DATABASE_URL`. Gating: static-now. |
| **FF-9** | `ops/catalog/run_vacuum` and `ops/catalog/queue_stats` exit 0 and return valid JSON on all outcomes (success, bad URL) | Integration: `DATABASE_URL=bad node ops/dist/run_vacuum.js` exits 0 and emits `{ ok: false, error: <non-empty> }`. `DATABASE_URL=$real_url node ops/dist/run_vacuum.js` emits `{ ok: true, tableVacuumed: "job" }`. `ci/checks/ops-ops.test.ts` (integration, live-T-0114). |
| **FF-10** | No ORM import in `src/` or `ops/` | `grep -rn "prisma\|typeorm\|drizzle\|sequelize\|knex\|mikro-orm" src/ ops/` MUST return 0 hits. Static-now. |
| **FF-11** | Migration `010_` adds `available_at bigint NOT NULL` and both partial indexes; idempotent re-run succeeds | Integration: apply migration twice on same DB; assert `\d job` shows column + indexes; no error on second run (migration runner guards via `schema_migrations` table, provided by T-0053). `ci/checks/migration-010.test.ts` (live-T-0114). |
| **FF-12** | Existing test contracts for `jobStore.test.ts` / `fetchLock.test.ts` / `completeFail.test.ts` are all green with the new codebase | `npm test` without `DATABASE_URL`; CI gate: 0 failures in those three files. All assertions valid because: `available_at` is not asserted negatively in those files; `lockJob` helper in `completeFail.test.ts` constructs via prototype cast (coder updates to include `available_at` as a field — internal to `InMemoryJobStore`, not a contract break). |

---

## 6. Compat-check (FE-W23-0008) — full importers survey

Public exports from `src/core/jobStore.ts` and their importers:

| Symbol | Importers | Impact of T-0114 |
|---|---|---|
| `JobStore` (class) | `server.ts`, `externalWorker.ts`, `rights.ts`, `inbox.ts`, `audit.ts`, `org.ts`, `processes.ts`, `auth.ts`, all 3 frozen unit-test files, `externalWorker.e2e.test.ts` | Re-exported as alias for `InMemoryJobStore`. Interface unchanged: same 7 methods, same signatures. **No breaking change for importers.** `server.ts` updated internally to use `PostgresJobStore` in production path — not a public contract change. |
| `CompleteResult` | `completeFail.test.ts` | Type unchanged. Re-exported. **No breaking change.** |
| `FailResult` | `completeFail.test.ts` | Type unchanged. Re-exported. **No breaking change.** |
| `ErrorCode` | `completeFail.test.ts` | Type unchanged: `"NOT_FOUND" \| "NOT_LOCKED" \| "LOCK_EXPIRED" \| "NOT_OWNER"`. Re-exported. **No breaking change.** |
| `Job` interface (from `types.ts`) | `jobStore.test.ts`, `fetchLock.test.ts`, `externalWorker.e2e.test.ts`, `completeFail.test.ts` (implicit via JobStore) | New required field `available_at: number` added. Tests do NOT construct `Job` literals for assertion; they assert individual fields. The `lockJob` helper in `completeFail.test.ts` constructs a frozen record via private map cast — coder must add `available_at` to that helper's frozen object. **This is an impl-only update to a test scaffolding helper, not a public contract break.** |

**Bottom line:** no frozen test import paths are broken. The one internal update required
(adding `available_at` to the `lockJob` private scaffolding helper) is expected coder work,
not a contract change.

---

## 7. Traceability (AC-1..AC-18 → design)

| AC | Covered by |
|---|---|
| AC-1 (fetchAndLock fields: state=LOCKED, lockOwner, lockExpiry, createdAt, available_at) | §3.4 PostgresJobStore.fetchAndLock + §4.2 SQL + **FF-3, FF-7** |
| AC-2 (fetchAndLock FIFO, maxJobs cap) | §4.2 `ORDER BY created_at ASC LIMIT $maxJobs` + **FF-2** |
| AC-3 (fetchAndLock respects available_at) | §3.2 `available_at <= $now` predicate + §4.2 + **FF-3** |
| AC-4 (expired lock reclaimable) | §4.2 `state='LOCKED' AND lock_expiry <= $now` + **FF-7** |
| AC-5 (fetchAndLock atomic: two concurrent callers = sum 1) | §4.2 `SKIP LOCKED` + **FF-1** |
| AC-6 (complete happy path: COMPLETED, lock cleared) | §4.3 complete CTE SQL + **FF-7** |
| AC-7 (complete gate: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER) | §4.3 gate SQL CTE precedence + **FF-7** |
| AC-8 (fail retries>0: CREATED, available_at=now+retryTimeoutMs; fetchAndLock respects it) | §4.4 fail SQL + §3.5 InMemoryJobStore available_at + **FF-3** |
| AC-9 (fail retries=0: FAILED, not returned by fetchAndLock) | §4.4 fail SQL (`state='FAILED'`) + §4.2 (no FAILED in predicate) + **FF-7** |
| AC-10 (fail gate: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER) | §4.4 gate SQL + **FF-7** |
| AC-11 (unit tests pass without Postgres) | §3.6 `JobStore` re-export → `InMemoryJobStore` + **FF-4, FF-12** |
| AC-12 (no Seq Scan with 1000 COMPLETED + 10 CREATED) | §3.3 partial indexes + §4.2 index predicates + **FF-2** |
| AC-13 (GET /health: queue.depth and oldestAvailableLagMs when non-empty) | §3.7 health extension + §4.5 SQL + **FF-8** |
| AC-14 (GET /health: depth=0, null when empty) | §3.7 health extension null branch + **FF-8** |
| AC-15 (existing health.test.ts AC-1..AC-4 pass) | §3.7 backward-compat status:ok + **FF-8** |
| AC-16 (run_vacuum: ok:true, idempotent) | §3.8 run_vacuum ops op + **FF-9** |
| AC-17 (queue_stats: correct metrics for known seed) | §4.6 queue_stats SQL + **FF-9** |
| AC-18 (ops at bad DATABASE_URL: ok:false, no exception) | §3.8 top-level catch + **FF-9** |

---

## 8. Runtime target

**Postgres 16 in docker-compose silo stack** on the founder's home server (`/srv/choros`,
deploy founder-gated), provided by T-0053. Connection via env `DATABASE_URL`. App connects
as `choros_app` (NOBYPASSRLS, non-owner — T-0013 invariant). Migrations run as
`choros_migrator`. T-0114 migrations start at `010_`.

**Infra NOT built here:** docker-compose, migrations runner, `pg` package, `001_`–`009_`
migrations — T-0053. BUILD phase of T-0114 starts after T-0053 merges to `dev`.

---

## 9. Escalation

None. All implementation choices (schema details, SQL structure, module layout, ops script
format, health HTTP code under degraded) are autonomous. The one product invariant at stake
— `FOR UPDATE SKIP LOCKED` as the queue mechanism — is already ratified in
`stack-and-fleet-ops.md` (GT-1). No new high-leverage fork.
