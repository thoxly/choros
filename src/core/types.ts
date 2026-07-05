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
  /**
   * T-0677 (upstream fix for T-0534/T-0638): the BPMN processDefinitionKey captured
   * at enqueue time (choros.job.process_def_id, migration 111). Optional/nullable —
   * absent or null for jobs enqueued before this column existed, or when the
   * enqueue caller had no process scope to capture (e.g. non-BPMN-originated jobs).
   * Threaded end-to-end so agent-step-context.ts's readJobVars() can prefer the
   * authoritative DB column over a best-effort `variables` lookup.
   */
  readonly processDefId?: string | null;
  /**
   * T-0677 (upstream fix for T-0534/T-0638): the Flowable processInstanceId captured
   * at enqueue time (choros.job.instance_id, migration 111). Optional/nullable —
   * same absence semantics as processDefId above. This is the field whose absence
   * left agent-step-context.ts's readJobVars() with instanceId="" for every live
   * agentTask job, making the T-0638 defer-completion fix inert (payload.instance_id
   * empty → deferred-inbox-store.ts treats it as null → 404 DEFER_NOT_ROUTABLE).
   */
  readonly instanceId?: string | null;
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
