/**
 * In-memory JobStore backed by a Map.
 * Single source of truth for Job state in this process.
 * Zero runtime dependencies — uses only node:crypto stdlib.
 */
import { randomUUID } from "node:crypto";
import { type Job, JobState, type Clock, systemClock } from "./types.js";

export class JobStore {
  /** Frozen canonical records — external code cannot mutate store state. */
  private readonly jobs: Map<string, Job> = new Map();
  private readonly clock: Clock;

  constructor(clock?: Clock) {
    this.clock = clock ?? systemClock;
  }

  /**
   * Create a new Job with state CREATED and store it.
   * Returns a defensive copy; the internal record is frozen.
   */
  enqueue(
    topic: string,
    variables: Record<string, unknown>,
    retries: number
  ): Job {
    const job: Job = Object.freeze({
      id: randomUUID(),
      topic,
      variables,
      state: JobState.CREATED,
      retries,
      lockOwner: undefined,
      lockExpiry: undefined,
      createdAt: this.clock.now(),
    });
    this.jobs.set(job.id, job);
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
   * Available predicate:
   *   state === CREATED  OR  (state === LOCKED AND lockExpiry <= clock.now())
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
          j.state === JobState.CREATED ||
          (j.state === JobState.LOCKED &&
            j.lockExpiry !== undefined &&
            j.lockExpiry <= now)
        );
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, maxJobs);
    return candidates.map((j) => {
      const locked = Object.freeze({
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
   * On success: stores a new frozen snapshot with state=COMPLETED and lock fields cleared.
   * Returns { ok: true } on success; does NOT return the updated Job (use getById).
   */
  complete(workerId: string, jobId: string): CompleteResult {
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
    const updated: Job = Object.freeze({
      ...job,
      state: JobState.COMPLETED,
      lockOwner: undefined,
      lockExpiry: undefined,
    });
    this.jobs.set(jobId, updated);
    return { ok: true };
  }

  /**
   * Report a job failure by the owning worker, optionally scheduling a retry.
   * Ownership gate precedence: NOT_FOUND → NOT_LOCKED → LOCK_EXPIRED → NOT_OWNER.
   * retries > 0 → state=CREATED (job re-available); retries <= 0 → state=FAILED.
   * retryTimeoutMs is accepted for API parity with the external-task pattern but is
   * RECORDED-ONLY / not enforced — no availableAt field is set (deferred: parallel T-0004
   * write-zone constraint blocks the types.ts change required to store the field).
   * Returns { ok: true } on success; does NOT return the updated Job (use getById).
   */
  fail(workerId: string, jobId: string, retries: number, retryTimeoutMs: number): FailResult {
    // retryTimeoutMs is accepted for API parity but not enforced as a delay here;
    // enforcement is deferred to fetchAndLock (T-0004) which will filter by availableAt.
    void retryTimeoutMs;
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
    const nextState = retries > 0 ? JobState.CREATED : JobState.FAILED;
    const nextRetries = retries > 0 ? retries : 0;
    const updated: Job = Object.freeze({
      ...job,
      state: nextState,
      retries: nextRetries,
      lockOwner: undefined,
      lockExpiry: undefined,
    });
    this.jobs.set(jobId, updated);
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Result-union types — exported from jobStore.ts (NOT from types.ts).
// These are behavioural contracts belonging to the store, not domain types.
// ---------------------------------------------------------------------------

/** The four gate-failure codes shared by complete and fail. */
export type ErrorCode = "NOT_FOUND" | "NOT_LOCKED" | "LOCK_EXPIRED" | "NOT_OWNER";

/** Discriminated result union returned by JobStore.complete(). */
export type CompleteResult = { ok: true } | { ok: false; code: ErrorCode };

/** Discriminated result union returned by JobStore.fail(). */
export type FailResult = { ok: true } | { ok: false; code: ErrorCode };
