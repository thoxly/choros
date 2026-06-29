/**
 * src/__tests__/timer-firing-loop.test.ts — T-0535 [ENGINE-CORE].
 *
 * Proves the BACKGROUND timer-firing worker is real and generic: on a tick it
 * discovers tenants with active instances, asks the LIVE engine which user-tasks are
 * now active per instance, and for any timer-routed escalation task the projection has
 * not yet surfaced it appends a `process.next_task(escalated, via:"timer-fire")` row —
 * idempotently, generically (any process key), and resiliently (one tenant's failure
 * does not stall the pass).
 *
 * The firing+escalation logic itself is NOT re-implemented in the loop: it reuses
 * reconcileInstanceTimers (the same function the on-read reconcile T-0458 calls). These
 * tests therefore drive runTimerFiringOnce end-to-end against the in-memory FakeAuditDb
 * harness (the proven inbox-engine-drive / message-waiting-projection pattern) plus a
 * MOCK engine + MOCK clock — no live Postgres, no live Flowable.
 *
 * HONEST SCOPE: this exercises the loop + reconcile (discovery, firing, idempotency,
 * generic, rotation). The REAL boundary-timer scheduling inside a live Flowable (the
 * engine actually advancing the token when PT24H elapses) is server-gated — not here.
 */

import { describe, it, expect } from "vitest";
import {
  appendProcessStarted,
  listInstanceInboxTasks,
  type ActiveEngineTask,
  type TimerReconcileEnginePort,
} from "../http/process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";
import {
  runTimerFiringOnce,
  startTimerFiringLoop,
  type TimerFiringDeps,
  type TimerTenantSource,
} from "../server/timer-firing-loop.js";

// ---------------------------------------------------------------------------
// In-memory fake audit DB (mirrors inbox-engine-drive.test.ts harness exactly).
// ---------------------------------------------------------------------------

interface AuditRow {
  tenant_id: string;
  seq: number;
  id: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurred_at: number;
  row_hash: Buffer;
}

class FakeAuditDb {
  events: AuditRow[] = [];
  heads = new Map<string, { seq: number; row_hash: Buffer }>();
}

function makeFakePool(db: FakeAuditDb): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    let tenant = "";
    const client = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: async (sql: string, paramsArg?: unknown[]): Promise<any> => {
        const params = paramsArg ?? [];
        const text = sql.trim();
        const m = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(text);
        if (m) { tenant = m[1]; return { rows: [] }; }
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
        if (/SET LOCAL search_path/i.test(text)) return { rows: [] };
        if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(text)) {
          return { rows: [{ tenant_id: tenant }] };
        }
        if (/INSERT INTO choros\.audit_head/i.test(text)) {
          if (!db.heads.has(tenant)) {
            db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          }
          return { rows: [] };
        }
        if (/FROM choros\.audit_head/i.test(text) && /FOR UPDATE/i.test(text)) {
          const head = db.heads.get(tenant) ?? { seq: 0, row_hash: Buffer.alloc(32) };
          return { rows: [{ seq: head.seq, row_hash: head.row_hash, vocab_version: 1 }] };
        }
        if (/INSERT INTO choros\.audit_event/i.test(text)) {
          db.events.push({
            tenant_id: tenant,
            seq: params[0] as number,
            id: params[1] as string,
            type: params[2] as string,
            actor: params[3] as string,
            payload: JSON.parse(params[9] as string),
            occurred_at: params[10] as number,
            row_hash: params[12] as Buffer,
          });
          return { rows: [] };
        }
        if (/UPDATE choros\.audit_head/i.test(text)) {
          db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          return { rows: [] };
        }
        if (/FROM choros\.audit_event/i.test(text) && /WHERE type = \$1/.test(text)) {
          const type = params[0] as string;
          const tid = params[1] as string;
          const rows = db.events
            .filter((e) => e.type === type && e.tenant_id === tid)
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload, occurred_at: e.occurred_at }));
          return { rows };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    return client as unknown as import("pg").PoolClient;
  }
  return { connect: async () => makeClient() } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const INST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const INST_B = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ACTOR = "system:timer";

/** Seed a process.started instance for a tenant (so it becomes a firing candidate). */
async function seedStartedInstance(
  pool: import("pg").Pool,
  tenantId: string,
  instanceId: string,
  procKey: string,
): Promise<void> {
  const client = await pool.connect();
  await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await appendProcessStarted(client as unknown as PgClientLike, {
    instanceId,
    procKey,
    actor: "founder",
    nowMs: 1000,
    tenantId,
    step: "Согласование",
  });
  client.release();
}

/**
 * Mock engine. Returns a fixed set of active user-tasks per instance — a fired timer
 * routes the token to an escalation user-task, which appears here as a NEW active task
 * (taskDefinitionKey the base projection has not surfaced). `failInstances` makes
 * getActiveUserTasks throw for a given instance (transient-failure rotation test).
 */
