/**
 * T-0028: Engine state-mutation guard — variable-guard test suite.
 *
 * Covers all acceptance criteria for the complete-payload guard (AC-2..AC-4, AC-7)
 * and the full adversarial corpus from the ADR §7 (ADV-1..ADV-12).
 *
 * Uses InMemoryJobStore (via the JobStore alias) — the TestDouble delivered by T-0114.
 * No external resources; pure in-process.
 */
import { describe, it, expect } from "vitest";
import { JobStore } from "../core/jobStore.js";
import { makeHandle } from "../core/object-handle.js";
import { type Clock, JobState } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixedClock(value: number): Clock {
  return { now: () => value };
}

/**
 * Enqueue + lock a job in one step via the public API path.
 * Uses enqueue() → fetchAndLock() so no private internals are accessed.
 * Returns the locked job id.
 *
 * Note: lockExpiry is controlled indirectly via the clock value and
 * lockDurationMs passed to fetchAndLock. To simulate a specific lockExpiry
 * (e.g. expiry=4999 with clock=5000 → already expired), use
 * enqueueAndLockExpired() instead.
 */
function enqueueAndLock(
  store: JobStore,
  clock: { now(): number },
  lockExpiry: number
): string {
  // lockDurationMs = lockExpiry - clock.now() gives the desired expiry time.
  // We use fetchAndLock which is the real acquire path: enqueue → fetchAndLock.
  const job = store.enqueue("test-topic", {}, 0);
  const lockDurationMs = lockExpiry - clock.now();
  const locked = store.fetchAndLock("worker-1", ["test-topic"], 1, lockDurationMs);
  if (locked.length === 0) {
    throw new Error(`enqueueAndLock: fetchAndLock returned no jobs for id=${job.id}`);
  }
  return locked[0].id;
}

// ---------------------------------------------------------------------------
// ADV-1: raw record in complete payload — single field (AC-2)
// ---------------------------------------------------------------------------
describe("complete-payload: raw record rejected fail-closed (AC-2, ADV-1)", () => {
  it("returns RECORD_IN_PAYLOAD when payload contains a record-kind ResourceRef object", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      result: { kind: "record", registryId: "reg-1", recordId: "rec-1", data: { x: 1 } },
    });

    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    // Job must remain LOCKED (state NOT advanced)
    const job = store.getById(jobId)!;
    expect(job.state).toBe(JobState.LOCKED);
  });

  it("returns RECORD_IN_PAYLOAD for a bare record-ref (no data key) — identity is enough", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      result: { kind: "record", registryId: "reg-1", recordId: "rec-1" },
    });

    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(store.getById(jobId)!.state).toBe(JobState.LOCKED);
  });
});

// ---------------------------------------------------------------------------
// ADV-2: nested record in plain object (AC-2, ADV-2)
// ---------------------------------------------------------------------------
describe("complete-payload: nested record rejected via assertVariableValue recursion (AC-2, ADV-2)", () => {
  it("rejects payload with deeply nested record object", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      wrapper: { inner: { kind: "record", registryId: "reg-1", recordId: "rec-1" } },
    });

    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(store.getById(jobId)!.state).toBe(JobState.LOCKED);
  });
});

// ---------------------------------------------------------------------------
// ADV-3: mixed payload — one handle, one raw record → all-or-nothing (AC-4, ADV-3)
// ---------------------------------------------------------------------------
describe("complete-payload: all-or-nothing rejection (AC-4, ADV-3)", () => {
  it("rejects the entire complete when only one value fails, even if others are valid handles", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const validHandle = makeHandle(
      { kind: "record", tenantId: "t1", registryId: "reg-1", recordId: "rec-1" },
      "t1"
    );

    const result = store.complete("worker-1", jobId, {
      handle: validHandle,
      rec: { kind: "record", registryId: "reg-1", recordId: "rec-1" },
    });

    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(store.getById(jobId)!.state).toBe(JobState.LOCKED);
  });
});

// ---------------------------------------------------------------------------
// ADV-4: valid ObjectHandle in payload → passes (AC-3, ADV-4)
// ---------------------------------------------------------------------------
describe("clean-payload: valid handle passes guard (AC-3, ADV-4)", () => {
  it("returns ok:true when payload contains only a valid ObjectHandle", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const handle = makeHandle(
      { kind: "record", tenantId: "t1", registryId: "reg-1", recordId: "rec-1" },
      "t1"
    );

    const result = store.complete("worker-1", jobId, { handle });

    expect(result).toEqual({ ok: true });
    expect(store.getById(jobId)!.state).toBe(JobState.COMPLETED);
    expect(store.getById(jobId)!.result).toEqual({ handle });
  });
});

