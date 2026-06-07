/**
 * Tests for JobStore.fetchAndLock (T-0004).
 * Covers AC-1 through AC-10, FF-5 through FF-11.
 */
import { describe, it, expect } from "vitest";
import { JobStore } from "../core/jobStore.js";
import { JobState } from "../core/types.js";

function makeStore(nowFn: () => number): JobStore {
  return new JobStore({ now: nowFn });
}

describe("JobStore.fetchAndLock", () => {
  // AC-1, AC-10, FF-6: lock-field correctness and clock seam
  it("AC-1/AC-10: returns locked job with correct fields when clock is stubbed", () => {
    const store = makeStore(() => 1000);
    const job = store.enqueue("invoice", { amount: 42 }, 3);
    const result = store.fetchAndLock("w1", ["invoice"], 1, 30000);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(job.id);
    expect(result[0].topic).toBe("invoice");
    expect(result[0].variables).toEqual({ amount: 42 });
    expect(result[0].retries).toBe(3);
    expect(result[0].createdAt).toBe(1000);
    expect(result[0].state).toBe(JobState.LOCKED);
    expect(result[0].lockOwner).toBe("w1");
    expect(result[0].lockExpiry).toBe(31000); // 1000 + 30000
  });

  // AC-2, FF-9: defensive copy — mutating returned object does not affect store
  it("AC-2: returned object is a defensive copy; mutating it does not alter the store", () => {
    const store = makeStore(() => 1000);
    const job = store.enqueue("invoice", {}, 0);
    const result = store.fetchAndLock("w1", ["invoice"], 1, 5000);
    expect(result).toHaveLength(1);

    // Capture the expected stored snapshot values before mutation
    const storedBefore = store.getById(job.id)!;
    expect(storedBefore.state).toBe(JobState.LOCKED);
    expect(storedBefore.lockOwner).toBe("w1");

    // Attempt to mutate the returned object — Job is readonly so we cast via unknown
    const mutable = result[0] as unknown as Record<string, unknown>;
    mutable["lockOwner"] = "hacker";
    mutable["state"] = "TAMPERED";

    // Store should be unaffected
    const storedAfter = store.getById(job.id)!;
    expect(storedAfter.state).toBe(JobState.LOCKED);
    expect(storedAfter.lockOwner).toBe("w1");
    expect(storedAfter.lockExpiry).toBe(6000);
  });

  // AC-3, FF-5: FIFO order and maxJobs cap
  it("AC-3: returns jobs in createdAt-ascending (FIFO) order, capped at maxJobs", () => {
    let callCount = 0;
    const clockSeq = [100, 200, 300, 400, 400, 400];
    const store = makeStore(() => clockSeq[callCount++] ?? 400);
    const a = store.enqueue("t", { n: 1 }, 0);
    const b = store.enqueue("t", { n: 2 }, 0);
    const c = store.enqueue("t", { n: 3 }, 0);

    const result = store.fetchAndLock("w", ["t"], 2, 5000);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(a.id);
    expect(result[0].createdAt).toBe(100);
    expect(result[1].id).toBe(b.id);
    expect(result[1].createdAt).toBe(200);

    // Third job untouched
    const third = store.getById(c.id)!;
    expect(third.state).toBe(JobState.CREATED);
  });

  // AC-4, FF-10: maxJobs boundary cases
  it("AC-4: maxJobs=0 returns []", () => {
    const store = makeStore(() => 1);
    store.enqueue("t", {}, 0);
    expect(store.fetchAndLock("w", ["t"], 0, 5000)).toEqual([]);
  });

  it("AC-4: maxJobs=-1 returns []", () => {
    const store = makeStore(() => 1);
    store.enqueue("t", {}, 0);
    expect(store.fetchAndLock("w", ["t"], -1, 5000)).toEqual([]);
  });

  it("AC-4: maxJobs=100 with 2 available jobs returns exactly 2", () => {
    const store = makeStore(() => 1);
    store.enqueue("t", {}, 0);
    store.enqueue("t", {}, 0);
    const result = store.fetchAndLock("w", ["t"], 100, 5000);
    expect(result).toHaveLength(2);
  });

  // AC-5, FF-10: empty topics returns []
  it("AC-5: empty topics array returns []", () => {
    const store = makeStore(() => 1);
    store.enqueue("t", {}, 0);
    expect(store.fetchAndLock("w", [], 10, 5000)).toEqual([]);
  });

  // AC-6: COMPLETED/FAILED/active-LOCKED jobs are not returned
  it("AC-6: active-locked job is not returned; no available candidates yields []", () => {
    const store = makeStore(() => 100);
    store.enqueue("t", {}, 0);
    // Lock with long expiry so it becomes active-locked
    const locked = store.fetchAndLock("w1", ["t"], 1, 9999);
    expect(locked).toHaveLength(1);
    // Now fetchAndLock again — active lock, no reclaim
    const again = store.fetchAndLock("w2", ["t"], 1, 9999);
    expect(again).toHaveLength(0);
  });

  // AC-7, FF-7: expired-lock reclaim
  it("AC-7: expired lock is reclaimable by a different worker", () => {
    let now = 500;
    const store = makeStore(() => now);
    store.enqueue("t", {}, 0);
    // Lock with lockDurationMs=0 → lockExpiry = 500+0 = 500
    const first = store.fetchAndLock("w1", ["t"], 1, 0);
    expect(first).toHaveLength(1);
    expect(first[0].lockExpiry).toBe(500);
    expect(first[0].lockOwner).toBe("w1");

    // Advance clock to 600 (>= lockExpiry=500)
    now = 600;
    const second = store.fetchAndLock("w2", ["t"], 1, 100);
    expect(second).toHaveLength(1);
    expect(second[0].lockOwner).toBe("w2");
    expect(second[0].lockExpiry).toBe(700); // 600+100
    expect(second[0].state).toBe(JobState.LOCKED);
  });

  // AC-8: topics union — only matching topics returned
  it("AC-8: only jobs from specified topics are returned", () => {
    const store = makeStore(() => 1);
    store.enqueue("a", { t: "a" }, 0);
    store.enqueue("b", { t: "b" }, 0);
    store.enqueue("c", { t: "c" }, 0);

    const result = store.fetchAndLock("w", ["a", "b"], 10, 5000);
    expect(result).toHaveLength(2);
    const topics = result.map((j) => j.topic).sort();
    expect(topics).toEqual(["a", "b"]);

    // job with topic 'c' untouched — still CREATED
    const cResult = store.listByTopic("c");
    expect(cResult).toHaveLength(1);
    expect(cResult[0].state).toBe(JobState.CREATED);
  });

  // AC-9, FF-8: active (non-expired) lock is not reclaimable
  it("AC-9: active lock (lockExpiry > now) is not reclaimable by another worker", () => {
    const now = 999;
    const store = makeStore(() => now);
    store.enqueue("t", {}, 0);
    // Lock with lockDurationMs=2 → lockExpiry = 999+2 = 1001
    store.fetchAndLock("w1", ["t"], 1, 2);
    // clock still at 999 < 1001
    const result = store.fetchAndLock("w2", ["t"], 1, 5000);
    expect(result).toHaveLength(0);
  });

  // AC-10 clock seam: all lockExpiry values come from injected clock
  it("AC-10: only this.clock.now() is used — stub controls all lockExpiry values", () => {
    const store = makeStore(() => 42);
    store.enqueue("t", {}, 0);
    store.enqueue("t", {}, 0);
    const result = store.fetchAndLock("w", ["t"], 10, 1000);
    for (const j of result) {
      expect(j.lockExpiry).toBe(1042); // 42 + 1000
    }
  });
});