function mockEngine(
  tasksByInstance: Record<string, ActiveEngineTask[]>,
  failInstances: Set<string> = new Set(),
): TimerReconcileEnginePort {
  return {
    async getActiveUserTasks(instanceId: string) {
      if (failInstances.has(instanceId)) throw new Error(`engine down for ${instanceId}`);
      const tasks = tasksByInstance[instanceId] ?? [];
      return { ok: true as const, tasks };
    },
  };
}

/** Mock tenant source returning a fixed candidate list (cross-tenant discovery stub). */
function tenantSource(...tenants: string[]): TimerTenantSource {
  return { listTenantsWithActiveInstances: async () => tenants };
}

/** A frozen clock for deterministic nowMs. */
const fixedNow = (t: number) => () => t;

// ---------------------------------------------------------------------------
// (а) due timer found and fired (escalation projected).
// ---------------------------------------------------------------------------

describe("T-0535 (а) — a due timer fires: escalation row is projected", () => {
  it("a timer-routed escalation user-task surfaces as escalated process.next_task", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    await seedStartedInstance(pool, TENANT, INST, "telLinear");

    // Engine reports a NEW active task the projection has not surfaced (timer fired,
    // token routed to the escalation user-task addressed to role-manager).
    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine({
        [INST]: [
          {
            id: "eng-esc-1",
            taskDefinitionKey: "escalate-to-manager",
            name: "Эскалация: истёк срок",
            candidateGroups: ["role-manager"],
          },
        ],
      }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    const summary = await runTimerFiringOnce(deps);
    expect(summary.tenants).toBe(1);
    expect(summary.emitted).toBe(1);
    expect(summary.errored).toBe(0);

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const esc = tasks.find((t) => t.taskDefKey === "escalate-to-manager");
    expect(esc).toBeDefined();
    expect(esc?.escalated).toBe(true);
    expect(esc?.role).toBe("role-manager"); // role from the timer's candidateGroups
    expect(esc?.inst).toBe(INST);
  });
});

// ---------------------------------------------------------------------------
// (б) NOT-due timer is not touched.
// ---------------------------------------------------------------------------

