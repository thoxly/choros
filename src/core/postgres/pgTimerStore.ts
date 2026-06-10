/**
 * PostgresTimerStore — Postgres-backed durable timer store (T-0116).
 *
 * Implements enqueue / fetchAndFire / cancel / done / getTimerHealth
 * by the interface in docs/design/T-0116-app-timer.adr.md §3.6.
 *
 * Uses raw `pg` SQL with parameterised queries (NF-4: no ORM, FF-T9).
 * fetchAndFire uses FOR UPDATE SKIP LOCKED (FF-T6, ADR §4.2).
 * Clock injection follows the same pattern as PostgresJobStore (T-0114).
 *
 * RLS invariants:
 *   - enqueue / fetchAndFire / cancel / done: caller MUST have SET choros.tenant_id
 *     GUC before (or inside) the transaction. RLS + FORCE enforce isolation.
 *   - getTimerHealth: executes without GUC (migrator pool or equivalent). Aggregates
 *     timer lag across all tenants. Throws on Postgres error (caller catches → degraded).
 *
 * Fail-closed (AC-1, FR-3): without GUC → INSERT raises Postgres error;
 * SELECT / UPDATE return 0 rows.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "../types.js";
import type { AppTimer, TimerState } from "../timerTypes.js";

// ---------------------------------------------------------------------------
// Public result type for getTimerHealth
// ---------------------------------------------------------------------------

export interface TimerHealthResult {
  timerLagMs: number | null;
}

// ---------------------------------------------------------------------------
// Row shape from Postgres (snake_case DB → camelCase TS)
// ---------------------------------------------------------------------------

interface AppTimerRow {
  tenant_id: string;
  id: string;
  due_at: string;          // bigint comes back as string from pg
  state: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;      // bigint comes back as string from pg
  fired_at: string | null; // bigint or null
  cancel_reason: string | null;
}

function rowToTimer(row: AppTimerRow): AppTimer {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    dueAt: Number(row.due_at),
    state: row.state as TimerState,
    kind: row.kind,
    payload: row.payload as Record<string, unknown>,
    createdAt: Number(row.created_at),
    firedAt: row.fired_at != null ? Number(row.fired_at) : undefined,
    cancelReason: row.cancel_reason ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// PostgresTimerStore
// ---------------------------------------------------------------------------

export class PostgresTimerStore {
  private readonly pool: pg.Pool;
  private readonly clock: Clock;

  constructor(pool: pg.Pool, clock?: Clock) {
    this.pool = pool;
    this.clock = clock ?? systemClock;
  }

  // ---------------------------------------------------------------------------
  // enqueue — INSERT state='pending'; caller must have SET GUC choros.tenant_id.
  // Fail-closed: current_setting('choros.tenant_id', false) raises if GUC absent.
  //
  // R-4 note: `tenantId` is accepted as a parameter for interface consistency
  // with cancel() / done() / fetchAndFire(), but the actual tenant_id stored in
  // the row is taken from the GUC `current_setting('choros.tenant_id', false)`
  // (same pattern as pgJobStore.enqueue, ADR §8). The parameter is NOT used in
  // the SQL.  Callers MUST SET choros.tenant_id before calling enqueue(); the GUC
  // is the authoritative source of truth, and mismatching tenantId vs. GUC is a
  // caller bug (fail-closed: INSERT will raise on missing GUC).
  // ---------------------------------------------------------------------------
  async enqueue(
    tenantId: string,
    kind: string,
    payload: Record<string, unknown>,
    dueAt: number
  ): Promise<AppTimer> {
    const id = randomUUID();
    const now = this.clock.now();
    const { rows } = await this.pool.query<AppTimerRow>(
      `INSERT INTO choros.app_timer
         (tenant_id, id, due_at, state, kind, payload, created_at)
       VALUES
         (current_setting('choros.tenant_id', false)::uuid,
          $1, $2, 'pending', $3, $4::jsonb, $5)
       RETURNING tenant_id, id, due_at, state, kind, payload,
                 created_at, fired_at, cancel_reason`,
      [id, dueAt, kind, JSON.stringify(payload), now]
    );
    return rowToTimer(rows[0]);
  }

  // ---------------------------------------------------------------------------
  // fetchAndFire — Two-phase tenant-scoped dispatcher (ADR §4.2, FF-T6).
  //
  // BEGIN; SET LOCAL choros.tenant_id = $tenantId;
  // CTE SELECT FOR UPDATE SKIP LOCKED LIMIT N → UPDATE state='firing'; COMMIT.
  //
  // RLS auto-filters to tenantId via GUC (AC-6, AC-7).
  // FOR UPDATE SKIP LOCKED = concurrent-safe (AC-8, FF-T6).
  //
  // R-3 defence: tenantId is UUID-validated before interpolation into SET LOCAL.
  // pg simple-query protocol allows multi-statement; a non-UUID tenantId could
  // in theory inject SQL. Even though callers always supply a DB-sourced UUID,
  // explicit validation makes the method safe in isolation.
  // ---------------------------------------------------------------------------
  async fetchAndFire(
    tenantId: string,
    dueBeforeMs: number,
    limit: number
  ): Promise<AppTimer[]> {
    if (limit <= 0) return [];
    // R-3: Validate tenantId is a UUID before interpolating into SET LOCAL.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(tenantId)) throw new Error(`fetchAndFire: invalid tenantId '${tenantId}'`);
    const now = this.clock.now();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      const { rows } = await client.query<AppTimerRow>(
        `WITH candidates AS (
           SELECT id FROM choros.app_timer
           WHERE state = 'pending'
             AND due_at < $1
           ORDER BY due_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE choros.app_timer t
         SET
           state    = 'firing',
           fired_at = $3
         FROM candidates
         WHERE t.id = candidates.id
         RETURNING t.tenant_id, t.id, t.due_at, t.state, t.kind,
                   t.payload, t.created_at, t.fired_at, t.cancel_reason`,
        [dueBeforeMs, limit, now]
      );

      await client.query("COMMIT");
      return rows.map(rowToTimer);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* ignore */});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // cancel — UPDATE state='cancelled' WHERE tenant_id=$1 AND id=$2 AND state='pending'.
  // Returns true if a row was updated (false = not found or not pending).
  //
  // R-1 fix: explicit `tenant_id = $1` predicate added for defense-in-depth.
  // RLS via GUC already enforces tenant isolation for choros_app connections,
  // but without an explicit SQL predicate a BYPASSRLS connection (e.g. migrator
  // or future ops-catalog admin script) would silently ignore tenantId and could
  // cancel a timer belonging to any tenant.
  // ---------------------------------------------------------------------------
  async cancel(tenantId: string, timerId: string, reason?: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE choros.app_timer
       SET state = 'cancelled', cancel_reason = $3
       WHERE tenant_id = $1
         AND id = $2
         AND state = 'pending'`,
      [tenantId, timerId, reason ?? null]
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // done — UPDATE state='done' WHERE tenant_id=$1 AND id=$2 AND state='firing'.
  // Returns true if a row was updated (false = not found or not firing).
  //
  // R-2 fix: explicit `tenant_id = $1` predicate added for defense-in-depth.
  // Same rationale as cancel() (R-1): without explicit predicate a BYPASSRLS
  // connection would ignore tenantId and transition any tenant's timer to 'done'.
  // ---------------------------------------------------------------------------
  async done(tenantId: string, timerId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE choros.app_timer
       SET state = 'done'
       WHERE tenant_id = $1
         AND id = $2
         AND state = 'firing'`,
      [tenantId, timerId]
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // getTimerHealth — lag metric for GET /health (ADR §4.3, AC-9, AC-10, AC-11).
  //
  // Executes WITHOUT GUC (migrator pool — no RLS filter; aggregates all tenants).
  // Throws on Postgres error; caller wraps in try/catch → degraded (AC-11).
  //
  // Returns: { timerLagMs: number } if overdue timers exist, { timerLagMs: null } otherwise.
  // ---------------------------------------------------------------------------
  async getTimerHealth(): Promise<TimerHealthResult> {
    const now = this.clock.now();
    const { rows } = await this.pool.query<{ oldest_overdue_at: string | null }>(
      `SELECT MIN(due_at) AS oldest_overdue_at
       FROM choros.app_timer
       WHERE state = 'pending' AND due_at <= $1`,
      [now]
    );
    const oldestOverdueAt = rows[0].oldest_overdue_at != null
      ? Number(rows[0].oldest_overdue_at)
      : null;
    const timerLagMs = oldestOverdueAt != null ? now - oldestOverdueAt : null;
    return { timerLagMs };
  }
}
