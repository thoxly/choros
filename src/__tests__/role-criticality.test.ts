/**
 * FF-RC7 — behavioural fitness + unit tests for T-0040 `role_criticality`
 * (E4.5). One+ assertion per AC-1..AC-14, including the adversarial cases from
 * the spec/ADR: empty grants ⇒ all axes false; an ineffective grant counts for
 * nothing; the threshold boundary (`class` exactly `confidential` vs below).
 *
 * AC-1  approve grant ⇒ approve_or_transition
 * AC-2  transition grant ⇒ approve_or_transition
 * AC-3  only read/create/update/delete ⇒ approve_or_transition false
 * AC-4  effect_resource ∧ invoke ⇒ external_invoke
 * AC-5  non-effect invoke ⇒ external_invoke false
 * AC-6  effect_resource non-invoke ⇒ external_invoke false
 * AC-7  read clearance confidential/restricted ⇒ sensitive_read
 * AC-8  read clearance public/internal/none ⇒ sensitive_read false (carveout)
 * AC-9  confidential clearance on a NON-read op ⇒ sensitive_read false
 * AC-10 level critical iff any bit; routine iff all false
 * AC-11 effective-window honored (out-of-window contributes zero; in-window flips)
 * AC-12 criticalityDiff expansion/escalates; narrowing/cosmetic ⇒ no escalate
 * AC-13 fail-closed unknown operation never lowers a bit
 * AC-14 determinism/purity (combineCriticality + roleCriticality, no extra IO)
 *
 * All functions under test are pure except `roleCriticality`, whose only IO is
 * the injected in-memory RoleGrantSource. No Postgres.
 */
import { describe, it, expect } from "vitest";
import {
  type RoleCriticality,
  type RoleGrantSource,
  SENSITIVE_READ_THRESHOLD,
  combineCriticality,
  roleCriticality,
  criticalityLevel,
  criticalityDiff,
} from "../core/role-criticality.js";
import {
  type Grant,
  type Operation,
  type ResourceType,
  type GrantScope,
} from "../core/grant-lattice.js";
import { type DataClass } from "../core/data-classification.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ROLE = "role-11111111-1111-1111-1111-111111111111";
const NOW = 1_700_000_000_000;

const WHOLE_SCOPE: GrantScope = { kind: "set", members: [] };

let grantSeq = 0;

/** Build a Grant with sane defaults; override per test. */
function makeGrant(over: Partial<Grant> = {}): Grant {
  grantSeq += 1;
  return {
    tenantId: TENANT,
    id: `grant-${grantSeq}`,
    roleId: ROLE,
    resourceType: "record" as ResourceType,
    operation: "read" as Operation,
    scope: WHOLE_SCOPE,
    delegable: false,
    grantedBy: "owner",
    createdAt: 0,
    ...over,
  };
}

/** A read grant carrying a clearance marker on its constraint surface. */
function readGrantWithClearance(
  clearance: DataClass | undefined,
  over: Partial<Grant> = {},
): Grant {
  return makeGrant({
    operation: "read",
    constraint: clearance === undefined ? undefined : { clearance },
    ...over,
  });
}

/** A deterministic in-memory RoleGrantSource for the async seam (AC-14). */
function makeSource(grants: Grant[]): RoleGrantSource {
  return {
    async getRoleGrants(tenantId: string, roleId: string): Promise<Grant[]> {
      if (tenantId !== TENANT || roleId !== ROLE) return [];
      return grants;
    },
  };
}

// ---------------------------------------------------------------------------
// axis a — approve_or_transition (AC-1, AC-2, AC-3)
// ---------------------------------------------------------------------------

