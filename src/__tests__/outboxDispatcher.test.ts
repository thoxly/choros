/**
 * Unit tests for the outbox two-phase dispatcher (T-0062, ADR §4.3).
 * Pure orchestration — uses a fake store + fake deliver. No DB (runs in `vitest run`).
 */
import { describe, it, expect } from "vitest";
import {
  runOutboxOnce,
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
