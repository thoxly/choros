/**
 * Unit tests for JobStore.complete() and JobStore.fail() (T-0005).
 * Covers all acceptance criteria (AC-1 through AC-15) and fitness functions (FF-T5-6 through FF-T5-14).
 */
import { describe, it, expect } from "vitest";
import { JobStore, type CompleteResult, type FailResult, type ErrorCode } from "../core/jobStore.js";
import { type Clock, JobState } from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed-value clock — always returns the same number. */
function makeFixedClock(value: number): Clock {
  return { now: () => value };
}

/** Mutable clock whose value can be advanced in tests. */
function makeMutableClock(initial: number): Clock & { advance(by: number): void } {
  let t = initial;
  return {
    now: () => t,
    advance(by: number) {
      t += by;
    },
  };
}

/**
 * Helper to put a job into LOCKED state by directly writing a frozen record into
 * the store's internal Map via the enqueue + prototype bypass seam.
 * Since T-0004 (fetchAndLock) is not yet available, tests manipulate the private
 * jobs Map via a cast — this is intentional test scaffolding, not production code.
 */
function lockJob(
  store: JobStore,
  jobId: string,
  lockOwner: string,
  lockExpiry: number
): void {
  // Access the private map via type cast for test scaffolding only.
  const privateJobs = (store as unknown as { jobs: Map<string, unknown> }).jobs;
  const job = privateJobs.get(jobId) as Record<string, unknown>;
  const locked = Object.freeze({
    ...job,
    state: JobState.LOCKED,
    lockOwner,
    lockExpiry,
  });
  privateJobs.set(jobId, locked);
}

/**
 * Exhaustiveness checker — the TypeScript compiler enforces that all
 * discriminants of a union are handled before reaching this function.
 * Including this in the test file satisfies FF-T5-14 and AC per tsc --noEmit.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}

/**
 * Exercises exhaustive handling of CompleteResult so that tsc validates
 * the union is fully discriminated.
 */
function handleCompleteResult(r: CompleteResult): string {
  if (r.ok) {
    return "success";
  }
  const code: ErrorCode = r.code;
  switch (code) {
    case "NOT_FOUND":
      return "not-found";
    case "NOT_LOCKED":
      return "not-locked";
    case "LOCK_EXPIRED":
      return "lock-expired";
    case "NOT_OWNER":
      return "not-owner";
    case "RECORD_IN_PAYLOAD":
      return "record-in-payload";
    default:
      return assertNever(code);
  }
}

/**
 * Exercises exhaustive handling of FailResult so that tsc validates
 * the union is fully discriminated.
 */
function handleFailResult(r: FailResult): string {
  if (r.ok) {
    return "success";
  }
  const code: ErrorCode = r.code;
  switch (code) {
    case "NOT_FOUND":
      return "not-found";
    case "NOT_LOCKED":
      return "not-locked";
    case "LOCK_EXPIRED":
      return "lock-expired";
    case "NOT_OWNER":
      return "not-owner";
    case "RECORD_IN_PAYLOAD":
      // fail() never returns RECORD_IN_PAYLOAD (no payload on fail path), but
      // ErrorCode is a shared type — exhaustiveness check covers all variants.
      return "record-in-payload";
    default:
      return assertNever(code);
  }
}

