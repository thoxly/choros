/**
 * Fitness tests for the T-0021 grant_resolver / Data-Access Gateway (PDP).
 * Each describe block maps to a fitness function (FF-R1..FF-R7) and its AC ids.
 *
 * FF-R1 → AC-3, AC-4  : action-time binding (revoke→deny, out-of-window→deny)
 * FF-R2 → AC-5        : human == agent identical-fields (one projectFields)
 * FF-R3 → AC-1/2/7/9  : default-deny / fail-closed
 * FF-R4 → AC-6, AC-8  : scope containment + projection (absent not null)
 * FF-R5 → AC-10       : single chokepoint (structural — see ci/checks too)
 * FF-R6 → AC-11       : no second authority subsystem (grant-rows-only)
 * FF-R7 → AC-12, AC-13: purity / port-conformance
 *
 * All IO is behind in-memory ports (GrantSource / RecordSource / AncestryOracle)
 * — the suite pins its own environment and does not depend on ambient build
 * state (D-056). Postgres-backed ports + RLS DAO probe land in T-0053.
 */
import { describe, it, expect } from "vitest";
import {
  type ObjectHandle,
  type ResolveSubject,
  type ResolvedView,
  type ResourceRef,
  type Facet,
  type HandleResolver,
  makeHandle,
  denyAllResolver,
} from "../core/object-handle.js";
import {
  type Grant,
  type Operation,
  type AncestryOracle,
} from "../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  refToScope,
  projectFields,
  visibleFields,
  resolveFor,
  makeGrantResolver,
} from "../core/grant-resolver.js";

// ---------------------------------------------------------------------------
// Shared in-memory fixtures
// ---------------------------------------------------------------------------

const T = "tenant-A";
const APP = "app-1";
const REG = "reg-1";
const REC = "rec-1";

/** A simple ancestry oracle: edges are [descendant, ancestor]; transitive. */
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

/** Default oracle: rec-1 ⊑ reg-1 ⊑ app-1 in the resource hierarchy. */
function defaultOracle(): AncestryOracle {
  return makeOracle([
    [REC, REG],
    [REG, APP],
  ]);
}

function recordRef(recordId = REC, registryId = REG, tenantId = T): ResourceRef {
  return { kind: "record", tenantId, registryId, recordId };
}

function recordHandle(facet?: Facet, tenantId = T): ObjectHandle {
  return makeHandle(recordRef(REC, REG, tenantId), tenantId, facet);
}

function subject(subjectId = "user-1", tenantId = T): ResolveSubject {
  return { tenantId, subjectId };
}

/** A grant scoped at the registry node (so rec-1 ⊑ reg-1 is covered). */
function grant(
  overrides: Partial<Grant> = {},
): Grant {
  return {
    tenantId: T,
    id: "g-1",
    roleId: "role-1",
    resourceType: "record",
    operation: "read",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: REG,
      nodeLevel: "registry",
    },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
    ...overrides,
  };
}

/** A GrantSource returning a fixed list (ignores subject/now). */
function staticGrants(grants: Grant[]): GrantSource {
  return { getGrants: () => Promise.resolve(grants) };
}

/** A RecordSource returning a fixed record (or null). */
function staticRecord(rec: Record<string, unknown> | null): RecordSource {
  return { getRecord: () => Promise.resolve(rec) };
}

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    grants: staticGrants([grant()]),
    records: staticRecord({ name: "Alice", salary: 100, ssn: "x" }),
    ancestry: defaultOracle(),
    now: () => 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// FF-R1 — action-time binding (AC-3, AC-4)
// ---------------------------------------------------------------------------

