/**
 * T-0019 · Typed actor-event ledger — the SoD substrate (E4.1).
 *
 * Pure TS port. This module FREEZES the write/read contracts that the
 * guarded-transition writer (T-0021/E4.2 `appendActorEvent`) and the SoD query
 * layer (T-0032/E4.2) consume — it does NOT implement either. There is no DB/IO
 * here: the only sanctioned writer is the gateway path, which lands in T-0021.
 *
 * It is a SEPARATE module from grant-resolver.ts (the run seam, ADR §7): T-0033
 * edits the resolver additively in parallel; this module never touches it.
 *
 * Semantic contract: §4.1–4.5 of docs/design/T-0019-actor-event-ledger.adr.md.
 * The Postgres schema (migration 018) is authoritative; this is the camelCase TS
 * mirror (string for uuid, number for bigint epoch-ms — T-0014/T-0017 convention).
 *
 * Invariants this module pins (the writer T-0021 must satisfy, the SoD layer
 * T-0032 reads against):
 *   - performer (`actor`) ≠ principal (`onBehalfOf`); SoD attributes to the
 *     principal `COALESCE(onBehalfOf, actor)` (AC-12).
 *   - the verb set is CLOSED and vocab-versioned (AC-18/20).
 *   - `approveLevel` is present IFF `event==='approve'` and is ≥ 1 (AC-19).
 *   - the row carries REFERENCES, never object payloads (AC-17) — `detail` is
 *     event metadata only.
 */

// ---------------------------------------------------------------------------
// Closed, vocab-versioned verb vocabulary (§4.2 / AC-18/20)
// ---------------------------------------------------------------------------

/**
 * The CLOSED, GT-1-signed verb set. Mirrors the `event` CHECK in migration 018.
 * Extending it is a CHECK edit + VOCAB_VERSION bump (a deliberate, reviewed,
 * CI-visible migration) — NEVER a runtime free string. The golden lint
 * `ci/checks/actor_event_vocab_pinned.sh` fails CI if this set drifts from the DDL.
 */
export const ACTOR_EVENT_VERBS = [
  "request",
  "prepare",
  "submit",
  "approve",
  "release",
] as const;

export type ActorEventVerb = (typeof ACTOR_EVENT_VERBS)[number];

/**
 * The current vocab version pinned on every appended row (§4.2). A future verb-set
 * migration bumps this so old rows stay interpretable.
 */
export const VOCAB_VERSION = 1 as const;

/** The object-kind discriminator (mirrors object_handle.ref_kind / object_kind CHECK). */
export type ObjectKind = "application" | "registry" | "record";

// ---------------------------------------------------------------------------
// Write contract — the shape the gateway writer (T-0021/E4.2) MUST satisfy
// ---------------------------------------------------------------------------

/**
 * The denormalized opaque ResourceRef anchor (§3.4 / FR-3). Exactly the component
 * implied by `kind` is populated; the component ids are NOT FK-enforced
 * (opaque-pointer posture — a record_id absent from `record` is accepted, AC-15).
 */
export type ActorEventObjectRef =
  | { objectKind: "application"; applicationId: string }
  | { objectKind: "registry"; registryId: string }
  | { objectKind: "record"; recordId: string };

/**
 * The frozen input to the guarded-transition writer (`appendActorEvent`, §4.3).
 *  - `actor` = the performer (employee.id, NOT NULL).
 *  - `onBehalfOf` = the principal when ≠ performer (nullable; null ⇒ own behalf).
 *  - `roleAtEvent` = the role the gateway resolved the actor under (point-in-time).
 *  - `approveLevel` is required IFF `event==='approve'` and must be ≥ 1.
 *  - `detail` is event metadata only — NEVER object field values (FR-6/AC-17).
 */
export type ActorEventInput = ActorEventObjectRef & {
  actor: string;
  onBehalfOf?: string | null;
  roleAtEvent: string;
  event: ActorEventVerb;
  approveLevel?: number;
  detail?: Record<string, unknown> | null;
};

/** What the writer returns after appending exactly one row (§4.3). */
export interface AppendedActorEvent {
  seq: number;
  id: string;
}

/**
 * The sanctioned-writer PORT (FR-7). Runs inside `withTenant` (T-0013), called by
 * the guarded-transition / gateway path at ACTION-TIME. T-0021/E4.2 implements it;
 * T-0019 ships only the contract + a deny stub. Append-only: it INSERTs one row
 * (advancing the per-tenant counter), never a read-modify-write of prior rows.
 */
export interface ActorEventWriter {
  appendActorEvent(input: ActorEventInput): Promise<AppendedActorEvent>;
}

// ---------------------------------------------------------------------------
// Input validation — the writer's precondition (pure, no IO)
// ---------------------------------------------------------------------------

export type ActorEventValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unknown_verb"
        | "approve_level_required"
        | "approve_level_forbidden"
        | "approve_level_lt_1"
        | "object_component_mismatch"
        | "missing_actor"
        | "missing_role";
    };

const VERB_SET: ReadonlySet<string> = new Set(ACTOR_EVENT_VERBS);

/**
 * Validates an ActorEventInput against the frozen DDL constraints BEFORE it ever
 * reaches the DB (the same predicates the CHECK constraints enforce, surfaced as
 * typed reasons for the writer). Pure, total, side-effect-free.
 *
 *  - `event` is in the closed verb set (mirrors the event CHECK, AC-18).
 *  - `approveLevel` present IFF approve, and ≥ 1 (mirrors the approve_level CHECKs, AC-19).
 *  - exactly the object component implied by `objectKind` is populated (AC-15 shape).
 *  - `actor` and `roleAtEvent` are NON-empty (NOT NULL columns, AC-10/14).
 */
