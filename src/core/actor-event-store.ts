/**
 * T-0032 · In-memory actor-event store — implements the FROZEN T-0019 ports
 * (`ActorEventReader` + `ActorEventWriter`) over ONE shared per-tenant list.
 *
 * This is the static-now test double for the guarded-transition writer (the
 * T-0019 §4.3 contract, tagged "T-0021/E4.2") and the three SoD read substrate
 * queries (the T-0019 §4.4 contract, tagged "T-0032/E4.2"). The Postgres DAO
 * over `withTenant` lands in T-0053 (ADR §2.1). `actor-event.ts` is NOT edited —
 * this module IMPLEMENTS its frozen ports.
 *
 * Discipline (ADR §4.1, the four contract bullets the tester checks):
 *  (a) one shared in-memory per-tenant list backs BOTH reader and writer, so the
 *      append a guarded op makes is immediately visible to the SoD read on the
 *      next call (the read-then-append on one logical step the resolver does);
 *  (b) the writer runs `validateActorEventInput` BEFORE the append and rejects
 *      on failure (AC-14) — the same precondition the DB CHECK constraints encode;
 *  (c) the per-tenant counter advances `+1` per append (AC-13 surrogate for the
 *      Postgres SELECT … FOR UPDATE; UPDATE next_seq = next_seq + 1);
 *  (d) it NEVER mutates a prior row — append-only, one push per append (AC-13).
 *
 * Pure / isolated (NF-1, AC-20): no pg/fs/net/http; all state is the in-memory
 * Map. The Postgres-backed store is T-0053; this is the deterministic substrate
 * the SoD decision functions and the resolver step 3.6 are tested against.
 */

import {
  type ActorEventInput,
  type ActorEventObjectRef,
  type ActorEventReader,
  type ActorEventRow,
  type ActorEventVerb,
  type ActorEventWriter,
  type AppendedActorEvent,
  type ObjectKind,
  actorEventPrincipal,
  validateActorEventInput,
} from "./actor-event.js";

/**
 * Thrown when the writer's `validateActorEventInput` precondition fails (AC-14).
 * Carries the typed validation reason so a caller (e.g. the resolver step 6.5,
 * which is fail-closed) can distinguish it. The DB CHECK constraints would
 * reject the same rows in T-0053.
 */
export class ActorEventValidationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`actor_event input rejected by validateActorEventInput: ${reason}`);
    this.name = "ActorEventValidationError";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Does an actor_event row reference the same object as `ref`? Pure structural
 * match on the discriminated component (mirrors the actor_event_object_read
 * index predicate; the trail is per-object).
 */
function rowMatchesRef(row: ActorEventRow, ref: ActorEventObjectRef): boolean {
  switch (ref.objectKind) {
    case "application":
      return (
        row.objectKind === "application" &&
        row.applicationId === ref.applicationId
      );
    case "registry":
      return row.objectKind === "registry" && row.registryId === ref.registryId;
    case "record":
      return row.objectKind === "record" && row.recordId === ref.recordId;
  }
}

/** Map the typed input ref into the row's denormalized component columns. */
function refColumns(input: ActorEventInput): {
  objectKind: ObjectKind;
  applicationId: string | null;
  registryId: string | null;
  recordId: string | null;
} {
  switch (input.objectKind) {
    case "application":
      return {
        objectKind: "application",
        applicationId: input.applicationId,
        registryId: null,
        recordId: null,
      };
    case "registry":
      return {
        objectKind: "registry",
        applicationId: null,
        registryId: input.registryId,
        recordId: null,
      };
    case "record":
      return {
        objectKind: "record",
        applicationId: null,
        registryId: null,
        recordId: input.recordId,
      };
  }
}

/**
 * In-memory implementation of BOTH frozen T-0019 ports over ONE shared
 * per-tenant list. Construct with the binding tenant id (the same `withTenant`
 * tenant in T-0053); reader and writer share `this` so an append is immediately
 * readable (the one-logical-step read-then-append the resolver performs).
 *
 * A monotonically increasing per-tenant `nextSeq` cursor (starts at 1) is
 * advanced `+1` per append — the static-now surrogate for the Postgres
 * SELECT … FOR UPDATE; UPDATE next_seq = next_seq + 1 path (the 028 trigger
 * structurally forbids ever moving it backward in the DB).
 */
