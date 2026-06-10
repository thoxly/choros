/**
 * In-memory JobStore backed by a Map — promoted to explicit TestDouble (T-0114).
 * Single source of truth for Job state in-process; used in unit tests and as the
 * no-DB fallback. Zero runtime dependencies — uses only node:crypto stdlib.
 *
 * T-0114 changes vs the original JobStore:
 *   - Gained `available_at` field in enqueue/fail (correct TestDouble semantics).
 *   - fetchAndLock enforces `available_at <= clock.now()` (previously void'd).
 */
import { randomUUID } from "node:crypto";
import { type Job, JobState, type Clock, systemClock } from "./types.js";
import type { CompleteResult, FailResult } from "./jobStoreTypes.js";
import { assertVariableValue } from "./object-handle.js";

export class InMemoryJobStore {
  /** Frozen canonical records — external code cannot mutate store state. */
  readonly jobs: Map<string, Job> = new Map();
  /**
   * Idempotency index (T-0062): idempotencyKey → jobId. The Postgres store keys
   * by (tenant_id, key); this single-process test double has no tenant, so the
   * key alone is the dedup identity (parity for the JobStore type surface).
   */
  private readonly byIdempotencyKey: Map<string, string> = new Map();
  private readonly clock: Clock;

  constructor(clock?: Clock) {
    this.clock = clock ?? systemClock;
  }

  /**
   * Create a new Job with state CREATED and store it.
   * available_at = createdAt (immediately eligible).
   * Returns a defensive copy; the internal record is frozen.
   *
   * T-0062 idempotency parity: when `idempotencyKey` is provided and a job with
   * the same key already exists, returns the EXISTING job (no duplicate, AC-2).
   * Undefined key = current behavior (always a new job, AC-3).
   */
  enqueue(
    topic: string,
    variables: Record<string, unknown>,
    retries: number,
    idempotencyKey?: string
  ): Job {
    if (idempotencyKey !== undefined) {
      const existingId = this.byIdempotencyKey.get(idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.jobs.get(existingId);
        if (existing !== undefined) return { ...existing };
      }
    }
    const now = this.clock.now();
    const job: Job = Object.freeze({
      id: randomUUID(),
      topic,
      variables,
      state: JobState.CREATED,
      retries,
      lockOwner: undefined,
      lockExpiry: undefined,
      createdAt: now,
      available_at: now,
    });
    this.jobs.set(job.id, job);
    if (idempotencyKey !== undefined) {
      this.byIdempotencyKey.set(idempotencyKey, job.id);
    }
    return { ...job };
  }

  /**
   * Return the Job matching the given id, or undefined if not found.
   * Returns a defensive copy.
   */
  getById(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job !== undefined ? { ...job } : undefined;
  }

