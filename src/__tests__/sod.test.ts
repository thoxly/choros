/**
 * Fitness tests for T-0032 — Separation-of-Duties (SoD) constraints (E4.2).
 *
 * Each describe block maps to a fitness function (FF-SOD9..FF-SOD14) and its AC ids.
 *
 * FF-SOD9  → AC-8, AC-11 : step 3.6 gating (op ∈ {approve,transition} ∧ deps.sod);
 *                           read/create/update/delete/invoke never enter it;
 *                           absent deps.sod ⇒ pre-T-0032 behavior.
 * FF-SOD10 → AC-10/13/14 : exactly-one-row-on-pass / zero-on-deny; the writer runs
 *                           validateActorEventInput first and rejects on failure.
 * FF-SOD11 → AC-4/5/6/7/12: dynamic SoD — DSoD-1 self-approval, DSoD-2 L1≠L2,
 *                           on_behalf_of attribution, delegated-act collision.
 * FF-SOD12 → AC-2/3       : static SoD — same-principal-two-roles over EFFECTIVE
 *                           assignments; the FR-10 standalone query.
 * FF-SOD13 → AC-20        : determinism / purity (call-twice deep-equal).
 * FF-SOD14 → AC-19        : (tsc — checked by `npm run ci`).
 *
 * All IO is behind in-memory ports — pure TS, no Postgres.
 */
import { describe, it, expect } from "vitest";
import {
  type ObjectHandle,
  type ResolveSubject,
  type ResourceRef,
  makeHandle,
} from "../core/object-handle.js";
import {
  type Grant,
  type AncestryOracle,
  type Operation,
} from "../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  type GuardContext,
  resolveFor,
} from "../core/grant-resolver.js";
import {
  type ActorEventObjectRef,
  type ActorEventVerb,
} from "../core/actor-event.js";
import {
  type SodConstraint,
  type SodSource,
  type EffectiveAssignment,
  type GuardedAct,
  InMemoryActorEventStore,
  detectStaticConflict,
  wouldCreateStaticConflict,
  evaluateDynamicSod,
} from "../core/sod.js";

// ---------------------------------------------------------------------------
// Shared in-memory fixtures
// ---------------------------------------------------------------------------

const T = "tenant-A";
const REG = "reg-1";
const REC = "rec-1";
const ROLE = "role-approver";

function makeOracle(edges: Array<[string, string]>): AncestryOracle {
  const map = new Map<string, Set<string>>();
  for (const [child, parent] of edges) {
    if (!map.has(child)) map.set(child, new Set());
    map.get(child)!.add(parent);
  }
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of map.get(cur) ?? []) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen;
  };
  return {
    isDescendantOrSelf(_h, descendantId, ancestorId): boolean {
      if (descendantId === ancestorId) return true;
      return ancestors(descendantId).has(ancestorId);
    },
  };
}

function defaultOracle(): AncestryOracle {
  return makeOracle([[REC, REG]]);
}

function recordRef(recordId = REC, registryId = REG, tenantId = T): ResourceRef {
  return { kind: "record", tenantId, registryId, recordId };
}

function recordHandle(tenantId = T): ObjectHandle {
  return makeHandle(recordRef(REC, REG, tenantId), tenantId);
}

function subject(subjectId = "user-1", tenantId = T): ResolveSubject {
  return { tenantId, subjectId };
}

/** A grant covering the record for the given op (scoped at the registry node). */
function grant(op: Operation): Grant {
  return {
    tenantId: T,
    id: `g-${op}`,
    roleId: ROLE,
    resourceType: "record",
    operation: op,
    scope: { kind: "node", hierarchy: "resource", nodeId: REG, nodeLevel: "registry" },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
  };
}

function staticGrants(grants: Grant[]): GrantSource {
  return { getGrants: () => Promise.resolve(grants) };
}

function staticRecord(rec: Record<string, unknown> | null): RecordSource {
  return { getRecord: () => Promise.resolve(rec) };
}

/** The actor_event ref for the test record. */
const RECORD_AEV_REF: ActorEventObjectRef = { objectKind: "record", recordId: REC };

/**
 * Build a SodSource over a shared in-memory store + fixed constraints +
 * a per-principal effective-assignment map.
 */
function makeSodSource(opts: {
  store: InMemoryActorEventStore;
  constraints?: SodConstraint[];
  assignments?: Record<string, EffectiveAssignment[]>;
}): SodSource {
  return {
    constraintsFor: () => Promise.resolve(opts.constraints ?? []),
    effectiveAssignmentsOf: (principal: string) =>
      Promise.resolve(opts.assignments?.[principal] ?? []),
    reader: opts.store,
    writer: opts.store,
  };
}

