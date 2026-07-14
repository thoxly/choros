/**
 * Domain types for the Choros app-timer model (T-0116).
 * Pure types — no behavior.
 */

/** The four lifecycle states of an AppTimer. */
export type TimerState = 'pending' | 'firing' | 'done' | 'cancelled';

/** Immutable domain record representing a single durable application timer. */
export interface AppTimer {
  readonly tenantId: string;         // UUID
  readonly id: string;               // UUID
  readonly dueAt: number;            // unix epoch ms; moment of firing
  readonly state: TimerState;
  readonly kind: string;             // timer type (inbox_sla, lease_renew, retry, …)
  readonly payload: Record<string, unknown>;  // opaque to dispatcher
  readonly createdAt: number;        // unix epoch ms (Clock.now() at enqueue)
  readonly firedAt: number | undefined;      // set by dispatcher when → firing
  readonly cancelReason: string | undefined; // set by cancel()
}
