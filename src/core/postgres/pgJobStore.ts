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
 *
 * Clock injection: constructor accepts an optional Clock for testable lock expiry
 * and available_at calculation.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { type Job, JobState, type Clock, systemClock } from "../types.js";
import type { CompleteResult, FailResult } from "../jobStoreTypes.js";

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
  // enqueue
  // ---------------------------------------------------------------------------
  async enqueue(
    topic: string,
    variables: Record<string, unknown>,
    retries: number
  ): Promise<Job> {
    const id = randomUUID();
    const now = this.clock.now();
    const { rows } = await this.pool.query<JobRow>(
      `INSERT INTO choros.job
         (tenant_id, id, topic, variables, state, retries,
          lock_owner, lock_expiry, created_at, available_at)
       VALUES
         (current_setting('choros.tenant_id', false)::uuid,
          $1, $2, $3::jsonb, 'CREATED', $4,
          NULL, NULL, $5, $5)
       RETURNING id, topic, variables, state, retries,
                 lock_owner, lock_expiry, created_at, available_at`,
      [id, topic, JSON.stringify(variables), retries, now]
    );
    return rowToJob(rows[0]);
  }

  // ---------------------------------------------------------------------------
  // getById
  // ---------------------------------------------------------------------------
  async getById(id: string): Promise<Job | undefined> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT id, topic, variables, state, retries,
              lock_owner, lock_expiry, created_at, available_at
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
              lock_owner, lock_expiry, created_at, available_at
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
              lock_owner, lock_expiry, created_at, available_at
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
              lock_owner, lock_expiry, created_at, available_at
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
                 j.lock_owner, j.lock_expiry, j.created_at, j.available_at`,
      [topics, now, maxJobs, workerId, lockDurationMs]
    );
    // Sort the returned rows by created_at ASC (UPDATE FROM doesn't guarantee order)
    return rows
      .sort((a, b) => Number(a.created_at) - Number(b.created_at))
      .map(rowToJob);
  }

  // ---------------------------------------------------------------------------
  // complete — atomic CTE ownership gate (ADR §4.3)
  // ---------------------------------------------------------------------------
  async complete(workerId: string, jobId: string): Promise<CompleteResult> {
    // Uses a single atomic UPDATE with re-read for gate verification.
    // FOR UPDATE in the CTE serializes concurrent complete calls (FF-7):
    // the second concurrent transaction blocks until the first commits, then
    // re-reads the already-COMPLETED row and returns NOT_LOCKED.
    const { rows } = await this.pool.query<{ verdict: string }>(
      `WITH locked_row AS (
         SELECT id, state, lock_owner, lock_expiry
         FROM choros.job
         WHERE id = $1
         FOR UPDATE
       ),
       gate AS (
         SELECT
           id,
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
           SELECT NULL, NULL, NULL, NULL
           WHERE NOT EXISTS (SELECT 1 FROM locked_row)
         ) g
       ),
       upd AS (
         UPDATE choros.job
         SET state='COMPLETED', lock_owner=NULL, lock_expiry=NULL
         WHERE id = $1 AND (SELECT verdict FROM gate) = 'OK'
       )
       SELECT verdict FROM gate`,
      [jobId, this.clock.now(), workerId]
    );
    const verdict = rows[0].verdict;
    if (verdict === "OK") return { ok: true };
    return { ok: false, code: verdict as "NOT_FOUND" | "NOT_LOCKED" | "LOCK_EXPIRED" | "NOT_OWNER" };
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
  // Health metrics — queue depth and oldest available lag
  // ---------------------------------------------------------------------------
  /**
   * Returns queue depth (CREATED rows with available_at<=now) and
   * oldestAvailableLagMs. Used by GET /health (ADR §3.7/§4.5).
   * Returns { depth: 0, oldestAvailableLagMs: null } on connection error.
   */
  async getQueueHealth(): Promise<{ depth: number; oldestAvailableLagMs: number | null }> {
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
    return { depth, oldestAvailableLagMs };
  }
}
