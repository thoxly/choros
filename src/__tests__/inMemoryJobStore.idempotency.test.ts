/**
 * Unit tests for InMemoryJobStore idempotency-key parity (T-0062, ADR §4.1).
 * The test double must mirror PostgresJobStore's idempotency surface so the
 * shared JobStore type stays consistent.
 */
import { describe, it, expect } from "vitest";
import { InMemoryJobStore } from "../core/inMemoryJobStore.js";

describe("InMemoryJobStore.enqueue idempotency parity", () => {
  it("AC-1: enqueue with a new key creates a job", () => {
    const store = new InMemoryJobStore();
    const job = store.enqueue("topic", { a: 1 }, 0, "key-1");
    expect(job.id).toBeDefined();
  });

  it("AC-2: repeat enqueue with same key returns the SAME job (no duplicate)", () => {
    const store = new InMemoryJobStore();
    const first = store.enqueue("topic", { a: 1 }, 0, "key-1");
    const second = store.enqueue("topic", { a: 2 }, 0, "key-1");
    expect(second.id).toBe(first.id);
    // Only one job exists.
    expect(store.jobs.size).toBe(1);
    // The returned job is the first one (variables unchanged — no DO UPDATE).
    expect(second.variables).toEqual({ a: 1 });
  });

  it("AC-3: enqueue without a key always creates a new job", () => {
    const store = new InMemoryJobStore();
    const j1 = store.enqueue("topic", {}, 0);
    const j2 = store.enqueue("topic", {}, 0);
    expect(j1.id).not.toBe(j2.id);
    expect(store.jobs.size).toBe(2);
  });

  it("different keys create different jobs", () => {
    const store = new InMemoryJobStore();
    const a = store.enqueue("t", {}, 0, "k-a");
    const b = store.enqueue("t", {}, 0, "k-b");
    expect(a.id).not.toBe(b.id);
    expect(store.jobs.size).toBe(2);
  });
});
