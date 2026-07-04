/**
 * T-0068 · R-1 wired-entry integration test (D-056 integration-honesty gate).
 *
 * The earlier build shipped a dep-less startLifecycleBridge() + a void-ed
 * onDispatched, so NOTHING appended a lifecycle audit row from the wired entry
 * point — the unit tests passed over a seam no runtime path exercised. This test
 * closes that gap: it drives the REAL composition root (startMain — the main
 * factory, NOT createServer) and asserts a task.completed lifecycle event DOES
 * reach audit_event through the live wiring:
 *
 *   startMain → startLifecycleBridge → startOutboxDispatcherLoop → runOutboxOnce
 *             → (deliver) → markDispatched → onDispatched=makeAuditOnDispatched
 *             → encoder → writer.appendAuditEvent
 *
 * Only the LEAVES are faked (an in-memory audit writer + tenant-tx, a fake outbox
 * store yielding one row, a fake job-store pool). The composition between them is
 * the production code path. If any link in the chain is broken (the R-1 bug), the
 * assertion that the in-memory writer received exactly one instance audit row
 * fails.
 */

import { describe, it, expect } from "vitest";
import { startMain } from "../main.js";
import {
  InMemoryAuditWriter,
  inMemoryTx,
  type PgClientLike,
} from "../db/audit-writer.js";
import type { OutboxRow } from "../core/outboxTypes.js";
import type { PostgresJobStore } from "../core/jobStore.js";
import type { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";

const TENANT = "22222222-2222-2222-2222-222222222222";

/** A pg-pool-like that returns zero rows for every query (no network/DB). */
function fakePool(): unknown {
  const client = {
    query: async () => ({ rows: [] as unknown[] }),
    release: () => {/* no-op */},
  };
  return { connect: async () => client };
}

/** A fake job store: makeExternalTaskDeliver only reads jobStore["pool"]. */
function fakeJobStore(): PostgresJobStore {
  return { pool: fakePool() } as unknown as PostgresJobStore;
}

/**
 * A fake outbox store: yields ONE pending task_completed row on the first pass,
 * then nothing. claimBatch hands the row to the dispatcher; markDispatched returns
 * true (durable advance) so onDispatched fires exactly once.
 */
function fakeOutboxStore(row: OutboxRow): {
  store: PostgresOutboxStore;
  dispatched: () => number;
} {
  let bucketsServed = false;
  let claimed = false;
  let dispatchedCount = 0;
  const store = {
    pendingBuckets: async () => {
      if (bucketsServed) return [];
      bucketsServed = true;
      return [{ tenantId: row.tenantId, count: 1 }];
    },
    claimBatch: async () => {
      if (claimed) return [];
      claimed = true;
      return [row];
    },
    markDispatched: async () => {
      dispatchedCount += 1;
      return true; // durable advance → onDispatched fires
    },
    markRetry: async () => "noop",
  } as unknown as PostgresOutboxStore;
  return { store, dispatched: () => dispatchedCount };
}

describe("startMain wired-entry (R-1 / D-056): lifecycle event reaches audit_event", () => {
  it("a dispatched task_completed lands exactly one lifecycle audit row via the real composition", async () => {
    const writer = new InMemoryAuditWriter();

    // In-memory per-tenant tx: real makeAuditOnDispatched calls this, then
    // writer.appendAuditEvent(tx, event). inMemoryTx carries __tenantId so the
    // InMemoryAuditWriter serializes the tenant chain exactly like Postgres.
    const withTenantTx = async <T>(
      tenantId: string,
      fn: (tx: PgClientLike) => Promise<T>,
    ): Promise<T> => fn(inMemoryTx(tenantId));

    const row: OutboxRow = {
      id: "00000000-0000-0000-0000-0000000000aa",
      tenantId: TENANT,
      aggregateKind: "job",
      aggregateId: "job-77",
      eventType: "task_completed",
      payload: { instanceId: "pi-77", actor: "bridge-worker" },
      idempotencyKey: "complete:job-77",
      state: "dispatching",
      attempts: 0,
      availableAt: 0,
      createdAt: 0,
    } as unknown as OutboxRow;

    const outbox = fakeOutboxStore(row);

    // Capture the dispatcher loop tick so we can drive exactly one pass
    // deterministically (no real timer). The poll loop gets the same fake.
    const ticks: Array<() => void> = [];
    const setIntervalFn = ((fn: () => void) => {
      ticks.push(fn);
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setInterval>;

    const handle = startMain({
      listen: false,
      // T-0636 (P0-5): startLifecycleBridge now honest-degrades (noopHandle) when
      // FLOWABLE_REST_APP_ADMIN_PASSWORD is absent, instead of silently building a
      // FlowableClient with the bogus admin:test default. This test drives the
      // REAL wired composition (its whole point — D-056 integration-honesty), so
      // it must supply the credential env the production composition root reads.
      env: {
        FLOWABLE_BASE_URL: "http://flowable:8082",
        FLOWABLE_REST_APP_ADMIN_USER_ID: "test-admin",
        FLOWABLE_REST_APP_ADMIN_PASSWORD: "test-admin-pw",
      } as unknown as NodeJS.ProcessEnv,
      lifecycleDeps: {
        pool: fakePool() as never,
        jobStore: fakeJobStore(),
        outboxStore: outbox.store,
        auditWriter: writer,
        withTenantTx,
        setIntervalFn,
        intervalMs: 1,
      },
    });

    // The bridge must NOT have degraded to a no-op: both loops registered a tick.
    expect(ticks.length).toBeGreaterThanOrEqual(1);

    // Drive each registered loop one pass and let the microtask chain settle.
    for (const tick of ticks) tick();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    handle.stop();

    // The row was durably dispatched, and the onDispatched callback appended
    // exactly ONE lifecycle audit row through the real writer (deliver returned
    // idempotentSuccess via the empty job lookup → still a durable dispatch).
    expect(outbox.dispatched()).toBe(1);
    const rows = writer.rows(TENANT);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("task.completed");
    expect(rows[0].subject).toBe("pi-77");
    expect((rows[0].payload as Record<string, unknown>)["actorType"]).toBe("service");
    expect((rows[0].payload as Record<string, unknown>)["aggregateId"]).toBe("job-77");
  });
});
