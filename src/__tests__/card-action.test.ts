/**
 * T-0200 / T-0125 · Card action primitive — unit tests
 *
 * Pure unit — no DB. Drives the real `resolveFor` PDP via in-memory ports
 * (GrantSource / RecordSource / AncestryOracle) and the InMemoryAuditWriter +
 * a fake ActorEventWriter. Covers the full primitive path:
 *   card-action → grant-check (ALLOW and DENY) → transition → audit_event →
 *   process binding (dormant gate, no live Flowable).
 *
 * Fitness coverage:
 *   FF-CA-1/8 — visibility/executability == resolveFor; tenant fail-closed.
 *   FF-CA-2   — closed enums (semantics → operation map; unknown fails closed).
 *   FF-CA-5   — dormant gate: terminate not-ready ⇒ denied(path_not_ready), no effect.
 *   FF-CA-7   — every firing (executed AND denied) writes exactly one audit_event;
 *               a transition additionally appends one actor_event.
 *   FF-CA-9   — default card set generated from status model (no custom schema read).
 */

import { describe, it, expect } from "vitest";
import { makeHandle, type ObjectHandle, type ResolveSubject, type ResourceRef } from "../core/object-handle.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import type { GrantSource, RecordSource, ResolverDeps, GuardContext } from "../core/grant-resolver.js";
import type { ActorEventWriter, ActorEventInput, AppendedActorEvent } from "../core/actor-event.js";
import { InMemoryAuditWriter, inMemoryTx } from "../db/audit-writer.js";
import {
  fireCardAction,
  resolveCardVisibility,
  defaultCardActions,
  mergeCardActions,
  isCardActionSemantics,
  isReady,
  dormantEngineBridge,
  SEMANTICS_TO_OPERATION,
  type CardActionDecl,
  type CardActionDeps,
  type EngineBridgeReadiness,
} from "../core/card-action.js";

// ---------------------------------------------------------------------------
// Fixtures — fresh random tenant per test family is NOT required (no DB here),
// but we keep deterministic dashed UUIDs that the audit preimage accepts.
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REG = "11111111-1111-1111-1111-111111111111";
const REC = "22222222-2222-2222-2222-222222222222";
const SUBJECT_ID = "33333333-3333-3333-3333-333333333333";

function recordRef(tenantId = TENANT_A): ResourceRef {
  return { kind: "record", tenantId, registryId: REG, recordId: REC };
}

function recordHandle(tenantId = TENANT_A): ObjectHandle {
  return makeHandle(recordRef(tenantId), tenantId);
}

function subject(tenantId = TENANT_A): ResolveSubject {
  return { tenantId, subjectId: SUBJECT_ID };
}

/** Oracle: rec ⊑ reg (so a registry-scoped grant covers the record). */
function oracle(): AncestryOracle {
  return {
    isDescendantOrSelf(_h, d, a): boolean {
      if (d === a) return true;
      return d === REC && a === REG;
    },
  };
}

/** A transition grant scoped at the registry node, covering the record. */
function transitionGrant(over: Partial<Grant> = {}): Grant {
  return {
    tenantId: TENANT_A,
    id: "g-1",
    roleId: "role-1",
    resourceType: "record",
    operation: "transition",
    scope: { kind: "node", hierarchy: "resource", nodeId: REG, nodeLevel: "registry" },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
    ...over,
  };
}

function staticGrants(grants: Grant[]): GrantSource {
  return { getGrants: () => Promise.resolve(grants) };
}
function staticRecord(rec: Record<string, unknown> | null): RecordSource {
  return { getRecord: () => Promise.resolve(rec) };
}

/** Recording fake actor-event writer. */
class FakeActorEventWriter implements ActorEventWriter {
  public appended: ActorEventInput[] = [];
  async appendActorEvent(input: ActorEventInput): Promise<AppendedActorEvent> {
    this.appended.push(input);
    return { seq: this.appended.length, id: `ae-${this.appended.length}` };
  }
}

