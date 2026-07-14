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
import { humanizeDoubtReason } from "../core/defer-inbox-producer.js";

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
  /**
   * T-0638 (F1): the REAL Flowable process-instance id (payload.instance_id),
   * when the defer event carries it (live agent-dispatch path,
   * dispatch-outcome.ts's deferredAuditEvent). null for legacy/legal-precheck
   * events authored before this field existed (run-precheck.ts's demo-run
   * path does not thread ctx.instanceId the same way) — a null instanceId
   * means this defer row cannot be routed to a live engine instance (there is
   * no instance to drive), which the /action route surfaces as an honest 404
   * rather than attempting (and failing) an engine call.
   */
  instanceId: string | null;
  /** T-0638 (F1): payload.proc_key, alongside instanceId — null when absent. */
  procKey: string | null;
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
  opts?: {
    limit?: number;
    /**
     * T-0710 [E16, capstone T-0691 P2]: scope to ONE Flowable instance — matched
     * against payload.instance_id (the REAL engine instance id, T-0638 F1), NOT
     * the `inst`/subject field (which for a defer row is an "agent:<id>" subject
     * reference, not a process-instance id). Pushed into the SQL WHERE clause
     * (not a post-fetch filter) for the same LIMIT-window-honesty reason as
     * process-projection.ts's readEvents. A defer row with no instance_id (a
     * legacy row, or one not tied to a live engine instance) never matches a
     * scoped read — correct: it is not honestly "of" any instance.
     */
    instanceId?: string;
  },
): Promise<DeferredInboxRow[]> {
  const limit = Math.min(opts?.limit ?? 100, 500);
  const instanceId = opts?.instanceId;

  return withTenant(pool, tenantId, async (client) => {
    // $1 = tenantId (explicit BYPASSRLS guard, mirrors T-0184 / audit-grant-trail.ts).
    // $2 = limit. $3 = instanceId (only when scoped).
    const instScope = instanceId ? ` AND payload->>'instance_id' = $3` : "";
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
        AND tenant_id = $1${instScope}
      ORDER BY occurred_at DESC
      LIMIT $2
    `;
    const params = instanceId ? [tenantId, limit, instanceId] : [tenantId, limit];

    const result = await client.query<{
      id: string;
      actor: string;
      subject: string | null;
      scope: Record<string, unknown> | null;
      payload: Record<string, unknown>;
      occurred_at: number;
    }>(sql, params);

    return result.rows.map((r) => {
      const payload = r.payload ?? {};
      const scope = r.scope ?? {};

      const rawDoubtReason =
        typeof payload["doubt_reason"] === "string" && payload["doubt_reason"].trim() !== ""
          ? payload["doubt_reason"]
          : "требуется проверка агентом-человеком";
      // T-0638 (defect #3): defensive humanization at the READ boundary too —
      // covers rows written BEFORE planDeferTask's own translation existed
      // (legacy audit_event rows already carry the raw English forever; the
      // write-side fix alone would not fix rows already persisted).
      const doubtReason = humanizeDoubtReason(rawDoubtReason);

      // T-0676 (anti-case hardcode fix, D-064): an unset/blank defer_role must NOT
      // default to a case-specific role literal ("fin-ctrl" — a day-1-demo role
      // that happens to have holders in THAT tenant's fixtures, not a universal
      // truth). The old default silently defeated the honest-addressing fallback
      // that T-0638 (F6) already built at the read layer: findInboxItems's
      // defer-merge block feeds row.role into resolveExecutorFallbackBatch, which
      // routes to the tenant owner (via findTenantOwnerSlug) ONLY when the role has
      // NO confirmed holders — but "fin-ctrl" often DOES have holders (it is a real,
      // commonly-seeded role), so a task that never actually had a role assigned
      // would incorrectly land on fin-ctrl's holder instead of the honest owner
      // fallback. "" is not a role any tenant can define (role.slug is never blank),
      // so getHoldersForRole("") is always empty — resolveExecutorFallbackBatch
      // correctly treats it as unfilled and reuses the SAME fallback ladder
      // (owner-via-findTenantOwnerSlug) that already exists for ordinary
      // instance-task roles. No new fallback path invented here — reusing the one
      // the main path already uses (ADR-T0638-defer-task-complete.md §2.5).
      const role =
        typeof payload["defer_role"] === "string" && payload["defer_role"].trim() !== ""
          ? payload["defer_role"]
          : "";

      // name: T-0638 — ALWAYS rebuilt from the (humanized) doubtReason, never
      // trusted verbatim from payload.defer_name. defer_name is a fully
      // DERIVED field (planDeferTask sets it to exactly "Проверить: "+doubtReason,
      // truncated) — a legacy row's stored defer_name was derived from the RAW
      // pre-humanization doubtReason (defect #3), so trusting it verbatim would
      // re-leak the raw English literal even after doubtReason itself is fixed
      // here. Recomputing from the already-humanized doubtReason is the single
      // source of truth and stays byte-identical to planDeferTask's own formula
      // for any row written by the current (fixed) write path.
      const namePrefix = "Проверить: ";
      const nameRaw = `${namePrefix}${doubtReason}`;
      const name = nameRaw.length > 120 ? `${nameRaw.slice(0, 119)}…` : nameRaw;

      const slaMinutes =
        typeof payload["defer_sla_minutes"] === "number"
          ? payload["defer_sla_minutes"]
          : null;

      const step =
        typeof scope["skill"] === "string" ? scope["skill"] : "legal_precheck";

      const inst = r.subject ?? `agent:${r.actor}`;

      // T-0638 (F1): real Flowable instance/proc-key, when the write path
      // threaded them (dispatch-outcome.ts's deferredAuditEvent — the live
      // agent-dispatch path). null for legacy events that never carried these
      // (e.g. run-precheck.ts's demo-run path, or events written before T-0638).
      const instanceId =
        typeof payload["instance_id"] === "string" && payload["instance_id"].trim() !== ""
          ? payload["instance_id"]
          : null;
      const procKey =
        typeof payload["proc_key"] === "string" && payload["proc_key"].trim() !== ""
          ? payload["proc_key"]
          : null;

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
        instanceId,
        procKey,
      };
    });
  });
}
