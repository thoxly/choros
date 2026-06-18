/**
 * ci/checks/db/deferred-inbox.test.ts — T-0254 rewrite of T-0221 live-DB fitness tests.
 *
 * Covers FF-2 / FF-3 / FF-4:
 *   FF-2 (AC-5 durable): defer write via appendAuditEvent lands as type='agent.deferred'
 *        with non-empty payload.doubt_reason; row survives a re-read (durability probe).
 *   FF-3 (AC-5 back-link): payload.inbox_task_id == audit_event.id (self-referential).
 *   FF-4-visible (AC-5 visible): defer row appears in listDeferredInboxTasks for its tenant.
 *   FF-4-isolated (AC-5 RLS-isolated): a second tenant cannot see tenant A's deferred item.
 *
 * Seeding strategy:
 *   - ALL audit_event writes go through appendAuditEvent (never raw INSERT into
 *     audit_event/audit_head) — satisfies hash-chain triggers (BEFORE UPDATE seq+1
 *     advance on audit_head, append-only enforcement).
 *   - The writer runs on an appUrl() connection inside a BEGIN/COMMIT transaction
 *     with SET LOCAL choros.tenant_id = '<uuid>' (exact production path).
 *   - Fresh UUID per test-run for tenantId so the suite runs cleanly against a shared
 *     Postgres without cross-test pollution (memory: choros-ci-db-gotchas).
 *   - listDeferredInboxTasks uses a Pool built from appUrl() — exercises RLS
 *     (choros_app is NOBYPASSRLS) exactly as production does.
 *
 * Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl } from "./_helpers.js";
import { makePgAuditWriter, type PgClientLike } from "../../../src/db/audit-writer.js";
import type { AuditEventInput } from "../../../src/core/audit-grant-encoder.js";
import { listDeferredInboxTasks } from "../../../src/db/deferred-inbox-store.js";

const { Client } = pg;
const writer = makePgAuditWriter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fresh random tenant UUID — no shared-DB pollution. */
function freshTenant(): string {
  return crypto.randomUUID();
}

/**
 * Open an appUrl() connection, BEGIN a tx, SET LOCAL choros.tenant_id + search_path,
 * run fn, then COMMIT.  The client closes when done.
 * This is the exact production path; writer.appendAuditEvent seeds the head row
 * on the first call (ON CONFLICT DO NOTHING), so no manual audit_head seed needed.
 */
