/**
 * T-0044 · pure-unit + fitness tests for the dual-control gate (E4.6, D-A=A3).
 * One+ assertion per AC-1..9/12/14/17 + the Q-2 implicit-escalate coverage.
 *
 * AC-1   escalates === true ⇒ required_approvers === 2
 * AC-2   escalates === false (from≡to / narrowing / no-op) ⇒ required === 1
 * AC-3   two-approver path satisfied by two distinct ≠ proposer
 * AC-4   two-approver path NOT satisfied by one approver
 * AC-5   duplicate ids collapse (['a','a'] ⇒ not satisfied for required 2)
 * AC-6   proposer-exclusion (['a','p'], proposer p ⇒ not satisfied for required 2)
 * AC-7   single-approver: ['a'] ✓; ['p'] ✗
 * AC-8   effective (compiled) trigger: from≡to ⇒ required 1 even if a row is written
 * AC-9   each axis a/b/c flipping false→true independently ⇒ required 2 (three cases)
 * AC-12  buildConfirmationFlag carries serialized CriticalityDiff + change_ref + approvers + status
 * AC-14  fail-closed: malformed from/to/approvers ⇒ denies (never a satisfiable single-approver)
 * AC-17  determinism: same input ⇒ deep-equal output
 * Q-2    non-derivable clearance on an added read grant ⇒ required 2 (implicit escalate)
 *
 * All functions under test are pure. No Postgres, no HTTP.
 */
import { describe, it, expect } from "vitest";
import {
  type RoleCriticality,
  combineCriticality,
  criticalityDiff,
} from "../core/role-criticality.js";
import {
  type Grant,
  type Operation,
  type ResourceType,
  type GrantScope,
} from "../core/grant-lattice.js";
import {
  dualControlDecision,
  nonDerivableReadClearance,
  buildConfirmationFlag,
  encodeDualControlAuditEvent,
  requirementReason,
} from "../core/dual-control.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const WHOLE_SCOPE: GrantScope = { kind: "set", members: [] };

let seq = 0;
function makeGrant(over: Partial<Grant> = {}): Grant {
  seq += 1;
  return {
    tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    id: `grant-${seq}`,
    roleId: "role-1",
    resourceType: "record" as ResourceType,
    operation: "read" as Operation,
    scope: WHOLE_SCOPE,
    delegable: false,
    grantedBy: "g",
    createdAt: NOW - 1000,
    ...over,
  };
}

const ALL_FALSE: RoleCriticality = {
  approve_or_transition: false,
  external_invoke: false,
  sensitive_read: false,
  level: "routine",
};

function crit(over: Partial<RoleCriticality>): RoleCriticality {
  const c = { ...ALL_FALSE, ...over };
  c.level =
    c.approve_or_transition || c.external_invoke || c.sensitive_read
      ? "critical"
      : "routine";
  return c;
}

// ---------------------------------------------------------------------------
// AC-1 / AC-2 — two-approver trigger keyed on escalates
// ---------------------------------------------------------------------------

describe("AC-1: escalates ⇒ required_approvers === 2", () => {
  it("from all-false to approve_or_transition:true ⇒ required 2", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: crit({ approve_or_transition: true }),
      proposedBy: "p",
      approvers: ["a", "b"],
    });
    expect(d.required_approvers).toBe(2);
  });
});

describe("AC-2: non-escalating ⇒ required_approvers === 1", () => {
  it("from ≡ to ⇒ required 1", () => {
    const d = dualControlDecision({
      from: crit({ approve_or_transition: true }),
      to: crit({ approve_or_transition: true }),
      proposedBy: "p",
      approvers: ["a"],
    });
    expect(d.required_approvers).toBe(1);
  });
  it("narrowing true→false ⇒ required 1", () => {
    const d = dualControlDecision({
      from: crit({ external_invoke: true }),
      to: ALL_FALSE,
      proposedBy: "p",
      approvers: ["a"],
    });
    expect(d.required_approvers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-3..7 — distinctness invariant
// ---------------------------------------------------------------------------

describe("AC-3: two-approver satisfied by two distinct ≠ proposer", () => {
  it("['a','b'], proposer p ⇒ satisfied", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: crit({ approve_or_transition: true }),
      proposedBy: "p",
      approvers: ["a", "b"],
    });
    expect(d.satisfied).toBe(true);
    expect(d.reason).toBe("satisfied");
  });
});

describe("AC-4: two-approver NOT satisfied by one approver", () => {
  it("['a'], required 2 ⇒ not satisfied", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: crit({ approve_or_transition: true }),
      proposedBy: "p",
      approvers: ["a"],
    });
    expect(d.satisfied).toBe(false);
    expect(d.reason).toBe("insufficient_distinct_approvers");
  });
});

