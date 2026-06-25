/**
 * ci/checks/db/process-projection.test.ts — T-0282 live-DB fitness for the
 * engine→screen projection (ADR T-0278 §2.3 / §D).
 *
 * Mirrors ci/checks/db/deferred-inbox.test.ts: ALL audit_event writes go through
 * the canonical writer (appendProcessStarted / appendTaskApproved → appendAuditEvent),
 * never raw INSERT. The reads exercise RLS via a choros_app (NOBYPASSRLS) Pool, the
 * exact production path. Fresh per-run tenant UUIDs avoid shared-DB pollution
 * (memory: choros-ci-db-gotchas).
 *
 * Covers:
 *   AC-3 (visible): a started instance's waiting user-task appears in
 *     listInstanceInboxTasks addressed to its ROLE (candidateGroups → role).
 *   AC-1 (visible): the started instance appears in listInstanceProjections (waiting).
 *   AC-5/AC-6 (advance): after appendTaskApproved, the instance reads `done` and the
 *     waiting inbox task drops (nothing left to act on).
 *   append-only: a second approve event is an additive append (no UPDATE/DELETE) —
 *     re-reading is idempotent (status stays `done`).
 *   RLS isolation: a started instance in tenant B is invisible when reading tenant A.
 *
 * Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl } from "./_helpers.js";
import { makePgAuditWriter, type PgClientLike } from "../../../src/db/audit-writer.js";
import {
  appendProcessStarted,
  appendTaskApproved,
  listInstanceProjections,
  listInstanceInboxTasks,
  reconcileInstanceTimers,
  TIMER_ESCALATION_REASON,
  APPROVER_ROLE,
  type TimerReconcileEnginePort,
  type ActiveEngineTask,
} from "../../../src/http/process-projection.js";

const { Client } = pg;
const writer = makePgAuditWriter();

function freshTenant(): string {
  return crypto.randomUUID();
}

/**
 * Open an appUrl() connection, BEGIN a tx, SET LOCAL choros.tenant_id + search_path,
 * run fn, COMMIT. Exact production write path; the writer seeds the head row on the
 * first call (ON CONFLICT DO NOTHING), so no manual audit_head seed is needed.
 */
async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: PgClientLike) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query("SET LOCAL search_path TO choros");
    const result = await fn(c as unknown as PgClientLike);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------
// AC-1 / AC-3 — started instance + waiting user-task are visible & role-addressed.
// ---------------------------------------------------------------------------