async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: PgClientLike, raw: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query("SET LOCAL search_path TO choros");
    const result = await fn(c as unknown as PgClientLike, c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/**
 * Build an AuditEventInput for an agent.deferred event — mirrors deferredAuditEvent()
 * in src/runtime/legal-precheck/run-precheck.ts (the canonical production builder).
 *
 * taskId is minted by the caller and passed in so payload.inbox_task_id === id
 * (self-referential back-link, FF-3 / T-0221 AC-5).
 */
function deferInput(opts: {
  taskId: string;
  agentEmployeeId: string;
  doubtReason: string;
  deferRole?: string;
  deferSlaMinutes?: number | null;
  deferName?: string;
  nowMs?: number;
}): AuditEventInput {
  const nowMs = opts.nowMs ?? Date.now();
  return {
    id: opts.taskId,
    type: "agent.deferred",
    actor: opts.agentEmployeeId,
    subject: `agent:${opts.agentEmployeeId}`,
    scope: { skill: "legal_precheck", signal: "threshold" },
    via: "legal-precheck-motor",
    proposed_by: null,
    confirmed_by: null,
    payload: {
      doubt_reason: opts.doubtReason,
      signal: "threshold",
      reasoning_trace_ref: null,
      inbox_task_id: opts.taskId,   // FF-3: self-referential back-link
      defer_role: opts.deferRole ?? "fin-ctrl",
      defer_sla_minutes: opts.deferSlaMinutes ?? null,
      defer_name: opts.deferName ?? `Проверить: ${opts.doubtReason}`,
    },
    occurred_at: nowMs,
  };
}

// ---------------------------------------------------------------------------
// FF-2: durable write via appendAuditEvent
// ---------------------------------------------------------------------------

describe("T-0221 FF-2 — durable: agent.deferred row lands and survives re-read", () => {
  it("appendAuditEvent writes type=agent.deferred with non-empty doubt_reason; row re-readable after COMMIT", async () => {
    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const doubtReason = "autonomy threshold not met — live DB probe FF-2";

    const input = deferInput({ taskId, agentEmployeeId: agentId, doubtReason });

    // Write through the canonical writer inside a tx.
    const appended = await withTenantTx(tenantId, (tx) =>
      writer.appendAuditEvent(tx, input),
    );
    expect(appended.seq).toBe(1);

    // Re-read via a FRESH connection (post-COMMIT durability probe — the data must
    // survive beyond the writing transaction).
    const row = await withTenantTx(tenantId, async (_tx, raw) => {
      const res = await raw.query<{
        id: string;
        type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, type, payload
           FROM choros.audit_event
          WHERE id = $1
            AND tenant_id = current_setting('choros.tenant_id', false)::uuid`,
        [taskId],
      );
      return res.rows[0];
    });

    expect(row).toBeDefined();
    expect(row.type).toBe("agent.deferred");
    const payload = row.payload as Record<string, unknown>;
    expect(typeof payload["doubt_reason"]).toBe("string");
    expect((payload["doubt_reason"] as string).trim().length).toBeGreaterThan(0);
    expect(payload["doubt_reason"]).toBe(doubtReason);
  });
});

// ---------------------------------------------------------------------------
// FF-3: self-referential back-link inbox_task_id == audit_event.id
// ---------------------------------------------------------------------------

describe("T-0221 FF-3 — back-link: payload.inbox_task_id == audit_event.id", () => {
  it("inbox_task_id in payload equals the event's own id (self-referential)", async () => {
    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;

    const input = deferInput({
      taskId,
      agentEmployeeId: agentId,
      doubtReason: "back-link probe FF-3",
    });

    await withTenantTx(tenantId, (tx) => writer.appendAuditEvent(tx, input));

    const row = await withTenantTx(tenantId, async (_tx, raw) => {
      const res = await raw.query<{
        id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, payload
           FROM choros.audit_event
          WHERE id = $1
            AND tenant_id = current_setting('choros.tenant_id', false)::uuid`,
        [taskId],
      );
      return res.rows[0];
    });

    expect(row).toBeDefined();
    // FF-3: the self-referential back-link must hold.
    expect(row.payload["inbox_task_id"]).toBe(taskId);
    expect(row.payload["inbox_task_id"]).toBe(row.id);
  });
});

// ---------------------------------------------------------------------------
// FF-4: visible via listDeferredInboxTasks + tenant-RLS isolated
// ---------------------------------------------------------------------------

describe("T-0221 FF-4 — visible + RLS-isolated: listDeferredInboxTasks projection", () => {
  it("FF-4-visible: defer row appears in listDeferredInboxTasks for its own tenant", async () => {
    const tenantId = freshTenant();
    const taskId = crypto.randomUUID();
    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;

    const input = deferInput({
      taskId,
      agentEmployeeId: agentId,
      doubtReason: "visibility probe FF-4",
      deferRole: "fin-ctrl",
      deferSlaMinutes: 30,
      deferName: "Проверить: visibility probe FF-4",
    });

    await withTenantTx(tenantId, (tx) => writer.appendAuditEvent(tx, input));

    // Use listDeferredInboxTasks with a Pool (exercises RLS: choros_app / NOBYPASSRLS).
    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const rows = await listDeferredInboxTasks(pool, tenantId);
      const found = rows.find((r) => r.id === taskId);

      expect(found).toBeDefined();
      expect(found!.doubtReason).toBe("visibility probe FF-4");
      expect(found!.role).toBe("fin-ctrl");
      expect(found!.slaMinutes).toBe(30);
      expect(found!.execName).toBe(agentId);
    } finally {
      await pool.end();
    }
  });

  it("FF-4-isolated: defer row from tenant B is NOT visible when querying tenant A", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();

    const taskIdA = crypto.randomUUID();
    const agentIdA = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const taskIdB = crypto.randomUUID();
    const agentIdB = `agent-${crypto.randomUUID().slice(0, 8)}`;

    // Seed one defer event per tenant (each through their own tx + GUC).
    await withTenantTx(tenantA, (tx) =>
      writer.appendAuditEvent(tx, deferInput({
        taskId: taskIdA,
        agentEmployeeId: agentIdA,
        doubtReason: "tenant-A isolation probe",
      })),
    );
    await withTenantTx(tenantB, (tx) =>
      writer.appendAuditEvent(tx, deferInput({
        taskId: taskIdB,
        agentEmployeeId: agentIdB,
        doubtReason: "tenant-B isolation probe",
      })),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // Query for tenant A: must see A's item, must NOT see B's item.
      const rowsA = await listDeferredInboxTasks(pool, tenantA);
      expect(rowsA.find((r) => r.id === taskIdA)).toBeDefined();
      expect(rowsA.find((r) => r.id === taskIdB)).toBeUndefined();

      // Query for tenant B: must see B's item, must NOT see A's item.
      const rowsB = await listDeferredInboxTasks(pool, tenantB);
      expect(rowsB.find((r) => r.id === taskIdB)).toBeDefined();
      expect(rowsB.find((r) => r.id === taskIdA)).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