function guardCtx(over: Partial<GuardContext> = {}): GuardContext {
  return {
    actor: "user-1",
    roleAtEvent: ROLE,
    verb: "approve",
    approveLevel: 1,
    ...over,
  };
}

function dynamicConstraint(id = "c-dyn"): SodConstraint {
  return {
    tenantId: T,
    id,
    kind: "dynamic",
    roleA: null,
    roleB: null,
    selfRecord: true,
    scope: { kind: "node", hierarchy: "resource", nodeId: REG, nodeLevel: "registry" },
  };
}

function staticConstraint(roleA: string, roleB: string, id = "c-static"): SodConstraint {
  return {
    tenantId: T,
    id,
    kind: "static",
    roleA,
    roleB,
    selfRecord: false,
    scope: { kind: "node", hierarchy: "org", nodeId: "dept-1", nodeLevel: "department" },
  };
}

const orgScope = (nodeId: string) => ({
  kind: "node" as const,
  hierarchy: "org" as const,
  nodeId,
  nodeLevel: "department" as const,
});

// ===========================================================================
// FF-SOD9 — step 3.6 gating (AC-8, AC-11)
// ===========================================================================
describe("FF-SOD9 step 3.6 gating [AC-8, AC-11]", () => {
  it("read never enters the SoD step (no writer append), even with deps.sod present", async () => {
    const store = new InMemoryActorEventStore(T);
    const d: ResolverDeps = {
      grants: staticGrants([grant("read")]),
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      sod: makeSodSource({ store, constraints: [dynamicConstraint()] }),
      now: () => 1000,
    };
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v.denied).toBe(false);
    expect(store.rowCount(), "read must NOT append an actor_event row").toBe(0);
  });

  for (const op of ["create", "update", "delete", "invoke"] as Operation[]) {
    it(`${op} never enters the SoD step (no append)`, async () => {
      const store = new InMemoryActorEventStore(T);
      const d: ResolverDeps = {
        grants: staticGrants([grant(op)]),
        records: staticRecord({ name: "Alice" }),
        ancestry: defaultOracle(),
        sod: makeSodSource({ store, constraints: [dynamicConstraint()] }),
        now: () => 1000,
      };
      const v = await resolveFor(d, recordHandle(), subject(), op, undefined, guardCtx());
      expect(v.denied).toBe(false);
      expect(store.rowCount(), `${op} must NOT append`).toBe(0);
    });
  }

  it("absent deps.sod ⇒ pre-T-0032 behavior: approve passes with no guard, no append", async () => {
    const d: ResolverDeps = {
      grants: staticGrants([grant("approve")]),
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      now: () => 1000,
    };
    const v = await resolveFor(d, recordHandle(), subject(), "approve");
    expect(v.denied).toBe(false);
  });

  it("guarded op with deps.sod present but guardCtx ABSENT ⇒ fail-closed sod_violation", async () => {
    const store = new InMemoryActorEventStore(T);
    const d: ResolverDeps = {
      grants: staticGrants([grant("approve")]),
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      sod: makeSodSource({ store }),
      now: () => 1000,
    };
    const v = await resolveFor(d, recordHandle(), subject(), "approve"); // no guardCtx
    expect(v).toEqual({ denied: true, reason: "sod_violation" });
    expect(store.rowCount(), "fail-closed deny must NOT append").toBe(0);
  });
});

