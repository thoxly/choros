/**
 * src/db/transition-journal.ts — T-0339 [E15-S3]
 *
 * Cycle-time analytics over the F2 Phase 1 transition journal.
 *
 * Reads the 6-event transition journal directly from `choros.audit_event` (migration 006)
 * under RLS (tenant_id GUC enforced via withTenant). The materialized view
 * `choros.process_transition_journal` (migration 079) was revoked and dropped in
 * migration 081 (cross-tenant leak risk); all analytics now query audit_event directly.
 *
 * QUERIES:
 *   1. `loadCycleTimeByActivity`: self-join on (tenant, instance_id, activity) over
 *      the raw audit_event to compute per-step duration. Returns bottleneck list
 *      ordered by avg_duration_ms DESC.
 *   2. `loadActorTypeBreakdown`: GROUP BY actor_type to answer
 *      "human vs agent vs service" split per activity.
 *   3. `loadInstanceJournal`: all 6 events for one instance, ordered by ts.
 *
 * DESIGN INVARIANTS:
 *   - Reads ONLY. No writes, no outbox, no audit emission here.
 *   - All queries run under the caller's tenant-scoped tx (RLS enforced).
 *     Callers that need cross-tenant analytics must use SECURITY DEFINER
 *     functions — this module is single-tenant (choros_app path).
 *   - Uses `payload -> 'transition_payload'` path (F2 Phase 1 embedding) —
 *     NOT a direct column — so it is form-neutral (T-0332 §goal).
 *   - `duration_ms` in the payload is the STEP duration. Instance total duration
 *     is computed as MAX(ts) - MIN(ts) over the full journal for that instance.
 *   - All SQL parameters are $N bindings. No string interpolation of user data.
 *   - NO import from http/* — this is a pure DB module.
 *
 * Usage by report-page-render.ts:
 *   const analytics = await loadCycleTimeByActivity(pool, tenantId);
 *   // analytics.bottleneck = activity with highest avg_duration_ms
 *   // analytics.rows = sorted list for display
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-activity cycle-time aggregate row. */
export interface ActivityCycleTime {
  /** BPMN activity / event type (e.g. "task.claimed", "task.completed"). */
  readonly activity: string;
  /** Average step duration in ms (from transition_payload.duration_ms). */
  readonly avg_duration_ms: number | null;
  /** Total count of this activity in the journal. */
  readonly count: number;
  /** Human vs agent vs service split — count per actor_type for this activity. */
  readonly human_count: number;
  readonly agent_count: number;
  readonly service_count: number;
}

/** Full cycle-time analytics result. */
export interface CycleTimeAnalytics {
  /** Tenant id these results are scoped to. */
  readonly tenant_id: string;
  /** Activity with the highest average duration (the "bottleneck"). */
  readonly bottleneck: string | null;
  /** All activities, ordered by avg_duration_ms DESC (nulls last). */
  readonly rows: ActivityCycleTime[];
}

/** Single event row in an instance journal. */
export interface JournalRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly ts_ms: number;
  readonly instance_id: string | null;
  readonly process_key: string | null;
  readonly activity: string | null;
  readonly actor: string | null;
  readonly actor_type: string | null;
  readonly duration_ms: number | null;
  readonly verdict: string | null;
}

// ---------------------------------------------------------------------------
// UUID guard
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Transition event types for the journal query (mirrors migration 079).
// ---------------------------------------------------------------------------

const TRANSITION_EVENT_TYPES = [
  "instance.started",
  "task.created",
  "task.claimed",
  "gateway.evaluated",
  "task.completed",
  "instance.ended",
] as const;

// ---------------------------------------------------------------------------
// withTenant helper (mirrors deferred-inbox-store.ts / audit-grant-trail.ts)
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// loadCycleTimeByActivity
//
// Self-join on (tenant_id, instance_id) from the raw audit_event to compute
// per-step average duration. Groups by activity (= transition_payload.activity).
//
// The query reads transition_payload directly from audit_event.payload (F2 Phase 1)
// without relying on the mat-view (the mat-view may not have been refreshed yet).
// This is the "source of truth" path; the mat-view is for snapshot/display.
//
// Human vs agent vs service split: extracted from transition_payload.actor_type.
// ---------------------------------------------------------------------------