  /**
   * Return all Jobs with the given topic, sorted by createdAt ascending.
   * Each element is a defensive copy.
   */
  listByTopic(topic: string): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.topic === topic)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({ ...j }));
  }

  /**
   * Return all Jobs in the given state, sorted by createdAt ascending.
   * Returns an empty array when no Jobs match.
   * Each element is a defensive copy.
   */
  listByState(state: JobState): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.state === state)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({ ...j }));
  }

  /**
   * Return all Jobs matching both topic AND state, sorted by createdAt ascending.
   * Each element is a defensive copy.
   */
  listByTopicAndState(topic: string, state: JobState): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.topic === topic && j.state === state)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({ ...j }));
  }

  /**
   * Atomically select up to maxJobs available jobs from the given topics,
   * acquire an exclusive lock on each, and return defensive copies in FIFO order.
   *
   * Available predicate (T-0114 — available_at now enforced):
   *   (state === CREATED AND available_at <= now)
   *   OR (state === LOCKED AND lockExpiry <= now)
   *
   * Returns [] immediately if maxJobs <= 0 or topics is empty.
   * Each returned element is a defensive copy; internal records are frozen snapshots.
   */
  fetchAndLock(
    workerId: string,
    topics: string[],
    maxJobs: number,
    lockDurationMs: number
  ): Job[] {
    if (maxJobs <= 0 || topics.length === 0) {
      return [];
    }
    const now = this.clock.now();
    const topicSet = new Set(topics);
    const candidates = [...this.jobs.values()]
      .filter((j) => {
        if (!topicSet.has(j.topic)) return false;
        return (
          (j.state === JobState.CREATED && j.available_at <= now) ||
          (j.state === JobState.LOCKED &&
            j.lockExpiry !== undefined &&
            j.lockExpiry <= now)
        );
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, maxJobs);
    return candidates.map((j) => {
      const locked: Job = Object.freeze({
        ...j,
        state: JobState.LOCKED,
        lockOwner: workerId,
        lockExpiry: this.clock.now() + lockDurationMs,
      });
      this.jobs.set(locked.id, locked);
      return { ...locked };
    });
  }

  /**
   * Mark a job as completed by the owning worker.
   * Ownership gate precedence: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER.
   * T-0028: optional payload parameter — validated fail-closed with assertVariableValue
   * before state is advanced. A raw record object in any payload value returns
   * { ok: false, code: "RECORD_IN_PAYLOAD" } and the job remains LOCKED (all-or-nothing).
   * On success: stores a new frozen snapshot with state=COMPLETED, lock fields cleared,
   * and result set to the validated payload (if provided).
   * Returns { ok: true } on success; does NOT return the updated Job (use getById).
   */
  complete(workerId: string, jobId: string, payload?: Record<string, unknown>): CompleteResult {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (job.state !== JobState.LOCKED) {
      return { ok: false, code: "NOT_LOCKED" };
    }
    if (job.lockExpiry! <= this.clock.now()) {
      return { ok: false, code: "LOCK_EXPIRED" };
    }
    if (job.lockOwner !== workerId) {
      return { ok: false, code: "NOT_OWNER" };
    }
    // T-0028 Layer B: validate payload before advancing state (all-or-nothing, fail-closed)
    if (payload !== undefined) {
      for (const value of Object.values(payload)) {
        const r = assertVariableValue(value);
        if (!r.ok) {
          return { ok: false, code: "RECORD_IN_PAYLOAD" };
        }
      }
    }
    const updated: Job = Object.freeze({
      ...job,
      state: JobState.COMPLETED,
      lockOwner: undefined,
      lockExpiry: undefined,
      ...(payload !== undefined ? { result: payload } : {}),
    });
    this.jobs.set(jobId, updated);
    return { ok: true };
  }

  /**
   * Report a job failure by the owning worker, optionally scheduling a retry.
   * Ownership gate precedence: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER.
   * retries > 0 → state=CREATED (job re-available after retryTimeoutMs delay).
   * retries <= 0 → state=FAILED (terminal).
   * T-0114: available_at = clock.now() + retryTimeoutMs if retries>0 (enforced, not void).
   * Returns { ok: true } on success; does NOT return the updated Job (use getById).
   */
  fail(workerId: string, jobId: string, retries: number, retryTimeoutMs: number): FailResult {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (job.state !== JobState.LOCKED) {
      return { ok: false, code: "NOT_LOCKED" };
    }
    if (job.lockExpiry! <= this.clock.now()) {
      return { ok: false, code: "LOCK_EXPIRED" };
    }
    if (job.lockOwner !== workerId) {
      return { ok: false, code: "NOT_OWNER" };
    }
    const now = this.clock.now();
    const nextState = retries > 0 ? JobState.CREATED : JobState.FAILED;
    const nextRetries = retries > 0 ? retries : 0;
    const available_at = retries > 0 ? now + retryTimeoutMs : job.available_at;
    const updated: Job = Object.freeze({
      ...job,
      state: nextState,
      retries: nextRetries,
      lockOwner: undefined,
      lockExpiry: undefined,
      available_at,
    });
    this.jobs.set(jobId, updated);
    return { ok: true };
  }
}