// ===========================================================================
// FF-SOD10 — exactly-one-row-on-pass / zero-on-deny (AC-10, AC-13, AC-14)
// ===========================================================================
describe("FF-SOD10 exactly-one / zero rows [AC-10, AC-13, AC-14]", () => {
  it("a passing guarded approve appends EXACTLY ONE actor_event row (matching fields)", async () => {
    const store = new InMemoryActorEventStore(T);
    const d: ResolverDeps = {
      grants: staticGrants([grant("approve")]),
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      sod: makeSodSource({ store, constraints: [dynamicConstraint()] }),
      now: () => 1000,
    };
    const v = await resolveFor(d, recordHandle(), subject(), "approve", undefined, guardCtx());
    expect(v.denied).toBe(false);
    expect(store.rowCount()).toBe(1);
    const row = store.snapshot()[0]!;
    expect(row.event).toBe("approve");
    expect(row.actor).toBe("user-1");
    expect(row.roleAtEvent).toBe(ROLE);
    expect(row.approveLevel).toBe(1);
    expect(row.recordId).toBe(REC);
  });

  it("no_grant denial appends ZERO rows", async () => {
    const store = new InMemoryActorEventStore(T);
    const d: ResolverDeps = {
      grants: staticGrants([]), // no covering grant
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      sod: makeSodSource({ store }),
      now: () => 1000,
    };
    const v = await resolveFor(d, recordHandle(), subject(), "approve", undefined, guardCtx());
    expect(v).toEqual({ denied: true, reason: "no_grant" });
    expect(store.rowCount()).toBe(0);
  });

  it("sod_violation denial appends ZERO rows (deny short-circuits before the writer)", async () => {
    const store = new InMemoryActorEventStore(T);
    // Seed a prior submit by the SAME principal → DSoD-1 self-approval block.
    await store.appendActorEvent({
      objectKind: "record",
      recordId: REC,
      actor: "user-1",
      roleAtEvent: "role-submitter",
      event: "submit",
    });
    const d: ResolverDeps = {
      grants: staticGrants([grant("approve")]),
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      sod: makeSodSource({ store, constraints: [dynamicConstraint()] }),
      now: () => 1000,
    };
    const before = store.rowCount();
    const v = await resolveFor(d, recordHandle(), subject(), "approve", undefined, guardCtx());
    expect(v).toEqual({ denied: true, reason: "sod_violation" });
    expect(store.rowCount(), "no new row on a sod_violation deny").toBe(before);
  });

  it("not_found denial appends ZERO rows", async () => {
    const store = new InMemoryActorEventStore(T);
    const d: ResolverDeps = {
      grants: staticGrants([grant("approve")]),
      records: staticRecord(null), // record absent
      ancestry: defaultOracle(),
      sod: makeSodSource({ store, constraints: [dynamicConstraint()] }),
      now: () => 1000,
    };
    const v = await resolveFor(d, recordHandle(), subject(), "approve", undefined, guardCtx());
    expect(v).toEqual({ denied: true, reason: "not_found" });
    expect(store.rowCount()).toBe(0);
  });

  it("the writer runs validateActorEventInput first: an approve with NO level is rejected (fail-closed)", async () => {
    const store = new InMemoryActorEventStore(T);
    const d: ResolverDeps = {
      grants: staticGrants([grant("approve")]),
      records: staticRecord({ name: "Alice" }),
      ancestry: defaultOracle(),
      sod: makeSodSource({ store, constraints: [dynamicConstraint()] }),
      now: () => 1000,
    };
    // approve verb but approveLevel omitted → validateActorEventInput rejects → fail-closed.
    const v = await resolveFor(
      d,
      recordHandle(),
      subject(),
      "approve",
      undefined,
      guardCtx({ approveLevel: undefined }),
    );
    expect(v).toEqual({ denied: true, reason: "sod_violation" });
    expect(store.rowCount(), "rejected append leaves zero rows").toBe(0);
  });

  it("the in-memory store rejects a malformed input directly (validateActorEventInput precondition)", async () => {
    const store = new InMemoryActorEventStore(T);
    await expect(
      store.appendActorEvent({
        objectKind: "record",
        recordId: REC,
        actor: "", // empty actor → missing_actor
        roleAtEvent: ROLE,
        event: "submit",
      }),
    ).rejects.toMatchObject({ name: "ActorEventValidationError" });
    expect(store.rowCount()).toBe(0);
  });

  it("the per-tenant counter advances +1 per append; prior rows are never mutated", async () => {
    const store = new InMemoryActorEventStore(T);
    const a = await store.appendActorEvent({
      objectKind: "record",
      recordId: REC,
      actor: "u",
      roleAtEvent: ROLE,
      event: "submit",
    });
    const b = await store.appendActorEvent({
      objectKind: "record",
      recordId: REC,
      actor: "u",
      roleAtEvent: ROLE,
      event: "prepare",
    });
    expect(b.seq).toBe(a.seq + 1);
    const snap = store.snapshot();
    expect(snap[0]!.event).toBe("submit"); // prior row untouched
    expect(snap[1]!.event).toBe("prepare");
  });
});

