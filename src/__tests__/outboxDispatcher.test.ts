/**
 * Unit tests for the outbox two-phase dispatcher (T-0062, ADR §4.3).
 * Pure orchestration — uses a fake store + fake deliver. No DB (runs in `vitest run`).
 */
import { describe, it, expect } from "vitest";
import {
  runOutboxOnce,
  startOutboxDispatcherLoop,
  defaultBackoff,
  type Deliver,
} from "../core/outboxDispatcher.js";
import type { OutboxRow } from "../core/outboxTypes.js";
import type { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";

function makeRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    id: over.id ?? "aaaaaaaa-0000-0000-0000-000000000001",
    aggregateKind: "job",
    aggregateId: "bbbbbbbb-0000-0000-0000-000000000001",
    eventType: "task_completed",
    payload: {},
    state: "dispatching",
    idempotencyKey: "k1",
    attempts: 0,
    createdAt: 0,
    availableAt: 0,
    dispatchedAt: undefined,
    lastError: undefined,
    ...over,
  };
}

/** A scriptable fake store recording calls; only the dispatcher's surface. */
class FakeStore {
  buckets: Array<{ tenantId: string; pendingCount: number }> = [];
  batches: Record<string, OutboxRow[]> = {};
  dispatched: string[] = [];
  retried: Array<{ id: string; backoffMs: number; error: string }> = [];
  // markDispatched outcome and markRetry outcome can be scripted per id.
  dispatchOutcome: Record<string, boolean> = {};
  retryOutcome: Record<string, "pending" | "dead" | "noop"> = {};

  async pendingBuckets() {
    return this.buckets;
  }
  async claimBatch(tenantId: string) {
    return this.batches[tenantId] ?? [];
  }
  async markDispatched(_tenantId: string, id: string) {
    this.dispatched.push(id);
    return this.dispatchOutcome[id] ?? true;
  }
  async markRetry(_tenantId: string, id: string, backoffMs: number, error: string) {
    this.retried.push({ id, backoffMs, error });
    return this.retryOutcome[id] ?? "pending";
  }
}

function asStore(f: FakeStore): PostgresOutboxStore {
  return f as unknown as PostgresOutboxStore;
}

describe("runOutboxOnce", () => {
  it("delivers each claimed row and marks dispatched on ok:true", async () => {
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t", pendingCount: 2 }];
    const r1 = makeRow({ id: "id1" });
    const r2 = makeRow({ id: "id2" });
    f.batches = { t: [r1, r2] };
    const deliver: Deliver = async () => ({ ok: true });

    const result = await runOutboxOnce(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 3,
      backoff: () => 1000,
    });
    expect(result.dispatched).toBe(2);
    expect(f.dispatched).toEqual(["id1", "id2"]);
    expect(f.retried).toEqual([]);
  });

  it("treats idempotentSuccess as dispatched (T-0067 NOT_FOUND contract, AC-17)", async () => {
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t", pendingCount: 1 }];
    f.batches = { t: [makeRow({ id: "idem" })] };
    const deliver: Deliver = async () => ({ ok: false, idempotentSuccess: true });

    const result = await runOutboxOnce(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 3,
      backoff: () => 1000,
    });
    expect(result.dispatched).toBe(1);
    expect(f.dispatched).toEqual(["idem"]);
  });

  it("on failure → markRetry with backoff(attempts); counts failed", async () => {
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t", pendingCount: 1 }];
    f.batches = { t: [makeRow({ id: "boom", attempts: 1 })] };
    f.retryOutcome = { boom: "pending" };
    const deliver: Deliver = async () => ({ ok: false, error: "nope" });

    const result = await runOutboxOnce(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 5,
      backoff: (a) => a * 100,
    });
    expect(result.failed).toBe(1);
    expect(f.retried).toEqual([{ id: "boom", backoffMs: 100, error: "nope" }]);
  });

  it("counts dead when markRetry returns 'dead' (AC-14)", async () => {
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t", pendingCount: 1 }];
    f.batches = { t: [makeRow({ id: "dead1", attempts: 2 })] };
    f.retryOutcome = { dead1: "dead" };
    const deliver: Deliver = async () => ({ ok: false });

    const result = await runOutboxOnce(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 3,
      backoff: () => 1000,
    });
    expect(result.dead).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("a throwing deliver is treated as failure (retry)", async () => {
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t", pendingCount: 1 }];
    f.batches = { t: [makeRow({ id: "throws" })] };
    const deliver: Deliver = async () => {
      throw new Error("kaboom");
    };

    const result = await runOutboxOnce(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 3,
      backoff: () => 1000,
    });
    expect(result.failed).toBe(1);
    expect(f.retried[0].error).toContain("kaboom");
  });

  it("invokes onDispatched only after a successful markDispatched", async () => {
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t", pendingCount: 2 }];
    f.batches = { t: [makeRow({ id: "ok" }), makeRow({ id: "lost" })] };
    f.dispatchOutcome = { ok: true, lost: false }; // 'lost' raced — markDispatched=false
    const seen: string[] = [];
    const deliver: Deliver = async () => ({ ok: true });

    const result = await runOutboxOnce(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 3,
      backoff: () => 1000,
      onDispatched: async (row) => {
        seen.push(row.id);
      },
    });
    expect(result.dispatched).toBe(1);
    expect(seen).toEqual(["ok"]); // not 'lost'
  });
});