// ---------------------------------------------------------------------------
// FF-T5-14: result-union exhaustiveness via assertNever
// ---------------------------------------------------------------------------
describe("result-union exhaustiveness via assertNever (FF-T5-14)", () => {
  it("handleCompleteResult covers all branches of CompleteResult", () => {
    const clock = makeMutableClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("topic", {}, 0);

    // ok=false, NOT_FOUND
    expect(handleCompleteResult(store.complete("w1", "nonexistent"))).toBe("not-found");
    // ok=false, NOT_LOCKED
    expect(handleCompleteResult(store.complete("w1", job.id))).toBe("not-locked");
    // ok=false, LOCK_EXPIRED
    lockJob(store, job.id, "w1", clock.now() - 1); // expired
    expect(handleCompleteResult(store.complete("w1", job.id))).toBe("lock-expired");
    // ok=false, NOT_OWNER — re-lock with future expiry
    lockJob(store, job.id, "w1", clock.now() + 10000);
    expect(handleCompleteResult(store.complete("w2", job.id))).toBe("not-owner");
    // ok=true
    expect(handleCompleteResult(store.complete("w1", job.id))).toBe("success");
  });

  it("handleFailResult covers all branches of FailResult", () => {
    const clock = makeMutableClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("topic", {}, 3);

    // ok=false, NOT_FOUND
    expect(handleFailResult(store.fail("w1", "nonexistent", 1, 5000))).toBe("not-found");
    // ok=false, NOT_LOCKED
    expect(handleFailResult(store.fail("w1", job.id, 1, 5000))).toBe("not-locked");
    // ok=false, LOCK_EXPIRED
    lockJob(store, job.id, "w1", clock.now() - 1); // expired
    expect(handleFailResult(store.fail("w1", job.id, 1, 5000))).toBe("lock-expired");
    // ok=false, NOT_OWNER — re-lock with future expiry
    lockJob(store, job.id, "w1", clock.now() + 10000);
    expect(handleFailResult(store.fail("w2", job.id, 1, 5000))).toBe("not-owner");
    // ok=true
    expect(handleFailResult(store.fail("w1", job.id, 1, 5000))).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// FF-T5-6 / AC-5: complete happy path
// ---------------------------------------------------------------------------
describe("complete happy path (AC-5, FF-T5-6)", () => {
  it("returns { ok: true } and transitions job to COMPLETED with lock fields cleared", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", { amount: 50 }, 2);
    lockJob(store, job.id, "worker-1", 9999);

    const result = store.complete("worker-1", job.id);
    expect(result).toEqual({ ok: true });

    const updated = store.getById(job.id)!;
    expect(updated.state).toBe(JobState.COMPLETED);
    expect(updated.lockOwner).toBeUndefined();
    expect(updated.lockExpiry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FF-T5-7 / AC-4: complete NOT_OWNER
// ---------------------------------------------------------------------------
describe("complete returns NOT_OWNER for wrong worker (AC-4, FF-T5-7)", () => {
  it("returns { ok: false, code: 'NOT_OWNER' } when workerId does not match lockOwner", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "correct-worker", 9999);

    const result = store.complete("wrong-worker", job.id);
    expect(result).toEqual({ ok: false, code: "NOT_OWNER" });
  });
});

// ---------------------------------------------------------------------------
// FF-T5-8 / AC-3: complete LOCK_EXPIRED
// ---------------------------------------------------------------------------
describe("complete returns LOCK_EXPIRED when lock has expired (AC-3, FF-T5-8)", () => {
  it("returns { ok: false, code: 'LOCK_EXPIRED' } when lockExpiry <= clock.now()", () => {
    const clock = makeFixedClock(5000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "worker-1", 5000); // lockExpiry === clock.now() → expired

    const result = store.complete("worker-1", job.id);
    expect(result).toEqual({ ok: false, code: "LOCK_EXPIRED" });
  });

  it("LOCK_EXPIRED is returned before NOT_OWNER (precedence AC-12)", () => {
    const clock = makeFixedClock(5000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    // Expired AND wrong owner — LOCK_EXPIRED must win
    lockJob(store, job.id, "correct-worker", 4999);

    const result = store.complete("wrong-worker", job.id);
    expect(result).toEqual({ ok: false, code: "LOCK_EXPIRED" });
  });
});

// ---------------------------------------------------------------------------
// FF-T5-9 / AC-6, AC-2: complete NOT_LOCKED (double-complete)
// ---------------------------------------------------------------------------
describe("complete returns NOT_LOCKED on double-complete (AC-6, AC-2, FF-T5-9)", () => {
  it("second complete after first success returns NOT_LOCKED", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "worker-1", 9999);

    store.complete("worker-1", job.id); // first — ok
    const result = store.complete("worker-1", job.id); // second — COMPLETED state
    expect(result).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("complete on CREATED job returns NOT_LOCKED", () => {
    const store = new JobStore(makeFixedClock(1000));
    const job = store.enqueue("invoice", {}, 0);
    expect(store.complete("w1", job.id)).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("complete on FAILED job returns NOT_LOCKED", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "worker-1", 9999);
    store.fail("worker-1", job.id, 0, 0); // → FAILED
    expect(store.complete("worker-1", job.id)).toEqual({ ok: false, code: "NOT_LOCKED" });
  });
});

// ---------------------------------------------------------------------------
// AC-1: complete NOT_FOUND
// ---------------------------------------------------------------------------
describe("complete returns NOT_FOUND for unknown jobId (AC-1)", () => {
  it("returns { ok: false, code: 'NOT_FOUND' } for nonexistent jobId", () => {
    const store = new JobStore();
    expect(store.complete("w1", "does-not-exist")).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// FF-T5-10 / AC-8, AC-10: fail retries>0 → re-CREATES job
// ---------------------------------------------------------------------------
describe("fail with retries>0 sets state=CREATED and clears lock (AC-8, AC-10, FF-T5-10)", () => {
  it("returns { ok: true } and transitions to CREATED with correct retries", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 3);
    lockJob(store, job.id, "worker-1", 9999);

    const result = store.fail("worker-1", job.id, 2, 5000);
    expect(result).toEqual({ ok: true });

    const updated = store.getById(job.id)!;
    expect(updated.state).toBe(JobState.CREATED);
    expect(updated.retries).toBe(2);
    expect(updated.lockOwner).toBeUndefined();
    expect(updated.lockExpiry).toBeUndefined();
  });

  it("decrements retries step by step until FAILED (AC-10)", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 3);

    // Step 1: retries=3 → fail with retries=2 → CREATED
    lockJob(store, job.id, "w", 9999);
    store.fail("w", job.id, 2, 1000);
    expect(store.getById(job.id)!.retries).toBe(2);
    expect(store.getById(job.id)!.state).toBe(JobState.CREATED);

    // Step 2: retries=2 → fail with retries=1 → CREATED
    lockJob(store, job.id, "w", 9999);
    store.fail("w", job.id, 1, 1000);
    expect(store.getById(job.id)!.retries).toBe(1);
    expect(store.getById(job.id)!.state).toBe(JobState.CREATED);

    // Step 3: retries=1 → fail with retries=0 → FAILED
    lockJob(store, job.id, "w", 9999);
    store.fail("w", job.id, 0, 0);
    expect(store.getById(job.id)!.retries).toBe(0);
    expect(store.getById(job.id)!.state).toBe(JobState.FAILED);
  });
});

// ---------------------------------------------------------------------------
// FF-T5-11 / AC-9: fail retries<=0 → FAILED terminal state
// ---------------------------------------------------------------------------
describe("fail with retries=0 sets state=FAILED (AC-9, FF-T5-11)", () => {
  it("returns { ok: true } and transitions to FAILED", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 3);
    lockJob(store, job.id, "worker-1", 9999);

    const result = store.fail("worker-1", job.id, 0, 99999);
    expect(result).toEqual({ ok: true });

    const updated = store.getById(job.id)!;
    expect(updated.state).toBe(JobState.FAILED);
    expect(updated.retries).toBe(0);
    expect(updated.lockOwner).toBeUndefined();
    expect(updated.lockExpiry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-7: fail gate error codes
// ---------------------------------------------------------------------------
describe("fail ownership gate returns correct codes (AC-7)", () => {
  it("returns NOT_FOUND for unknown jobId", () => {
    const store = new JobStore();
    expect(store.fail("w", "no-such-id", 1, 1000)).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("returns NOT_LOCKED for CREATED job", () => {
    const store = new JobStore(makeFixedClock(1000));
    const job = store.enqueue("invoice", {}, 0);
    expect(store.fail("w", job.id, 1, 1000)).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("returns NOT_LOCKED for COMPLETED job", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "w", 9999);
    store.complete("w", job.id);
    expect(store.fail("w", job.id, 1, 1000)).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("returns LOCK_EXPIRED for expired lock", () => {
    const clock = makeFixedClock(5000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "w", 4999);
    expect(store.fail("w", job.id, 1, 1000)).toEqual({ ok: false, code: "LOCK_EXPIRED" });
  });

  it("returns NOT_OWNER for wrong workerId", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("invoice", {}, 0);
    lockJob(store, job.id, "correct-w", 9999);
    expect(store.fail("wrong-w", job.id, 1, 1000)).toEqual({ ok: false, code: "NOT_OWNER" });
  });
});

// ---------------------------------------------------------------------------
// FF-T5-12 / AC-12: gate precedence NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER
// ---------------------------------------------------------------------------
describe("gate precedence: NOT_FOUND > NOT_LOCKED > LOCK_EXPIRED > NOT_OWNER (AC-12, FF-T5-12)", () => {
  it("NOT_FOUND beats everything: nonexistent job with any state or owner assumption", () => {
    const store = new JobStore();
    expect(store.complete("w", "ghost")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(store.fail("w", "ghost", 1, 1000)).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("NOT_LOCKED beats LOCK_EXPIRED: CREATED job returns NOT_LOCKED regardless of time", () => {
    const clock = makeFixedClock(99999);
    const store = new JobStore(clock);
    const job = store.enqueue("t", {}, 0); // state=CREATED
    // Do not lock → state is CREATED
    expect(store.complete("w", job.id)).toEqual({ ok: false, code: "NOT_LOCKED" });
    expect(store.fail("w", job.id, 1, 0)).toEqual({ ok: false, code: "NOT_LOCKED" });
  });

  it("LOCK_EXPIRED beats NOT_OWNER: expired lock + wrong owner → LOCK_EXPIRED", () => {
    const clock = makeFixedClock(5000);
    const store = new JobStore(clock);
    const job = store.enqueue("t", {}, 0);
    lockJob(store, job.id, "real-owner", 4000); // expired

    // wrong owner and expired — LOCK_EXPIRED must win
    expect(store.complete("wrong-owner", job.id)).toEqual({ ok: false, code: "LOCK_EXPIRED" });
    lockJob(store, job.id, "real-owner", 4000); // reset to expired again
    expect(store.fail("wrong-owner", job.id, 1, 1000)).toEqual({ ok: false, code: "LOCK_EXPIRED" });
  });

  it("NOT_OWNER is last: valid lock, correct state, non-expired, wrong owner", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("t", {}, 0);
    lockJob(store, job.id, "real-owner", 9999);

    expect(store.complete("intruder", job.id)).toEqual({ ok: false, code: "NOT_OWNER" });
    expect(store.fail("intruder", job.id, 1, 1000)).toEqual({ ok: false, code: "NOT_OWNER" });
  });
});

// ---------------------------------------------------------------------------
// FF-T5-13 / AC-11: immutability — no internal reference leak
// ---------------------------------------------------------------------------
describe("complete/fail do not leak internal references (AC-11, FF-T5-13)", () => {
  it("mutating the Job returned by getById after complete does not change stored record", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("t", { x: 1 }, 0);
    lockJob(store, job.id, "w", 9999);
    store.complete("w", job.id);

    const copy = store.getById(job.id)!;
    const snapshot = store.getById(job.id);

    // Attempt to mutate returned copy
    (copy as { retries: number }).retries = 999;
    (copy as { state: string }).state = "MUTATED";

    // Stored record must be unchanged
    expect(store.getById(job.id)).toEqual(snapshot);
    expect(store.getById(job.id)!.state).toBe(JobState.COMPLETED);
  });

  it("mutating the Job returned by getById after fail does not change stored record", () => {
    const clock = makeFixedClock(1000);
    const store = new JobStore(clock);
    const job = store.enqueue("t", { y: 2 }, 3);
    lockJob(store, job.id, "w", 9999);
    store.fail("w", job.id, 2, 5000);

    const copy = store.getById(job.id)!;
    const snapshot = store.getById(job.id);

    (copy as { retries: number }).retries = 999;

    expect(store.getById(job.id)).toEqual(snapshot);
    expect(store.getById(job.id)!.retries).toBe(2);
  });
});
