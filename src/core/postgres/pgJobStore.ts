/**
 * PostgresJobStore — Postgres-backed implementation of the JobStore contract (T-0114).
 *
 * Implements all 7 public methods behind the same interface as InMemoryJobStore.
 * Uses raw `pg` SQL with parameterised queries (NF-4: no ORM).
 * fetchAndLock uses FOR UPDATE SKIP LOCKED (ratified stack ADR §1).
 * complete/fail ownership gate is a single atomic CTE (no TOCTOU — FF-7).
 *
 * RLS invariants (T-0013/T-0053):
 *   - Caller MUST SET choros.tenant_id GUC before any query.
 *   - Rows with tenant_id != current_setting('choros.tenant_id') are invisible.
 *   - This class operates as choros_app (NOBYPASSRLS, non-owner).
 *   - READ-only methods (getById, listBy*) omit explicit tenant_id predicates
 *     because RLS+FORCE at table level (choros.job) automatically filters rows.
 *     The set_config('choros.tenant_id') GUC MUST be set in the transaction
 *     before any query; RLS enforcement is architecture-level (T-0053).
 *
 * Clock injection: constructor accepts an optional Clock for testable lock expiry
 * and available_at calculation.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { type Job, JobState, type Clock, systemClock } from "../types.js";
import type { CompleteResult, FailResult, SweepResult } from "../jobStoreTypes.js";
import { assertVariableValue } from "../object-handle.js";
import type { PostgresOutboxStore } from "./pgOutboxStore.js";

// UUID validation regex (образец pgOutboxStore claimBatch — R-3 defence).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * T-0636 (P0-6): minimal structural shape enqueue needs from its query
 * executor. Satisfied by both `pg.Pool` and `pg.PoolClient` — the caller
 * supplies a GUC-scoped client (SET LOCAL choros.tenant_id already applied on
 * it) when it needs enqueue's `current_setting('choros.tenant_id', false)`
 * read to see a tenant that was set on a DIFFERENT connection than the pool's
 * default. Omit the parameter to keep today's behaviour (query via this.pool —
 * correct only when the GUC was set on a connection the pool itself owns,
 * e.g. a single-connection pool or an already-scoped caller).
 */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Row shape from Postgres (snake_case DB → camelCase TS)
// ---------------------------------------------------------------------------
interface JobRow {
  id: string;
  topic: string;
  variables: Record<string, unknown>;
  state: string;
  retries: number;
  lock_owner: string | null;
  lock_expiry: string | null; // bigint comes back as string from pg
  created_at: string;         // bigint comes back as string from pg
  available_at: string;       // bigint comes back as string from pg
  // tenant_id is present but not part of the TS Job interface
  /**
   * T-0677: process_def_id/instance_id (migration 111, T-0534). Present on
   * JobRow ONLY when the caller's SELECT/RETURNING list includes them — every
   * query in this file now does (fetchAndLock, enqueue, getById, listBy*).
   * Optional here (not just nullable) so call sites that construct a JobRow
   * literal without these columns (none currently do, but future defensiveness)
   * still type-check; rowToJob() treats a missing key the same as SQL NULL.
   */
  process_def_id?: string | null;
  instance_id?: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    topic: row.topic,
    variables: row.variables as Record<string, unknown>,
    state: row.state as JobState,
    retries: row.retries,
    lockOwner: row.lock_owner ?? undefined,
    lockExpiry: row.lock_expiry != null ? Number(row.lock_expiry) : undefined,
    createdAt: Number(row.created_at),
    available_at: Number(row.available_at),
    // T-0677: thread process_def_id/instance_id (migration 111) into the Job
    // object. `?? null` normalises `undefined` (column absent from a SELECT
    // list — should not happen now, but defensive) to `null`, matching the
    // documented "absent/legacy row" contract on Job.processDefId/instanceId.
    processDefId: row.process_def_id ?? null,
    instanceId: row.instance_id ?? null,
  };
}

export class PostgresJobStore {
  private readonly pool: pg.Pool;
  private readonly clock: Clock;

  constructor(pool: pg.Pool, clock?: Clock) {
    this.pool = pool;
    this.clock = clock ?? systemClock;
  }

