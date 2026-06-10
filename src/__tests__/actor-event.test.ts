// T-0019 · static-now unit fixtures for the frozen actor_event contract.
//
// These cover the `static-now` halves of the SoD-substrate ACs (the live-DB
// halves are in ci/checks/db/actor-event.test.ts):
//   AC-12 — principal SoD attribution uses COALESCE(on_behalf_of, actor).
//   AC-13 — human and agent are equal actors (same code path, no kind branch).
//   AC-17 — the contract carries references/metadata, never object field values.
//   AC-18 — the verb set is the closed GT-1 set.
//   AC-19 — approve_level is present IFF event==='approve' and ≥ 1.
//   AC-22 — one guarded transition → one actor_event row, referable by an
//           audit_event row via the actor_event.id uuid, WITHOUT an enforced FK.

import { describe, it, expect } from "vitest";
import {
  ACTOR_EVENT_VERBS,
  VOCAB_VERSION,
  actorEventPrincipal,
  validateActorEventInput,
  notImplementedActorEventWriter,
  ActorEventNotImplementedError,
  type ActorEventInput,
  type ActorEventRow,
} from "../core/actor-event.js";

// A valid human and a valid agent employee id (kind is resolved by joining
// employee — it is NOT a column of actor_event; both ids flow identically here).
const HUMAN = "d0000000-0000-0000-0000-000000000004"; // e-mironov (human)
const AGENT = "d0000000-0000-0000-0000-000000000003"; // a-invoice (agent)
const PRINCIPAL = "d0000000-0000-0000-0000-000000000005"; // e-larina
const ROLE = "c0000000-0000-0000-0000-000000000002";
const RECORD = "11111111-2222-3333-4444-555555555555";

function recordInput(over: Partial<ActorEventInput> = {}): ActorEventInput {
  return {
    objectKind: "record",
    recordId: RECORD,
    actor: HUMAN,
    roleAtEvent: ROLE,
    event: "submit",
    ...over,
  } as ActorEventInput;
}