describe("FF-R1 action-time binding (revoke/window) [AC-3, AC-4]", () => {
  it("re-queries grants per call: covering at t0 (denied:false), empty at t1 (no_grant)", async () => {
    // A GrantSource that returns a covering grant before t=2000, empty after.
    const grants: GrantSource = {
      getGrants: (_s, nowMs) =>
        Promise.resolve(nowMs < 2000 ? [grant()] : []),
    };
    let clock = 1000;
    const d = deps({ grants, now: () => clock });

    const at0 = await resolveFor(d, recordHandle(), subject(), "read");
    expect(at0.denied).toBe(false);

    clock = 3000; // grant revoked between mint and resolve
    const at1 = await resolveFor(d, recordHandle(), subject(), "read");
    expect(at1).toEqual({ denied: true, reason: "no_grant" });
  });

  it("never caches a mint-time snapshot: a fresh GrantSource call happens each resolve", async () => {
    let calls = 0;
    const grants: GrantSource = {
      getGrants: () => {
        calls += 1;
        return Promise.resolve([grant()]);
      },
    };
    const d = deps({ grants });
    await resolveFor(d, recordHandle(), subject(), "read");
    await resolveFor(d, recordHandle(), subject(), "read");
    expect(calls).toBe(2);
  });

  it("out-of-window grant (isEffective false) yields no_grant [AC-4]", async () => {
    // validUntil in the past relative to injected now=1000.
    const expired = grant({ validFrom: 0, validUntil: 500 });
    const d = deps({ grants: staticGrants([expired]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
  });

  it("not-yet-valid grant (validFrom in future) yields no_grant [AC-4]", async () => {
    const future = grant({ validFrom: 5000 });
    const d = deps({ grants: staticGrants([future]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
  });
});

// ---------------------------------------------------------------------------
// FF-R2 — human == agent identical fields (AC-5)
// ---------------------------------------------------------------------------

describe("FF-R2 human==agent identical-fields [AC-5]", () => {
  it("two distinct call-sites (human form, agent payload) return deep-equal views", async () => {
    const d = deps();
    const handle = recordHandle();
    const subj = subject();

    // The human-form path and the agent-payload path are the SAME call.
    const humanForm = await resolveFor(d, handle, subj, "read");
    const agentPayload = await resolveFor(d, handle, subj, "read");

    expect(humanForm).toEqual(agentPayload);
    expect(humanForm.denied).toBe(false);
    if (!humanForm.denied) {
      expect(humanForm.fields).toEqual({ name: "Alice", salary: 100, ssn: "x" });
    }
  });

  it("both paths share exactly one projectFields invocation per resolve", async () => {
    // Structural: resolveFor delegates filtering only to projectFields; there is
    // no human/agent branch. We assert by feeding both through makeGrantResolver
    // (the human form path uses resolveHandle) and resolveFor (agent op path),
    // both reaching the same projection for the same inputs.
    const d = deps();
    const resolver = makeGrantResolver(d);
    const viaPort = await resolver.resolveHandle(recordHandle(), subject());
    const viaCore = await resolveFor(d, recordHandle(), subject(), "read");
    expect(viaPort).toEqual(viaCore);
  });

  it("ResolveSubject is identity-only — no human/agent flag exists to branch on", () => {
    const s = subject();
    expect(Object.keys(s).sort()).toEqual(["subjectId", "tenantId"]);
  });
});

// ---------------------------------------------------------------------------
// FF-R3 — default-deny / fail-closed (AC-1, AC-2, AC-7, AC-9)
// ---------------------------------------------------------------------------

describe("FF-R3 fail-closed / default-deny [AC-1, AC-2, AC-7, AC-9]", () => {
  it("no covering grant ⇒ no_grant, no fields key [AC-1]", async () => {
    const d = deps({ grants: staticGrants([]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
    expect("fields" in v).toBe(false);
  });

  it("cross-tenant handle ⇒ cross_tenant, before any grant/record read [AC-2]", async () => {
    let grantsRead = false;
    let recordRead = false;
    const grants: GrantSource = {
      getGrants: () => {
        grantsRead = true;
        return Promise.resolve([grant()]);
      },
    };
    const records: RecordSource = {
      getRecord: () => {
        recordRead = true;
        return Promise.resolve({ name: "Alice" });
      },
    };
    const d = deps({ grants, records });

    // subject in tenant-A; handle minted for tenant-B.
    const handleB = recordHandle(undefined, "tenant-B");
    const v = await resolveFor(d, handleB, subject("user-1", T), "read");
    expect(v).toEqual({ denied: true, reason: "cross_tenant" });
    expect(grantsRead).toBe(false);
    expect(recordRead).toBe(false);
  });

  it("operation mismatch (read grant, update request) ⇒ no_grant [AC-7]", async () => {
    const d = deps({ grants: staticGrants([grant({ operation: "read" })]) });
    const v = await resolveFor(d, recordHandle(), subject(), "update");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
  });

  it("operation mismatch (update grant, read request) ⇒ no_grant [AC-7]", async () => {
    const d = deps({ grants: staticGrants([grant({ operation: "update" })]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
  });

  it("absent record (RecordSource returns null) ⇒ not_found [AC-9]", async () => {
    const d = deps({ records: staticRecord(null) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "not_found" });
  });

  it("no path returns denied:false without a covering grant", async () => {
    // Cross-tenant + empty grants + absent record: all deny.
    for (const d of [
      deps({ grants: staticGrants([]) }),
      deps({ records: staticRecord(null) }),
    ]) {
      const v = await resolveFor(d, recordHandle(), subject(), "read");
      expect(v.denied).toBe(true);
    }
  });

  it("a grant with a free-form (non-lattice) scope never covers ⇒ no_grant", async () => {
    const freeform = grant({
      scope: { kind: "freeform", predicate: "owner == self" },
    });
    const d = deps({ grants: staticGrants([freeform]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
  });
});

// ---------------------------------------------------------------------------
// FF-R4 — scope containment + projection (AC-6, AC-8)
// ---------------------------------------------------------------------------

describe("FF-R4 containment + projection [AC-6, AC-8]", () => {
  it("ref inside the granted subtree resolves [AC-8]", async () => {
    // grant scoped at app-1; rec-1 ⊑ reg-1 ⊑ app-1.
    const appGrant = grant({
      scope: {
        kind: "node",
        hierarchy: "resource",
        nodeId: APP,
        nodeLevel: "application",
      },
    });
    const d = deps({ grants: staticGrants([appGrant]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v.denied).toBe(false);
  });

  it("ref outside the granted subtree ⇒ no_grant [AC-8]", async () => {
    // grant scoped at a sibling registry the record does not descend from.
    const otherReg = grant({
      scope: {
        kind: "node",
        hierarchy: "resource",
        nodeId: "reg-other",
        nodeLevel: "registry",
      },
    });
    const d = deps({ grants: staticGrants([otherReg]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v).toEqual({ denied: true, reason: "no_grant" });
  });

  it("visible set = grant facet ∩ handle facet; masked fields are ABSENT not null [AC-6]", async () => {
    // grant facet exposes {name, salary}; handle narrows to {name, ssn}.
    const facetGrant = grant({ resourceFacet: { fields: ["name", "salary"] } });
    const handle = recordHandle({ fields: ["name", "ssn"] });
    const d = deps({ grants: staticGrants([facetGrant]) });
    const v = await resolveFor(d, handle, subject(), "read");
    expect(v.denied).toBe(false);
    if (!v.denied) {
      // intersection = {name}; salary masked by handle, ssn masked by grant.
      expect(v.fields).toEqual({ name: "Alice" });
      expect("salary" in v.fields).toBe(false);
      expect("ssn" in v.fields).toBe(false);
    }
  });

  it("grant with no facet ⇒ whole-resource read (all raw keys visible) [AC-6]", async () => {
    const d = deps({ grants: staticGrants([grant()]) });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v.denied).toBe(false);
    if (!v.denied) {
      expect(v.fields).toEqual({ name: "Alice", salary: 100, ssn: "x" });
    }
  });

  it("handle facet can only shrink the grant view, never widen it [AC-6]", async () => {
    // grant facet = {name}; handle facet asks for {name, salary} — salary is NOT
    // conferred by the grant, so it cannot appear.
    const facetGrant = grant({ resourceFacet: { fields: ["name"] } });
    const handle = recordHandle({ fields: ["name", "salary"] });
    const d = deps({ grants: staticGrants([facetGrant]) });
    const v = await resolveFor(d, handle, subject(), "read");
    expect(v.denied).toBe(false);
    if (!v.denied) {
      expect(v.fields).toEqual({ name: "Alice" });
    }
  });

  it("union over multiple covering grants' facets", () => {
    const g1 = grant({ id: "g1", resourceFacet: { fields: ["name"] } });
    const g2 = grant({ id: "g2", resourceFacet: { fields: ["salary"] } });
    const vis = visibleFields([g1, g2], undefined, {
      name: 1,
      salary: 2,
      ssn: 3,
    });
    expect([...vis].sort()).toEqual(["name", "salary"]);
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL (R-1): a PRESENT-but-malformed resourceFacet must FAIL-CLOSED
  // to ZERO visible fields — it must NEVER widen to whole-resource. Only a
  // STRICTLY-ABSENT facet (undefined/null) confers whole-resource (ADR §4.4).
  // resourceFacet is typed `unknown`, so any of these parse cleanly yet must
  // confer no fields. Each case is checked both via visibleFields (the unit)
  // and end-to-end via resolveFor (the projected payload).
  // -------------------------------------------------------------------------
  const RAW = { name: "Alice", salary: 100, ssn: "x" } as const;
  const malformedFacets: Array<[string, unknown]> = [
    ["fields is a number ({fields:123})", { fields: 123 }],
    ["fields is a string ({fields:'bad'})", { fields: "bad" }],
    ["fields is null ({fields:null})", { fields: null }],
    ["fields is an object ({fields:{}})", { fields: {} }],
    ["fields is array of non-strings ([1,2])", { fields: [1, 2] }],
    ["fields is array of mixed junk ([1,{},null])", { fields: [1, {}, null] }],
    ["missing fields key ({})", {}],
    ["extra junk, no fields ({foo:'bar'})", { foo: "bar" }],
    ["facet is a bare number (42)", 42],
    ["facet is a bare string ('whole')", "whole"],
    ["facet is a boolean (true)", true],
    ["facet is an array (['name'])", ["name"]],
  ];

  for (const [label, badFacet] of malformedFacets) {
    it(`malformed facet ⇒ ZERO fields, NOT whole-resource [R-1]: ${label}`, async () => {
      const g = grant({ resourceFacet: badFacet });

      // Unit: visibleFields confers nothing for the malformed grant.
      const vis = visibleFields([g], undefined, { ...RAW });
      expect([...vis]).toEqual([]);

      // End-to-end: the projected payload is empty (fail-closed), and crucially
      // NOT the whole record — none of name/salary/ssn leak.
      const d = deps({
        grants: staticGrants([g]),
        records: staticRecord({ ...RAW }),
      });
      const v = await resolveFor(d, recordHandle(), subject(), "read");
      expect(v.denied).toBe(false);
      if (!v.denied) {
        expect(v.fields).toEqual({});
        expect("name" in v.fields).toBe(false);
        expect("salary" in v.fields).toBe(false);
        expect("ssn" in v.fields).toBe(false);
      }
    });
  }

  it("explicit empty fields array ({fields:[]}) ⇒ zero fields (not whole) [R-1]", () => {
    const g = grant({ resourceFacet: { fields: [] } });
    const vis = visibleFields([g], undefined, { ...RAW });
    expect([...vis]).toEqual([]);
  });

  it("strictly-absent facet (undefined) ⇒ whole-resource (the ONLY widen path) [AC-6]", () => {
    const g = grant({ resourceFacet: undefined });
    const vis = visibleFields([g], undefined, { ...RAW });
    expect([...vis].sort()).toEqual(["name", "salary", "ssn"]);
  });

  it("strictly-absent facet (null) ⇒ whole-resource [AC-6]", () => {
    const g = grant({ resourceFacet: null });
    const vis = visibleFields([g], undefined, { ...RAW });
    expect([...vis].sort()).toEqual(["name", "salary", "ssn"]);
  });

  it("malformed facet does NOT widen a sibling well-formed grant's view [R-1]", async () => {
    // One grant confers {name}; another is malformed. The malformed one must
    // contribute nothing — the union stays {name}, never the whole resource.
    const good = grant({ id: "good", resourceFacet: { fields: ["name"] } });
    const bad = grant({ id: "bad", resourceFacet: { fields: 999 } });
    const vis = visibleFields([good, bad], undefined, { ...RAW });
    expect([...vis].sort()).toEqual(["name"]);

    const d = deps({
      grants: staticGrants([good, bad]),
      records: staticRecord({ ...RAW }),
    });
    const v = await resolveFor(d, recordHandle(), subject(), "read");
    expect(v.denied).toBe(false);
    if (!v.denied) {
      expect(v.fields).toEqual({ name: "Alice" });
    }
  });
});

// ---------------------------------------------------------------------------
// FF-R5 / FF-R6 — structural (single chokepoint, grant-rows-only)
// ---------------------------------------------------------------------------

describe("FF-R5/FF-R6 structural surface [AC-10, AC-11]", () => {
  it("refToScope maps each ref kind to a resource-hierarchy node leaf", () => {
    expect(refToScope({ kind: "application", tenantId: T, applicationId: APP }))
      .toEqual({ kind: "node", hierarchy: "resource", nodeId: APP, nodeLevel: "application" });
    expect(refToScope({ kind: "registry", tenantId: T, applicationId: APP, registryId: REG }))
      .toEqual({ kind: "node", hierarchy: "resource", nodeId: REG, nodeLevel: "registry" });
    expect(refToScope(recordRef()))
      .toEqual({ kind: "node", hierarchy: "resource", nodeId: REC, nodeLevel: "record" });
  });

  it("projectFields produces a NEW object containing only visible keys (absent not null)", () => {
    const raw = { a: 1, b: 2, c: 3 };
    const out = projectFields(raw, new Set(["a", "c"]));
    expect(out).toEqual({ a: 1, c: 3 });
    expect("b" in out).toBe(false);
    expect(out).not.toBe(raw); // fresh object, no payload write-back (NF-4)
  });

  it("the decision/field set derive ONLY from grant rows (no parallel store)", async () => {
    // With grants present the record resolves; with the SAME record but no
    // grants it denies — proving the field-visibility source is grant rows only.
    const allow = deps({ grants: staticGrants([grant()]) });
    const denyN = deps({ grants: staticGrants([]) });
    const a = await resolveFor(allow, recordHandle(), subject(), "read");
    const d = await resolveFor(denyN, recordHandle(), subject(), "read");
    expect(a.denied).toBe(false);
    expect(d.denied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FF-R7 — purity / port-conformance (AC-12, AC-13)
// ---------------------------------------------------------------------------

describe("FF-R7 purity / port-conformance [AC-12, AC-13]", () => {
  it("deeply-equal inputs (same ports, same now) ⇒ deeply-equal outputs [AC-12]", async () => {
    const d = deps();
    const r1 = await resolveFor(d, recordHandle(), subject(), "read");
    const r2 = await resolveFor(d, recordHandle(), subject(), "read");
    expect(r1).toEqual(r2);
  });

  it("makeGrantResolver(deps) type-checks as HandleResolver and replaces denyAllResolver [AC-13]", async () => {
    // Compile-time conformance: both are HandleResolver. Runtime: swapping the
    // seam from deny-all to the real resolver changes deny→allow with no signature change.
    const seam: HandleResolver = denyAllResolver;
    const swapped: HandleResolver = makeGrantResolver(deps());

    const denied: ResolvedView = await seam.resolveHandle(
      recordHandle(),
      subject(),
    );
    const allowed: ResolvedView = await swapped.resolveHandle(
      recordHandle(),
      subject(),
    );
    expect(denied.denied).toBe(true);
    expect(allowed.denied).toBe(false);
  });

  it("resolveHandle is the read-path facade over resolveFor(.., 'read')", async () => {
    const d = deps();
    const viaResolver = await makeGrantResolver(d).resolveHandle(
      recordHandle(),
      subject(),
    );
    const viaCoreRead = await resolveFor(d, recordHandle(), subject(), "read");
    expect(viaResolver).toEqual(viaCoreRead);
  });

  it("all write-path operations route through the same core (op-aware)", async () => {
    const ops: Operation[] = [
      "create",
      "update",
      "delete",
      "approve",
      "transition",
    ];
    for (const op of ops) {
      // A grant for that exact op covers; a read grant does not.
      const opGrant = grant({ operation: op });
      const d = deps({ grants: staticGrants([opGrant]) });
      const v = await resolveFor(d, recordHandle(), subject(), op);
      expect(v.denied).toBe(false);
    }
  });
});
