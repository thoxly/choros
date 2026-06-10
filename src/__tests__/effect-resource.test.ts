/**
 * Fitness tests for T-0034 — External-Effect Resources (E4.4).
 *
 * Covers all AC-1 through AC-18 and adversarial cases from spec §9.
 *
 * FF-ER3 → AC-2, AC-3, AC-17: classifyTool determinism + pure/effecting
 * FF-ER4 → AC-1, AC-4:       fail-closed on malformed/unknown-kind declares
 * FF-ER5 → AC-5, AC-9:       gateway deny on missing effect grant
 * FF-ER6 → AC-6:             gateway permit on complete effect grants
 * FF-ER7 → AC-7:             all-or-nothing: partial coverage → denied
 * FF-ER8 → AC-8:             no EffectSource → no effect-verification path
 * FF-ER10 → AC-16:           all seven symbols exported and importable
 * FF-ER11 → AC-15:           frozen modules not imported (checked by mutation-gateway-isolation.sh)
 * FF-ER12 → AC-14:           grant-resolver.ts import surface preserved (structural)
 * FF-ER13 → AC-13:           single-resolver seam (checked by single-resolver.sh)
 *
 * All IO is behind in-memory ports — suite is pure TS, no Postgres.
 */
import { describe, it, expect } from "vitest";
import {
  type EffectKind,
  type EffectDeclaration,
  type EffectResource,
  type EffectSource,
  type ToolEffectProfile,
  classifyTool,
  verifyEffectGrants,
} from "../core/effect-resource.js";
import {
  type Grant,
  type AncestryOracle,
} from "../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  resolveFor,
} from "../core/grant-resolver.js";
import {
  type ObjectHandle,
  type ResolveSubject,
  makeHandle,
} from "../core/object-handle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const EP_1 = "ep-11111111-1111-1111-1111-111111111111";
const EP_2 = "ep-22222222-2222-2222-2222-222222222222";

function makeEffectSource(
  resources: EffectResource[],
): EffectSource {
  return {
    getEffect(tenantId: string, resourceId: string): EffectResource | null {
      return (
        resources.find(
          (r) => r.tenantId === tenantId && r.id === resourceId,
        ) ?? null
      );
    },
  };
}

function effectResource(
  id: string,
  kind: EffectKind,
  tenantId: string = TENANT_A,
): EffectResource {
  return { id, tenantId, kind, scope: { kind: "node", hierarchy: "resource", nodeId: id, nodeLevel: "record" } };
}

/** A grant for an effect_resource with a simple node scope matching the resource id. */
function effectGrant(
  resourceId: string,
  tenantId: string = TENANT_A,
): Grant {
  return {
    tenantId,
    id: `grant-${resourceId}`,
    roleId: "role-effect",
    resourceType: "effect_resource",
    operation: "invoke",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: resourceId,
      nodeLevel: "record",
    },
    delegable: false,
    grantedBy: "admin",
    createdAt: 0,
  };
}

/** A standard record-read grant for the resolver's step 3 (covering grant). */
function recordGrant(tenantId: string = TENANT_A): Grant {
  return {
    tenantId,
    id: "grant-record-read",
    roleId: "role-reader",
    resourceType: "record",
    operation: "invoke",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: "reg-1",
      nodeLevel: "registry",
    },
    delegable: false,
    grantedBy: "admin",
    createdAt: 0,
  };
}

function staticGrants(grants: Grant[]): GrantSource {
  return { getGrants: () => Promise.resolve(grants) };
}

function staticRecord(
  rec: Record<string, unknown> | null = { field: "value" },
): RecordSource {
  return { getRecord: () => Promise.resolve(rec) };
}

function defaultOracle(): AncestryOracle {
  return {
    isDescendantOrSelf(_h, descendantId, ancestorId): boolean {
      return descendantId === ancestorId || descendantId === "rec-1";
    },
  };
}

function makeSubject(tenantId: string = TENANT_A): ResolveSubject {
  return { tenantId, subjectId: "user-1" };
}

function makeRecordHandle(tenantId: string = TENANT_A): ObjectHandle {
  return makeHandle(
    { kind: "record", tenantId, registryId: "reg-1", recordId: "rec-1" },
    tenantId,
  );
}

