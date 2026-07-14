/**
 * src/core/env-tier.ts — T-0087 E12.6: two logical tiers (draft→published).
 *
 * PURE, IO-FREE. No import from pg, http, https, net, fetch, child_process.
 *
 * Exports:
 *   Tier                — "draft" | "published"
 *   assertWritable      — app-layer published-lock guard (AC-2 / FR-4)
 *   PromoteInput        — input to decidePromote
 *   PromoteDecision     — decision union from decidePromote
 *   decidePromote       — pure promote transition decision (AC-7 / FR-3)
 *   readTierScope       — default read-tier resolver (AC-6 / FR-5)
 *
 * ADR (docs/design/T-0087-client-env-tiers.adr.md) §4.2 / §4.3 / §4.4.
 *
 * DESIGN INVARIANTS:
 *  - No IO, no side-effects. Every function is pure.
 *  - tier='published' is NEVER assigned here — promote is a decision;
 *    the actual UPDATE is in the promoteTier service (src/http/artifacts.ts).
 *  - actorType always comes from the AUTHENTICATED claim (T-0044 §9 discipline),
 *    never from a request body — the caller's contract.
 */

// ---------------------------------------------------------------------------
// Tier type
// ---------------------------------------------------------------------------

/** The two logical tiers of a client environment (ADR §4.1). */
export type Tier = "draft" | "published";

// ---------------------------------------------------------------------------
// assertWritable — app-layer published-lock guard (FR-4 / AC-2)
// ---------------------------------------------------------------------------

/**
 * Returns `{ ok: true }` when the artifact is in draft (writable).
 * Returns `{ ok: false, code: "PUBLISHED_LOCKED" }` when it is published.
 *
 * The HTTP handler maps `PUBLISHED_LOCKED` → 409.
 * This is the app-layer half of the dual mechanism; the DB trigger is the
 * fail-closed half (ADR §2.2).
 */
export function assertWritable(
  currentTier: Tier,
): { ok: true } | { ok: false; code: "PUBLISHED_LOCKED" } {
  if (currentTier === "draft") {
    return { ok: true };
  }
  return { ok: false, code: "PUBLISHED_LOCKED" };
}

// ---------------------------------------------------------------------------
// decidePromote — pure promote transition decision (FR-3 / AC-7)
// ---------------------------------------------------------------------------

/** Input to decidePromote. actorType MUST come from the authenticated claim. */
export interface PromoteInput {
  currentTier: Tier;
  /** From the AUTHENTICATED actor_type claim (T-0044 §9). Never from request body. */
  actorType: "human" | "agent";
}

/** Decision union returned by decidePromote. */
export type PromoteDecision =
  | { ok: true; from: "draft"; to: "published" }
  | { ok: false; code: "FORBIDDEN_AGENT_SELF_PROMOTE" }  // agent actor → 403 (AC-7)
  | { ok: false; code: "NOT_IN_DRAFT" };                 // already published → 409

/**
 * Pure promote decision: validates agent gate and source-tier.
 *
 * - Agent actor → FORBIDDEN_AGENT_SELF_PROMOTE (AC-7, FR-3 human-gated).
 * - currentTier !== "draft" → NOT_IN_DRAFT (idempotent-safe: already published).
 * - Human + draft → ok (the transactional UPDATE is the service's job).
 *
 * The agent check fires BEFORE the tier check so an agent with a published
 * artifact gets 403 (agent gate), not 409 (tier state) — preserving the
 * separation of authority and state (ADR §4.5).
 */
export function decidePromote(input: PromoteInput): PromoteDecision {
  if (input.actorType === "agent") {
    return { ok: false, code: "FORBIDDEN_AGENT_SELF_PROMOTE" };
  }
  if (input.currentTier !== "draft") {
    return { ok: false, code: "NOT_IN_DRAFT" };
  }
  return { ok: true, from: "draft", to: "published" };
}

// ---------------------------------------------------------------------------
// readTierScope — default read-tier resolver (FR-5 / AC-6)
// ---------------------------------------------------------------------------

/**
 * Returns the tier to use for data reads.
 * Defaults to "published" (prod-context) unless the caller explicitly opts
 * into draft (e.g. the simulation/authoring surface — T-0130 / T-0077).
 *
 * Never reads NODE_ENV / CHOROS_ENV — tier is orthogonal to the SDLC (FR-6 / AC-9).
 */
export function readTierScope(ctx: { draftRequested?: boolean }): Tier {
  return ctx.draftRequested === true ? "draft" : "published";
}