// ---------------------------------------------------------------------------
// ADV-5: empty payload passes (AC-3, ADV-5)
// ---------------------------------------------------------------------------
describe("clean-payload: empty payload object passes (AC-3, ADV-5)", () => {
  it("returns ok:true for an empty payload {}; job advances to COMPLETED", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {});

    expect(result).toEqual({ ok: true });
    expect(store.getById(jobId)!.state).toBe(JobState.COMPLETED);
  });
});

// ---------------------------------------------------------------------------
// ADV-6: inert primitives only (AC-3, ADV-6)
// ---------------------------------------------------------------------------
describe("clean-payload: inert primitives pass (AC-3, ADV-6)", () => {
  it("returns ok:true for payload with number, string, boolean, null values", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      n: 42,
      s: "hello",
      b: true,
      nil: null,
    });

    expect(result).toEqual({ ok: true });
    expect(store.getById(jobId)!.state).toBe(JobState.COMPLETED);
  });
});

// ---------------------------------------------------------------------------
// ADV-7: no-payload-regression — 2-arg form is byte-identical (AC-3, ADV-7)
// ---------------------------------------------------------------------------
describe("no-payload-regression: complete without payload is byte-identical (AC-3, ADV-7)", () => {
  it("complete(workerId, jobId) with no payload succeeds and does not set result", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId);

    expect(result).toEqual({ ok: true });
    const job = store.getById(jobId)!;
    expect(job.state).toBe(JobState.COMPLETED);
    expect(job.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADV-8: JSON-encoded string containing record → passes (§2 decision, ADV-8)
// ---------------------------------------------------------------------------
describe("clean-payload: JSON string containing record is inert (§2 decision, ADV-8)", () => {
  it("string payload value whose content is a JSON-encoded record passes guard", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      s: '{"kind":"record","registryId":"x","recordId":"y"}',
    });

    expect(result).toEqual({ ok: true });
    expect(store.getById(jobId)!.state).toBe(JobState.COMPLETED);
  });
});

// ---------------------------------------------------------------------------
// ADV-9: array containing a record → rejected (AC-2, AC-4, ADV-9)
// ---------------------------------------------------------------------------
describe("complete-payload: array containing record rejected (AC-2, ADV-9)", () => {
  it("returns RECORD_IN_PAYLOAD when payload array contains a record object", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      arr: [{ kind: "record", registryId: "reg-1", recordId: "rec-1" }],
    });

    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(store.getById(jobId)!.state).toBe(JobState.LOCKED);
  });
});

// ---------------------------------------------------------------------------
// ADV-10: object with data key (raw_object_with_data) → rejected (AC-2, ADV-10)
// ---------------------------------------------------------------------------
describe("complete-payload: object with data key rejected (AC-2, ADV-10)", () => {
  it("returns RECORD_IN_PAYLOAD for an object carrying a data key alongside other keys", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    const result = store.complete("worker-1", jobId, {
      obj: { data: "not-a-record", otherKey: "x" },
    });

    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(store.getById(jobId)!.state).toBe(JobState.LOCKED);
  });
});

// ---------------------------------------------------------------------------
// ADV-12: existing ownership gate checks still fire before payload validation (regression)
// ---------------------------------------------------------------------------
describe("complete-payload: ownership gate takes precedence over payload validation (AC-3, ADV-12)", () => {
  it("returns NOT_FOUND for unknown job — payload not evaluated", () => {
    const store = new JobStore(makeFixedClock(1000));
    const result = store.complete("w1", "no-such-job", {
      rec: { kind: "record", registryId: "r", recordId: "x" },
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("returns NOT_LOCKED for CREATED job — payload not evaluated", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("t", {}, 0);
    const result = store.complete("w1", job.id, {
      rec: { kind: "record", registryId: "r", recordId: "x" },
    });
    expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("returns LOCK_EXPIRED for expired lock — payload not evaluated", () => {
    const clock = makeFixedClock(5000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 4999); // expired
    const result = store.complete("worker-1", jobId, {
      rec: { kind: "record", registryId: "r", recordId: "x" },
    });
    expect(result).toEqual({ ok: false, code: "LOCK_EXPIRED" });
  });

  it("returns NOT_OWNER for wrong workerId — payload not evaluated", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);
    const result = store.complete("wrong-worker", jobId, {
      rec: { kind: "record", registryId: "r", recordId: "x" },
    });
    expect(result).toEqual({ ok: false, code: "NOT_OWNER" });
  });
});

// ---------------------------------------------------------------------------
// result field: stored on job when payload provided and valid (AC-3)
// ---------------------------------------------------------------------------
describe("complete-payload: result field stored on completed job", () => {
  it("job.result equals the validated payload after successful complete", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    store.complete("worker-1", jobId, { score: 99, label: "ok" });

    const job = store.getById(jobId)!;
    expect(job.result).toEqual({ score: 99, label: "ok" });
  });

  it("job.result is absent when complete called without payload", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const jobId = enqueueAndLock(store, clock, 9999);

    store.complete("worker-1", jobId);

    expect(store.getById(jobId)!.result).toBeUndefined();
  });
});