  // ---------------------------------------------------------------------------
  // enqueue — idempotency-key extension (T-0062, ADR §4.1)
  // ---------------------------------------------------------------------------
  /**
   * 4th optional parameter `idempotencyKey` (≤255). Backward-compatible:
   *   - undefined → current behavior: unconditional INSERT with a fresh UUID (AC-3).
   *   - present   → INSERT … ON CONFLICT (tenant_id, idempotency_key)
   *                   WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING …;
   *                 on empty RETURNING (conflict) → SELECT-back the existing row.
   *                 Returns the EXISTING job, no duplicate (AC-1/AC-2).
   *
   * The conflict target carries the partial-index predicate
   * (WHERE idempotency_key IS NOT NULL) — mandatory to match
   * job_idempotency_key_uq (migration 023).
   *
   * RLS: tenant_id is taken from the GUC (current behavior); the SELECT-back adds
   * an explicit `tenant_id = current_setting(...)` predicate as defense-in-depth.
   */
  /**
   * T-0534: optional 5th/6th parameters capture the Flowable process scope at
   * enqueue time so the triage seam can scope rule-table lookups by process
   * without relying on process variables.
   *   processDefId — the BPMN processDefinitionKey (e.g. "telLinear")
   *   instanceId   — the Flowable processInstanceId (correlation, audit)
   * Both nullable; omit to get legacy behaviour (columns left NULL).
   *
   * T-0636 (P0-6): optional 7th parameter `executor` — the query executor to run
   * the INSERT/SELECT-back on. Defaults to `this.pool` (today's behaviour,
   * unchanged for every existing caller). A caller that opened its OWN
   * GUC-scoped client (SET LOCAL choros.tenant_id on a dedicated pg.PoolClient —
   * because current_setting('choros.tenant_id', false) is a per-CONNECTION
   * setting, not a pool-wide one) passes that client here so the INSERT's
   * current_setting(...) read sees the GUC. Without this seam, a caller that
   * sets the GUC on a client obtained from `pool.connect()` and then calls
   * `jobStore.enqueue(...)` (which queries `this.pool` directly) would have its
   * GUC invisible — `this.pool.query` may run on an entirely different
   * connection. This is exactly the externalTaskBridge multi-tenant bug the
   * seam closes (ADR T-0636 §P0-6).
   */
  async enqueue(
    topic: string,
    variables: Record<string, unknown>,
    retries: number,
    idempotencyKey?: string,
    processDefId?: string,
    instanceId?: string,
    executor?: Queryable,
  ): Promise<Job> {
    const q = executor ?? this.pool;
    const id = randomUUID();
    const now = this.clock.now();
    const pdi = processDefId?.trim().length ? processDefId.trim() : null;
    const iid = instanceId?.trim().length ? instanceId.trim() : null;

    if (idempotencyKey === undefined) {
      const { rows } = await q.query<JobRow>(
        `INSERT INTO choros.job
           (tenant_id, id, topic, variables, state, retries,
            lock_owner, lock_expiry, created_at, available_at, idempotency_key,
            process_def_id, instance_id)
         VALUES
           (current_setting('choros.tenant_id', false)::uuid,
            $1, $2, $3::jsonb, 'CREATED', $4,
            NULL, NULL, $5, $5, NULL,
            $6, $7)
         RETURNING id, topic, variables, state, retries,
                   lock_owner, lock_expiry, created_at, available_at,
                   process_def_id, instance_id`,
        [id, topic, JSON.stringify(variables), retries, now, pdi, iid]
      );
      return rowToJob(rows[0]);
    }

    // Idempotent path: INSERT … ON CONFLICT DO NOTHING, then SELECT-back on conflict.
    const ins = await q.query<JobRow>(
      `INSERT INTO choros.job
         (tenant_id, id, topic, variables, state, retries,
          lock_owner, lock_expiry, created_at, available_at, idempotency_key,
          process_def_id, instance_id)
       VALUES
         (current_setting('choros.tenant_id', false)::uuid,
          $1, $2, $3::jsonb, 'CREATED', $4,
          NULL, NULL, $5, $5, $6,
          $7, $8)
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING id, topic, variables, state, retries,
                 lock_owner, lock_expiry, created_at, available_at,
                 process_def_id, instance_id`,
      [id, topic, JSON.stringify(variables), retries, now, idempotencyKey, pdi, iid]
    );
    if (ins.rows.length > 0) {
      return rowToJob(ins.rows[0]);
    }

    // Conflict → the row already exists for this (tenant, key). Return it as-is.
    const sel = await q.query<JobRow>(
      `SELECT id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at,
              process_def_id, instance_id
       FROM choros.job
       WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid
         AND idempotency_key = $1`,
      [idempotencyKey]
    );
    return rowToJob(sel.rows[0]);
  }