// ===========================================================================
// FF-SOD11 — dynamic SoD attribution (AC-4, AC-5, AC-6, AC-7, AC-12)
// ===========================================================================
describe("FF-SOD11 dynamic SoD [AC-4/5/6/7/12]", () => {
  async function seedTrail(
    store: InMemoryActorEventStore,
    events: Array<{
      actor: string;
      onBehalfOf?: string | null;
      event: ActorEventVerb;
      approveLevel?: number;
      role?: string;
    }>,
  ): Promise<void> {
    for (const e of events) {
      await store.appendActorEvent({
        objectKind: "record",
        recordId: REC,
        actor: e.actor,
        onBehalfOf: e.onBehalfOf ?? null,
        roleAtEvent: e.role ?? ROLE,
        event: e.event,
        ...(e.event === "approve" ? { approveLevel: e.approveLevel ?? 1 } : {}),
      });
    }
  }

  function act(over: Partial<GuardedAct> = {}): GuardedAct {
    return {
      ref: RECORD_AEV_REF,
      actor: "alice",
      roleAtEvent: ROLE,
      event: "approve",
      approveLevel: 1,
      ...over,
    };
  }

  it("DSoD-1: the principal who submitted cannot approve (self-approval blocked)", async () => {
    const store = new InMemoryActorEventStore(T);
    await seedTrail(store, [{ actor: "alice", event: "submit" }]);
    const d = await evaluateDynamicSod(store, [dynamicConstraint()], act({ actor: "alice" }));
    expect(d).toEqual({ violated: true, constraintId: "c-dyn", rule: "dsod1" });
  });

  it("DSoD-1: a DIFFERENT principal may approve a submitted record", async () => {
    const store = new InMemoryActorEventStore(T);
    await seedTrail(store, [{ actor: "alice", event: "submit" }]);
    const d = await evaluateDynamicSod(store, [dynamicConstraint()], act({ actor: "bob" }));
    expect(d).toEqual({ violated: false });
  });

  it("DSoD-2: the principal who approved at L1 cannot approve at L2 (L1≠L2)", async () => {
    const store = new InMemoryActorEventStore(T);
    await seedTrail(store, [{ actor: "alice", event: "approve", approveLevel: 1 }]);
    const d = await evaluateDynamicSod(
      store,
      [dynamicConstraint()],
      act({ actor: "alice", approveLevel: 2 }),
    );
    expect(d).toEqual({ violated: true, constraintId: "c-dyn", rule: "dsod2" });
  });

  it("DSoD-2: a different principal may perform L2 after another did L1", async () => {
    const store = new InMemoryActorEventStore(T);
    await seedTrail(store, [{ actor: "alice", event: "approve", approveLevel: 1 }]);
    const d = await evaluateDynamicSod(
      store,
      [dynamicConstraint()],
      act({ actor: "bob", approveLevel: 2 }),
    );
    expect(d).toEqual({ violated: false });
  });

  it("on_behalf_of attribution: X on_behalf_of P collides with P's submit", async () => {
    const store = new InMemoryActorEventStore(T);
    // P submitted; now X tries to approve on_behalf_of P → attributed to P → DSoD-1.
    await seedTrail(store, [{ actor: "P", event: "submit" }]);
    const d = await evaluateDynamicSod(
      store,
      [dynamicConstraint()],
      act({ actor: "X", onBehalfOf: "P" }),
    );
    expect(d).toEqual({ violated: true, constraintId: "c-dyn", rule: "dsod1" });
  });

  it("on_behalf_of: a self-act by X (after P's submit) does NOT collide", async () => {
    const store = new InMemoryActorEventStore(T);
    await seedTrail(store, [{ actor: "P", event: "submit" }]);
    const d = await evaluateDynamicSod(
      store,
      [dynamicConstraint()],
      act({ actor: "X", onBehalfOf: null }),
    );
    expect(d).toEqual({ violated: false });
  });

  it("delegated submit collides with the principal's later approve attribution", async () => {
    const store = new InMemoryActorEventStore(T);
    // X submitted on_behalf_of P (attributed to P); now P tries to self-approve → collide.
    await seedTrail(store, [{ actor: "X", onBehalfOf: "P", event: "submit" }]);
    const d = await evaluateDynamicSod(
      store,
      [dynamicConstraint()],
      act({ actor: "P", onBehalfOf: null }),
    );
    expect(d).toEqual({ violated: true, constraintId: "c-dyn", rule: "dsod1" });
  });

  it("no dynamic constraint ⇒ no dynamic violation (declarations gate the rule)", async () => {
    const store = new InMemoryActorEventStore(T);
    await seedTrail(store, [{ actor: "alice", event: "submit" }]);
    const d = await evaluateDynamicSod(store, [], act({ actor: "alice" }));
    expect(d).toEqual({ violated: false });
  });
});