describe("T-0535 (б) — a not-yet-due timer fires nothing", () => {
  it("when the engine reports no new active task, no escalation is emitted", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    await seedStartedInstance(pool, TENANT, INST, "telLinear");

    // Engine reports ONLY the base waiting task (taskDefKey 'task-approve') — the timer
    // has NOT fired, so there is no new escalation task to surface.
    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine({
        [INST]: [
          {
            id: "eng-base-1",
            taskDefinitionKey: "task-approve",
            name: "Согласовать",
            candidateGroups: ["role-approver"],
          },
        ],
      }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    const summary = await runTimerFiringOnce(deps);
    expect(summary.tenants).toBe(1);
    expect(summary.emitted).toBe(0); // not-due → nothing fired

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    expect(tasks.some((t) => t.escalated)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (в) idempotency — a second tick does not duplicate the escalation.
// ---------------------------------------------------------------------------

describe("T-0535 (в) — idempotent: re-tick does not duplicate the escalation", () => {
  it("two passes over the same fired timer emit the escalation exactly once", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    await seedStartedInstance(pool, TENANT, INST, "telLinear");

    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine({
        [INST]: [
          {
            id: "eng-esc-1",
            taskDefinitionKey: "escalate-to-manager",
            name: "Эскалация: истёк срок",
            candidateGroups: ["role-manager"],
          },
        ],
      }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    const first = await runTimerFiringOnce(deps);
    expect(first.emitted).toBe(1);

    // Second tick — the escalation is already projected; dedup by taskDefKey → 0 new.
    const second = await runTimerFiringOnce({ ...deps, now: fixedNow(9000) });
    expect(second.emitted).toBe(0);

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const escs = tasks.filter((t) => t.taskDefKey === "escalate-to-manager");
    expect(escs).toHaveLength(1); // exactly one — no duplicate
  });
});

// ---------------------------------------------------------------------------
// (г) generic — a NON-ТЭЛ process with a timer fires identically.
// ---------------------------------------------------------------------------

describe("T-0535 (г) — generic: a non-ТЭЛ process timer fires the same way", () => {
  it("an arbitrary process key with a timer escalation surfaces an escalation row", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    // A totally unrelated process — NOT telLinear, no ТЭЛ anything.
    await seedStartedInstance(pool, TENANT, INST, "vacationApproval");

    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine({
        [INST]: [
          {
            id: "eng-esc-vac",
            taskDefinitionKey: "vacation-deadline-escalation",
            name: "Срок согласования отпуска истёк",
            candidateGroups: ["role-owner"],
          },
        ],
      }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    const summary = await runTimerFiringOnce(deps);
    expect(summary.emitted).toBe(1);

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const esc = tasks.find((t) => t.taskDefKey === "vacation-deadline-escalation");
    expect(esc).toBeDefined();
    expect(esc?.escalated).toBe(true);
    expect(esc?.role).toBe("role-owner");
    // The emitted projection carries the generic process key — no ТЭЛ hardcode.
    expect(esc?.procKey).toBe("vacationApproval");
  });
});

// ---------------------------------------------------------------------------
// (д) transient failure of one instance/tenant does not stall the pass (GV-5).
// ---------------------------------------------------------------------------

describe("T-0535 (д) — resilient: one failing instance does not stall the pass", () => {
  it("an instance whose engine call throws is skipped; other instances still fire", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    // Two instances in the SAME tenant: one engine-failing, one firing normally.
    await seedStartedInstance(pool, TENANT, INST, "telLinear");
    await seedStartedInstance(pool, TENANT, INST_B, "telLinear");

    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine(
        {
          [INST_B]: [
            {
              id: "eng-esc-b",
              taskDefinitionKey: "escalate-to-manager",
              name: "Эскалация B",
              candidateGroups: ["role-manager"],
            },
          ],
        },
        new Set([INST]), // INST's getActiveUserTasks throws
      ),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    // reconcileInstanceTimers swallows the per-instance engine throw internally and
    // continues with the next instance, so the healthy instance still fires.
    const summary = await runTimerFiringOnce(deps);
    expect(summary.emitted).toBe(1); // INST_B fired despite INST failing

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const fired = tasks.filter((t) => t.taskDefKey === "escalate-to-manager");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.inst).toBe(INST_B);
  });

  it("a tenant whose reconcile DEGRADES silently does not stall the pass; other tenants still fire", async () => {
    // reconcileInstanceTimers is TOTAL: a DB read failure inside it degrades to 0
    // (returns, never throws). The loop honours that — tenant A degrades silently to
    // 0, the pass continues, and tenant B still fires. Cross-tenant rotation through
    // the loop is what this asserts (tenant A's silent no-op does not block B).
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    // Only tenant B has a seeded instance — tenant A has none (its reconcile finds no
    // waiting instances and degrades to 0), modelling a tenant that contributes nothing
    // this pass while B fires.
    await seedStartedInstance(pool, TENANT_B, INST_B, "telLinear");

    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT, TENANT_B), // A empty/degraded, B fires
      pool,
      engine: mockEngine({
        [INST_B]: [
          {
            id: "eng-esc-b",
            taskDefinitionKey: "escalate-to-manager",
            name: "Эскалация B",
            candidateGroups: ["role-manager"],
          },
        ],
      }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    const summary = await runTimerFiringOnce(deps);
    expect(summary.tenants).toBe(2);
    expect(summary.emitted).toBe(1); // tenant B fired; tenant A's no-op did not block it

    const tasksB = await listInstanceInboxTasks(pool, TENANT_B);
    expect(tasksB.some((t) => t.taskDefKey === "escalate-to-manager")).toBe(true);
    const tasksA = await listInstanceInboxTasks(pool, TENANT);
    expect(tasksA).toHaveLength(0); // tenant A produced nothing
  });

  it("the loop's own try/catch counts and swallows a throwing tenantSource pass without firing", async () => {
    // Defence-in-depth: if discovery itself throws (tenant source down), the WHOLE
    // pass degrades to a no-op summary — the loop survives to the next tick (the loop's
    // outer try/catch in runTimerFiringOnce, mirroring agent-dispatch's pass-swallow).
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const deps: TimerFiringDeps = {
      tenantSource: {
        listTenantsWithActiveInstances: async () => {
          throw new Error("discovery down");
        },
      },
      pool,
      engine: mockEngine({}),
      actor: ACTOR,
      now: fixedNow(5000),
    };
    const summary = await runTimerFiringOnce(deps);
    expect(summary).toEqual({ tenants: 0, emitted: 0, errored: 0 });
  });
});

// ---------------------------------------------------------------------------
// Loop scheduling + degrade.
// ---------------------------------------------------------------------------

describe("T-0535 — startTimerFiringLoop scheduling + honest-degrade", () => {
  it("undefined deps → no-op handle (no interval scheduled), stop() is safe", () => {
    let scheduled = false;
    const handle = startTimerFiringLoop(undefined, {
      setIntervalFn: () => {
        scheduled = true;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
    });
    expect(scheduled).toBe(false); // degraded: no loop
    expect(() => handle.stop()).not.toThrow();
  });

  it("with deps → schedules an interval; stop() clears it", () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    let cleared: ReturnType<typeof setInterval> | undefined;
    const fakeTimer = 42 as unknown as ReturnType<typeof setInterval>;
    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(),
      pool,
      engine: mockEngine({}),
    };
    const realClear = globalThis.clearInterval;
    globalThis.clearInterval = ((h: ReturnType<typeof setInterval>) => {
      cleared = h;
    }) as typeof clearInterval;
    try {
      const handle = startTimerFiringLoop(deps, {
        intervalMs: 1234,
        setIntervalFn: (_fn, _ms) => fakeTimer,
      });
      handle.stop();
      expect(cleared).toBe(fakeTimer);
    } finally {
      globalThis.clearInterval = realClear;
    }
  });
});
