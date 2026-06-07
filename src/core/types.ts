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