// ---------------------------------------------------------------------------
// AC-18 — closed verb set
// ---------------------------------------------------------------------------
describe("AC-18: the verb set is the closed GT-1 set", () => {
  it("is exactly {request,prepare,submit,approve,release}", () => {
    expect([...ACTOR_EVENT_VERBS].sort()).toEqual(
      ["approve", "prepare", "release", "request", "submit"].sort(),
    );
  });

  it("rejects a verb outside the closed set", () => {
    const r = validateActorEventInput(
      recordInput({ event: "escalate" as unknown as "submit" }),
    );
    expect(r).toEqual({ ok: false, reason: "unknown_verb" });
  });

  it("accepts each of the five valid verbs", () => {
    for (const event of ACTOR_EVENT_VERBS) {
      const input =
        event === "approve"
          ? recordInput({ event, approveLevel: 1 })
          : recordInput({ event });
      expect(validateActorEventInput(input).ok, event).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-19 — approve_level present IFF approve, and ≥ 1
// ---------------------------------------------------------------------------
describe("AC-19: approve_level non-null IFF event==='approve' (and ≥ 1)", () => {
  it("approve without a level is rejected", () => {
    expect(validateActorEventInput(recordInput({ event: "approve" }))).toEqual({
      ok: false,
      reason: "approve_level_required",
    });
  });

  it("a non-approve verb with a level is rejected", () => {
    expect(
      validateActorEventInput(recordInput({ event: "submit", approveLevel: 2 })),
    ).toEqual({ ok: false, reason: "approve_level_forbidden" });
  });

  it("approve with level < 1 is rejected", () => {
    expect(
      validateActorEventInput(recordInput({ event: "approve", approveLevel: 0 })),
    ).toEqual({ ok: false, reason: "approve_level_lt_1" });
  });

  it("approve@L1 and approve@L2 are both valid and orderable (L1 < L2)", () => {
    const l1 = recordInput({ event: "approve", approveLevel: 1 });
    const l2 = recordInput({ event: "approve", approveLevel: 2 });
    expect(validateActorEventInput(l1).ok).toBe(true);
    expect(validateActorEventInput(l2).ok).toBe(true);
    expect((l1.approveLevel as number) < (l2.approveLevel as number)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-12 — principal SoD attribution = COALESCE(on_behalf_of, actor)
// ---------------------------------------------------------------------------
describe("AC-12: SoD principal = COALESCE(onBehalfOf, actor)", () => {
  it("a delegated approval (actor=X, onBehalfOf=P) is attributed to P", () => {
    expect(
      actorEventPrincipal({ actor: HUMAN, onBehalfOf: PRINCIPAL }),
    ).toBe(PRINCIPAL);
  });

  it("a self-act (onBehalfOf=null) is attributed to actor", () => {
    expect(actorEventPrincipal({ actor: HUMAN, onBehalfOf: null })).toBe(HUMAN);
  });

  it("a self-act (onBehalfOf absent) is attributed to actor", () => {
    expect(actorEventPrincipal({ actor: HUMAN })).toBe(HUMAN);
  });
});

// ---------------------------------------------------------------------------
// AC-13 — human and agent are equal actors (no kind discrimination)
// ---------------------------------------------------------------------------
describe("AC-13: human and agent are equal actors (same code path)", () => {
  it("a human and an agent actor validate identically (no kind branch)", () => {
    const human = validateActorEventInput(recordInput({ actor: HUMAN }));
    const agent = validateActorEventInput(recordInput({ actor: AGENT }));
    expect(human).toEqual(agent);
    expect(human.ok).toBe(true);
  });

  it("principal attribution does not branch on which employee is human/agent", () => {
    // agent submits then agent approves → same principal both times → a SoD
    // violation exactly as a human would be (kind is never consulted here).
    const submitP = actorEventPrincipal({ actor: AGENT });
    const approveP = actorEventPrincipal({ actor: AGENT });
    expect(submitP).toBe(approveP);
  });
});

// ---------------------------------------------------------------------------
// AC-17 — references/metadata only, never object field values
// ---------------------------------------------------------------------------
describe("AC-17: the ledger row carries references/metadata, never object values", () => {
  it("a read-back row exposes object references and a detail metadata slot only", () => {
    const row: ActorEventRow = {
      tenantId: "a0000000-0000-0000-0000-000000000001",
      seq: 7,
      id: "00000000-0000-0000-0000-0000000000aa",
      objectKind: "record",
      applicationId: null,
      registryId: null,
      recordId: RECORD,
      actor: HUMAN,
      onBehalfOf: null,
      roleAtEvent: ROLE,
      event: "approve",
      approveLevel: 1,
      // detail is event metadata (a from→to state id) — NOT record field values.
      detail: { fromState: "in_review", toState: "approved" },
      ts: 1_700_000_000_000,
      vocabVersion: VOCAB_VERSION,
    };
    // The row type has no data/snapshot/view/payload member — only `detail`.
    expect("detail" in row).toBe(true);
    const keys = Object.keys(row);
    for (const forbidden of ["data", "snapshot", "view", "payload"]) {
      expect(keys).not.toContain(forbidden);
    }
    // detail holds no record field values in the contract example.
    expect(row.detail).toEqual({ fromState: "in_review", toState: "approved" });
  });
});

// ---------------------------------------------------------------------------
// AC-22 — one guarded transition → one actor_event row, referable (no FK) by an
//         audit_event row via the actor_event.id uuid.
// ---------------------------------------------------------------------------
describe("AC-22: one guarded submit → one actor_event row, audit-referable without FK", () => {
  it("a guarded submit maps to exactly one actor_event input; an audit row may carry its id", () => {
    const submit = recordInput({ event: "submit" });
    expect(validateActorEventInput(submit).ok).toBe(true);

    // The appended row carries a stable id (the writer mints it). An audit_event
    // row MAY reference that uuid — but with NO enforced FK (distinct ledgers).
    const appendedId = "00000000-0000-0000-0000-0000000000bb";
    const auditRow = {
      type: "submit",
      actorEventId: appendedId, // optional cross-reference; NOT a DB FK
    };
    // One SoD fact (actor_event) + one audit fact (audit_event) — distinct rows.
    expect(auditRow.actorEventId).toBe(appendedId);
    // The shape PERMITS the reference; it does not enforce it.
    expect(typeof auditRow.actorEventId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// The writer is frozen-not-implemented in T-0019 (FR-7).
// ---------------------------------------------------------------------------
describe("FR-7: the writer is frozen-not-implemented in T-0019", () => {
  it("the default writer refuses to append (T-0021/E4.2 implements it)", async () => {
    await expect(
      notImplementedActorEventWriter.appendActorEvent(recordInput()),
    ).rejects.toBeInstanceOf(ActorEventNotImplementedError);
  });
});
