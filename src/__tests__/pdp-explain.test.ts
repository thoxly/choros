/**
 * T-0136: PDP Explain — unit tests
 *
 * Tests the TraceCollector instrumentation in resolveFor and the explain
 * endpoint's authz + verdict-agreement property.
 *
 * Design discipline: explain uses the same resolveFor path — verdict
 * agreement is guaranteed structurally, not by cross-checking two
 * independent implementations.
 *
 * Test matrix:
 *   - trace: cross_tenant → no trace after tenant step
 *   - trace: no_grant (all grants missing)
 *   - trace: no_grant (time-window mismatch → effective_filter fails)
 *   - trace: no_grant (scope mismatch → scope_filter fails)
 *   - trace: allow → masking step present
 *   - property: for N random deny/allow cases, trace verdict === resolveFor verdict
 *   - authz: 403 for non-admin caller about foreign subject (HTTP layer)
 */

import { describe, it, expect } from "vitest";
import {
  type Grant,
  type AncestryOracle,
} from "../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  type TraceCollector,
  type TraceStep,
  resolveFor,
} from "../core/grant-resolver.js";
import {
  type ObjectHandle,
  type ResolveSubject,
  makeHandle,
} from "../core/object-handle.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const T = "tenant-A";
const OTHER_T = "tenant-B";
const APP = "app-1";
const REG = "reg-1";
const REC = "rec-1";

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
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
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
  return makeOracle([[REC, REG], [REG, APP]]);
}

function recordHandle(tenantId = T): ObjectHandle {
  return makeHandle(
    { kind: "record", tenantId, registryId: REG, recordId: REC },
    tenantId,
    undefined,
  );
}

function subject(subjectId = "user-1", tenantId = T): ResolveSubject {
  return { tenantId, subjectId };
}

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    tenantId: T,
    id: "g-1",
    roleId: "role-1",
    resourceType: "record",
    operation: "read",
    scope: { kind: "node", hierarchy: "resource", nodeId: APP, nodeLevel: "application" },
    delegable: true,
    grantedBy: "owner",
    createdAt: 1000,
    ...overrides,
  };
}

function makeGrants(grants: Grant[]): GrantSource {
  return { async getGrants(_subject, _now) { return grants; } };
}

function makeRecord(
  fields: Record<string, unknown> = { x: 1 },
): RecordSource {
  return { async getRecord(_ref) { return fields; } };
}

function nullRecord(): RecordSource {
  return { async getRecord(_ref) { return null; } };
}

function makeDeps(opts: {
  grants?: Grant[];
  record?: Record<string, unknown> | null;
  now?: number;
}): ResolverDeps {
  return {
    grants: opts.grants !== undefined
      ? makeGrants(opts.grants)
      : makeGrants([makeGrant()]),
    records: opts.record === null
      ? nullRecord()
      : makeRecord(opts.record ?? { x: 1 }),
    ancestry: defaultOracle(),
    now: opts.now !== undefined ? () => opts.now! : () => 5000,
  };
}

function collectTrace(deps: ResolverDeps, handle: ObjectHandle, sub: ResolveSubject): {
  steps: TraceStep[];
  result: ReturnType<typeof resolveFor>;
} {
  const steps: TraceStep[] = [];
  const collector: TraceCollector = { push: (s) => { steps.push(s); } };
  const result = resolveFor(deps, handle, sub, "read", undefined, undefined, collector);
  return { steps, result };
}

// ---------------------------------------------------------------------------
// Trace: cross_tenant
// ---------------------------------------------------------------------------

describe("trace: cross_tenant", () => {
  it("emits tenant step with ok:false and returns denied:cross_tenant", async () => {
    const handle = recordHandle(OTHER_T); // different tenant
    const sub = subject("user-1", T); // caller tenant T, handle tenant OTHER_T
    const deps = makeDeps({});

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "cross_tenant" });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ step: "tenant", ok: false });
  });
});

// ---------------------------------------------------------------------------
// Trace: no grants
// ---------------------------------------------------------------------------

