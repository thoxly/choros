/**
 * T-0068 · FF-10 / AC-15: the GuardContext seam is additive — without deps.sod the
 * resolveFor decision is identical to pre-T-0032 (grant-only; no sod_violation),
 * and resolveFor's signature is unchanged (buildLifecycleGuardCtx feeds the
 * existing optional guardCtx param).
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
  resolveFor,
} from "../core/grant-resolver.js";
import { makeHandle, type ObjectHandle, type ResourceRef } from "../core/object-handle.js";
import { buildLifecycleGuardCtx } from "../core/lifecycle-guard.js";

const T = "tenant-A";
const REG = "reg-1";
const REC = "rec-1";

function oracle(): AncestryOracle {
  return {
    isDescendantOrSelf(_h, d, a): boolean {
      if (d === a) return true;
      return d === REC && a === REG;
    },
  };
}

function ref(): ResourceRef {
  return { kind: "record", tenantId: T, registryId: REG, recordId: REC };
}
function handle(): ObjectHandle {
  return makeHandle(ref(), T);
}

function approveGrant(): Grant {
  return {
    tenantId: T,
    id: "g-approve",
    roleId: "role-1",
    resourceType: "record",
    operation: "approve",
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

function deps(over: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    grants: staticGrants([approveGrant()]),
    records: staticRecord({ name: "Alice" }),
    ancestry: oracle(),
    now: () => 1000,
    ...over,
  };
}

describe("buildLifecycleGuardCtx (pure)", () => {
  it("builds a GuardContext, normalizing onBehalfOf and threading approveLevel", () => {
    const ctx = buildLifecycleGuardCtx({
      actor: "e-larina",
      roleAtEvent: "role-1",
      verb: "approve",
      approveLevel: 2,
    });
    expect(ctx.actor).toBe("e-larina");
    expect(ctx.onBehalfOf).toBeNull();
    expect(ctx.verb).toBe("approve");
    expect(ctx.approveLevel).toBe(2);
  });

  it("omits approveLevel when not supplied", () => {
    const ctx = buildLifecycleGuardCtx({ actor: "a", roleAtEvent: "r", verb: "submit" });
    expect(ctx.approveLevel).toBeUndefined();
  });
});

describe("FF-10 / AC-15 — guardCtx additive, no deps.sod → grant-only", () => {
  it("approve with guardCtx but no deps.sod → not sod_violation (pre-T-0032 behavior)", async () => {
    const guardCtx = buildLifecycleGuardCtx({
      actor: "e-larina",
      roleAtEvent: "role-1",
      verb: "approve",
      approveLevel: 1,
    });
    const view = await resolveFor(deps(), handle(), { tenantId: T, subjectId: "u1" }, "approve", undefined, guardCtx);
    // Without deps.sod the SoD branch never runs → decision is grant-only.
    if (view.denied) {
      expect(view.reason).not.toBe("sod_violation");
    } else {
      expect(view.denied).toBe(false);
    }
  });

  it("a covering approve grant resolves (denied:false) with guardCtx, no sod", async () => {
    const guardCtx = buildLifecycleGuardCtx({
      actor: "e-larina",
      roleAtEvent: "role-1",
      verb: "approve",
      approveLevel: 1,
    });
    const view = await resolveFor(deps(), handle(), { tenantId: T, subjectId: "u1" }, "approve", undefined, guardCtx);
    expect(view.denied).toBe(false);
  });
});