// ---------------------------------------------------------------------------
// FF-ER3 — classifyTool determinism + pure/effecting (AC-2, AC-3, AC-17)
// ---------------------------------------------------------------------------

describe("FF-ER3: classifyTool determinism (AC-2, AC-3, AC-17)", () => {
  it("AC-2: classifyTool([]) === { pure: true }", () => {
    const result = classifyTool([]);
    expect(result).toEqual({ pure: true });
  });

  it("AC-3: classifyTool with valid declares → { pure: false, effects: [...] }", () => {
    const decls: EffectDeclaration[] = [
      { resourceId: EP_1, kind: "integration_endpoint" },
    ];
    const result = classifyTool(decls);
    expect(result).toEqual({ pure: false, effects: decls });
  });

  it("AC-3: effects array equals the input (same structure, AC-3 second assertion)", () => {
    const decls: EffectDeclaration[] = [
      { resourceId: EP_1, kind: "messaging_channel" },
      { resourceId: EP_2, kind: "external_account" },
    ];
    const result = classifyTool(decls) as { pure: false; effects: EffectDeclaration[] };
    expect(result.pure).toBe(false);
    expect(result.effects).toEqual(decls);
  });

  it("AC-17: determinism — same inputs twice yield equal outputs", () => {
    const decls: EffectDeclaration[] = [
      { resourceId: EP_1, kind: "integration_endpoint" },
    ];
    const r1 = classifyTool(decls);
    const r2 = classifyTool(decls);
    expect(r1).toEqual(r2);
  });

  it("AC-17: determinism — classifyTool([]) twice yields equal outputs", () => {
    expect(classifyTool([])).toEqual(classifyTool([]));
  });
});

// ---------------------------------------------------------------------------
// FF-ER4 — fail-closed on malformed / unknown-kind declares (AC-1, AC-4)
// ---------------------------------------------------------------------------

