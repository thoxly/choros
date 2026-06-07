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
}