describe("AC-5: duplicate ids collapse", () => {
  it("['a','a'], required 2 ⇒ not satisfied (a principal cannot count twice)", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: crit({ external_invoke: true }),
      proposedBy: "p",
      approvers: ["a", "a"],
    });
    expect(d.satisfied).toBe(false);
  });
});

describe("AC-6: proposer-exclusion", () => {
  it("['a','p'], proposer p, required 2 ⇒ not satisfied", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: crit({ sensitive_read: true }),
      proposedBy: "p",
      approvers: ["a", "p"],
    });
    expect(d.satisfied).toBe(false);
  });
});

describe("AC-7: single-approver path", () => {
  it("['a'] ⇒ satisfied", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: ALL_FALSE,
      proposedBy: "p",
      approvers: ["a"],
    });
    expect(d.required_approvers).toBe(1);
    expect(d.satisfied).toBe(true);
  });
  it("['p'] (== proposer) ⇒ not satisfied", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: ALL_FALSE,
      proposedBy: "p",
      approvers: ["p"],
    });
    expect(d.satisfied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-8 — effective (compiled) trigger, not row-diff
// ---------------------------------------------------------------------------

describe("AC-8: re-stating a held grant ⇒ required 1 (compiled, not row-diff)", () => {
  it("role already holds an approve grant; adding another approve grant ⇒ from≡to ⇒ required 1", () => {
    const held = [makeGrant({ operation: "approve" })];
    const fromCrit = combineCriticality(held, NOW);
    const added = makeGrant({ operation: "approve" });
    const toCrit = combineCriticality([...held, added], NOW);
    const d = dualControlDecision({
      from: fromCrit,
      to: toCrit,
      proposedBy: "p",
      approvers: ["a"],
    });
    expect(criticalityDiff(fromCrit, toCrit).escalates).toBe(false);
    expect(d.required_approvers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-9 — each axis a/b/c flipping false→true ⇒ required 2 (three cases)
// ---------------------------------------------------------------------------

describe("AC-9: each axis independently triggers required 2", () => {
  const cases: Array<{ name: string; grant: Partial<Grant> }> = [
    { name: "axis a (approve)", grant: { operation: "approve" } },
    {
      name: "axis b (effect_resource invoke)",
      grant: { resourceType: "effect_resource" as ResourceType, operation: "invoke" as Operation },
    },
    {
      name: "axis c (read confidential)",
      grant: { operation: "read", constraint: { clearance: "confidential" } },
    },
  ];
  for (const c of cases) {
    it(`${c.name} from all-false ⇒ required 2`, () => {
      const fromCrit = combineCriticality([], NOW);
      const added = makeGrant(c.grant);
      const toCrit = combineCriticality([added], NOW);
      const d = dualControlDecision({
        from: fromCrit,
        to: toCrit,
        proposedBy: "p",
        approvers: ["a", "b"],
        addedReadGrants: added.operation === "read" ? [added] : [],
      });
      expect(d.required_approvers, c.name).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Q-2 — non-derivable clearance on an added read grant ⇒ implicit escalate
// ---------------------------------------------------------------------------

describe("Q-2: garbage clearance on an added read grant ⇒ required 2 (implicit escalate)", () => {
  it("required 2 + reason implicit_escalate even though escalates===false", () => {
    const garbageRead = makeGrant({
      operation: "read",
      constraint: { clearance: "ultra-top-secret" }, // not a derivable DataClass
    });
    // Folded criticality does NOT raise sensitive_read (T-0040 quiet-null under-flag).
    const fromCrit = combineCriticality([], NOW);
    const toCrit = combineCriticality([garbageRead], NOW);
    expect(criticalityDiff(fromCrit, toCrit).escalates).toBe(false);

    expect(nonDerivableReadClearance([garbageRead])).toBe(true);

    const d = dualControlDecision({
      from: fromCrit,
      to: toCrit,
      proposedBy: "p",
      approvers: ["a", "b"],
      addedReadGrants: [garbageRead],
    });
    expect(d.required_approvers).toBe(2);
    expect(
      requirementReason({ from: fromCrit, to: toCrit, addedReadGrants: [garbageRead] }),
    ).toBe("implicit_escalate_clearance");
  });

  it("a VALID clearance token is NOT an implicit escalate (only escalates via criticalityDiff)", () => {
    const validRead = makeGrant({
      operation: "read",
      constraint: { clearance: "confidential" },
    });
    expect(nonDerivableReadClearance([validRead])).toBe(false);
  });

  it("NO clearance key at all ⇒ not an implicit escalate (public read confers no sensitivity)", () => {
    const plainRead = makeGrant({ operation: "read" });
    expect(nonDerivableReadClearance([plainRead])).toBe(false);
  });

  it("a garbage clearance on a NON-read grant is inert (axis c is read-keyed)", () => {
    const garbageNonRead = makeGrant({
      operation: "approve",
      constraint: { clearance: "garbage" },
    });
    expect(nonDerivableReadClearance([garbageNonRead])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-14 — fail-closed on malformed input
// ---------------------------------------------------------------------------

describe("AC-14: malformed input denies (fail-closed, never a satisfiable single-approver)", () => {
  it("malformed from ⇒ denies with malformed_input + required 2", () => {
    const d = dualControlDecision({
      // @ts-expect-error intentionally malformed
      from: { approve_or_transition: "yes" },
      to: ALL_FALSE,
      proposedBy: "p",
      approvers: ["a"],
    });
    expect(d.satisfied).toBe(false);
    expect(d.reason).toBe("malformed_input");
    expect(d.required_approvers).toBe(2);
  });
  it("non-array approvers ⇒ denies", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: ALL_FALSE,
      proposedBy: "p",
      // @ts-expect-error intentionally malformed
      approvers: "a",
    });
    expect(d.satisfied).toBe(false);
    expect(d.reason).toBe("malformed_input");
  });
  it("empty proposedBy ⇒ denies", () => {
    const d = dualControlDecision({
      from: ALL_FALSE,
      to: ALL_FALSE,
      proposedBy: "",
      approvers: ["a"],
    });
    expect(d.satisfied).toBe(false);
    expect(d.reason).toBe("malformed_input");
  });
});

// ---------------------------------------------------------------------------
// AC-12 — confirmation_flag + audit encoder shape
// ---------------------------------------------------------------------------

describe("AC-12: buildConfirmationFlag + encodeDualControlAuditEvent shape", () => {
  it("flag carries serialized CriticalityDiff, change_ref, approvers, status", () => {
    const diff = criticalityDiff(ALL_FALSE, crit({ approve_or_transition: true }));
    const flag = buildConfirmationFlag({
      changeRef: "chg-1",
      diff,
      approvers: ["a", "b"],
      status: "satisfied",
    });
    expect(flag.change_ref).toBe("chg-1");
    expect(flag.effective_diff).toEqual(diff);
    expect(flag.effective_diff.escalates).toBe(true);
    expect(flag.effective_diff.expanded.approve_or_transition).toBe(true);
    expect(flag.approvers).toEqual(["a", "b"]);
    expect(flag.status).toBe("satisfied");
  });

  it("audit event is a dualcontrol.gate AuditEventInput with the payload fields", () => {
    const diff = criticalityDiff(ALL_FALSE, crit({ external_invoke: true }));
    const flag = buildConfirmationFlag({
      changeRef: "chg-2",
      diff,
      approvers: ["a", "b"],
      status: "satisfied",
    });
    const decision = dualControlDecision({
      from: ALL_FALSE,
      to: crit({ external_invoke: true }),
      proposedBy: "p",
      approvers: ["a", "b"],
    });
    const evt = encodeDualControlAuditEvent({
      id: "audit-1",
      flag,
      decision,
      changeKind: "grant",
      actor: "a",
      proposedBy: "p",
      primaryConfirmer: "a",
      nowMs: NOW,
    });
    expect(evt.type).toBe("dualcontrol.gate");
    expect(evt.subject).toBe("chg-2");
    expect(evt.via).toBe("dual-control");
    expect(evt.proposed_by).toBe("p");
    expect(evt.confirmed_by).toBe("a");
    expect(evt.occurred_at).toBe(NOW);
    const payload = evt.payload as Record<string, unknown>;
    expect(payload.change_kind).toBe("grant");
    expect(payload.required_approvers).toBe(2);
    expect(payload.escalates).toBe(true);
    expect(payload.expanded).toEqual(diff.expanded);
    expect(payload.approvers).toEqual(["a", "b"]);
    expect(payload.status).toBe("satisfied");
  });

  it("second-confirm carries via dual-control.second-confirm", () => {
    const diff = criticalityDiff(ALL_FALSE, crit({ approve_or_transition: true }));
    const flag = buildConfirmationFlag({
      changeRef: "chg-3",
      diff,
      approvers: ["a", "b"],
      status: "satisfied",
    });
    const evt = encodeDualControlAuditEvent({
      id: "audit-2",
      flag,
      decision: { required_approvers: 2, distinct_ok: true, satisfied: true, reason: "satisfied" },
      changeKind: "grant",
      actor: "b",
      proposedBy: "a",
      primaryConfirmer: "b",
      via: "dual-control.second-confirm",
      nowMs: NOW,
    });
    expect(evt.via).toBe("dual-control.second-confirm");
    expect(evt.confirmed_by).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// AC-17 — determinism
// ---------------------------------------------------------------------------

describe("AC-17: determinism", () => {
  it("same input ⇒ deep-equal output", () => {
    const input = {
      from: ALL_FALSE,
      to: crit({ approve_or_transition: true }),
      proposedBy: "p",
      approvers: ["a", "b", "a"],
      addedReadGrants: [],
    };
    const a = dualControlDecision(input);
    const b = dualControlDecision(input);
    expect(a).toEqual(b);
  });
});
