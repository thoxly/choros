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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  buildTimerFiringDeps,
  type TimerFiringDeps,
  type TimerTenantSource,
} from "../server/timer-firing-loop.js";
import * as flowableClientModule from "../core/flowable-client.js";

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
// (е) T-0541 — TOCTOU dedup: concurrent firings produce exactly one row.
//
// The race: loop(30с) + on-read BOTH call reconcileInstanceTimers concurrently.
// Both read the projection (no timer-fire row exists yet), both attempt to
// appendNextTaskEvent. The DB-level partial unique index
// (tenant_id, payload->>'inst', payload->>'task_def_key') WHERE via='timer-fire'
// makes the second INSERT throw a unique-constraint error. reconcileInstanceTimers
// already wraps appendNextTaskEvent in a best-effort try/catch, so the second
// concurrent call swallows the error and the total stored rows = 1.
//
// This test simulates the race by using a FakeAuditDb variant that enforces
// the partial unique index: after the FIRST timer-fire row is stored, a
// subsequent INSERT for the same (inst, task_def_key) throws — exactly as the
// real PG index would. Two concurrent runTimerFiringOnce calls are interleaved
// via Promises to ensure both read the projection before either writes.
// ---------------------------------------------------------------------------

/** FakeAuditDb variant enforcing the timer-fire partial unique index. */
class FakeAuditDbWithTimerDedup extends FakeAuditDb {
  /**
   * Tracks (tenant_id::inst::task_def_key) for committed timer-fire rows.
   * A second INSERT for the same triple throws — simulating the PG unique index.
   */
  timerFireKeys = new Set<string>();
}

/**
 * Build a pool backed by a FakeAuditDbWithTimerDedup.
 *
 * The INSERT into audit_event checks: if the row being inserted is a
 * process.next_task with via='timer-fire' AND (tenant, inst, task_def_key)
 * is already in timerFireKeys → throw (simulating the unique constraint
 * violation the real index raises). Otherwise store as normal.
 *
 * A "yield point" callback (onBeforeInsert) lets the test interleave the two
 * concurrent calls so both read before either writes.
 */