// ===========================================================================
// FF-SOD12 — static SoD (AC-2, AC-3)
// ===========================================================================
describe("FF-SOD12 static SoD [AC-2, AC-3]", () => {
  const ROLE_A = "role-maker";
  const ROLE_B = "role-checker";

  it("same principal holding both incompatible roles (overlapping scope) ⇒ violation", async () => {
    const assignments: EffectiveAssignment[] = [
      { employeeId: "alice", roleId: ROLE_A, orgScope: orgScope("dept-1") },
      { employeeId: "alice", roleId: ROLE_B, orgScope: orgScope("dept-1") },
    ];
    const d = detectStaticConflict(
      assignments,
      [staticConstraint(ROLE_A, ROLE_B)],
      defaultOracle(),
    );
    expect(d).toEqual({ violated: true, constraintId: "c-static", rule: "static" });
  });

  it("holding only ONE of the incompatible pair ⇒ no violation", async () => {
    const assignments: EffectiveAssignment[] = [
      { employeeId: "alice", roleId: ROLE_A, orgScope: orgScope("dept-1") },
    ];
    const d = detectStaticConflict(
      assignments,
      [staticConstraint(ROLE_A, ROLE_B)],
      defaultOracle(),
    );
    expect(d).toEqual({ violated: false });
  });

  it("both roles but NON-overlapping scopes ⇒ no violation", async () => {
    // The constraint scope is dept-1; assignment B is in dept-2 (disjoint nodes).
    const assignments: EffectiveAssignment[] = [
      { employeeId: "alice", roleId: ROLE_A, orgScope: orgScope("dept-1") },
      { employeeId: "alice", roleId: ROLE_B, orgScope: orgScope("dept-2") },
    ];
    const d = detectStaticConflict(
      assignments,
      [staticConstraint(ROLE_A, ROLE_B)],
      defaultOracle(),
    );
    expect(d).toEqual({ violated: false });
  });

  it("FR-10 standalone: confirming the second role WOULD create a violation", async () => {
    const existing: EffectiveAssignment[] = [
      { employeeId: "alice", roleId: ROLE_A, orgScope: orgScope("dept-1") },
    ];
    const d = wouldCreateStaticConflict(
      existing,
      { roleId: ROLE_B, orgScope: orgScope("dept-1") },
      [staticConstraint(ROLE_A, ROLE_B)],
      defaultOracle(),
    );
    expect(d).toEqual({ violated: true, constraintId: "c-static", rule: "static" });
  });

  it("FR-10 standalone: a non-conflicting candidate ⇒ no violation", async () => {
    const existing: EffectiveAssignment[] = [
      { employeeId: "alice", roleId: ROLE_A, orgScope: orgScope("dept-1") },
    ];
    const d = wouldCreateStaticConflict(
      existing,
      { roleId: "role-unrelated", orgScope: orgScope("dept-1") },
      [staticConstraint(ROLE_A, ROLE_B)],
      defaultOracle(),
    );
    expect(d).toEqual({ violated: false });
  });

  it("a malformed static constraint (null role) is fail-closed (violation)", async () => {
    const bad: SodConstraint = {
      tenantId: T,
      id: "c-bad",
      kind: "static",
      roleA: ROLE_A,
      roleB: null, // malformed (DB CHECK would reject) → fail-closed
      selfRecord: false,
      scope: orgScope("dept-1"),
    };
    const d = detectStaticConflict(
      [{ employeeId: "alice", roleId: ROLE_A, orgScope: orgScope("dept-1") }],
      [bad],
      defaultOracle(),
    );
    expect(d).toEqual({ violated: true, constraintId: "c-bad", rule: "static" });
  });
});

// ===========================================================================
// FF-SOD13 — determinism / purity (AC-20)
// ===========================================================================
describe("FF-SOD13 determinism / purity [AC-20]", () => {
  it("detectStaticConflict called twice with identical inputs ⇒ deep-equal output", () => {
    const assignments: EffectiveAssignment[] = [
      { employeeId: "a", roleId: "r-a", orgScope: orgScope("d-1") },
      { employeeId: "a", roleId: "r-b", orgScope: orgScope("d-1") },
    ];
    const cs = [staticConstraint("r-a", "r-b")];
    const o = defaultOracle();
    const x = detectStaticConflict(assignments, cs, o);
    const y = detectStaticConflict(assignments, cs, o);
    expect(x).toEqual(y);
  });

  it("evaluateDynamicSod called twice over the same trail ⇒ deep-equal output", async () => {
    const store = new InMemoryActorEventStore(T);
    await store.appendActorEvent({
      objectKind: "record",
      recordId: REC,
      actor: "alice",
      roleAtEvent: ROLE,
      event: "submit",
    });
    const a: GuardedAct = {
      ref: RECORD_AEV_REF,
      actor: "alice",
      roleAtEvent: ROLE,
      event: "approve",
      approveLevel: 1,
    };
    const x = await evaluateDynamicSod(store, [dynamicConstraint()], a);
    const y = await evaluateDynamicSod(store, [dynamicConstraint()], a);
    expect(x).toEqual(y);
  });
});