function resolverDeps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    grants: staticGrants([transitionGrant()]),
    records: staticRecord({ status: "in_review" }),
    ancestry: oracle(),
    now: () => 1000,
    ...over,
  };
}

interface Harness {
  deps: CardActionDeps;
  audit: InMemoryAuditWriter;
  actorWriter: FakeActorEventWriter;
}

function harness(
  resolverOver: Partial<ResolverDeps> = {},
  bridge: EngineBridgeReadiness = dormantEngineBridge,
): Harness {
  const audit = new InMemoryAuditWriter();
  const actorWriter = new FakeActorEventWriter();
  const deps: CardActionDeps = {
    resolverDeps: resolverDeps(resolverOver),
    actorEventWriter: actorWriter,
    auditWriter: audit,
    tx: inMemoryTx(TENANT_A),
    engineBridge: bridge,
    clock: { now: () => 1000 },
  };
  return { deps, audit, actorWriter };
}

const GUARD: GuardContext = {
  actor: SUBJECT_ID,
  roleAtEvent: "role-1",
  verb: "submit",
};

function transitionDecl(over: Partial<CardActionDecl> = {}): CardActionDecl {
  return {
    id: "to_rejected",
    label: "Отказать",
    operation: SEMANTICS_TO_OPERATION.transition,
    semantics: "transition",
    target: { kind: "record", handle: recordHandle(), processInstanceId: null },
    bindings: [],
    origin: "default",
    readiness: "live",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// FF-CA-2 — closed enums
// ---------------------------------------------------------------------------

describe("FF-CA-2 closed semantics/operation enum", () => {
  it("isCardActionSemantics accepts the four members, rejects others", () => {
    for (const s of ["transition", "terminate", "message", "invoke"]) {
      expect(isCardActionSemantics(s)).toBe(true);
    }
    for (const s of ["delete", "approve", "read", "", null, 1, {}]) {
      expect(isCardActionSemantics(s)).toBe(false);
    }
  });

  it("every semantics maps onto an existing Operation (no new right-type)", () => {
    expect(SEMANTICS_TO_OPERATION.transition).toBe("transition");
    expect(SEMANTICS_TO_OPERATION.terminate).toBe("transition");
    expect(SEMANTICS_TO_OPERATION.message).toBe("transition");
    expect(SEMANTICS_TO_OPERATION.invoke).toBe("invoke");
  });
});

// ---------------------------------------------------------------------------
// FF-CA-1 / FF-CA-7 — ALLOW path: PDP allows → transition → audit + actor_event
// ---------------------------------------------------------------------------

describe("FF-CA-1/7 transition ALLOW: grant → actor_event + audit", () => {
  it("a subject with a covering transition grant executes: 1 audit_event(executed) + 1 actor_event", async () => {
    const { deps, audit, actorWriter } = harness();
    const res = await fireCardAction(deps, transitionDecl(), subject(), { reason: "n/a" }, GUARD);

    expect(res).toEqual({ ok: true, actionId: "to_rejected" });
    // exactly one audit_event, executed
    expect(audit.rows(TENANT_A).length).toBe(1);
    expect(audit.rows(TENANT_A)[0].type).toBe("card_action.executed");
    // exactly one actor_event for the transition
    expect(actorWriter.appended.length).toBe(1);
    expect(actorWriter.appended[0].objectKind).toBe("record");
    expect(actorWriter.appended[0].detail).toEqual({ actionId: "to_rejected", params: { reason: "n/a" } });
  });

  it("audit_event carries the action params in its subject blob (reason captured)", async () => {
    const { deps, audit } = harness();
    await fireCardAction(deps, transitionDecl(), subject(), { reason: "duplicate" }, GUARD);
    const subj = JSON.parse(audit.rows(TENANT_A)[0].subject as string);
    expect(subj.actionId).toBe("to_rejected");
    expect(subj.params).toEqual({ reason: "duplicate" });
  });
});

// ---------------------------------------------------------------------------
// FF-CA-1 / FF-CA-7 — DENY path: no grant → audit(denied), no mutation
// ---------------------------------------------------------------------------

describe("FF-CA-1/7 DENY: no grant ⇒ denied + audit, no actor_event", () => {
  it("subject without a covering grant is denied(no_grant), one audit_event(denied), zero actor_event", async () => {
    const { deps, audit, actorWriter } = harness({ grants: staticGrants([]) });
    const res = await fireCardAction(deps, transitionDecl(), subject(), {}, GUARD);

    expect(res).toEqual({ ok: false, reason: "no_grant" });
    expect(audit.rows(TENANT_A).length).toBe(1);
    expect(audit.rows(TENANT_A)[0].type).toBe("card_action.denied");
    expect(audit.rows(TENANT_A)[0].via).toBe("transition:no_grant");
    expect(actorWriter.appended.length).toBe(0);
  });

  it("a read-only grant does NOT cover a transition action (op mismatch)", async () => {
    const readGrant = transitionGrant({ operation: "read" });
    const { deps, actorWriter } = harness({ grants: staticGrants([readGrant]) });
    const res = await fireCardAction(deps, transitionDecl(), subject(), {}, GUARD);
    expect(res).toEqual({ ok: false, reason: "no_grant" });
    expect(actorWriter.appended.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FF-CA-8 — tenant fail-closed
// ---------------------------------------------------------------------------

describe("FF-CA-8 tenant fail-closed", () => {
  it("a cross-tenant handle is denied(cross_tenant) before any mutation", async () => {
    const { deps, audit, actorWriter } = harness();
    // handle in TENANT_B, subject in TENANT_A
    const decl = transitionDecl({
      target: { kind: "record", handle: recordHandle(TENANT_B), processInstanceId: null },
    });
    const res = await fireCardAction(deps, decl, subject(TENANT_A), {}, GUARD);
    expect(res).toEqual({ ok: false, reason: "cross_tenant" });
    expect(audit.rows(TENANT_A)[0].type).toBe("card_action.denied");
    expect(actorWriter.appended.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FF-CA-5 — dormant gate (terminate / process binding, no live engine)
// ---------------------------------------------------------------------------

describe("FF-CA-5 dormant gate: terminate not ready", () => {
  const terminateDecl = transitionDecl({
    id: "abort_approval",
    label: "Прервать согласование",
    operation: SEMANTICS_TO_OPERATION.terminate,
    semantics: "terminate",
    target: { kind: "process_instance", handle: recordHandle(), processInstanceId: "inst-1" },
    readiness: "dormant",
  });

  it("isReady is false for terminate/message under the dormant bridge", () => {
    expect(isReady("terminate", dormantEngineBridge)).toBe(false);
    expect(isReady("message", dormantEngineBridge)).toBe(false);
    expect(isReady("transition", dormantEngineBridge)).toBe(true);
    expect(isReady("invoke", dormantEngineBridge)).toBe(true);
  });

  it("firing a dormant terminate ⇒ denied(path_not_ready), audit, NO actor_event, NO PDP mutation", async () => {
    const { deps, audit, actorWriter } = harness();
    const res = await fireCardAction(deps, terminateDecl, subject(), { reason: "founder order" }, GUARD);
    expect(res).toEqual({ ok: false, reason: "path_not_ready" });
    expect(audit.rows(TENANT_A).length).toBe(1);
    expect(audit.rows(TENANT_A)[0].type).toBe("card_action.denied");
    expect(audit.rows(TENANT_A)[0].via).toBe("transition:path_not_ready");
    expect(actorWriter.appended.length).toBe(0);
  });

  it("when the bridge reports ready, the dormant gate no longer blocks (declaration unchanged)", async () => {
    // Simulated B-8: bridge supports terminate. The declaration is identical.
    const readyBridge: EngineBridgeReadiness = { supports: () => true };
    const { deps } = harness({}, readyBridge);
    // With a covering grant over the record handle, terminate now passes the gate
    // and the PDP. (Day-1 the engine call itself is a no-op stub; FF-CA-3 covers
    // the single-channel constraint statically.)
    const res = await fireCardAction(deps, terminateDecl, subject(), {}, GUARD);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch visibility on render (FF-CA-1)
// ---------------------------------------------------------------------------

describe("resolveCardVisibility (batch-PDP render)", () => {
  it("executable subset is decided by resolveFor; dormant actions are non-executable", async () => {
    const { deps } = harness();
    const live = transitionDecl({ id: "a1" });
    const dormant = transitionDecl({
      id: "a2",
      semantics: "terminate",
      operation: SEMANTICS_TO_OPERATION.terminate,
      target: { kind: "process_instance", handle: recordHandle(), processInstanceId: "i" },
      readiness: "dormant",
    });
    const vis = await resolveCardVisibility(deps, [live, dormant], subject(), GUARD);
    const byId = Object.fromEntries(vis.map((v) => [v.actionId, v]));
    expect(byId.a1.executable).toBe(true);
    expect(byId.a2.executable).toBe(false);
    expect(byId.a2.reason).toBe("path_not_ready");
  });

  it("no grant ⇒ executable=false for an otherwise-live action", async () => {
    const { deps } = harness({ grants: staticGrants([]) });
    const vis = await resolveCardVisibility(deps, [transitionDecl()], subject(), GUARD);
    expect(vis[0].executable).toBe(false);
    expect(vis[0].reason).toBe("no_grant");
  });
});

// ---------------------------------------------------------------------------
// FF-CA-9 — default-card generation from status model
// ---------------------------------------------------------------------------

describe("FF-CA-9 default card generation", () => {
  it("one transition action per available transition; no custom schema read", () => {
    const handle = recordHandle();
    const decls = defaultCardActions(
      handle,
      [
        { id: "approve", label: "Согласовать" },
        { id: "reject", label: "Отказать" },
      ],
      null,
    );
    expect(decls.length).toBe(2);
    expect(decls.every((d) => d.semantics === "transition")).toBe(true);
    expect(decls.every((d) => d.origin === "default")).toBe(true);
    expect(decls.every((d) => d.readiness === "live")).toBe(true);
    expect(decls.every((d) => d.target.kind === "record")).toBe(true);
  });

  it("a bound process instance adds a dormant terminate action", () => {
    const handle = recordHandle();
    const decls = defaultCardActions(
      handle,
      [{ id: "approve", label: "Согласовать" }],
      { processInstanceId: "inst-9", handle },
    );
    const abort = decls.find((d) => d.semantics === "terminate");
    expect(abort).toBeDefined();
    expect(abort!.readiness).toBe("dormant");
    expect(abort!.target.kind).toBe("process_instance");
    expect(abort!.target.processInstanceId).toBe("inst-9");
  });

  it("invoke actions are NOT in the default set", () => {
    const decls = defaultCardActions(recordHandle(), [{ id: "x", label: "X" }], null);
    expect(decls.some((d) => d.semantics === "invoke")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Custom overlay (ADR §4 — structural authorization prohibition)
// ---------------------------------------------------------------------------

describe("mergeCardActions custom overlay", () => {
  it("custom adds a new action and overrides an existing one by id", () => {
    const defaults = [transitionDecl({ id: "a" }), transitionDecl({ id: "b", label: "B" })];
    const customs = [
      transitionDecl({ id: "b", label: "B-custom" }),
      transitionDecl({ id: "c", label: "C" }),
    ];
    const merged = mergeCardActions(defaults, customs);
    const byId = Object.fromEntries(merged.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(["a", "b", "c"]);
    expect(byId.b.label).toBe("B-custom");
  });

  it("a custom action with a mismatched operation/semantics is dropped (fail-closed)", () => {
    const bad = { ...transitionDecl({ id: "bad" }), operation: "delete" as const };
    const merged = mergeCardActions([], [bad as unknown as CardActionDecl]);
    expect(merged.some((d) => d.id === "bad")).toBe(false);
  });
});