export function validateActorEventInput(
  input: ActorEventInput,
): ActorEventValidation {
  if (!VERB_SET.has(input.event)) {
    return { ok: false, reason: "unknown_verb" };
  }

  const isApprove = input.event === "approve";
  const hasLevel = input.approveLevel !== undefined && input.approveLevel !== null;
  if (isApprove && !hasLevel) {
    return { ok: false, reason: "approve_level_required" };
  }
  if (!isApprove && hasLevel) {
    return { ok: false, reason: "approve_level_forbidden" };
  }
  if (hasLevel && (input.approveLevel as number) < 1) {
    return { ok: false, reason: "approve_level_lt_1" };
  }

  // Exactly the component implied by objectKind must be present.
  const componentOk =
    (input.objectKind === "application" &&
      typeof (input as { applicationId?: string }).applicationId === "string") ||
    (input.objectKind === "registry" &&
      typeof (input as { registryId?: string }).registryId === "string") ||
    (input.objectKind === "record" &&
      typeof (input as { recordId?: string }).recordId === "string");
  if (!componentOk) {
    return { ok: false, reason: "object_component_mismatch" };
  }

  if (typeof input.actor !== "string" || input.actor.length === 0) {
    return { ok: false, reason: "missing_actor" };
  }
  if (typeof input.roleAtEvent !== "string" || input.roleAtEvent.length === 0) {
    return { ok: false, reason: "missing_role" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// SoD attribution — the principal rule (§4.4 / AC-12)
// ---------------------------------------------------------------------------

/**
 * The SoD principal of an actor-event: `COALESCE(onBehalfOf, actor)`.
 *
 * A delegated act (`actor=X, onBehalfOf=P`) is attributed to the principal `P`;
 * a self-act (`onBehalfOf` null/absent) is attributed to the performer `actor`.
 * This is the same-person SoD attribution the dynamic-SoD substrate matches on
 * (T-0032 reads `COALESCE(on_behalf_of, actor)` — §4.4(b)).
 */
export function actorEventPrincipal(e: {
  actor: string;
  onBehalfOf?: string | null;
}): string {
  return e.onBehalfOf ?? e.actor;
}

// ---------------------------------------------------------------------------
// Read contract — the SoD substrate shapes (§4.4; consumed by T-0032/E4.2)
// ---------------------------------------------------------------------------

/**
 * A read-back actor-event row (the TS mirror of an actor_event row). Carries
 * references and identities only — NO object payload (FR-6). `detail` is optional
 * event metadata.
 */
export interface ActorEventRow {
  tenantId: string;
  seq: number;
  id: string;
  objectKind: ObjectKind;
  applicationId: string | null;
  registryId: string | null;
  recordId: string | null;
  actor: string;
  onBehalfOf: string | null;
  roleAtEvent: string;
  event: ActorEventVerb;
  approveLevel: number | null;
  detail: Record<string, unknown> | null;
  ts: number;
  vocabVersion: number;
}

/**
 * The SoD read PORT (FR-8 / §4.4). Frozen here; implemented by T-0032/E4.2.
 * These are READ SHAPES, not the SoD constraints — the static/dynamic decision and
 * the action-time block are T-0032's.
 */
export interface ActorEventReader {
  /** (a) per-object ordered trail: all rows for one object, ORDER BY seq. */
  trail(ref: ActorEventObjectRef): Promise<ActorEventRow[]>;

  /**
   * (b) dynamic-SoD substrate: did principal P perform event E on object X?
   *     Matches on `COALESCE(onBehalfOf, actor) = principal` (actorEventPrincipal).
   */
  didPrincipalPerform(
    ref: ActorEventObjectRef,
    event: ActorEventVerb,
    principal: string,
  ): Promise<boolean>;

  /**
   * (c) static-SoD substrate: the distinct roles (role_at_event) that acted on
   *     object X, optionally filtered to a verb subset.
   */
  rolesThatActed(
    ref: ActorEventObjectRef,
    events?: ActorEventVerb[],
  ): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Deny / not-implemented default — the frozen seam (T-0021/E4.2 swaps it in)
// ---------------------------------------------------------------------------

/** Thrown by the default stubs: the writer/reader is T-0021/T-0032's, not T-0019's. */
export class ActorEventNotImplementedError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "actor_event writer/reader is frozen-not-implemented in T-0019 (writer=T-0021/E4.2, SoD reads=T-0032/E4.2)",
    );
    this.name = "ActorEventNotImplementedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The default writer: refuses to append — T-0019 ships the contract, not the
 * writer. T-0021/E4.2 replaces this with the real `withTenant`-scoped, per-tenant
 * counter-advancing INSERT path without changing the ActorEventWriter contract.
 */
export const notImplementedActorEventWriter: ActorEventWriter = {
  appendActorEvent(_input: ActorEventInput): Promise<AppendedActorEvent> {
    return Promise.reject(new ActorEventNotImplementedError());
  },
};

/** The default reader: refuses to read — T-0032/E4.2 implements the real one. */
export const notImplementedActorEventReader: ActorEventReader = {
  trail(_ref: ActorEventObjectRef): Promise<ActorEventRow[]> {
    return Promise.reject(new ActorEventNotImplementedError());
  },
  didPrincipalPerform(
    _ref: ActorEventObjectRef,
    _event: ActorEventVerb,
    _principal: string,
  ): Promise<boolean> {
    return Promise.reject(new ActorEventNotImplementedError());
  },
  rolesThatActed(
    _ref: ActorEventObjectRef,
    _events?: ActorEventVerb[],
  ): Promise<string[]> {
    return Promise.reject(new ActorEventNotImplementedError());
  },
};