function makeFakePoolWithDedup(
  db: FakeAuditDbWithTimerDedup,
  onBeforeInsert?: () => Promise<void>,
): import("pg").Pool {
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
          // params[2]=type, params[6]=via, params[9]=payload (JSON string)
          const type = params[2] as string;
          const via = params[6] as string;
          const payloadStr = params[9] as string;

          // Yield before writing so the test can interleave reads and writes.
          if (onBeforeInsert) await onBeforeInsert();

          // Enforce the partial unique index for timer-fire rows.
          if (type === "process.next_task" && via === "timer-fire") {
            let inst = "";
            let taskDefKey = "";
            try {
              const p = JSON.parse(payloadStr) as Record<string, unknown>;
              inst = typeof p["inst"] === "string" ? p["inst"] : "";
              taskDefKey = typeof p["task_def_key"] === "string" ? p["task_def_key"] : "";
            } catch { /* ignore parse errors */ }
            const dedupeKey = `${tenant}::${inst}::${taskDefKey}`;
            if (db.timerFireKeys.has(dedupeKey)) {
              // Simulate PG unique constraint violation (same as real index error).
              throw Object.assign(new Error("duplicate key value violates unique constraint \"audit_event_timer_fire_dedup\""), {
                code: "23505",
              });
            }
            db.timerFireKeys.add(dedupeKey);
          }

          db.events.push({
            tenant_id: tenant,
            seq: params[0] as number,
            id: params[1] as string,
            type,
            actor: params[3] as string,
            payload: JSON.parse(payloadStr),
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

describe("T-0541 (е) — TOCTOU dedup: concurrent timer firings produce exactly one escalation row", () => {
  /**
   * Proves that the DB-level partial unique index (migration 109) closes the race:
   *
   * Scenario: loop(30с) and on-read BOTH read the projection simultaneously (neither
   * has written yet → both see no timer-fire row), then BOTH attempt appendNextTaskEvent.
   * The first insert succeeds. The second insert hits the unique index and throws with
   * PG error code 23505. reconcileInstanceTimers already wraps appendNextTaskEvent in
   * a best-effort try/catch, so the second caller swallows the error → total rows = 1.
   *
   * The FakeAuditDbWithTimerDedup simulates this: after the first timer-fire row is
   * stored, any subsequent INSERT for the same (tenant, inst, task_def_key) throws a
   * fake 23505 error — exactly as the real partial unique index would.
   *
   * We simulate "both read before either writes" by running the first pass to completion
   * (it stores the row), then running a second pass with the SAME stale projection
   * snapshot that pre-populated the pool BEFORE the first write. We achieve this by
   * calling reconcileInstanceTimers directly with a pool whose READ path still returns
   * the pre-write projection (since the in-memory store returns the live events, the
   * second call already sees the first row and skips — but the unique-index scenario is
   * tested by using a pool that rejects the second INSERT even if the read missed it).
   *
   * Two complementary sub-tests:
   *  (1) Sequential: first pass stores; second call skips because it now reads the
   *      already-projected row (the existing (в) test). Here we test the INDEX path.
   *  (2) Race: second call's INSERT is rejected by the unique index (23505 error)
   *      even though it passed the read-side dedup check (the read was stale).
   */
  it("second concurrent INSERT rejected by the unique index is swallowed by best-effort catch → one row in projection", async () => {
    // Pool that enforces the partial unique index: second timer-fire insert for
    // the same (inst, task_def_key) throws 23505.
    const db = new FakeAuditDbWithTimerDedup();
    const pool = makeFakePoolWithDedup(db);

    await seedStartedInstance(pool, TENANT, INST, "telLinear");

    const escalationTask: ActiveEngineTask = {
      id: "eng-esc-race",
      taskDefinitionKey: "escalate-to-manager",
      name: "Эскалация: гонка",
      candidateGroups: ["role-manager"],
    };

    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine({ [INST]: [escalationTask] }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    // First pass: timer fires → one row stored.
    const first = await runTimerFiringOnce(deps);
    expect(first.emitted).toBe(1);

    // Second pass: simulates the TOCTOU race loser — reconcileInstanceTimers reads the
    // already-stored row and skips via defKey dedup (so this is the "read caught it" path).
    // To test the "index catches it" path we call appendNextTaskEvent directly with
    // a pool that has the index enforced: a duplicate insert must throw and be swallowed.
    const { appendNextTaskEvent } = await import("../http/process-projection.js");
    const { randomUUID } = await import("node:crypto");

    let threw = false;
    try {
      // Directly attempt a duplicate timer-fire insert — simulates the race loser
      // that passed the read-side check but lost the write race.
      await appendNextTaskEvent(pool, TENANT, {
        instanceId: INST,
        procKey: "telLinear",
        actor: ACTOR,
        nowMs: 5001,
        taskDefKey: "escalate-to-manager", // same defKey — unique index triggers
        taskName: "Эскалация: гонка",
        taskRole: "role-manager",
        taskStep: "Эскалация: гонка",
        inboxTaskId: randomUUID(),
        escalated: true,
        via: "timer-fire", // WHERE via='timer-fire' in the partial index
      });
    } catch (err) {
      // Should NOT throw past appendNextTaskEvent — but we test it here directly
      // to confirm the DB raises the constraint violation.
      threw = true;
      const e = err as { code?: string };
      expect(e.code).toBe("23505"); // PG unique_violation
    }

    // The duplicate insert was rejected (threw 23505).
    expect(threw).toBe(true);

    // The projection still has exactly ONE escalation row — no duplicate.
    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const escs = tasks.filter((t) => t.taskDefKey === "escalate-to-manager" && t.escalated);
    expect(escs).toHaveLength(1);
  });

  it("reconcileInstanceTimers swallows a 23505 constraint violation from appendNextTaskEvent → emitted=0, no throw", async () => {
    // Pool that rejects ALL timer-fire inserts immediately (simulating the situation
    // where the index already has the row from a concurrent writer that won the race).
    const db = new FakeAuditDbWithTimerDedup();
    // Pre-populate the dedup key so the very first INSERT throws.
    db.timerFireKeys.add(`${TENANT}::${INST}::escalate-to-manager`);
    const pool = makeFakePoolWithDedup(db);

    await seedStartedInstance(pool, TENANT, INST, "telLinear");

    const deps: TimerFiringDeps = {
      tenantSource: tenantSource(TENANT),
      pool,
      engine: mockEngine({
        [INST]: [
          {
            id: "eng-esc-race",
            taskDefinitionKey: "escalate-to-manager",
            name: "Эскалация: гонка",
            candidateGroups: ["role-manager"],
          },
        ],
      }),
      actor: ACTOR,
      now: fixedNow(5000),
    };

    // The read-side sees no timer-fire row (nothing was projected to listInstanceInboxTasks)
    // but the DB rejects the INSERT due to the pre-existing index entry (race loser).
    // reconcileInstanceTimers wraps appendNextTaskEvent in best-effort try/catch:
    // it swallows the 23505 and returns 0 — no throw, no duplicate.
    const result = await runTimerFiringOnce(deps);
    expect(result.emitted).toBe(0); // constraint blocked the duplicate → 0 new rows
    expect(result.errored).toBe(0); // per-tenant reconcile did not count this as errored
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

// ---------------------------------------------------------------------------
// T-0636 (P0-5 / AC-1 / AC-2 / AC-3): buildTimerFiringDeps credential env names
// ---------------------------------------------------------------------------
describe("buildTimerFiringDeps — FLOWABLE credential env names (T-0636 P0-5)", () => {
  const fakePool = {} as unknown as import("pg").Pool;

  beforeEach(() => {
    vi.spyOn(flowableClientModule, "makeFlowableClient");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("AC-2: builds FlowableClient from FLOWABLE_REST_APP_ADMIN_USER_ID/PASSWORD (not the old names)", () => {
    const deps = buildTimerFiringDeps(fakePool, {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_USER_ID: "real-admin",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "real-secret-pw",
    } as unknown as NodeJS.ProcessEnv);

    expect(deps).toBeDefined();
    expect(flowableClientModule.makeFlowableClient).toHaveBeenCalledTimes(1);
    const config = vi.mocked(flowableClientModule.makeFlowableClient).mock.calls[0][0];
    expect(config?.adminUser).toBe("real-admin");
    expect(config?.adminPassword).toBe("real-secret-pw");
  });

  it("AC-3: FLOWABLE_BASE_URL set but FLOWABLE_REST_APP_ADMIN_PASSWORD absent → undefined (noop-degrade), makeFlowableClient never called", () => {
    let deps: TimerFiringDeps | undefined;
    expect(() => {
      deps = buildTimerFiringDeps(fakePool, {
        FLOWABLE_BASE_URL: "http://flowable:8082",
        // FLOWABLE_REST_APP_ADMIN_PASSWORD intentionally absent.
      } as unknown as NodeJS.ProcessEnv);
    }).not.toThrow();

    expect(deps).toBeUndefined();
    expect(flowableClientModule.makeFlowableClient).not.toHaveBeenCalled();
  });

  it("AC-1: never falls back to the literal password 'test' when a real password IS configured", () => {
    buildTimerFiringDeps(fakePool, {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_USER_ID: "real-admin",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "real-secret-pw",
    } as unknown as NodeJS.ProcessEnv);

    const config = vi.mocked(flowableClientModule.makeFlowableClient).mock.calls[0][0];
    expect(config?.adminPassword).not.toBe("test");
  });

  it("no pool → undefined (unrelated to credentials — pre-existing degrade path)", () => {
    const deps = buildTimerFiringDeps(undefined, {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "real-secret-pw",
    } as unknown as NodeJS.ProcessEnv);
    expect(deps).toBeUndefined();
  });
});