describe("defaultBackoff", () => {
  it("is exponential and capped at 5 minutes", () => {
    expect(defaultBackoff(0)).toBe(1000);
    expect(defaultBackoff(1)).toBe(2000);
    expect(defaultBackoff(2)).toBe(4000);
    expect(defaultBackoff(100)).toBe(5 * 60 * 1000);
  });
});

/**
 * R-NEW proof (T-0170 re-review): startOutboxDispatcherLoop MUST thread
 * perRowMaxAttempts through to runOutboxOnce — otherwise immediate-dead rows
 * survive 5 retries in the production loop. This test drives the loop directly
 * (via injectable setIntervalFn) and proves the callback reaches runOutboxOnce.
 */
describe("startOutboxDispatcherLoop — perRowMaxAttempts threads to runOutboxOnce (R-NEW proof)", () => {
  it("loop pass invokes perRowMaxAttempts for each failed row", async () => {
    // Arrange: one failing row per tenant
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t1", pendingCount: 1 }];
    const row = makeRow({ id: "rn1", attempts: 0 });
    f.batches = { t1: [row] };
    f.retryOutcome = { rn1: "pending" };

    const deliver: Deliver = async () => ({ ok: false, error: "immediate-dead" });

    // Capture which rows the callback was called for
    const callbackHits: Array<{ rowId: string; error: string | undefined }> = [];
    const perRowMaxAttempts = (r: typeof row, err: string | undefined): number | undefined => {
      callbackHits.push({ rowId: r.id, error: err });
      return undefined; // fall through to default maxAttempts
    };

    // Capture pass results
    const passResults: import("../core/outboxDispatcher.js").RunOutboxResult[] = [];

    // Use injectable setInterval: capture fn, run it manually once, then assert
    let capturedFn: (() => void) | undefined;
    const fakeSetInterval = (fn: () => void, _ms: number) => {
      capturedFn = fn;
      return 0 as unknown as ReturnType<typeof setInterval>;
    };

    const { stop } = startOutboxDispatcherLoop(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 5,
      backoff: () => 1000,
      intervalMs: 100,
      setIntervalFn: fakeSetInterval,
      onPass: (r) => passResults.push(r),
      perRowMaxAttempts,
    });

    // The loop has NOT fired yet (first pass is deferred to interval)
    expect(capturedFn).toBeDefined();
    expect(callbackHits).toHaveLength(0);

    // Trigger one pass manually and wait for the async chain to settle
    capturedFn!();
    // Allow microtasks to flush (the pass is async; onPass fires in .then())
    await new Promise<void>((resolve) => setImmediate(resolve));

    stop();

    // Assert: perRowMaxAttempts was called — proving it reached runOutboxOnce
    expect(callbackHits).toHaveLength(1);
    expect(callbackHits[0].rowId).toBe("rn1");
    expect(callbackHits[0].error).toBe("immediate-dead");

    // And the pass itself ran (failed=1, because the row is still pending)
    expect(passResults).toHaveLength(1);
    expect(passResults[0].failed).toBe(1);
  });

  it("loop pass does NOT invoke perRowMaxAttempts when it is undefined (backward-compat)", async () => {
    // Sanity-check: omitting perRowMaxAttempts still works (no regression)
    const f = new FakeStore();
    f.buckets = [{ tenantId: "t2", pendingCount: 1 }];
    f.batches = { t2: [makeRow({ id: "ok2" })] };
    const deliver: Deliver = async () => ({ ok: true });

    const passResults: import("../core/outboxDispatcher.js").RunOutboxResult[] = [];
    let capturedFn: (() => void) | undefined;

    const { stop } = startOutboxDispatcherLoop(asStore(f), deliver, {
      batchLimit: 10,
      maxAttempts: 3,
      backoff: () => 1000,
      intervalMs: 100,
      setIntervalFn: (fn) => { capturedFn = fn; return 0 as unknown as ReturnType<typeof setInterval>; },
      onPass: (r) => passResults.push(r),
      // perRowMaxAttempts intentionally omitted
    });

    capturedFn!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    stop();

    expect(passResults).toHaveLength(1);
    expect(passResults[0].dispatched).toBe(1);
  });
});