export class InMemoryActorEventStore
  implements ActorEventReader, ActorEventWriter
{
  private readonly tenantId: string;
  private readonly rows: ActorEventRow[] = [];
  private nextSeq = 1;
  private idCounter = 0;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  // ---- ActorEventWriter (the guarded-transition append) -------------------

  /**
   * Append EXACTLY ONE row (AC-13). Runs `validateActorEventInput` first and
   * REJECTS on failure (AC-14, bullet (b)); advances the per-tenant counter `+1`
   * (bullet (c)); never mutates a prior row (bullet (d)). Returns the assigned
   * `{ seq, id }` (the T-0019 §4.3 AppendedActorEvent contract).
   */
  appendActorEvent(input: ActorEventInput): Promise<AppendedActorEvent> {
    const validation = validateActorEventInput(input);
    if (!validation.ok) {
      return Promise.reject(new ActorEventValidationError(validation.reason));
    }
    const seq = this.nextSeq;
    this.nextSeq += 1; // advance +1 (FOR UPDATE surrogate); never decremented.
    const id = `aev-${this.tenantId}-${this.idCounter++}`;
    const cols = refColumns(input);
    const row: ActorEventRow = {
      tenantId: this.tenantId,
      seq,
      id,
      objectKind: cols.objectKind,
      applicationId: cols.applicationId,
      registryId: cols.registryId,
      recordId: cols.recordId,
      actor: input.actor,
      onBehalfOf: input.onBehalfOf ?? null,
      roleAtEvent: input.roleAtEvent,
      event: input.event,
      approveLevel: input.approveLevel ?? null,
      detail: input.detail ?? null,
      ts: 0, // static-now: deterministic ts (the DAO sets epoch-ms in T-0053).
      vocabVersion: 1,
    };
    this.rows.push(row); // exactly one push; prior rows untouched (append-only).
    return Promise.resolve({ seq, id });
  }

  // ---- ActorEventReader (the SoD read substrate, a/b/c) --------------------

  /** (a) per-object ordered trail: all rows for one object, ORDER BY seq. */
  trail(ref: ActorEventObjectRef): Promise<ActorEventRow[]> {
    const out = this.rows
      .filter((r) => rowMatchesRef(r, ref))
      .sort((x, y) => x.seq - y.seq);
    return Promise.resolve(out);
  }

  /**
   * (b) dynamic-SoD substrate: did principal P perform event E on object X?
   *     Matches on COALESCE(onBehalfOf, actor) = principal (actorEventPrincipal).
   */
  didPrincipalPerform(
    ref: ActorEventObjectRef,
    event: ActorEventVerb,
    principal: string,
  ): Promise<boolean> {
    const found = this.rows.some(
      (r) =>
        rowMatchesRef(r, ref) &&
        r.event === event &&
        actorEventPrincipal({ actor: r.actor, onBehalfOf: r.onBehalfOf }) ===
          principal,
    );
    return Promise.resolve(found);
  }

  /**
   * (c) static-SoD substrate: the distinct roles (role_at_event) that acted on
   *     object X, optionally filtered to a verb subset.
   */
  rolesThatActed(
    ref: ActorEventObjectRef,
    events?: ActorEventVerb[],
  ): Promise<string[]> {
    const verbFilter = events !== undefined ? new Set(events) : undefined;
    const roles = new Set<string>();
    for (const r of this.rows) {
      if (!rowMatchesRef(r, ref)) continue;
      if (verbFilter !== undefined && !verbFilter.has(r.event)) continue;
      roles.add(r.roleAtEvent);
    }
    return Promise.resolve([...roles]);
  }

  // ---- Test-only introspection (NOT part of the frozen ports) -------------

  /** The total number of appended rows — the exactly-one/zero invariant probe. */
  rowCount(): number {
    return this.rows.length;
  }

  /** A copy of all rows in seq order (for assertions). */
  snapshot(): ActorEventRow[] {
    return [...this.rows].sort((x, y) => x.seq - y.seq);
  }
}

/**
 * Factory mirroring the other ports' construction style. Re-exported from
 * `sod.ts` so FR-12's "consumable without re-declaration" holds even though the
 * mutable store lives here (keeping `sod.ts` a pure-decision module — ADR §4.1
 * architect note).
 */
export function makeInMemoryActorEventStore(
  tenantId: string,
): InMemoryActorEventStore {
  return new InMemoryActorEventStore(tenantId);
}