describe("T-0282 — started instance becomes visible (AC-1/AC-3)", () => {
  it("appendProcessStarted → instance is `waiting` and its user-task is in the inbox addressed to role-approver", async () => {
    const tenantId = freshTenant();
    const instanceId = `flw-${crypto.randomUUID().slice(0, 8)}`;

    const taskId = await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: "telLinear",
        actor: "e-orlov",
        nowMs: Date.now(),
      }),
    );
    expect(typeof taskId).toBe("string");

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const projections = await listInstanceProjections(pool, tenantId);
      const proj = projections.find((p) => p.inst === instanceId);
      expect(proj).toBeDefined();
      expect(proj!.status).toBe("waiting");
      expect(proj!.procKey).toBe("telLinear");
      expect(proj!.role).toBe(APPROVER_ROLE);

      // AC-3: the waiting user-task appears in the inbox, addressed to the ROLE.
      const tasks = await listInstanceInboxTasks(pool, tenantId);
      const task = tasks.find((t) => t.id === taskId);
      expect(task).toBeDefined();
      expect(task!.role).toBe(APPROVER_ROLE);
      expect(task!.inst).toBe(instanceId);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 — approve advances the instance to `done`; the waiting task drops.
// ---------------------------------------------------------------------------

describe("T-0282 — approve advances instance to done (AC-5/AC-6)", () => {
  it("after appendTaskApproved, the instance reads `done` and the waiting inbox task is gone", async () => {
    const tenantId = freshTenant();
    const instanceId = `flw-${crypto.randomUUID().slice(0, 8)}`;

    const taskId = await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: "telLinear",
        actor: "e-orlov",
        nowMs: Date.now(),
      }),
    );

    await withTenantTx(tenantId, (tx) =>
      appendTaskApproved(tx, {
        taskId,
        instanceId,
        procKey: "telLinear",
        actor: "e-larina",
        nowMs: Date.now(),
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const projections = await listInstanceProjections(pool, tenantId);
      const proj = projections.find((p) => p.inst === instanceId);
      expect(proj).toBeDefined();
      expect(proj!.status).toBe("done"); // AC-6: reached done.

      // AC-6: the waiting approval task drops once the instance is done.
      const tasks = await listInstanceInboxTasks(pool, tenantId);
      expect(tasks.find((t) => t.id === taskId)).toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("append-only: a second approve append is additive and idempotent (status stays done)", async () => {
    const tenantId = freshTenant();
    const instanceId = `flw-${crypto.randomUUID().slice(0, 8)}`;

    const taskId = await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: "telLinear",
        actor: "e-orlov",
        nowMs: Date.now(),
      }),
    );
    await withTenantTx(tenantId, (tx) =>
      appendTaskApproved(tx, { taskId, instanceId, procKey: "telLinear", actor: "e-larina", nowMs: Date.now() }),
    );
    // Second approve event — append-only track means this is just another row.
    await withTenantTx(tenantId, (tx) =>
      appendTaskApproved(tx, { taskId, instanceId, procKey: "telLinear", actor: "e-larina", nowMs: Date.now() }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const projections = await listInstanceProjections(pool, tenantId);
      const proj = projections.find((p) => p.inst === instanceId);
      expect(proj!.status).toBe("done"); // idempotent — still done, not corrupted.
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// RLS isolation — a started instance in tenant B is invisible when reading tenant A.
// ---------------------------------------------------------------------------

describe("T-0282 — projection is tenant-RLS isolated (AC-9 substrate)", () => {
  it("instance started in tenant B is NOT visible when querying tenant A", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const instA = `flw-${crypto.randomUUID().slice(0, 8)}`;
    const instB = `flw-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantA, (tx) =>
      appendProcessStarted(tx, { instanceId: instA, procKey: "telLinear", actor: "e-orlov", nowMs: Date.now() }),
    );
    await withTenantTx(tenantB, (tx) =>
      appendProcessStarted(tx, { instanceId: instB, procKey: "telLinear", actor: "e-orlov", nowMs: Date.now() }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      const projA = await listInstanceProjections(pool, tenantA);
      expect(projA.find((p) => p.inst === instA)).toBeDefined();
      expect(projA.find((p) => p.inst === instB)).toBeUndefined();

      const projB = await listInstanceProjections(pool, tenantB);
      expect(projB.find((p) => p.inst === instB)).toBeDefined();
      expect(projB.find((p) => p.inst === instA)).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0458 [D8-R3] — timer-firing projection: a fired boundary timer surfaces an
// ESCALATION inbox task to the escalation target, with an F5 prefill reason.
// ---------------------------------------------------------------------------

/**
 * A fake engine port that simulates Flowable AFTER a boundary timer fired: the
 * instance now has a single active escalation user-task (the boundary-event target),
 * addressed to the escalation role via candidateGroups.
 */
function fakeEngineWithEscalation(
  instanceId: string,
  escTask: ActiveEngineTask,
): TimerReconcileEnginePort {
  return {
    async getActiveUserTasks(inst: string) {
      if (inst === instanceId) return { ok: true, tasks: [escTask] };
      return { ok: true, tasks: [] };
    },
  };
}

describe("T-0458 — timer firing surfaces an escalation inbox task", () => {
  it("reconcileInstanceTimers emits a process.next_task(escalated) addressed to the escalation role", async () => {
    const tenantId = freshTenant();
    const instanceId = `flw-${crypto.randomUUID().slice(0, 8)}`;

    // Seed a started instance waiting on the base approval task.
    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: "telLinear",
        actor: "e-orlov",
        nowMs: Date.now(),
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // The timer fired in Flowable → the escalation user-task is now active.
      const escTask: ActiveEngineTask = {
        id: "engine-task-escalate",
        taskDefinitionKey: "task-escalate",
        name: "Эскалация: согласование просрочено",
        candidateGroups: ["role-manager"],
      };
      const engine = fakeEngineWithEscalation(instanceId, escTask);

      const emitted = await reconcileInstanceTimers(pool, tenantId, engine, {
        actor: "system:timer",
      });
      expect(emitted).toBe(1);

      // The escalation task is now in the inbox, addressed to the manager pool,
      // flagged escalated, and carrying the F5 prefill reason.
      const tasks = await listInstanceInboxTasks(pool, tenantId);
      const esc = tasks.find((t) => t.taskDefKey === "task-escalate");
      expect(esc).toBeDefined();
      expect(esc!.role).toBe("role-manager");
      expect(esc!.inst).toBe(instanceId);
      expect(esc!.escalated).toBe(true);
      expect(esc!.doubtReason).toBe(TIMER_ESCALATION_REASON);

      // Idempotent: a second reconcile pass (timer still firing, task already
      // surfaced) emits nothing — the escalation row is not duplicated.
      const emittedAgain = await reconcileInstanceTimers(pool, tenantId, engine, {
        actor: "system:timer",
      });
      expect(emittedAgain).toBe(0);
      const tasks2 = await listInstanceInboxTasks(pool, tenantId);
      expect(tasks2.filter((t) => t.taskDefKey === "task-escalate")).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("no firing → no escalation row (engine reports no extra active tasks)", async () => {
    const tenantId = freshTenant();
    const instanceId = `flw-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: "telLinear",
        actor: "e-orlov",
        nowMs: Date.now(),
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // Engine reports ONLY the base approve task (already projected) → nothing new.
      const engine: TimerReconcileEnginePort = {
        async getActiveUserTasks() {
          return {
            ok: true,
            tasks: [
              {
                id: "engine-task-approve",
                taskDefinitionKey: "task-approve",
                name: "Согласование",
                candidateGroups: [APPROVER_ROLE],
              },
            ],
          };
        },
      };
      const emitted = await reconcileInstanceTimers(pool, tenantId, engine, {});
      expect(emitted).toBe(0);

      const tasks = await listInstanceInboxTasks(pool, tenantId);
      expect(tasks.some((t) => t.escalated)).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