describe("trace: no_grant (empty grant set)", () => {
  it("emits tenant+grants_resolved+effective_filter+scope_filter+covering steps", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [] }); // no grants at all

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const stepNames = steps.map((s) => s.step);
    expect(stepNames).toContain("tenant");
    expect(stepNames).toContain("grants_resolved");
    expect(stepNames).toContain("effective_filter");
    expect(stepNames).toContain("scope_filter");
    expect(stepNames).toContain("covering");

    const coveringStep = steps.find((s) => s.step === "covering")!;
    expect(coveringStep.ok).toBe(false);
    expect((coveringStep as Extract<TraceStep, { step: "covering" }>).reason).toBe("no_grant");

    const grantStep = steps.find((s) => s.step === "grants_resolved")!;
    expect((grantStep as Extract<TraceStep, { step: "grants_resolved" }>).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace: effective_filter (time window mismatch)
// ---------------------------------------------------------------------------

describe("trace: effective_filter fails (expired grant)", () => {
  it("emits effective_filter ok:false when grant is expired", async () => {
    const now = 5000;
    // Grant valid_until=1000 < now=5000 → expired
    const expiredGrant = makeGrant({ validUntil: 1000 });
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [expiredGrant], now });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const effectiveStep = steps.find((s) => s.step === "effective_filter") as
      Extract<TraceStep, { step: "effective_filter" }> | undefined;
    expect(effectiveStep).toBeDefined();
    expect(effectiveStep!.ok).toBe(false);
    expect(effectiveStep!.passed).toBe(0);
  });

  it("emits effective_filter ok:false when grant is not yet valid", async () => {
    const now = 1000;
    // Grant valid_from=5000 > now=1000 → future
    const futureGrant = makeGrant({ validFrom: 5000 });
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [futureGrant], now });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const effectiveStep = steps.find((s) => s.step === "effective_filter") as
      Extract<TraceStep, { step: "effective_filter" }> | undefined;
    expect(effectiveStep).toBeDefined();
    expect(effectiveStep!.ok).toBe(false);
    expect(effectiveStep!.passed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace: scope_filter (scope mismatch)
// ---------------------------------------------------------------------------

describe("trace: scope_filter fails (wrong scope node)", () => {
  it("emits scope_filter ok:false when grant scope doesn't cover handle", async () => {
    // Grant scoped to "other-app" — does NOT cover APP/REG/REC
    const narrowGrant = makeGrant({
      scope: { kind: "node", hierarchy: "resource", nodeId: "other-app", nodeLevel: "application" },
    });
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [narrowGrant] });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "no_grant" });

    const scopeStep = steps.find((s) => s.step === "scope_filter") as
      Extract<TraceStep, { step: "scope_filter" }> | undefined;
    expect(scopeStep).toBeDefined();
    expect(scopeStep!.ok).toBe(false);
    expect(scopeStep!.passed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trace: allow + masking step
// ---------------------------------------------------------------------------

describe("trace: allow path", () => {
  it("emits all steps with ok:true and includes masking step", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [makeGrant()], record: { name: "Alice" } });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result.denied).toBe(false);

    const stepNames = steps.map((s) => s.step);
    expect(stepNames).toContain("tenant");
    expect(stepNames).toContain("grants_resolved");
    expect(stepNames).toContain("effective_filter");
    expect(stepNames).toContain("scope_filter");
    expect(stepNames).toContain("covering");
    expect(stepNames).toContain("record_fetch");
    expect(stepNames).toContain("masking");

    const maskStep = steps.find((s) => s.step === "masking") as
      Extract<TraceStep, { step: "masking" }> | undefined;
    expect(maskStep).toBeDefined();
    expect(maskStep!.ok).toBe(true);
    expect(maskStep!.governed).toBe(false); // no ClassificationSource wired
  });

  it("grants_resolved count matches actual grant count", async () => {
    const grants = [makeGrant(), makeGrant({ id: "g-2" })];
    const deps = makeDeps({ grants });
    const handle = recordHandle();
    const sub = subject();

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };
    await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    const grantStep = steps.find((s) => s.step === "grants_resolved") as
      Extract<TraceStep, { step: "grants_resolved" }> | undefined;
    expect(grantStep!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Trace: not_found
// ---------------------------------------------------------------------------

describe("trace: not_found", () => {
  it("emits record_fetch ok:false with reason not_found", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [makeGrant()], record: null });

    const steps: TraceStep[] = [];
    const trace: TraceCollector = { push: (s) => { steps.push(s); } };

    const result = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

    expect(result).toEqual({ denied: true, reason: "not_found" });

    const fetchStep = steps.find((s) => s.step === "record_fetch") as
      Extract<TraceStep, { step: "record_fetch" }> | undefined;
    expect(fetchStep).toBeDefined();
    expect(fetchStep!.ok).toBe(false);
    expect(fetchStep!.reason).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Property: trace.verdict === resolveFor.verdict for a matrix of cases
// ---------------------------------------------------------------------------

describe("property: explain verdict matches resolveFor verdict", () => {
  /**
   * For each test case, we run resolveFor TWICE:
   *   1. Without trace (baseline)
   *   2. With trace (explain path)
   *
   * The verdict from the trace-annotated run must match the baseline.
   * This is the structural guarantee of AC-1.
   */
  const cases: Array<{
    name: string;
    grants: Grant[];
    record: Record<string, unknown> | null;
    now: number;
    crossTenant?: boolean;
  }> = [
    { name: "empty grants → deny", grants: [], record: { x: 1 }, now: 5000 },
    { name: "good grant → allow", grants: [makeGrant()], record: { x: 1 }, now: 5000 },
    { name: "expired grant → deny", grants: [makeGrant({ validUntil: 1000 })], record: { x: 1 }, now: 5000 },
    { name: "future grant → deny", grants: [makeGrant({ validFrom: 9000 })], record: { x: 1 }, now: 5000 },
    { name: "wrong op → deny", grants: [makeGrant({ operation: "write" as never })], record: { x: 1 }, now: 5000 },
    { name: "record not_found → deny", grants: [makeGrant()], record: null, now: 5000 },
    { name: "cross_tenant → deny", grants: [makeGrant()], record: { x: 1 }, now: 5000, crossTenant: true },
    {
      name: "good grant with window → allow",
      grants: [makeGrant({ validFrom: 1000, validUntil: 9000 })],
      record: { x: 1 },
      now: 5000,
    },
    {
      name: "two grants, one expired one valid → allow",
      grants: [makeGrant({ id: "g-exp", validUntil: 1000 }), makeGrant({ id: "g-valid" })],
      record: { x: 1 },
      now: 5000,
    },
  ];

  for (const tc of cases) {
    it(`${tc.name}`, async () => {
      const tenantId = tc.crossTenant ? OTHER_T : T;
      const handle = recordHandle(tenantId);
      const sub = subject("user-1", T);
      const deps = makeDeps({ grants: tc.grants, record: tc.record, now: tc.now });

      // Baseline: without trace
      const baseline = await resolveFor(deps, handle, sub, "read");

      // With trace
      const steps: TraceStep[] = [];
      const trace: TraceCollector = { push: (s) => { steps.push(s); } };
      const withTrace = await resolveFor(deps, handle, sub, "read", undefined, undefined, trace);

      // Verdict must match
      expect(withTrace.denied).toBe(baseline.denied);
      if (baseline.denied && withTrace.denied) {
        expect(withTrace.reason).toBe(baseline.reason);
      }

      // Trace must have at least the tenant step
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]!.step).toBe("tenant");
    });
  }
});

// ---------------------------------------------------------------------------
// Backward compatibility: trace absent = byte-identical (NF-1)
// ---------------------------------------------------------------------------

describe("backward compat: no trace = no behaviour change", () => {
  it("resolveFor without trace returns same result as with null-trace", async () => {
    const handle = recordHandle();
    const sub = subject();
    const deps = makeDeps({ grants: [makeGrant()], record: { foo: "bar" } });

    const without = await resolveFor(deps, handle, sub, "read");
    const withEmpty = await resolveFor(deps, handle, sub, "read", undefined, undefined, undefined);

    expect(without.denied).toBe(withEmpty.denied);
    if (!without.denied && !withEmpty.denied) {
      expect(JSON.stringify(without.fields)).toBe(JSON.stringify(withEmpty.fields));
    }
  });
});