describe("FF-RC7 axis a — approve_or_transition", () => {
  it("AC-1: an effective approve grant sets approve_or_transition", () => {
    const c = combineCriticality([makeGrant({ operation: "approve" })], NOW);
    expect(c.approve_or_transition).toBe(true);
  });

  it("AC-2: an effective transition grant sets approve_or_transition", () => {
    const c = combineCriticality([makeGrant({ operation: "transition" })], NOW);
    expect(c.approve_or_transition).toBe(true);
  });

  it("AC-3: only read/create/update/delete grants ⇒ approve_or_transition false", () => {
    const ops: Operation[] = ["read", "create", "update", "delete"];
    const c = combineCriticality(
      ops.map((operation) => makeGrant({ operation })),
      NOW,
    );
    expect(c.approve_or_transition).toBe(false);
    expect(c.level).toBe("routine");
  });
});

// ---------------------------------------------------------------------------
// axis b — external_invoke (AC-4, AC-5, AC-6)
// ---------------------------------------------------------------------------

describe("FF-RC7 axis b — external_invoke", () => {
  it("AC-4: effect_resource ∧ invoke ⇒ external_invoke", () => {
    const c = combineCriticality(
      [makeGrant({ resourceType: "effect_resource", operation: "invoke" })],
      NOW,
    );
    expect(c.external_invoke).toBe(true);
  });

  it("AC-5: invoke on a NON-effect resource ⇒ external_invoke false", () => {
    const c = combineCriticality(
      [makeGrant({ resourceType: "record", operation: "invoke" })],
      NOW,
    );
    expect(c.external_invoke).toBe(false);
  });

  it("AC-6: effect_resource with a NON-invoke op ⇒ external_invoke false", () => {
    const c = combineCriticality(
      [makeGrant({ resourceType: "effect_resource", operation: "read" })],
      NOW,
    );
    expect(c.external_invoke).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// axis c — sensitive_read + threshold carveout (AC-7, AC-8, AC-9)
// ---------------------------------------------------------------------------

describe("FF-RC7 axis c — sensitive_read (threshold carveout)", () => {
  it("AC-7: a read grant conferring 'confidential' sets sensitive_read", () => {
    const c = combineCriticality([readGrantWithClearance("confidential")], NOW);
    expect(c.sensitive_read).toBe(true);
  });

  it("AC-7: a read grant conferring 'restricted' (above threshold) also sets it", () => {
    const c = combineCriticality([readGrantWithClearance("restricted")], NOW);
    expect(c.sensitive_read).toBe(true);
  });

  it("AC-8: 'internal'/'public'/no-marker read grants ⇒ sensitive_read false", () => {
    expect(
      combineCriticality([readGrantWithClearance("internal")], NOW)
        .sensitive_read,
    ).toBe(false);
    expect(
      combineCriticality([readGrantWithClearance("public")], NOW).sensitive_read,
    ).toBe(false);
    expect(
      combineCriticality([readGrantWithClearance(undefined)], NOW)
        .sensitive_read,
    ).toBe(false);
  });

  it("AC-8 (boundary): class EXACTLY at SENSITIVE_READ_THRESHOLD raises; the step below does not", () => {
    // The threshold is 'confidential'; 'internal' is exactly one step below.
    expect(SENSITIVE_READ_THRESHOLD).toBe("confidential");
    expect(
      combineCriticality(
        [readGrantWithClearance(SENSITIVE_READ_THRESHOLD)],
        NOW,
      ).sensitive_read,
    ).toBe(true);
    expect(
      combineCriticality([readGrantWithClearance("internal")], NOW)
        .sensitive_read,
    ).toBe(false);
  });

  it("AC-9: a 'confidential' clearance on a NON-read op (approve) ⇒ sensitive_read false", () => {
    // The clearance marker rides an approve grant, not a read grant.
    const g = readGrantWithClearance("confidential", { operation: "approve" });
    const c = combineCriticality([g], NOW);
    expect(c.sensitive_read).toBe(false);
    // (it DOES, however, set approve_or_transition — the marker doesn't change that)
    expect(c.approve_or_transition).toBe(true);
  });

  it("AC-9: a confidential read grant alongside the approve grant DOES set the bit", () => {
    const c = combineCriticality(
      [
        readGrantWithClearance("confidential", { operation: "approve" }),
        readGrantWithClearance("confidential", { operation: "read" }),
      ],
      NOW,
    );
    expect(c.sensitive_read).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// level (AC-10) + empty-grants adversarial
// ---------------------------------------------------------------------------

describe("FF-RC7 level + carveout", () => {
  it("AC-10: criticalityLevel is 'critical' iff any bit true, else 'routine'", () => {
    expect(
      criticalityLevel({
        approve_or_transition: false,
        external_invoke: false,
        sensitive_read: false,
      }),
    ).toBe("routine");
    for (const bit of [
      "approve_or_transition",
      "external_invoke",
      "sensitive_read",
    ] as const) {
      const base = {
        approve_or_transition: false,
        external_invoke: false,
        sensitive_read: false,
      };
      expect(criticalityLevel({ ...base, [bit]: true })).toBe("critical");
    }
  });

  it("adversarial: an EMPTY grant set ⇒ all axes false, level routine", () => {
    const c = combineCriticality([], NOW);
    expect(c).toStrictEqual<RoleCriticality>({
      approve_or_transition: false,
      external_invoke: false,
      sensitive_read: false,
      level: "routine",
    });
  });

  it("level wiring: combineCriticality sets level consistently with its bits", () => {
    const c = combineCriticality([makeGrant({ operation: "approve" })], NOW);
    expect(c.level).toBe("critical");
    expect(c.level).toBe(criticalityLevel(c));
  });
});

// ---------------------------------------------------------------------------
// effective-window (AC-11)
// ---------------------------------------------------------------------------

describe("FF-RC7 effective-window (AC-11)", () => {
  it("AC-11: an out-of-window approve grant contributes ZERO; in-window flips the bit", () => {
    // validUntil in the past ⇒ ineffective at NOW.
    const expired = makeGrant({
      operation: "approve",
      validFrom: NOW - 10_000,
      validUntil: NOW - 1,
    });
    expect(combineCriticality([expired], NOW).approve_or_transition).toBe(false);

    // The SAME grant, in-window, flips the bit.
    const live = makeGrant({
      operation: "approve",
      validFrom: NOW - 10_000,
      validUntil: NOW + 10_000,
    });
    expect(combineCriticality([live], NOW).approve_or_transition).toBe(true);
  });

  it("AC-11: an out-of-window effect-invoke and read-clearance grant contribute zero", () => {
    const expiredInvoke = makeGrant({
      resourceType: "effect_resource",
      operation: "invoke",
      validUntil: NOW - 1,
    });
    const expiredRead = readGrantWithClearance("restricted", {
      validUntil: NOW - 1,
    });
    const c = combineCriticality([expiredInvoke, expiredRead], NOW);
    expect(c.external_invoke).toBe(false);
    expect(c.sensitive_read).toBe(false);
    expect(c.level).toBe("routine");
  });

  it("AC-11: a not-yet-valid grant (validFrom in the future) contributes zero", () => {
    const future = makeGrant({ operation: "transition", validFrom: NOW + 1 });
    expect(combineCriticality([future], NOW).approve_or_transition).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// criticalityDiff (AC-12)
// ---------------------------------------------------------------------------

describe("FF-RC7 criticalityDiff (AC-12)", () => {
  const routine: RoleCriticality = {
    approve_or_transition: false,
    external_invoke: false,
    sensitive_read: false,
    level: "routine",
  };
  const criticalA: RoleCriticality = {
    approve_or_transition: true,
    external_invoke: false,
    sensitive_read: false,
    level: "critical",
  };

  it("AC-12: false→true on a bit sets expanded.<bit> and escalates routine→critical", () => {
    const d = criticalityDiff(routine, criticalA);
    expect(d.expanded.approve_or_transition).toBe(true);
    expect(d.expanded.external_invoke).toBe(false);
    expect(d.expanded.sensitive_read).toBe(false);
    expect(d.escalates).toBe(true);
  });

  it("AC-12: a true→false NARROWING does not expand and does not escalate", () => {
    const d = criticalityDiff(criticalA, routine);
    expect(d.expanded.approve_or_transition).toBe(false);
    expect(d.escalates).toBe(false);
  });

  it("AC-12: cosmetic same-state (false→false, true→true) ⇒ no expansion, no escalate", () => {
    expect(criticalityDiff(routine, routine)).toStrictEqual({
      expanded: {
        approve_or_transition: false,
        external_invoke: false,
        sensitive_read: false,
      },
      escalates: false,
    });
    expect(criticalityDiff(criticalA, criticalA).escalates).toBe(false);
  });

  it("AC-12: a critical→critical state that adds a NEW bit expands that bit but does not escalate", () => {
    const criticalAB: RoleCriticality = {
      approve_or_transition: true,
      external_invoke: true,
      sensitive_read: false,
      level: "critical",
    };
    const d = criticalityDiff(criticalA, criticalAB);
    expect(d.expanded.external_invoke).toBe(true);
    // already critical → not a routine→critical escalation
    expect(d.escalates).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fail-closed unknown operation (AC-13)
// ---------------------------------------------------------------------------

describe("FF-RC7 fail-closed unknown operation (AC-13)", () => {
  it("AC-13: a grant with an out-of-vocabulary operation never CLEARS a real bit", () => {
    // A genuine approve grant sets the bit; a sibling grant with a corrupt op
    // (cast through unknown) must not lower it.
    const corrupt = makeGrant({
      operation: "frobnicate" as unknown as Operation,
    });
    const real = makeGrant({ operation: "approve" });
    const c = combineCriticality([corrupt, real], NOW);
    expect(c.approve_or_transition).toBe(true);
    // The corrupt op alone raises nothing (it can only ever fail to raise).
    const alone = combineCriticality([corrupt], NOW);
    expect(alone.approve_or_transition).toBe(false);
    expect(alone.external_invoke).toBe(false);
    expect(alone.sensitive_read).toBe(false);
    expect(alone.level).toBe("routine");
  });
});

// ---------------------------------------------------------------------------
// determinism / purity + the async port seam (AC-14)
// ---------------------------------------------------------------------------

describe("FF-RC7 determinism / purity (AC-14)", () => {
  it("AC-14: combineCriticality is deterministic — identical inputs ⇒ deep-equal output", () => {
    const grants = [
      makeGrant({ operation: "approve" }),
      makeGrant({ resourceType: "effect_resource", operation: "invoke" }),
      readGrantWithClearance("restricted"),
    ];
    const a = combineCriticality(grants, NOW);
    const b = combineCriticality(grants, NOW);
    expect(a).toStrictEqual(b);
    expect(a).toStrictEqual<RoleCriticality>({
      approve_or_transition: true,
      external_invoke: true,
      sensitive_read: true,
      level: "critical",
    });
  });

  it("AC-14: roleCriticality fetches via the port then combines — deterministic across calls", async () => {
    const grants = [readGrantWithClearance("confidential")];
    const src = makeSource(grants);
    const a = await roleCriticality(src, TENANT, ROLE, NOW);
    const b = await roleCriticality(src, TENANT, ROLE, NOW);
    expect(a).toStrictEqual(b);
    expect(a.sensitive_read).toBe(true);
    expect(a.level).toBe("critical");
  });

  it("AC-14: roleCriticality is the only IO seam — combine over the port's grants equals combineCriticality", async () => {
    const grants = [makeGrant({ operation: "transition" })];
    const src = makeSource(grants);
    const viaPort = await roleCriticality(src, TENANT, ROLE, NOW);
    const direct = combineCriticality(grants, NOW);
    expect(viaPort).toStrictEqual(direct);
  });
});
