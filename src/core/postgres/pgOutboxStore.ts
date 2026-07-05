/**
 * PostgresOutboxStore — Postgres-backed outbox store (T-0062, E1.2).
 *
 * Implements the interface in docs/design/T-0062-idempotency-outbox.adr.md §4.2.
 * Uses raw `pg` SQL with parameterised queries (NF-3: no ORM).
 * claimBatch uses FOR UPDATE SKIP LOCKED (AC-12, образец T-0116 fetchAndFire).
 * Clock injection follows pgJobStore/pgTimerStore (T-0114/T-0116, NF-5).
 *
 * RLS invariants (T-0013/T-0053):
 *   - enqueueInTx / claimBatch / markDispatched / markRetry: caller MUST have
 *     SET choros.tenant_id GUC (transaction-scoped). RLS + FORCE enforce isolation.
 *   - pendingBuckets / getOutboxHealth: execute WITHOUT GUC (migrator pool /
 *     SECURITY DEFINER aggregate across all tenants). Throw on Postgres error
 *     (caller catches → degraded).
 *
 * Fail-closed (AC-5, NF-1): without GUC → enqueueInTx INSERT raises Postgres
 * error; claimBatch/markDispatched/markRetry SELECT/UPDATE return 0 rows.
 *
 * State monotonicity (T-0019 no-decrement, ADR §4.2):
 *   claimBatch takes only state='pending'; markDispatched advances only from
 *   'dispatching'; markRetry returns to 'pending' only from 'dispatching'.
 *   attempts only increments. dispatched→pending and attempts-decrement are
 *   structurally impossible (no SQL path emits them).
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "../types.js";
import type { OutboxRow, OutboxInsert, OutboxState } from "../outboxTypes.js";

// ---------------------------------------------------------------------------
// Public result type for getOutboxHealth
// ---------------------------------------------------------------------------

export interface OutboxHealthResult {
  pendingLagMs: number | null;
  deadCount: number;
}

// ---------------------------------------------------------------------------
// Row shape from Postgres (snake_case DB → camelCase TS)
// ---------------------------------------------------------------------------

interface OutboxDbRow {
  tenant_id: string;
  id: string;
  aggregate_kind: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  state: string;
  idempotency_key: string;
  attempts: number;
  created_at: string;        // bigint comes back as string from pg
  available_at: string;      // bigint comes back as string from pg
  dispatched_at: string | null;
  last_error: string | null;
}

const RETURNING_COLS = `tenant_id, id, aggregate_kind, aggregate_id, event_type,
  payload, state, idempotency_key, attempts, created_at, available_at,
  dispatched_at, last_error`;

// Same column list, qualified with the `o.` table alias (for UPDATE … RETURNING).
const RETURNING_COLS_O = `o.tenant_id, o.id, o.aggregate_kind, o.aggregate_id, o.event_type,
  o.payload, o.state, o.idempotency_key, o.attempts, o.created_at, o.available_at,
  o.dispatched_at, o.last_error`;

function rowToOutbox(row: OutboxDbRow): OutboxRow {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload as Record<string, unknown>,
    state: row.state as OutboxState,
    idempotencyKey: row.idempotency_key,
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    dispatchedAt: row.dispatched_at != null ? Number(row.dispatched_at) : undefined,
    lastError: row.last_error ?? undefined,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// PostgresOutboxStore
// ---------------------------------------------------------------------------

export class PostgresOutboxStore {
  private readonly pool: pg.Pool;
  private readonly clock: Clock;

  constructor(pool: pg.Pool, clock?: Clock) {
    this.pool = pool;
    this.clock = clock ?? systemClock;
  }

  // -------------------------------------------------------------------------
  // enqueueInTx — INSERT a 'pending' outbox row using the CALLER's client.
  //
  // Atomicity (AC-8, FR-3): this method does NOT open its own transaction. It
  // runs on the client/transaction supplied by the consumer, so the domain
  // mutation and the outbox INSERT commit/rollback together — one logical
  // transaction "data + signal" (CONCEPT §6).
  //
  // R-4 note: tenant_id is taken from the GUC current_setting('choros.tenant_id',
  // false)::uuid (same pattern as pgJobStore/pgTimerStore.enqueue). The caller
  // MUST have SET choros.tenant_id (LOCAL or session) before calling. Fail-closed:
  // INSERT raises on missing GUC (AC-5).
  // -------------------------------------------------------------------------
  async enqueueInTx(
    client: pg.PoolClient,
    row: OutboxInsert
  ): Promise<OutboxRow> {
    const id = randomUUID();
    const now = this.clock.now();
    const availableAt = row.availableAt ?? now;
    const { rows } = await client.query<OutboxDbRow>(
      `INSERT INTO choros.outbox
         (tenant_id, id, aggregate_kind, aggregate_id, event_type, payload,
          state, idempotency_key, attempts, created_at, available_at,
          dispatched_at, last_error)
       VALUES
         (current_setting('choros.tenant_id', false)::uuid,
          $1, $2, $3, $4, $5::jsonb,
          'pending', $6, 0, $7, $8,
          NULL, NULL)
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING ${RETURNING_COLS}`,
      [
        id,
        row.aggregateKind,
        row.aggregateId,
        row.eventType,
        JSON.stringify(row.payload),
        row.idempotencyKey,
        now,
        availableAt,
      ]
    );
    if (rows.length > 0) {
      return rowToOutbox(rows[0]);
    }
    // ON CONFLICT case: idempotency key already exists — SELECT-back the existing row
    // (образец pgJobStore.enqueue idempotency, ADR §6).
    const sel = await client.query<OutboxDbRow>(
      `SELECT ${RETURNING_COLS} FROM choros.outbox
       WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid
         AND idempotency_key = $1`,
      [row.idempotencyKey]
    );
    return rowToOutbox(sel.rows[0]);
  }

  // -------------------------------------------------------------------------
  // pendingBuckets — Phase-1 cross-tenant aggregate (AC-9, AC-10).
  //
  // Calls the SECURITY DEFINER function choros.outbox_pending_buckets(before).
  // Executes WITHOUT GUC (the function bypasses RLS and aggregates all tenants).
  // Returns ONLY (tenantId, pendingCount) — no row data leaks.
  // -------------------------------------------------------------------------
  async pendingBuckets(
    before: number
  ): Promise<Array<{ tenantId: string; pendingCount: number }>> {
    const { rows } = await this.pool.query<{ tenant_id: string; pending_count: string }>(
      `SELECT tenant_id, pending_count
       FROM choros.outbox_pending_buckets($1)`,
      [before]
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      pendingCount: Number(r.pending_count),
    }));
  }

  // -------------------------------------------------------------------------
  // claimBatch — Phase-2 per-tenant claim (AC-11, AC-12).
  //
  // BEGIN; SET LOCAL choros.tenant_id = $tenantId;
  // CTE SELECT FOR UPDATE SKIP LOCKED LIMIT N (state='pending' AND available_at<=now)
  // → UPDATE state='dispatching'; COMMIT.
  //
  // RLS auto-filters to tenantId via GUC. FOR UPDATE SKIP LOCKED = concurrent-safe
  // (exactly one claimer per row, образец T-0116 fetchAndFire).
  //
  // R-3 defence: tenantId is UUID-validated before interpolation into SET LOCAL.
  // -------------------------------------------------------------------------
  async claimBatch(tenantId: string, limit: number): Promise<OutboxRow[]> {
    if (limit <= 0) return [];
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`claimBatch: invalid tenantId '${tenantId}'`);
    }
    const now = this.clock.now();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      const { rows } = await client.query<OutboxDbRow>(
        `WITH candidates AS (
           SELECT id FROM choros.outbox
           WHERE state = 'pending'
             AND available_at <= $1
           ORDER BY available_at ASC, created_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE choros.outbox o
         SET state = 'dispatching'
         FROM candidates
         WHERE o.id = candidates.id
         RETURNING ${RETURNING_COLS_O}`,
        [now, limit]
      );

      await client.query("COMMIT");
      // UPDATE … FROM doesn't guarantee order — sort by availableAt/createdAt ASC.
      return rows
        .map(rowToOutbox)
        .sort(
          (a, b) =>
            a.availableAt - b.availableAt || a.createdAt - b.createdAt
        );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {/* ignore */});
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // markDispatched — 'dispatching' → 'dispatched' + dispatched_at (AC-13).
  //
  // Monotonic-forward (T-0019): advances ONLY from 'dispatching'. rowCount gate:
  // if 0, the row was already taken/advanced by a concurrent dispatcher — harmless.
  // Caller MUST have SET choros.tenant_id (explicit tenant_id predicate is added
  // for defense-in-depth against BYPASSRLS connections, как pgTimerStore.done).
  // -------------------------------------------------------------------------
  async markDispatched(tenantId: string, id: string): Promise<boolean> {
    const now = this.clock.now();
    const { rowCount } = await this.pool.query(
      `UPDATE choros.outbox
       SET state = 'dispatched', dispatched_at = $3
       WHERE tenant_id = $1
         AND id = $2
         AND state = 'dispatching'`,
      [tenantId, id, now]
    );
    return (rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // markRetry — 'dispatching' → 'pending' (attempts+1, backoff) OR → 'dead'.
  //
  // Monotonic-forward (T-0019): transitions ONLY from 'dispatching'. attempts is
  // ALWAYS incremented (never decremented). If attempts+1 >= maxAttempts the row
  // becomes 'dead' (terminal, never re-claimed, AC-14); otherwise it returns to
  // 'pending' with available_at = now + backoffMs (AC-13).
  //
  // Returns the resulting state ('pending' | 'dead'). Caller MUST have SET
  // choros.tenant_id; explicit tenant_id predicate = defense-in-depth.
  // -------------------------------------------------------------------------
  async markRetry(
    tenantId: string,
    id: string,
    backoffMs: number,
    error: string,
    maxAttempts: number
  ): Promise<"pending" | "dead" | "noop"> {
    const now = this.clock.now();
    // Single atomic UPDATE: compute next state from (attempts+1) vs maxAttempts.
    // available_at: for 'dead' it is irrelevant (never re-claimed), keep now.
    const { rows } = await this.pool.query<{ state: string }>(
      `UPDATE choros.outbox
       SET
         attempts     = attempts + 1,
         last_error   = $4,
         state        = CASE WHEN attempts + 1 >= $5 THEN 'dead' ELSE 'pending' END,
         available_at = CASE WHEN attempts + 1 >= $5 THEN available_at ELSE $3 END
       WHERE tenant_id = $1
         AND id = $2
         AND state = 'dispatching'
       RETURNING state`,
      [tenantId, id, now + backoffMs, error, maxAttempts]
    );
    if (rows.length === 0) return "noop";
    return rows[0].state as "pending" | "dead";
  }

  // -------------------------------------------------------------------------
  // getOutboxHealth — lag + dead metrics for GET /health (AC-16).
  //
  // Executes WITHOUT GUC (migrator pool — no RLS filter; aggregates all tenants,
  // как getTimerHealth). Throws on Postgres error; caller wraps → degraded.
  //
  // Returns:
  //   pendingLagMs: now - oldest pending available_at (already due), or null
  //                 if no pending row is due.
  //   deadCount:    total rows in 'dead' state (silent-failure P1 signal).
  // -------------------------------------------------------------------------
  async getOutboxHealth(): Promise<OutboxHealthResult> {
    const now = this.clock.now();
    const { rows } = await this.pool.query<{
      oldest_available_at: string | null;
      dead_count: string;
    }>(
      `SELECT
         MIN(available_at) FILTER (WHERE state = 'pending' AND available_at <= $1)
           AS oldest_available_at,
         COUNT(*) FILTER (WHERE state = 'dead') AS dead_count
       FROM choros.outbox`,
      [now]
    );
    const oldest =
      rows[0].oldest_available_at != null
        ? Number(rows[0].oldest_available_at)
        : null;
    const pendingLagMs = oldest != null ? now - oldest : null;
    const deadCount = Number(rows[0].dead_count);
    return { pendingLagMs, deadCount };
  }

  // -------------------------------------------------------------------------
  // T-0644 (P0/столп4) — reviveDeadOutboxRows: one-time reconciliation for
  // rows that went 'dead' BECAUSE OF the workerId mismatch this task fixes.
  //
  // Rationale: before this fix, EVERY task_completed/task_failed row produced
  // by a component OTHER than the bridge itself (concretely: the agent
  // dispatcher, whose payload carries "choros-agent-dispatcher" as workerId)
  // was rejected by Flowable on every delivery attempt (workerId mismatch vs
  // the actual lock-holder) → 5 attempts exhausted → state='dead' (terminal,
  // NEVER re-claimed by the normal dispatch loop, ADR §4.2 monotonicity). Those
  // rows are now safely deliverable (makeExternalTaskDeliver ignores
  // payload.workerId and always uses the bridge's own workerId), but a 'dead'
  // row is never automatically re-picked-up — someone has to explicitly move
  // it back to 'pending' once the fix is deployed.
  //
  // This is NOT a blanket "revive everything dead" operation (a row can be
  // dead for many OTHER legitimate reasons — a genuinely gone Flowable
  // instance, a permanently invalid payload, etc. — resurrecting those would
  // just burn another 5 attempts for nothing). It is scoped tightly:
  //   - eventType IN ('task_completed', 'task_failed')  — the two event types
  //     this bug's outbox payload shape applies to (worker_lock_expired and
  //     notification rows are untouched — no-op / different producer).
  //   - state = 'dead'                                  — only terminal rows.
  //   - payload->>'workerId' <> bridgeWorkerId           — the diagnostic
  //     fingerprint of THIS bug: a row whose payload workerId does not match
  //     the bridge's own identity is exactly the shape this fix targets. A
  //     dead row whose payload.workerId ALREADY equals the bridge's own
  //     identity died for some OTHER reason (e.g. a genuinely gone instance)
  //     and is deliberately left alone (fail-closed — never guess).
  //
  // Resets attempts=0 and last_error=NULL so the row gets the FULL retry
  // budget again under the (now-fixed) delivery path — a fresh start, not a
  // continuation of the old failure count.
  //
  // Callable manually (via a one-shot script — see src/outbox-revive-runner.ts)
  // AFTER the fix is deployed; NEVER auto-run on every pass (that would risk
  // masking a future, different systemic failure as "just replay it").
  // Executes WITHOUT GUC (migrator pool, mirrors getOutboxHealth) — this is an
  // operator action across all tenants, by design (the bug was tenant-agnostic).
  // -------------------------------------------------------------------------
  async reviveDeadOutboxRows(bridgeWorkerId: string): Promise<number> {
    const now = this.clock.now();
    const { rowCount } = await this.pool.query(
      `UPDATE choros.outbox
       SET state = 'pending',
           attempts = 0,
           available_at = $2,
           last_error = NULL
       WHERE state = 'dead'
         AND event_type IN ('task_completed', 'task_failed')
         AND payload->>'workerId' IS DISTINCT FROM $1`,
      [bridgeWorkerId, now],
    );
    return rowCount ?? 0;
  }
}