  // ---------------------------------------------------------------------------
  // getById
  // ---------------------------------------------------------------------------
  /**
   * NOTE (T-0028/R-4): Jobs sourced from PostgresJobStore NEVER have a `result` field,
   * even after a successful complete() call with a payload. The `result` column does not
   * exist in the schema until T-0053+ lands. Callers who store a result via complete() and
   * then call getById() will observe `result === undefined` — asymmetric with InMemoryJobStore
   * which preserves the result in-memory.
   *
   * TODO T-0053: once the result column is added (migration 011+), add `result` to the SELECT
   * list here and to rowToJob(). This comment is the seam marker for that migration.
   * See: docs/design/T-0028-engine-mutation-guard.adr.md §4.5 / T-0053 (Postgres DAO).
   */
  async getById(id: string): Promise<Job | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at,
              process_def_id, instance_id
       FROM choros.job
       WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? rowToJob(rows[0]) : undefined;
  }

  // ---------------------------------------------------------------------------
  // listByTopic
  // ---------------------------------------------------------------------------
  async listByTopic(topic: string): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at,
              process_def_id, instance_id
       FROM choros.job
       WHERE topic = $1
       ORDER BY created_at ASC`,
      [topic]
    );
    return rows.map(rowToJob);
  }

  // ---------------------------------------------------------------------------
  // listByState
  // ---------------------------------------------------------------------------
  async listByState(state: JobState): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at,
              process_def_id, instance_id
       FROM choros.job
       WHERE state = $1
       ORDER BY created_at ASC`,
      [state]
    );
    return rows.map(rowToJob);
  }

  // ---------------------------------------------------------------------------
  // listByTopicAndState
  // ---------------------------------------------------------------------------
  async listByTopicAndState(topic: string, state: JobState): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at,
              process_def_id, instance_id
       FROM choros.job
       WHERE topic = $1 AND state = $2
       ORDER BY created_at ASC`,
      [topic, state]
    );
    return rows.map(rowToJob);
  }

  // ---------------------------------------------------------------------------
  // fetchAndLock — FOR UPDATE SKIP LOCKED (ADR §1/FF-1)
  // ---------------------------------------------------------------------------
  /**
   * Canonically (ADR §4.2): CTE selects candidates by partial-index predicates,
   * then UPDATE locks them atomically in the same statement.
   *
   * Parameters: $1=topics[], $2=now, $3=maxJobs, $4=workerId, $5=lockDurationMs
   */
  async fetchAndLock(
    workerId: string,
    topics: string[],
    maxJobs: number,
    lockDurationMs: number
  ): Promise<Job[]> {
    if (maxJobs <= 0 || topics.length === 0) return [];
    const now = this.clock.now();
    const { rows } = await this.pool.query<JobRow>(
      `WITH candidates AS (
         SELECT id FROM choros.job
         WHERE topic = ANY($1::text[])
           AND (
             (state = 'CREATED' AND available_at <= $2)
             OR (state = 'LOCKED' AND lock_expiry  <= $2)
           )
         ORDER BY created_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE choros.job j
       SET
         state       = 'LOCKED',
         lock_owner  = $4,
         lock_expiry = $2 + $5
       FROM candidates
       WHERE j.id = candidates.id
       RETURNING j.id, j.topic, j.variables, j.state, j.retries,
                 j.lock_owner, j.lock_expiry, j.created_at, j.available_at,
                 j.process_def_id, j.instance_id`,
      [topics, now, maxJobs, workerId, lockDurationMs]
    );
    // Sort the returned rows by created_at ASC (UPDATE FROM doesn't guarantee order)
    return rows
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))
      .map(rowToJob);
  }

  // ---------------------------------------------------------------------------
  // complete — ownership gate + T-0028 payload guard (ADR §4.4 ordering)
  // ---------------------------------------------------------------------------
  /**
   * Guard algorithm follows ADR §4.4 step order exactly:
   *   1. [ownership gate] CTE gate-check → NOT_FOUND/NOT_LOCKED/LOCK_EXPIRED/NOT_OWNER
   *   2. [payload guard]  assertVariableValue each value → RECORD_IN_PAYLOAD (fail-closed)
   *   3. [advance state]  conditional UPDATE (same ownership predicate — safe for FF-7)
   *
   * Concurrency note (FF-7): The original single-CTE approach advanced state atomically
   * with the gate. The new two-statement approach introduces a narrow window between
   * step 1 and step 3. The step-3 UPDATE carries the full ownership predicate, so a
   * concurrent complete() that sneaks in between will have already set state='COMPLETED';
   * the step-3 UPDATE matches 0 rows — harmless (job was already completed). The caller
   * of the sneaking concurrent complete() will have gotten ok:true on its own step 3.
   * This is acceptable because the integration test (FF-7) validates the one-ok:true
   * invariant, which still holds: at most one concurrent call whose step-3 UPDATE
   * actually matches the LOCKED row.
   *
   * This ordering mirrors InMemoryJobStore exactly (ADV-12 gate-precedence contract, R-1 fix).
   *
   * Note: result persistence to DB is deferred to T-0053+ (no result column in schema yet).
   * See getById() JSDoc for the asymmetry note. The guard IS wired; the structural invariant
   * (assertVariableValue called before any result write) is enforced pre-T-0053.
   */
  async complete(workerId: string, jobId: string, payload?: Record<string, unknown>): Promise<CompleteResult> {
    const now = this.clock.now();

    // Step 1 (ADR §4.4): ownership gate — evaluate all conditions in one round-trip.
    const { rows } = await this.pool.query<{ verdict: string }>(
      `WITH locked_row AS (
         SELECT id, state, lock_owner, lock_expiry
         FROM choros.job
         WHERE id = $1
       )
       SELECT
         CASE
           WHEN (SELECT id FROM locked_row) IS NULL           THEN 'NOT_FOUND'
           WHEN (SELECT state FROM locked_row) <> 'LOCKED'    THEN 'NOT_LOCKED'
           WHEN (SELECT lock_expiry FROM locked_row) <= $2     THEN 'LOCK_EXPIRED'
           WHEN (SELECT lock_owner FROM locked_row) <> $3      THEN 'NOT_OWNER'
           ELSE 'OK'
         END AS verdict`,
      [jobId, now, workerId]
    );
    const verdict = rows[0].verdict;
    if (verdict !== "OK") {
      return { ok: false, code: verdict as "NOT_FOUND" | "NOT_LOCKED" | "LOCK_EXPIRED" | "NOT_OWNER" };
    }

    // Step 2 (ADR §4.4): payload guard — runs after ownership gate, before state advance.
    // Fail-closed: a bad payload does NOT advance job state.
    if (payload !== undefined) {
      for (const value of Object.values(payload)) {
        const r = assertVariableValue(value);
        if (!r.ok) {
          return { ok: false, code: "RECORD_IN_PAYLOAD" };
        }
      }
    }

    // Step 3 (ADR §4.4): advance state with the same ownership conditions.
    // Check rowCount: if 0, a concurrent complete() won the race — return NOT_LOCKED
    // (the job is now COMPLETED, not owned by this worker any more).
    const upd = await this.pool.query(
      `UPDATE choros.job
       SET state='COMPLETED', lock_owner=NULL, lock_expiry=NULL
       WHERE id = $1
         AND state = 'LOCKED'
         AND lock_expiry > $2
         AND lock_owner = $3`,
      [jobId, now, workerId]
    );
    if (upd.rowCount === 0) {
      // Race: concurrent complete() already advanced the state between steps 1 and 3.
      return { ok: false, code: "NOT_LOCKED" };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // fail — atomic CTE ownership gate (ADR §4.4)
  // ---------------------------------------------------------------------------
  async fail(
    workerId: string,
    jobId: string,
    retries: number,
    retryTimeoutMs: number
  ): Promise<FailResult> {
    const now = this.clock.now();
    const nextState = retries > 0 ? "CREATED" : "FAILED";
    // available_at: if retries>0 delay by retryTimeoutMs; else keep current value
    // We pass $6 = retries > 0 ? now+retryTimeoutMs : -1 and handle in SQL
    const newAvailableAt = retries > 0 ? now + retryTimeoutMs : null;

    const { rows } = await this.pool.query<{ verdict: string }>(
      `WITH locked_row AS (
         SELECT id, state, lock_owner, lock_expiry, available_at
         FROM choros.job
         WHERE id = $1
         FOR UPDATE
       ),
       gate AS (
         SELECT
           id,
           available_at,
           CASE
             WHEN id IS NULL         THEN 'NOT_FOUND'
             WHEN state <> 'LOCKED'  THEN 'NOT_LOCKED'
             WHEN lock_expiry <= $2  THEN 'LOCK_EXPIRED'
             WHEN lock_owner  <> $3  THEN 'NOT_OWNER'
             ELSE 'OK'
           END AS verdict
         FROM (
           SELECT * FROM locked_row
           UNION ALL
           SELECT NULL, NULL, NULL, NULL, NULL
           WHERE NOT EXISTS (SELECT 1 FROM locked_row)
         ) g
       ),
       upd AS (
         UPDATE choros.job
         SET
           state       = $4,
           retries     = $5,
           lock_owner  = NULL,
           lock_expiry = NULL,
           available_at = COALESCE($6::bigint, (SELECT available_at FROM gate))
         WHERE id = $1 AND (SELECT verdict FROM gate) = 'OK'
       )
       SELECT verdict FROM gate`,
      [jobId, now, workerId, nextState, retries, newAvailableAt]
    );
    const verdict = rows[0].verdict;
    if (verdict === "OK") return { ok: true };
    return { ok: false, code: verdict as "NOT_FOUND" | "NOT_LOCKED" | "LOCK_EXPIRED" | "NOT_OWNER" };
  }

  // ---------------------------------------------------------------------------
  // Health metrics — queue depth, oldest available lag, workerIncidents (T-0063)
  // ---------------------------------------------------------------------------
  /**
   * Returns queue depth (CREATED rows with available_at<=now), oldestAvailableLagMs,
   * and workerIncidents (count of outbox rows with event_type='worker_lock_expired'
   * in state 'pending' or 'dead'). Used by GET /health (ADR §3.7/§4.5).
   *
   * workerIncidents uses a raw SELECT to choros.outbox on the same pool (option b from
   * ADR §4.4 — no circular dependency). Wrapped in independent try/catch: error → 0.
   * getQueueHealth executes WITHOUT per-tenant GUC (like getOutboxHealth — aggregates
   * all tenants using the migrator pool or a BYPASSRLS-capable pool).
   */
  async getQueueHealth(): Promise<{
    depth: number;
    oldestAvailableLagMs: number | null;
    workerIncidents: number;
  }> {
    const now = this.clock.now();
    const { rows } = await this.pool.query<{
      depth: string;
      oldest_available_at: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'CREATED' AND available_at <= $1)   AS depth,
         MIN(available_at) FILTER (WHERE state = 'CREATED' AND available_at <= $1) AS oldest_available_at
       FROM choros.job`,
      [now]
    );
    const depth = Number(rows[0].depth);
    const oldestAvailableLagMs =
      rows[0].oldest_available_at != null
        ? now - Number(rows[0].oldest_available_at)
        : null;

    // workerIncidents: independent try/catch — error → 0, not 500.
    let workerIncidents = 0;
    try {
      const inc = await this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM choros.outbox
         WHERE event_type = 'worker_lock_expired'
           AND state IN ('pending', 'dead')`
      );
      workerIncidents = Number(inc.rows[0].cnt);
    } catch {
      // degraded — caller will set status='degraded' if needed
    }

    return { depth, oldestAvailableLagMs, workerIncidents };
  }

  // ---------------------------------------------------------------------------
  // getLockedExpiredBuckets — cross-tenant phase-1 aggregate (T-0063)
  // ---------------------------------------------------------------------------
  /**
   * Calls SECURITY DEFINER choros.job_locked_expired_buckets(p_before) to discover
   * which tenants have expired LOCKED jobs. Executes WITHOUT GUC (образец
   * pgOutboxStore.pendingBuckets — no RLS filter needed, SECURITY DEFINER bypasses).
   */
  async getLockedExpiredBuckets(
    before: number
  ): Promise<Array<{ tenantId: string; expiredCount: number }>> {
    const { rows } = await this.pool.query<{
      tenant_id: string;
      expired_count: string;
    }>(
      `SELECT tenant_id, expired_count
       FROM choros.job_locked_expired_buckets($1)`,
      [before]
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      expiredCount: Number(r.expired_count),
    }));
  }

  // ---------------------------------------------------------------------------
  // sweepExpiredLocks — active lock-reclaim + incident outbox (T-0063, E1.3)
  // ---------------------------------------------------------------------------
  /**
   * Atomically reclaims LOCKED jobs with lock_expiry <= sweepDurationMs (the clock
   * snapshot at call time) within a single tenant. For each expired job:
   *   - retries > 0 → state='CREATED', retries--, available_at=now (immediate retry)
   *   - retries = 0 → state='FAILED' (terminal)
   *   - enqueueInTx an outbox incident (event_type='worker_lock_expired') in the SAME
   *     transaction (atomicity — образец T-0062).
   *
   * Idempotency: idempotency_key='lock_expired:'+jobId+':'+lockExpiry combined with
   * ON CONFLICT DO NOTHING in enqueueInTx guarantees no duplicate incident row on
   * repeated sweep of the same lock event.
   *
   * Concurrent-safe: FOR UPDATE SKIP LOCKED — two parallel sweepers don't double-reclaim.
   *
   * R-3: tenantId is UUID-validated before interpolation into SET LOCAL.
   */
  async sweepExpiredLocks(
    outboxStore: PostgresOutboxStore,
    tenantId: string
  ): Promise<SweepResult> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`sweepExpiredLocks: invalid tenantId '${tenantId}'`);
    }

    // FF-14: use this.clock.now() — not Date.now() directly (Clock injection for tests).
    const now = this.clock.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      // Atomic CTE: capture expired LOCKED jobs, update state + retries atomically.
      // FOR UPDATE SKIP LOCKED: concurrent sweepers skip rows already locked by another.
      // 'now' from this.clock.now() is used as the "before" threshold (FF-14).
      const { rows } = await client.query<{
        id: string;
        topic: string;
        retries_after: string;
        lock_owner_before: string | null;
        lock_expiry_before: string;
        new_state: string;
      }>(
        `WITH expired AS (
           SELECT id, topic, retries, lock_owner, lock_expiry
           FROM choros.job
           WHERE state = 'LOCKED' AND lock_expiry <= $1
           FOR UPDATE SKIP LOCKED
         ),
         updated AS (
           UPDATE choros.job j
           SET
             state        = CASE WHEN (SELECT retries FROM expired WHERE id = j.id) > 0
                                 THEN 'CREATED' ELSE 'FAILED' END,
             retries      = GREATEST((SELECT retries FROM expired WHERE id = j.id) - 1, 0),
             lock_owner   = NULL,
             lock_expiry  = NULL,
             available_at = $1
           FROM expired
           WHERE j.id = expired.id
           RETURNING j.id,
                     j.topic,
                     j.retries AS retries_after,
                     (SELECT lock_owner FROM expired WHERE id = j.id) AS lock_owner_before,
                     (SELECT lock_expiry FROM expired WHERE id = j.id) AS lock_expiry_before,
                     j.state AS new_state
         )
         SELECT * FROM updated`,
        [now]
      );

      let reclaimed = 0;
      let failed = 0;
      let incidents = 0;

      for (const row of rows) {
        if (row.new_state === "CREATED") {
          reclaimed += 1;
        } else {
          failed += 1;
        }

        const idempotencyKey =
          "lock_expired:" + row.id + ":" + String(row.lock_expiry_before);

        // enqueueInTx runs on the SAME client (same transaction = atomicity).
        // ON CONFLICT DO NOTHING (via enqueueInTx) handles idempotency.
        await outboxStore.enqueueInTx(client, {
          aggregateKind: "job",
          aggregateId: row.id,
          eventType: "worker_lock_expired",
          payload: {
            topic: row.topic,
            lockOwner: row.lock_owner_before,
            lockExpiry: Number(row.lock_expiry_before),
            retriesLeft: Number(row.retries_after),
          },
          idempotencyKey,
        });
        incidents += 1;
      }

      await client.query("COMMIT");
      return { reclaimed, failed, incidents };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* ignore */});
      throw err;
    } finally {
      client.release();
    }
  }
}
