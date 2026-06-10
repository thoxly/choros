/**
 * Domain type declarations for the Choros job model.
 * Pure types and value constants — no behavior.
 */

/** The four lifecycle states of a Job in the pull-model external worker API. */
export enum JobState {
  /** Job enqueued, awaiting a worker to pick it up. */
  CREATED = "CREATED",
  /** A worker holds an exclusive lock and is executing the job. */
  LOCKED = "LOCKED",
  /** Worker reported successful completion. */
  COMPLETED = "COMPLETED",
  /** Worker reported an error, or retries are exhausted. */
  FAILED = "FAILED",
}

/** Immutable domain record representing a single unit of work. */
export interface Job {
  readonly id: string;
  readonly topic: string;
  readonly variables: Record<string, unknown>;
  readonly state: JobState;
  readonly retries: number;
  /** Set by the lock operation (T-0004). Undefined until a worker acquires the job. */
  readonly lockOwner: string | undefined;
  /** Unix epoch ms at which the lock expires. Undefined until a worker acquires the job. */
  readonly lockExpiry: number | undefined;
  /** Unix epoch ms at the time the job was enqueued, sourced from the injected Clock. */
  readonly createdAt: number;
  /**
   * Unix epoch ms at which this job becomes eligible for fetchAndLock.
   * Set to createdAt on enqueue; updated to clock.now()+retryTimeoutMs on fail-with-retry.
   * T-0114: previously recorded-only — now actively enforced by fetchAndLock.
   */
  readonly available_at: number;
  /**
   * T-0028: validated complete-payload result. Set when a worker calls complete() with a payload.
   * Absent when complete() is called without a payload (backward-compat: field absent = no payload).
   */
  readonly result?: Record<string, unknown>;
}

/** Clock abstraction — injection seam for deterministic time in tests. */
export interface Clock {
  now(): number;
}

/** Input parameters for enqueuing a new job. */
export interface EnqueueInput {
  topic: string;
  variables: Record<string, unknown>;
  retries: number;
}

/** Default real-time clock backed by Date.now(). */
export const systemClock: Clock = { now: () => Date.now() };