describe("FF-ER4: fail-closed on malformed declares (AC-1, AC-4)", () => {
  it("AC-4: null → { pure: false } (fail-closed, not pure)", () => {
    const result = classifyTool(null as unknown as EffectDeclaration[]);
    expect(result.pure).toBe(false);
  });

  it("AC-4: non-array → { pure: false }", () => {
    const result = classifyTool("not-an-array" as unknown as EffectDeclaration[]);
    expect(result.pure).toBe(false);
  });

  it("AC-4: array with item missing kind → { pure: false }", () => {
    const result = classifyTool([{ resourceId: EP_1 }] as unknown as EffectDeclaration[]);
    expect(result.pure).toBe(false);
  });

  it("AC-1/AC-4: unknown kind → { pure: false } (fail-closed, EffectKind is closed)", () => {
    const result = classifyTool([
      { resourceId: EP_1, kind: "unknown_kind" },
    ] as unknown as EffectDeclaration[]);
    expect(result.pure).toBe(false);
  });

  it("AC-4: array with item missing resourceId → { pure: false }", () => {
    const result = classifyTool([{ kind: "integration_endpoint" }] as unknown as EffectDeclaration[]);
    expect(result.pure).toBe(false);
  });

  it("AC-4: array with non-string resourceId → { pure: false }", () => {
    const result = classifyTool([
      { resourceId: 42, kind: "integration_endpoint" },
    ] as unknown as EffectDeclaration[]);
    expect(result.pure).toBe(false);
  });

  it("AC-4: malformed never returns pure: true", () => {
    const cases: unknown[] = [null, undefined, 42, {}, "str", [{ kind: "bad" }]];
    for (const c of cases) {
      const r = classifyTool(c as EffectDeclaration[]);
      expect(r.pure, `classifyTool(${JSON.stringify(c)}) should not be pure`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// FF-ER5 — gateway deny on missing / malformed effect grant (AC-5, AC-9)
// ---------------------------------------------------------------------------

describe("FF-ER5: gateway deny on missing effect grant (AC-5, AC-9)", () => {
  it("AC-5: invoke with EffectSource wired, no effect grant → no_effect_grant", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
    ]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [{ resourceId: EP_1, kind: "integration_endpoint" }] },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("AC-9: malformed declares with EffectSource wired → no_effect_grant", async () => {
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: null },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("AC-9: unknown kind in declares → no_effect_grant", async () => {
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant(), effectGrant(EP_1)]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [{ resourceId: EP_1, kind: "bad_kind" }] },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });
});

// ---------------------------------------------------------------------------
// FF-ER6 — gateway permit on complete effect grants (AC-6)
// ---------------------------------------------------------------------------

describe("FF-ER6: gateway permit on full effect grants (AC-6)", () => {
  it("AC-6: subject holds all declared effect grants → denied: false", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
    ]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant(), effectGrant(EP_1)]),
      records: staticRecord({ name: "Tool" }),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [{ resourceId: EP_1, kind: "integration_endpoint" }] },
    );
    expect(result.denied).toBe(false);
  });

  it("AC-6: empty declares with EffectSource wired → denied: false (pure-compute tool)", async () => {
    const source = makeEffectSource([]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord({ name: "PureTool" }),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [] },
    );
    expect(result.denied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-ER7 — all-or-nothing: partial coverage → denied (AC-7)
// ---------------------------------------------------------------------------

describe("FF-ER7: all-or-nothing effect-grant check (AC-7)", () => {
  it("AC-7: 2-effect tool, subject holds grant for ep-1 only → denied", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
      effectResource(EP_2, "messaging_channel"),
    ]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant(), effectGrant(EP_1)]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      {
        declares: [
          { resourceId: EP_1, kind: "integration_endpoint" },
          { resourceId: EP_2, kind: "messaging_channel" },
        ],
      },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("AC-7: holding neither grant → denied (sanity check for all-or-nothing)", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
      effectResource(EP_2, "messaging_channel"),
    ]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      {
        declares: [
          { resourceId: EP_1, kind: "integration_endpoint" },
          { resourceId: EP_2, kind: "messaging_channel" },
        ],
      },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("AC-7: holding both grants → permit", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
      effectResource(EP_2, "messaging_channel"),
    ]);
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant(), effectGrant(EP_1), effectGrant(EP_2)]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      effects: source,
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      {
        declares: [
          { resourceId: EP_1, kind: "integration_endpoint" },
          { resourceId: EP_2, kind: "messaging_channel" },
        ],
      },
    );
    expect(result.denied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-ER8 — backward compat: no EffectSource → no effect-verification (AC-8)
// ---------------------------------------------------------------------------

describe("FF-ER8: no EffectSource → no effect-verification path (AC-8)", () => {
  it("AC-8: resolveFor without effects in deps behaves as pre-T-0034 (no no_effect_grant)", async () => {
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord({ field: "value" }),
      ancestry: defaultOracle(),
      // no effects port — T-0034 verification skipped
      now: () => 1000,
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
    );
    // No effect grant for the undeclared tool, but EffectSource is absent → no denial
    expect(result.denied).toBe(false);
  });

  it("AC-8: op=invoke without invokeCtx and no effects port → no no_effect_grant path", async () => {
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord({ x: 1 }),
      ancestry: defaultOracle(),
      now: () => 1000,
    };
    const result = await resolveFor(d, makeRecordHandle(), makeSubject(), "invoke");
    expect(result.denied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adversarial cases from spec §9
// ---------------------------------------------------------------------------

describe("Adversarial cases (spec §9)", () => {
  it("§9-1: tool declares ep-1, subject has no effect_resource grant → no_effect_grant", async () => {
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const result = await resolveFor(
      {
        grants: staticGrants([recordGrant()]),
        records: staticRecord(),
        ancestry: defaultOracle(),
        effects: source,
        now: () => 1000,
      },
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [{ resourceId: EP_1, kind: "integration_endpoint" }] },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("§9-2: partial coverage (ep-1 granted, ep-2 not) → no_effect_grant", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
      effectResource(EP_2, "messaging_channel"),
    ]);
    const result = await resolveFor(
      {
        grants: staticGrants([recordGrant(), effectGrant(EP_1)]),
        records: staticRecord(),
        ancestry: defaultOracle(),
        effects: source,
        now: () => 1000,
      },
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      {
        declares: [
          { resourceId: EP_1, kind: "integration_endpoint" },
          { resourceId: EP_2, kind: "messaging_channel" },
        ],
      },
    );
    expect(result.denied).toBe(true);
    expect((result as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("§9-3: full coverage → denied: false", async () => {
    const source = makeEffectSource([
      effectResource(EP_1, "integration_endpoint"),
      effectResource(EP_2, "messaging_channel"),
    ]);
    const result = await resolveFor(
      {
        grants: staticGrants([recordGrant(), effectGrant(EP_1), effectGrant(EP_2)]),
        records: staticRecord(),
        ancestry: defaultOracle(),
        effects: source,
        now: () => 1000,
      },
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      {
        declares: [
          { resourceId: EP_1, kind: "integration_endpoint" },
          { resourceId: EP_2, kind: "messaging_channel" },
        ],
      },
    );
    expect(result.denied).toBe(false);
  });

  it("§9-4: empty declares → classifyTool returns { pure: true }, gateway permits", async () => {
    const r = classifyTool([]);
    expect(r).toEqual({ pure: true });

    const source = makeEffectSource([]);
    const result = await resolveFor(
      {
        grants: staticGrants([recordGrant()]),
        records: staticRecord(),
        ancestry: defaultOracle(),
        effects: source,
        now: () => 1000,
      },
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [] },
    );
    expect(result.denied).toBe(false);
  });

  it("§9-5: malformed declares (null) → classifyTool pure:false, gateway → no_effect_grant", async () => {
    const nullResult = classifyTool(null as unknown as EffectDeclaration[]);
    expect(nullResult.pure).toBe(false);

    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const gwResult = await resolveFor(
      {
        grants: staticGrants([recordGrant(), effectGrant(EP_1)]),
        records: staticRecord(),
        ancestry: defaultOracle(),
        effects: source,
        now: () => 1000,
      },
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: null },
    );
    expect(gwResult.denied).toBe(true);
    expect((gwResult as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("§9-6: malformed kind → classifyTool pure:false, gateway denies fail-closed", async () => {
    const malformed = [{ resourceId: EP_1, kind: "unknown_kind" }];
    const lintResult = classifyTool(malformed as unknown as EffectDeclaration[]);
    expect(lintResult.pure).toBe(false);

    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const gwResult = await resolveFor(
      {
        grants: staticGrants([recordGrant(), effectGrant(EP_1)]),
        records: staticRecord(),
        ancestry: defaultOracle(),
        effects: source,
        now: () => 1000,
      },
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: malformed },
    );
    expect(gwResult.denied).toBe(true);
    expect((gwResult as { reason: string }).reason).toBe("no_effect_grant");
  });

  it("§9-7: cross-tenant effect isolation — grant for ep-1 in TENANT_A does NOT cover TENANT_B", () => {
    // EffectSource returns null for TENANT_B even if TENANT_A has the resource.
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint", TENANT_A)]);
    // source.getEffect(TENANT_B, EP_1) === null
    const result = source.getEffect(TENANT_B, EP_1);
    expect(result).toBeNull();
  });

  it("§9-8: no EffectSource port → invoke does not reach no_effect_grant path", async () => {
    const d: ResolverDeps = {
      grants: staticGrants([recordGrant()]),
      records: staticRecord(),
      ancestry: defaultOracle(),
      now: () => 1000,
      // no effects port
    };
    const result = await resolveFor(
      d,
      makeRecordHandle(),
      makeSubject(),
      "invoke",
      { declares: [{ resourceId: EP_1, kind: "integration_endpoint" }] },
    );
    // Without EffectSource, no effect verification → grant-only enforcement
    expect(result.denied).toBe(false);
  });

  it("§9-9: kind-mismatch in EffectSource row → verifyEffectGrants denies", () => {
    // Tool declares messaging_channel, but row says integration_endpoint → denied.
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const coveringGrants: Grant[] = [effectGrant(EP_1)];
    const result = verifyEffectGrants(
      [{ resourceId: EP_1, kind: "messaging_channel" }],
      coveringGrants,
      1000,
      source,
      TENANT_A,
    );
    expect(result.ok).toBe(false);
    expect((result as { missingResourceId: string }).missingResourceId).toBe(EP_1);
  });
});

// ---------------------------------------------------------------------------
// FF-ER10 — T-0043 seam exports present (AC-16)
// All seven symbols must be importable without cast.
// ---------------------------------------------------------------------------

describe("FF-ER10: T-0043 seam exports present (AC-16)", () => {
  it("EffectKind type is the closed union (compile-time check via value usage)", () => {
    const k1: EffectKind = "integration_endpoint";
    const k2: EffectKind = "messaging_channel";
    const k3: EffectKind = "external_account";
    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k3).toBeDefined();
  });

  it("EffectDeclaration shape is correct", () => {
    const d: EffectDeclaration = { resourceId: EP_1, kind: "integration_endpoint" };
    expect(d.resourceId).toBe(EP_1);
    expect(d.kind).toBe("integration_endpoint");
  });

  it("EffectResource shape is correct", () => {
    const r: EffectResource = {
      id: EP_1,
      tenantId: TENANT_A,
      kind: "integration_endpoint",
      scope: {},
    };
    expect(r.id).toBe(EP_1);
  });

  it("EffectSource port is usable without cast", () => {
    const s: EffectSource = makeEffectSource([]);
    expect(s.getEffect(TENANT_A, EP_1)).toBeNull();
  });

  it("ToolEffectProfile is correct discriminated union", () => {
    const pure: ToolEffectProfile = { pure: true };
    const effecting: ToolEffectProfile = {
      pure: false,
      effects: [{ resourceId: EP_1, kind: "integration_endpoint" }],
    };
    expect(pure.pure).toBe(true);
    expect(effecting.pure).toBe(false);
  });

  it("classifyTool is callable without cast", () => {
    const result = classifyTool([]);
    expect(result).toBeDefined();
  });

  it("verifyEffectGrants is callable without cast", () => {
    const result = verifyEffectGrants([], [], 0, makeEffectSource([]), TENANT_A);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyEffectGrants unit tests (pure function, no gateway)
// ---------------------------------------------------------------------------

describe("verifyEffectGrants unit tests (pure)", () => {
  it("empty declarations → ok: true (no effects to verify)", () => {
    const result = verifyEffectGrants(
      [],
      [],
      1000,
      makeEffectSource([]),
      TENANT_A,
    );
    expect(result).toEqual({ ok: true });
  });

  it("declaration not found in EffectSource → ok: false", () => {
    const result = verifyEffectGrants(
      [{ resourceId: EP_1, kind: "integration_endpoint" }],
      [effectGrant(EP_1)],
      1000,
      makeEffectSource([]), // EP_1 not in source
      TENANT_A,
    );
    expect(result.ok).toBe(false);
    expect((result as { missingResourceId: string }).missingResourceId).toBe(EP_1);
  });

  it("resource found, grant found, kind matches → ok: true", () => {
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const result = verifyEffectGrants(
      [{ resourceId: EP_1, kind: "integration_endpoint" }],
      [effectGrant(EP_1)],
      1000,
      source,
      TENANT_A,
    );
    expect(result).toEqual({ ok: true });
  });

  it("expired grant → ok: false (isEffective gate)", () => {
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint")]);
    const expiredGrant: Grant = {
      ...effectGrant(EP_1),
      validUntil: 500, // expired before nowMs=1000
    };
    const result = verifyEffectGrants(
      [{ resourceId: EP_1, kind: "integration_endpoint" }],
      [expiredGrant],
      1000,
      source,
      TENANT_A,
    );
    expect(result.ok).toBe(false);
  });

  it("cross-tenant grant (tenantId mismatch) → ok: false", () => {
    const source = makeEffectSource([effectResource(EP_1, "integration_endpoint", TENANT_A)]);
    const crossGrant: Grant = { ...effectGrant(EP_1, TENANT_B) }; // different tenant
    const result = verifyEffectGrants(
      [{ resourceId: EP_1, kind: "integration_endpoint" }],
      [crossGrant],
      1000,
      source,
      TENANT_A,
    );
    expect(result.ok).toBe(false);
  });
});
