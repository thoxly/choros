/**
 * src/db/deferred-inbox-store.ts — T-0221 read-only projection: agent.deferred → InboxItem wire.
 *
 * Design: §5.3 of T-0221 ADR. Pattern mirrors src/db/audit-grant-trail.ts:
 *   - reads ONLY choros.audit_event WHERE type='agent.deferred'
 *   - runs inside withTenant() (sets choros.tenant_id GUC)
 *   - explicit WHERE tenant_id=$N for BYPASSRLS pool safety (T-0184 pattern)
 *   - NO INSERT / UPDATE / DELETE — read-only DAO
 *   - NO new tables; known_tenant_tables.txt is unchanged (FF-1/FF-7)
 *
 * FF-7: this file must not contain INSERT, UPDATE, or DELETE.
 * FF-9: only payload.doubt_reason is surfaced — reasoning_trace_ref stays opaque.
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// UUID guard — mirrors audit-grant-trail.ts pattern.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// withTenant — exact copy of the pattern from src/db/audit-grant-trail.ts.
// Sets choros.tenant_id GUC inside a BEGIN/COMMIT/ROLLBACK block.
//
// NOTE: src/db/org.ts does not export withTenant (private). Until a shared
// extraction exists (future cleanup), this local copy is correct by design
// (mirrors audit-grant-trail.ts which carries the same NOTE).
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
// DeferredInboxRow — projected shape from audit_event (agent.deferred).
// Maps to InboxItem fields per §4 of the T-0221 ADR.
// ---------------------------------------------------------------------------

export interface DeferredInboxRow {
  /** audit_event.id — stable task id (== payload.inbox_task_id). */
  id: string;
  /** Role the task is addressed to (payload.defer_role). */
  role: string;
  /** Human-readable name built by planDeferTask (payload.defer_name). */
  name: string;
  /** Doubt reason for the human reviewer (payload.doubt_reason). */
  doubtReason: string;
  /** agent employeeId (audit_event.actor). */
  execName: string;
  /** SLA in minutes (payload.defer_sla_minutes), null if not set. */
  slaMinutes: number | null;
  /** Epoch-ms when the event occurred (audit_event.occurred_at). */
  occurredAt: number;
  /** Skill step context (audit_event.scope->>'skill', typically 'legal_precheck'). */
  step: string;
  /** Subject reference (audit_event.subject, e.g. 'agent:<id>'). */
  inst: string;
}

// ---------------------------------------------------------------------------
// listDeferredInboxTasks — the main read-projection.
//
// Reads audit_event rows with type='agent.deferred' for the given tenant,
// ordered newest-first. LIMIT defaults to 100 (same as queryGrantTrail).
// Returns raw projected rows — mapping to InboxItem wire is done in inbox.ts.
// ---------------------------------------------------------------------------

export async function listDeferredInboxTasks(
  pool: pg.Pool,
  tenantId: string,
  opts?: { limit?: number },
): Promise<DeferredInboxRow[]> {
  const limit = Math.min(opts?.limit ?? 100, 500);

  return withTenant(pool, tenantId, async (client) => {
    // $1 = tenantId (explicit BYPASSRLS guard, mirrors T-0184 / audit-grant-trail.ts).
    // $2 = limit.
    const sql = `
      SELECT
        id,
        actor,
        subject,
        scope,
        payload,
        occurred_at::float8 AS occurred_at
      FROM choros.audit_event
      WHERE type = 'agent.deferred'
        AND tenant_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2
    `;

    const result = await client.query<{
      id: string;
      actor: string;
      subject: string | null;
      scope: Record<string, unknown> | null;
      payload: Record<string, unknown>;
      occurred_at: number;
    }>(sql, [tenantId, limit]);

    return result.rows.map((r) => {
      const payload = r.payload ?? {};
      const scope = r.scope ?? {};

      const doubtReason =
        typeof payload["doubt_reason"] === "string" && payload["doubt_reason"].trim() !== ""
          ? payload["doubt_reason"]
          : "требуется проверка агентом-человеком";

      const role =
        typeof payload["defer_role"] === "string" && payload["defer_role"].trim() !== ""
          ? payload["defer_role"]
          : "fin-ctrl"; // safe default role (matches day-1 demo)

      // name: prefer defer_name from payload (set by updated run-precheck), fallback to «Проверить: <doubtReason>».
      const nameRaw =
        typeof payload["defer_name"] === "string" && payload["defer_name"].trim() !== ""
          ? payload["defer_name"]
          : `Проверить: ${doubtReason}`;
      const name = nameRaw.length > 120 ? `${nameRaw.slice(0, 119)}…` : nameRaw;

      const slaMinutes =
        typeof payload["defer_sla_minutes"] === "number"
          ? payload["defer_sla_minutes"]
          : null;

      const step =
        typeof scope["skill"] === "string" ? scope["skill"] : "legal_precheck";

      const inst = r.subject ?? `agent:${r.actor}`;

      return {
        id: r.id,
        role,
        name,
        doubtReason,
        execName: r.actor,
        slaMinutes,
        occurredAt: r.occurred_at,
        step,
        inst,
      };
    });
  });
}