export async function loadCycleTimeByActivity(
  pool: pg.Pool,
  tenantId: string,
): Promise<CycleTimeAnalytics> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      activity: string;
      avg_duration_ms: string | null;
      total_count: string;
      human_count: string;
      agent_count: string;
      service_count: string;
    }>(
      `SELECT
         (payload -> 'transition_payload' ->> 'activity')   AS activity,
         AVG(
           NULLIF(payload -> 'transition_payload' ->> 'duration_ms', '')::bigint
         )::numeric(20,2)                                   AS avg_duration_ms,
         COUNT(*)                                           AS total_count,
         COUNT(*) FILTER (
           WHERE payload -> 'transition_payload' ->> 'actor_type' = 'human'
         )                                                  AS human_count,
         COUNT(*) FILTER (
           WHERE payload -> 'transition_payload' ->> 'actor_type' = 'agent'
         )                                                  AS agent_count,
         COUNT(*) FILTER (
           WHERE payload -> 'transition_payload' ->> 'actor_type' = 'service'
         )                                                  AS service_count
       FROM choros.audit_event
      WHERE tenant_id = $1
        AND type = ANY($2::text[])
        AND payload ? 'transition_payload'
      GROUP BY (payload -> 'transition_payload' ->> 'activity')
      ORDER BY avg_duration_ms DESC NULLS LAST`,
      [tenantId, TRANSITION_EVENT_TYPES],
    );

    const analyticsRows: ActivityCycleTime[] = rows.map((r) => ({
      activity: r.activity ?? "(unknown)",
      avg_duration_ms: r.avg_duration_ms != null ? parseFloat(r.avg_duration_ms) : null,
      count: parseInt(r.total_count, 10),
      human_count: parseInt(r.human_count, 10),
      agent_count: parseInt(r.agent_count, 10),
      service_count: parseInt(r.service_count, 10),
    }));

    const bottleneck =
      analyticsRows.length > 0 && analyticsRows[0].avg_duration_ms != null
        ? analyticsRows[0].activity
        : null;

    return { tenant_id: tenantId, bottleneck, rows: analyticsRows };
  });
}

// ---------------------------------------------------------------------------
// loadActorTypeBreakdown
//
// GROUP BY (activity, actor_type) — the "human vs agent" breakdown per step.
// Used by report-page-render.ts for the actor-type analytics panel.
// ---------------------------------------------------------------------------

export interface ActorTypeBreakdown {
  readonly activity: string;
  readonly actor_type: string;
  readonly count: number;
}

export async function loadActorTypeBreakdown(
  pool: pg.Pool,
  tenantId: string,
): Promise<ActorTypeBreakdown[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      activity: string;
      actor_type: string;
      cnt: string;
    }>(
      `SELECT
         (payload -> 'transition_payload' ->> 'activity')  AS activity,
         (payload -> 'transition_payload' ->> 'actor_type') AS actor_type,
         COUNT(*)                                           AS cnt
       FROM choros.audit_event
      WHERE tenant_id = $1
        AND type = ANY($2::text[])
        AND payload ? 'transition_payload'
      GROUP BY
         (payload -> 'transition_payload' ->> 'activity'),
         (payload -> 'transition_payload' ->> 'actor_type')
      ORDER BY activity, actor_type`,
      [tenantId, TRANSITION_EVENT_TYPES],
    );

    return rows.map((r) => ({
      activity: r.activity ?? "(unknown)",
      actor_type: r.actor_type ?? "(unknown)",
      count: parseInt(r.cnt, 10),
    }));
  });
}

// ---------------------------------------------------------------------------
// loadInstanceJournal
//
// All 6 transition events for ONE instance, ordered by occurred_at.
// Used by the detail page / report to show the full lifecycle of a single run.
// ---------------------------------------------------------------------------

export async function loadInstanceJournal(
  pool: pg.Pool,
  tenantId: string,
  instanceId: string,
): Promise<JournalRow[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      event_id: string;
      event_type: string;
      ts_ms: string;
      instance_id: string | null;
      process_key: string | null;
      activity: string | null;
      actor: string | null;
      actor_type: string | null;
      duration_ms: string | null;
      verdict: string | null;
    }>(
      `SELECT
         id                                                       AS event_id,
         type                                                     AS event_type,
         occurred_at                                              AS ts_ms,
         (payload -> 'transition_payload' ->> 'instance_id')     AS instance_id,
         (payload -> 'transition_payload' ->> 'process_key')     AS process_key,
         (payload -> 'transition_payload' ->> 'activity')        AS activity,
         (payload -> 'transition_payload' ->> 'actor')           AS actor,
         (payload -> 'transition_payload' ->> 'actor_type')      AS actor_type,
         NULLIF(
           payload -> 'transition_payload' ->> 'duration_ms', ''
         )::bigint                                               AS duration_ms,
         (payload -> 'transition_payload' ->> 'verdict')        AS verdict
       FROM choros.audit_event
      WHERE tenant_id = $1
        AND type = ANY($2::text[])
        AND payload ? 'transition_payload'
        AND (
          payload -> 'transition_payload' ->> 'instance_id' = $3
          -- also match events that carry the instance in the outer payload (task.claimed)
          OR payload ->> 'inst' = $3
          OR payload ->> 'instance_id' = $3
        )
      ORDER BY occurred_at ASC`,
      [tenantId, TRANSITION_EVENT_TYPES, instanceId],
    );

    return rows.map((r) => ({
      event_id: r.event_id,
      event_type: r.event_type,
      ts_ms: parseInt(r.ts_ms, 10),
      instance_id: r.instance_id,
      process_key: r.process_key,
      activity: r.activity,
      actor: r.actor,
      actor_type: r.actor_type,
      duration_ms: r.duration_ms != null ? parseInt(r.duration_ms, 10) : null,
      verdict: r.verdict,
    }));
  });
}
