/**
 * Domain types for the Choros outbox model (T-0062, E1.2).
 * Pure types — no behavior.
 *
 * Outbox = transactional "data change + signal" record, delivered out-of-band
 * by a two-phase dispatcher (по образцу T-0116 app_timer).
 */

/** The four lifecycle states of an outbox row (monotonic forward, T-0019). */
export type OutboxState = 'pending' | 'dispatching' | 'dispatched' | 'dead';

/** Immutable domain record representing a single outbox row. */
export interface OutboxRow {
  readonly tenantId: string;        // UUID
  readonly id: string;              // UUID
  readonly aggregateKind: string;   // polymorphic source: 'job'/'record'/'external_task'/…
  readonly aggregateId: string;     // UUID; opaque ref, NOT a FK (polymorphism)
  readonly eventType: string;       // e.g. 'task_completed'
  readonly payload: Record<string, unknown>;  // signal data
  readonly state: OutboxState;
  readonly idempotencyKey: string;  // for delivery dedup by consumer
  readonly attempts: number;        // ≥ 0 (no-decrement)
  readonly createdAt: number;       // unix epoch ms (Clock.now() at enqueue)
  readonly availableAt: number;     // backoff window; dispatcher takes <= now
  readonly dispatchedAt: number | undefined;  // set when → dispatched
  readonly lastError: string | undefined;     // last failure diagnostic
}

/**
 * Insert shape for enqueueInTx. tenant_id is NOT part of the insert — it is
 * sourced from the GUC current_setting('choros.tenant_id', false)::uuid
 * (same pattern as pgTimerStore.enqueue, R-4). id/created_at/available_at/state
 * are assigned by the store (state='pending', attempts=0 by default).
 */
export interface OutboxInsert {
  readonly aggregateKind: string;
  readonly aggregateId: string;       // UUID
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;    // delivery dedup key (NOT NULL)
  /** Optional explicit available_at (defaults to clock.now() = immediately eligible). */
  readonly availableAt?: number;
}
