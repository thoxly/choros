/**
 * src/core/lifecycle-guard.ts
 *
 * T-0068: PURE GuardContext construction for the approve/transition seam (ADR §4.7
 * / FR-7). Additive only: resolveFor already accepts the optional `guardCtx` and
 * `deps.sod` params (grant-resolver.ts), so T-0068 does NOT change that signature
 * and does NOT build the Postgres SoD-DAO (that is T-0053). This helper builds a
 * GuardContext from lifecycle context so that, once T-0053's deps.sod lands, the
 * seam is injectable without a rewrite.
 *
 * Without deps.sod, resolveFor's behavior is identical to pre-T-0032 (fail-open by
 * absence; grant-only decision) — verified by FF-10.
 *
 * IO-free: no import from pg/http/https/net/fetch/child_process.
 */

import type { GuardContext } from "./grant-resolver.js";
import type { ActorEventVerb } from "./actor-event.js";

/** Lifecycle context the seam carries at an approve/transition point. */
export interface LifecycleGuardInput {
  /** The performer (employee id). */
  actor: string;
  /** The principal when distinct from the performer. */
  onBehalfOf?: string | null;
  /** The role the gateway resolved the actor under. */
  roleAtEvent: string;
  /**
   * The verb recorded on the act. Restricted to the CLOSED actor_event verb set
   * (migration 018) — there is no free-string 'transition' verb; a transition in
   * a process maps onto one of the closed verbs (e.g. 'submit' / 'release').
   */
  verb: ActorEventVerb;
  /** Approve level — required iff verb === 'approve' (≥1). */
  approveLevel?: number;
}

/**
 * Build a GuardContext from lifecycle context. Pure. Threads approveLevel only
 * when supplied (the writer rejects a level on a non-approve verb / a missing
 * level on approve — fail-closed downstream).
 */
export function buildLifecycleGuardCtx(input: LifecycleGuardInput): GuardContext {
  const ctx: GuardContext = {
    actor: input.actor,
    onBehalfOf: input.onBehalfOf ?? null,
    roleAtEvent: input.roleAtEvent,
    verb: input.verb,
  };
  if (input.approveLevel !== undefined) {
    ctx.approveLevel = input.approveLevel;
  }
  return ctx;
}
