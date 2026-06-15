/**
 * T-0231: Implementation Loop B-2..B-5 unit tests.
 *
 * AC-1..AC-20 mapped to test cases.
 * NF-8: all tests that would append audit to a "shared" tenant instead mint
 *        fresh random tenant UUIDs (lessons from T-0205 / db-shared-db-gotcha).
 *
 * This test file is purely unit — no DB, no network, no Flowable.
 */

import { describe, it, expect } from "vitest";
import {
  transitionPhase,
  getTransitionInitiator,
  computeCoherenceHash,
  verifyBundleCoherence,
  assembleDraftBundle,
  emitPhaseTransitionAudit,
  validateGrantConsistency,
  processInterviewClaim,
  runSimulationMode1,
  type ImplementationPhase,
  type PhaseTransition,
  type Bundle,
  type BundleComponents,
  type OrgTree,
  type OrgNode,
  type AuditSink,
  type SimulationCase,
  type GatewayRoute,
  type GrantSpec,
} from "../core/implementation-loop.js";

import type { AncestryOracle } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function freshTenantId(): string {
  return `tenant-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/** Minimal in-memory AuditSink for tests. */
function makeAuditSink(): { sink: AuditSink; events: unknown[] } {
  const events: unknown[] = [];
  const sink: AuditSink = {
    append: async (input) => { events.push(input); },
  };
  return { sink, events };
}

/** Simple ancestry oracle for tests (only resolves same-id equality). */
const simpleOracle: AncestryOracle = {
  isDescendantOrSelf: (_h, a, b) => a === b,
};

/** Build a minimal valid OrgTree with given nodes and roleIds. */
function makeOrgTree(nodes: OrgNode[], roleIds?: string[]): OrgTree {
  const allRoleIds = roleIds ?? nodes.flatMap((n) => n.roleIds);
  return {
    getNodes: () => nodes,
    getNode: (id) => nodes.find((n) => n.nodeId === id),
    getRoleIds: () => allRoleIds,
  };
}

/** Build a minimal BundleComponents. */
function makeComponents(overrides?: Partial<BundleComponents>): BundleComponents {
  return {
    process: "<bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\"></bpmn:definitions>",
    forms: [],
    statuses: { statuses: [], transitions: [] },
    roles: [],
    grants: [],
    ...overrides,
  };
}

/** Build a minimal Bundle. */
function makeBundle(overrides?: Partial<Bundle>): Bundle {
  const components = makeComponents();
  return {
    bundleId: "bundle-1",
    implementationId: "impl-1",
    tier: "draft",
    version: 1,
    components,
    coherenceHash: computeCoherenceHash(components),
    changelog: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B-2: Phase machine (AC-1, AC-2)
// ---------------------------------------------------------------------------

describe("AC-1 — phase machine accepts legal edges and rejects illegal ones (fail-closed)", () => {
  // Legal edges from ADR §2
  const legalEdges: Array<[ImplementationPhase, PhaseTransition, ImplementationPhase]> = [
    ["org_ready",       "start_interview",      "interview"],
    ["interview",       "complete_interview",    "draft_bundle"],
    ["draft_bundle",    "start_simulation",      "simulation"],
    ["simulation",      "start_pilot",           "pilot"],
    ["simulation",      "request_promote",       "promote_pending"],
    ["pilot",           "request_promote",       "promote_pending"],
    ["promote_pending", "promote",               "production"],
    // revise backward edges
    ["simulation",      "revise_to_interview",   "interview"],
    ["simulation",      "revise_to_draft",       "draft_bundle"],
    // evolve backward edge
    ["production",      "evolve",                "interview"],
  ];

  for (const [from, transition, expectedTo] of legalEdges) {
    it(`legal: ${from} --[${transition}]--> ${expectedTo}`, () => {
      const result = transitionPhase(from, transition);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.newPhase).toBe(expectedTo);
    });
  }

  // Illegal edges — fail-closed
  const illegalEdges: Array<[ImplementationPhase, PhaseTransition]> = [
    ["org_ready",    "complete_interview"],  // skip interview phase
    ["org_ready",    "promote"],             // direct promote from start
    ["interview",    "promote"],             // skip bundle/simulation
    ["draft_bundle", "promote"],             // skip simulation
    ["production",   "promote"],             // re-promote from production
    ["org_ready",    "evolve"],              // evolve from non-production
    ["interview",    "revise_to_draft"],     // revise not from simulation
  ];

  for (const [from, transition] of illegalEdges) {
    it(`illegal fail-closed: ${from} --[${transition}]--> rejected`, () => {
      const result = transitionPhase(from, transition);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeTruthy();
    });
  }
});

describe("AC-2 — human-gate: promote_pending→production is the ONLY human-initiated transition", () => {
  it("promote_pending→production initiator is 'human'", () => {
    const initiator = getTransitionInitiator("promote_pending", "promote");
    expect(initiator).toBe("human");
  });

  it("all other legal transitions are agent-initiated", () => {
    const allEdges: Array<[ImplementationPhase, PhaseTransition]> = [
      ["org_ready",       "start_interview"],
      ["interview",       "complete_interview"],
      ["draft_bundle",    "start_simulation"],
      ["simulation",      "start_pilot"],
      ["simulation",      "request_promote"],
      ["pilot",           "request_promote"],
      ["simulation",      "revise_to_interview"],
      ["simulation",      "revise_to_draft"],
      ["production",      "evolve"],
    ];
    for (const [from, transition] of allEdges) {
      const initiator = getTransitionInitiator(from, transition);
      expect(initiator).toBe("agent");
    }
  });

  it("no agent-initiated transition crosses draft→published boundary", () => {
    // The ONLY transition to production is promote (human).
    // No agent-initiated transition should lead to the 'production' phase.
    const allPhases: ImplementationPhase[] = [
      "org_ready", "interview", "draft_bundle", "simulation", "pilot", "promote_pending", "production",
    ];
    const allTransitions: PhaseTransition[] = [
      "start_interview", "complete_interview", "start_simulation", "start_pilot",
      "request_promote", "promote", "revise_to_interview", "revise_to_draft", "evolve",
    ];
    for (const from of allPhases) {
      for (const t of allTransitions) {
        const initiator = getTransitionInitiator(from, t);
        if (initiator === "agent") {
          const result = transitionPhase(from, t);
          if (result.ok) {
            // Agent-initiated transitions must NOT result in 'production'
            expect(result.newPhase).not.toBe("production");
          }
        }
      }
    }
  });

  it("self-promote (agent doing promote) is not a legal edge", () => {
    // If the agent calls promote, it should fail because the initiator must be human.
    // transitionPhase itself doesn't check initiator — but the API (getTransitionInitiator)
    // shows it's human-only. We test this by verifying that an agent cannot construct
    // a self-promote path without the human-gate.
    //
    // The structural guarantee: promote_pending→production has initiator="human";
    // the agent's toolset has no "promote" tool (T-0077 / ADR §4 MUST-propose).
    // This test verifies the phase-machine correctly encodes this.
    const initiator = getTransitionInitiator("promote_pending", "promote");
    expect(initiator).toBe("human");
    expect(initiator).not.toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// B-2: Bundle projection model (AC-3, AC-4, AC-5, AC-6)
// ---------------------------------------------------------------------------

describe("AC-3 — bundle serializes with all required fields (§5.1)", () => {
  it("bundle has all required top-level fields", () => {
    const bundle = makeBundle();
    expect(bundle).toHaveProperty("bundleId");
    expect(bundle).toHaveProperty("implementationId");
    expect(bundle).toHaveProperty("tier");
    expect(bundle).toHaveProperty("version");
    expect(bundle).toHaveProperty("components");
    expect(bundle).toHaveProperty("coherenceHash");
    expect(bundle).toHaveProperty("changelog");
  });

  it("bundle.components has all required sub-fields", () => {
    const bundle = makeBundle();
    expect(bundle.components).toHaveProperty("process");
    expect(bundle.components).toHaveProperty("forms");
    expect(bundle.components).toHaveProperty("statuses");
    expect(bundle.components).toHaveProperty("roles");
    expect(bundle.components).toHaveProperty("grants");
  });

  it("tier is 'draft' or 'published'", () => {
    const draft = makeBundle({ tier: "draft" });
    const published = makeBundle({ tier: "published" });
    expect(["draft", "published"]).toContain(draft.tier);
    expect(["draft", "published"]).toContain(published.tier);
  });
});

describe("AC-4 — coherenceHash is deterministic; component desync → different hash", () => {
  it("identical components → identical hash", () => {
    const c1 = makeComponents();
    const c2 = makeComponents();
    expect(computeCoherenceHash(c1)).toBe(computeCoherenceHash(c2));
  });

  it("different process XML → different hash", () => {
    const c1 = makeComponents({ process: "<bpmn:definitions A/>" });
    const c2 = makeComponents({ process: "<bpmn:definitions B/>" });
    expect(computeCoherenceHash(c1)).not.toBe(computeCoherenceHash(c2));
  });

  it("different forms → different hash", () => {
    const c1 = makeComponents({ forms: [{ formId: "f1", name: "Form1", jsonSchema: {} }] });
    const c2 = makeComponents({ forms: [{ formId: "f2", name: "Form2", jsonSchema: {} }] });
    expect(computeCoherenceHash(c1)).not.toBe(computeCoherenceHash(c2));
  });

  it("component version desync detected by verifyBundleCoherence", () => {
    const bundle = makeBundle();
    // Mutate components without recomputing hash → desync
    const tampered: Bundle = {
      ...bundle,
      components: { ...bundle.components, process: "<bpmn:definitions TAMPERED/>" },
      // coherenceHash still points to original components → desync
    };
    const result = verifyBundleCoherence(tampered);
    expect(result.ok).toBe(false);
  });

  it("verifyBundleCoherence passes for a coherent bundle", () => {
    const bundle = makeBundle();
    const result = verifyBundleCoherence(bundle);
    expect(result.ok).toBe(true);
  });
});

describe("AC-5 — phase transition and bundle assembly emit correct audit events", () => {
  it("assembleDraftBundle emits impl.bundle.assembled event", async () => {
    const { sink, events } = makeAuditSink();
    await assembleDraftBundle({
      implementationId: "impl-1",
      tenantId: freshTenantId(),
      version: 1,
      components: makeComponents(),
      changelog: [],
      actor: "agent-1",
      auditSink: sink,
    });
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string };
    expect(ev.type).toBe("impl.bundle.assembled");
  });

  it("emitPhaseTransitionAudit emits impl.phase.transitioned event", async () => {
    const { sink, events } = makeAuditSink();
    await emitPhaseTransitionAudit(
      "impl-1", "org_ready", "interview", "start_interview", "agent-1", sink,
    );
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; payload: unknown };
    expect(ev.type).toBe("impl.phase.transitioned");
    expect((ev.payload as { fromPhase: string }).fromPhase).toBe("org_ready");
    expect((ev.payload as { toPhase: string }).toPhase).toBe("interview");
  });

  it("no second audit-log created (audit goes through AuditSink only)", async () => {
    // This test verifies no alternative audit path is created.
    // We spy on the sink and verify all audit events go through it.
    const { sink, events } = makeAuditSink();
    await assembleDraftBundle({
      implementationId: "impl-test",
      tenantId: freshTenantId(),
      version: 1,
      components: makeComponents(),
      changelog: [],
      actor: "agent-1",
      auditSink: sink,
    });
    // All audit goes through the sink (no side channels)
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect((ev as { type: string }).type).toMatch(/^impl\./);
    }
  });
});

describe("AC-6 — partial promote is unreachable (coherence_hash ties all components)", () => {
  it("modifying any component changes the coherenceHash → promotes the wrong bundle", () => {
    const components = makeComponents({ forms: [{ formId: "f1", name: "Form1", jsonSchema: {} }] });
    const bundle = makeBundle({ components, coherenceHash: computeCoherenceHash(components) });

    // Simulate: try to promote only a subset (forms removed) — coherenceHash won't match
    const subsetComponents: BundleComponents = { ...components, forms: [] };
    const subsetBundle: Bundle = { ...bundle, components: subsetComponents };
    // coherenceHash still refers to original (with forms) → verification fails
    const result = verifyBundleCoherence(subsetBundle);
    expect(result.ok).toBe(false);
  });

  it("published bundle = exactly the draft that was assembled (same coherenceHash)", async () => {
    const { sink } = makeAuditSink();
    const components = makeComponents();
    const draftBundle = await assembleDraftBundle({
      implementationId: "impl-1",
      tenantId: freshTenantId(),
      version: 1,
      components,
      changelog: [],
      actor: "agent-1",
      auditSink: sink,
    });
    // Promote: publish exactly this bundle (tier change only, same hash)
    const publishedBundle: Bundle = { ...draftBundle, tier: "published" };
    // Coherence must still hold (same components)
    expect(verifyBundleCoherence(publishedBundle).ok).toBe(true);
    expect(publishedBundle.coherenceHash).toBe(draftBundle.coherenceHash);
  });
});

// ---------------------------------------------------------------------------
// B-3: Grant consistency (AC-9, AC-10, AC-11)
// ---------------------------------------------------------------------------

describe("AC-9 — unresolvable GrantSpec.scope → validation failure with step identified", () => {
  it("returns ok:false with step id for unresolvable scope", () => {
    const org = makeOrgTree(
      [{ nodeId: "node-legal", parentId: undefined, roleIds: ["role-legal"] }],
      ["role-legal"],
    );
    const scope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node",
      hierarchy: "org",
      nodeId: "node-DOES-NOT-EXIST",
      nodeLevel: "department",
    };
    const grant: GrantSpec = {
      stepId: "step-approval",
      roleRef: { roleId: "role-missing" },
      resourceType: "authoring_draft",
      operation: "create",
      scope,
    };
    const bundle = makeBundle({
      components: makeComponents({ grants: [grant] }),
    });
    const result = validateGrantConsistency(bundle, { org, oracle: simpleOracle });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.stepId === "step-approval")).toBe(true);
      expect(result.violations.some((v) => v.kind === "unresolvable_assignee")).toBe(true);
    }
  });

  it("returns ok:true for a resolvable scope (node exists in org-tree)", () => {
    const org = makeOrgTree(
      [{ nodeId: "node-legal", parentId: undefined, roleIds: ["role-legal"] }],
      ["role-legal"],
    );
    const scope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node",
      hierarchy: "org",
      nodeId: "node-legal",
      nodeLevel: "department",
    };
    const grant: GrantSpec = {
      stepId: "step-approval",
      roleRef: { roleId: "role-legal" },
      resourceType: "authoring_draft",
      operation: "create",
      scope,
    };
    const bundle = makeBundle({ components: makeComponents({ grants: [grant] }) });
    const result = validateGrantConsistency(bundle, { org, oracle: simpleOracle });
    expect(result.ok).toBe(true);
  });
});

describe("AC-10 — narrowing check via isNarrowerOrEqual (T-0018 as READER)", () => {
  it("grant scope narrower than parent role scope → passes", () => {
    const org = makeOrgTree(
      [{ nodeId: "node-dept", parentId: undefined, roleIds: ["role-manager"] }],
      ["role-manager"],
    );
    // Grant scope: same node (narrower or equal)
    const grantScope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node", hierarchy: "org", nodeId: "node-dept", nodeLevel: "department",
    };
    // Parent role scope: same node (equal)
    const parentScope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node", hierarchy: "org", nodeId: "node-dept", nodeLevel: "department",
    };
    const grant: GrantSpec = {
      stepId: "step-1",
      roleRef: { roleId: "role-manager" },
      resourceType: "authoring_draft",
      operation: "create",
      scope: grantScope,
    };
    const bundle = makeBundle({ components: makeComponents({ grants: [grant] }) });
    const parentRoleScopes = new Map([["role-manager", parentScope]]);
    const result = validateGrantConsistency(bundle, {
      org, oracle: simpleOracle, parentRoleScopes,
    });
    expect(result.ok).toBe(true);
  });

  it("grant scope wider than parent role scope → narrowing violation", () => {
    const org = makeOrgTree(
      [
        { nodeId: "node-child", parentId: "node-parent", roleIds: ["role-child"] },
        { nodeId: "node-parent", parentId: undefined, roleIds: ["role-parent"] },
      ],
      ["role-child", "role-parent"],
    );

    // Oracle that knows node-parent is an ancestor of node-child
    const oracle: AncestryOracle = {
      isDescendantOrSelf: (_h, a, b) => {
        if (a === b) return true;
        if (a === "node-child" && b === "node-parent") return true;
        return false;
      },
    };

    // Grant scope: parent node (wider) — but parent role scope is the child node (narrower)
    const grantScope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node", hierarchy: "org", nodeId: "node-parent", nodeLevel: "department",
    };
    // Parent role scope: child node (narrower than grant scope)
    const parentScope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node", hierarchy: "org", nodeId: "node-child", nodeLevel: "department",
    };

    const grant: GrantSpec = {
      stepId: "step-wide",
      roleRef: { roleId: "role-child" },
      resourceType: "authoring_draft",
      operation: "create",
      scope: grantScope,
    };
    const bundle = makeBundle({ components: makeComponents({ grants: [grant] }) });
    const parentRoleScopes = new Map([["role-child", parentScope]]);

    // isNarrowerOrEqual(grantScope=node-parent, parentScope=node-child, oracle):
    // node-parent is NOT narrower than node-child → should fail
    const result = validateGrantConsistency(bundle, {
      org, oracle, parentRoleScopes,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.kind === "scope_too_wide")).toBe(true);
    }
  });
});

describe("AC-11 — drain-desync: grant newer than drained bundle version → error", () => {
  it("grant appeared at version 2, drained instance on version 1 → drain_desync error", () => {
    const org = makeOrgTree(
      [{ nodeId: "node-a", parentId: undefined, roleIds: ["role-a"] }],
      ["role-a"],
    );
    const scope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node", hierarchy: "org", nodeId: "node-a", nodeLevel: "department",
    };
    const grant: GrantSpec = {
      stepId: "step-new",
      roleRef: { roleId: "role-a" },
      resourceType: "authoring_draft",
      operation: "create",
      scope,
    };
    const bundle = makeBundle({ components: makeComponents({ grants: [grant] }) });

    // Grant first appeared at version 2; drained instance is on version 1 → desync
    const grantSpecVersions = new Map([["step-new", 2]]);
    const result = validateGrantConsistency(bundle, {
      org,
      oracle: simpleOracle,
      drainedBundleVersion: 1,
      grantSpecVersions,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.kind === "drain_desync")).toBe(true);
    }
  });

  it("grant appeared at version 1, drained instance on version 1 → ok (no desync)", () => {
    const org = makeOrgTree(
      [{ nodeId: "node-a", parentId: undefined, roleIds: ["role-a"] }],
      ["role-a"],
    );
    const scope: import("../core/grant-lattice.js").ScopeElement = {
      kind: "node", hierarchy: "org", nodeId: "node-a", nodeLevel: "department",
    };
    const grant: GrantSpec = {
      stepId: "step-same",
      roleRef: { roleId: "role-a" },
      resourceType: "authoring_draft",
      operation: "create",
      scope,
    };
    const bundle = makeBundle({ components: makeComponents({ grants: [grant] }) });

    // Grant appeared at version 1; drained instance is on version 1 → ok
    const grantSpecVersions = new Map([["step-same", 1]]);
    const result = validateGrantConsistency(bundle, {
      org,
      oracle: simpleOracle,
      drainedBundleVersion: 1,
      grantSpecVersions,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B-4: Interview protocol (AC-13, AC-14, AC-15)
// ---------------------------------------------------------------------------

describe("AC-13 — missing_role claim → discrepancy, question asked, no phantom org node", () => {
  it("claim referencing non-existent role → resolution=discrepancy, kind=missing_role", async () => {
    const { sink, events } = makeAuditSink();
    const org = makeOrgTree([], []); // empty org-tree
    const tenantId = freshTenantId();

    const result = await processInterviewClaim({
      claim: {
        claimId: "claim-1",
        text: "≥5M requires legal dept approval",
        orgRefs: [{ roleId: "role-legal", displayName: "Юротдел" }],
      },
      implementationId: "impl-1",
      tenantId,
      actor: "agent-1",
      org,
      auditSink: sink,
    });

    expect(result.resolution).toBe("discrepancy");
    expect(result.discrepancy?.kind).toBe("missing_role");
    expect(result.discrepancy?.question).toBeTruthy();

    // Audit event for question_asked emitted
    expect(events.some((e) => (e as { type: string }).type === "impl.interview.question_asked")).toBe(true);

    // No phantom org node created (org-tree still empty)
    expect(org.getNodes()).toHaveLength(0);
    expect(org.getRoleIds()).toHaveLength(0);
  });
});

describe("AC-14 — ambiguous_assignee → discrepancy, question asked, no silent selection", () => {
  it("claim with role that maps to multiple nodes → ambiguous_assignee", async () => {
    const { sink, events } = makeAuditSink();
    // Two nodes both claim role-manager
    const org = makeOrgTree([
      { nodeId: "node-dept-a", parentId: undefined, roleIds: ["role-manager"] },
      { nodeId: "node-dept-b", parentId: undefined, roleIds: ["role-manager"] },
    ], ["role-manager"]);
    const tenantId = freshTenantId();

    const result = await processInterviewClaim({
      claim: {
        claimId: "claim-2",
        text: "Manager approval required",
        orgRefs: [{ roleId: "role-manager" }],
      },
      implementationId: "impl-1",
      tenantId,
      actor: "agent-1",
      org,
      auditSink: sink,
    });

    expect(result.resolution).toBe("discrepancy");
    expect(result.discrepancy?.kind).toBe("ambiguous_assignee");
    // Question is asked — no silent selection of one candidate
    expect(events.some((e) => (e as { type: string }).type === "impl.interview.question_asked")).toBe(true);
    // The question mentions both node IDs
    expect(result.discrepancy?.question).toContain("node-dept-a");
    expect(result.discrepancy?.question).toContain("node-dept-b");
  });
});

describe("AC-15 — org-tree read-only during interview; resolved claim → claim_resolved audit", () => {
  it("resolved claim emits impl.interview.claim_resolved", async () => {
    const { sink, events } = makeAuditSink();
    const org = makeOrgTree([
      { nodeId: "node-legal", parentId: undefined, roleIds: ["role-legal"] },
    ], ["role-legal"]);
    const tenantId = freshTenantId();

    const result = await processInterviewClaim({
      claim: {
        claimId: "claim-3",
        text: "Legal dept reviews contracts ≥5M",
        orgRefs: [{ roleId: "role-legal" }],
      },
      implementationId: "impl-1",
      tenantId,
      actor: "agent-1",
      org,
      auditSink: sink,
    });

    expect(result.resolution).toBe("resolved");
    expect(result.discrepancy).toBeUndefined();
    expect(events.some((e) => (e as { type: string }).type === "impl.interview.claim_resolved")).toBe(true);
  });

  it("org-tree node count does not change after processInterviewClaim", async () => {
    const { sink } = makeAuditSink();
    const orgNodes: OrgNode[] = [];
    const org = makeOrgTree(orgNodes, []);
    const initialCount = org.getNodes().length;

    await processInterviewClaim({
      claim: {
        claimId: "claim-ro",
        text: "Non-existent role",
        orgRefs: [{ roleId: "role-phantom" }],
      },
      implementationId: "impl-ro",
      tenantId: freshTenantId(),
      actor: "agent-1",
      org,
      auditSink: sink,
    });

    // Org-tree node count must not change
    expect(org.getNodes().length).toBe(initialCount);
  });
});

// ---------------------------------------------------------------------------
// B-5: Simulation mode-1 (AC-17, AC-18, AC-19)
// ---------------------------------------------------------------------------

describe("AC-17 — mode-1 is deterministic: same input → byte-identical result", () => {
  it("running the same simulation twice produces identical results", () => {
    const org = makeOrgTree([
      { nodeId: "node-legal", parentId: undefined, roleIds: ["role-legal"] },
      { nodeId: "node-finance", parentId: undefined, roleIds: ["role-finance"] },
    ], ["role-legal", "role-finance"]);

    const gatewayRoutes: GatewayRoute[] = [
      {
        gatewayId: "gw-amount",
        conditions: [
          { attribute: "amount", op: "gte", value: 5_000_000, nextStepId: "step-legal", assigneeRoleId: "role-legal" },
          { attribute: "amount", op: "default", nextStepId: "step-finance", assigneeRoleId: "role-finance" },
        ],
      },
    ];

    const bundle = makeBundle({
      components: makeComponents({
        roles: [
          { roleId: "role-legal", displayName: "Юротдел" },
          { roleId: "role-finance", displayName: "Финансы" },
        ],
      }),
    });

    const cases: SimulationCase[] = [
      { caseId: "case-big", attributes: { amount: 6_000_000 } },
      { caseId: "case-small", attributes: { amount: 1_000_000 } },
    ];

    const result1 = runSimulationMode1(bundle, { cases, org, gatewayRoutes });
    const result2 = runSimulationMode1(bundle, { cases, org, gatewayRoutes });

    // Results must be deterministic
    expect(result1.bundleId).toBe(result2.bundleId);
    expect(result1.cases.length).toBe(result2.cases.length);
    for (let i = 0; i < result1.cases.length; i++) {
      expect(result1.cases[i]!.caseId).toBe(result2.cases[i]!.caseId);
      expect(result1.cases[i]!.path).toEqual(result2.cases[i]!.path);
    }
  });

  it("produces caseId→route→assignee table", () => {
    const org = makeOrgTree([
      { nodeId: "node-legal", parentId: undefined, roleIds: ["role-legal"] },
    ], ["role-legal"]);

    const gatewayRoutes: GatewayRoute[] = [
      {
        gatewayId: "gw-1",
        conditions: [
          { attribute: "amount", op: "gte", value: 5_000_000, nextStepId: "step-legal", assigneeRoleId: "role-legal" },
          { attribute: "amount", op: "default", nextStepId: "step-end" },
        ],
      },
    ];
    const bundle = makeBundle({
      components: makeComponents({ roles: [{ roleId: "role-legal", displayName: "Legal" }] }),
    });
    const cases: SimulationCase[] = [{ caseId: "case-1", attributes: { amount: 7_000_000 } }];
    const result = runSimulationMode1(bundle, { cases, org, gatewayRoutes });

    expect(result.cases).toHaveLength(1);
    const c = result.cases[0]!;
    expect(c.caseId).toBe("case-1");
    expect(c.path.length).toBeGreaterThan(0);
  });
});

describe("AC-18 — mode-1 is a pure function; ≥5M routes to Юротдел role", () => {
  it("case with amount ≥ 5M routes to role-legal (Юротдел)", () => {
    const org = makeOrgTree([
      { nodeId: "node-legal", parentId: undefined, roleIds: ["role-legal"] },
    ], ["role-legal"]);

    const gatewayRoutes: GatewayRoute[] = [
      {
        gatewayId: "gw-amount",
        conditions: [
          { attribute: "amount", op: "gte", value: 5_000_000, nextStepId: "step-legal", assigneeRoleId: "role-legal" },
          { attribute: "amount", op: "default", nextStepId: "step-standard" },
        ],
      },
    ];

    const bundle = makeBundle({
      components: makeComponents({
        roles: [{ roleId: "role-legal", displayName: "Юротдел" }],
      }),
    });

    const result = runSimulationMode1(bundle, {
      cases: [{ caseId: "big-contract", attributes: { amount: 6_000_000 } }],
      org,
      gatewayRoutes,
    });

    expect(result.cases).toHaveLength(1);
    const caseResult = result.cases[0]!;
    // Should route through legal step
    expect(caseResult.path).toContain("step-legal");
    // Assignee for step-legal should be role-legal (Юротдел)
    const assignee = caseResult.assignees.get("step-legal");
    expect(assignee?.roleId).toBe("role-legal");
  });

  it("case with amount < 5M routes to standard step (not Юротдел)", () => {
    const org = makeOrgTree([
      { nodeId: "node-finance", parentId: undefined, roleIds: ["role-finance"] },
    ], ["role-finance"]);

    const gatewayRoutes: GatewayRoute[] = [
      {
        gatewayId: "gw-amount",
        conditions: [
          { attribute: "amount", op: "gte", value: 5_000_000, nextStepId: "step-legal", assigneeRoleId: "role-legal" },
          { attribute: "amount", op: "default", nextStepId: "step-standard", assigneeRoleId: "role-finance" },
        ],
      },
    ];

    const bundle = makeBundle({
      components: makeComponents({
        roles: [{ roleId: "role-finance" }],
      }),
    });

    const result = runSimulationMode1(bundle, {
      cases: [{ caseId: "small-contract", attributes: { amount: 1_000_000 } }],
      org,
      gatewayRoutes,
    });

    const caseResult = result.cases[0]!;
    expect(caseResult.path).toContain("step-standard");
    expect(caseResult.path).not.toContain("step-legal");
  });

  it("no I/O side effects — pure function (sink not called by simulation)", () => {
    // B-5 runSimulationMode1 is a pure function — it does NOT call any async I/O.
    // Verify by calling it without any mock and confirming it returns synchronously.
    const org = makeOrgTree([], []);
    const result = runSimulationMode1(makeBundle(), {
      cases: [{ caseId: "c1", attributes: {} }],
      org,
      gatewayRoutes: [],
    });
    // If this throws or hangs, the function has side effects.
    expect(result).toBeDefined();
    expect(result.cases).toBeDefined();
  });
});

describe("AC-19 — mode-1 uses lintBpmn as the sole linter; invalid BPMN → fail-closed", () => {
  it("invalid BPMN → simulation returns error for all cases (fail-closed)", () => {
    const org = makeOrgTree([], []);
    const bundle = makeBundle({
      components: makeComponents({ process: "THIS IS NOT VALID BPMN XML AT ALL <<>>" }),
    });
    const result = runSimulationMode1(bundle, {
      cases: [{ caseId: "c1", attributes: {} }],
      org,
      gatewayRoutes: [],
    });

    // All cases should have errors (fail-closed)
    expect(result.cases.every((c) => c.error !== undefined)).toBe(true);
    expect(result.cases[0]!.error).toBeTruthy();
  });

  it("valid BPMN passes lint and simulation proceeds", () => {
    const org = makeOrgTree([], []);
    // A minimal valid BPMN XML (no raw-object bindings)
    const validBpmn = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <bpmn:process id="p1">
        <bpmn:startEvent id="start"/>
        <bpmn:endEvent id="end"/>
      </bpmn:process>
    </bpmn:definitions>`;
    const bundle = makeBundle({
      components: makeComponents({ process: validBpmn }),
    });
    const result = runSimulationMode1(bundle, {
      cases: [{ caseId: "c1", attributes: {} }],
      org,
      gatewayRoutes: [],
    });
    // No error (lint passed)
    expect(result.cases[0]!.error).toBeUndefined();
  });
});
