/**
 * src/__tests__/process-catalog-view.test.ts — T-0270
 *
 * Unit tests for the pure catalog view logic (src/core/process-catalog-view.ts).
 * No DB, no I/O — exercises the honesty core: a definition appears ONLY if it has a
 * real source (modeler row or real instance), nothing fabricated, empty→empty.
 */

import { describe, it, expect } from "vitest";
import {
  buildCatalogDefinitions,
  serializeInstance,
  fallbackDefinitionName,
  overlayLiveSteps,
  pickPrimaryLiveNode,
  type LiveActiveNode,
  type ProcessDefRow,
  type ProjectionLike,
} from "../core/process-catalog-view.js";

function def(partial: Partial<ProcessDefRow> & { process_key: string }): ProcessDefRow {
  return {
    name: partial.name ?? partial.process_key,
    version: partial.version ?? 1,
    status: partial.status ?? "draft",
    deployment_id: partial.deployment_id ?? null,
    updated_at: partial.updated_at ?? 0,
    process_key: partial.process_key,
  };
}

function proj(partial: Partial<ProjectionLike> & { inst: string; procKey: string }): ProjectionLike {
  return {
    role: partial.role ?? "role-approver",
    step: partial.step ?? "Согласование",
    status: partial.status ?? "waiting",
    startedAt: partial.startedAt ?? 1000,
    inst: partial.inst,
    procKey: partial.procKey,
  };
}

describe("buildCatalogDefinitions — honesty core", () => {
  it("empty inputs → empty output (graceful-empty, no fabrication)", () => {
    expect(buildCatalogDefinitions([], [])).toEqual([]);
  });

  it("surfaces a modeler definition with its status/version + zero instances", () => {
    const out = buildCatalogDefinitions(
      [def({ process_key: "purchase-approval", name: "Согласование закупки", status: "published", version: 3 })],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      process_key: "purchase-approval",
      name: "Согласование закупки",
      source: "modeler",
      status: "published",
      version: 3,
      instance_count: 0,
    });
  });

  it("surfaces an engine-only key (Flowable-deployed telLinear, no modeler row) from REAL instances", () => {
    const out = buildCatalogDefinitions(
      [],
      [proj({ inst: "flw-1", procKey: "telLinear" }), proj({ inst: "flw-2", procKey: "telLinear" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      process_key: "telLinear",
      // T-0616 [F-2]: no modeler row → the honest fallback is the key itself,
      // not the special-cased case-literal display name.
      name: "telLinear",
      source: "engine",
      status: "deployed",
      version: null,
      instance_count: 2,
    });
  });

  it("a modeler row takes precedence over the engine source for the same key, but keeps the real instance count", () => {
    const out = buildCatalogDefinitions(
      [def({ process_key: "telLinear", name: "Modeler ТЭЛ", status: "draft", version: 1 })],
      [proj({ inst: "flw-1", procKey: "telLinear" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      process_key: "telLinear",
      name: "Modeler ТЭЛ",
      source: "modeler",
      instance_count: 1,
    });
  });

  it("returns a deterministic order sorted by process_key", () => {
    const out = buildCatalogDefinitions(
      [def({ process_key: "zeta" }), def({ process_key: "alpha" })],
      [proj({ inst: "i1", procKey: "mid" })],
    );
    expect(out.map((d) => d.process_key)).toEqual(["alpha", "mid", "zeta"]);
  });
});

describe("serializeInstance", () => {
  it("maps a projection to the catalog instance wire shape", () => {
    const out = serializeInstance(
      proj({ inst: "flw-9", procKey: "telLinear", status: "done", step: "Завершено", role: "role-approver", startedAt: 42 }),
    );
    expect(out).toEqual({
      inst: "flw-9",
      process_key: "telLinear",
      status: "done",
      step: "Завершено",
      role: "role-approver",
      started_at: 42,
    });
  });
});

// ---------------------------------------------------------------------------
// T-0709 [E16/P1]: live-engine step/role overlay — the catalog↔engine sync fix.
//
// NEUTRAL fixtures ONLY (step-next/role-next = the frozen snapshot, step-current/
// role-current = the real live node). The divergence semantics are literal-agnostic
// ("snapshot value ≠ live value" is all that matters), so no D-064 case string
// (role-approver / Согласование / a persona) is used — the overlay logic is proven
// without borrowing a real business case, and this file adds zero anti-case literals.
// ---------------------------------------------------------------------------

const SNAP_STEP = "step-next";       // what the start-time snapshot froze in.
const SNAP_ROLE = "role-next";
const LIVE_STEP = "step-current";    // what the engine token is really on.
const LIVE_ROLE = "role-current";
const PROC = "proc-fixture-1";

function live(partial: Partial<LiveActiveNode> & { step: string; role: string }): LiveActiveNode {
  return {
    step: partial.step,
    role: partial.role,
    ...(partial.concurrentSteps !== undefined ? { concurrentSteps: partial.concurrentSteps } : {}),
  };
}

/** A projection whose snapshot step/role are the (wrong) NEXT node — the bug shape. */
function snapProj(inst: string, over: Partial<ProjectionLike> = {}): ProjectionLike {
  return proj({ inst, procKey: PROC, step: SNAP_STEP, role: SNAP_ROLE, ...over });
}

describe("pickPrimaryLiveNode — reduce engine active-task set to the current node", () => {
  it("no active user-task → null (token between nodes / instance ended)", () => {
    expect(pickPrimaryLiveNode([])).toBeNull();
  });

  it("single active task → step=name, role=candidateGroups[0]", () => {
    const node = pickPrimaryLiveNode([{ name: LIVE_STEP, candidateGroups: [LIVE_ROLE] }]);
    expect(node).toEqual({
      step: LIVE_STEP,
      role: LIVE_ROLE,
      concurrentSteps: [LIVE_STEP],
    });
  });

  it("empty candidateGroups → role '' (neutral, never a borrowed role)", () => {
    const node = pickPrimaryLiveNode([{ name: LIVE_STEP, candidateGroups: [] }]);
    expect(node).toMatchObject({ step: LIVE_STEP, role: "" });
  });

  it("AND-split (multiple active tasks) → primary is first, concurrentSteps deduped", () => {
    const node = pickPrimaryLiveNode([
      { name: "branch-a", candidateGroups: ["role-a"] },
      { name: "branch-b", candidateGroups: ["role-b"] },
      { name: "branch-a", candidateGroups: ["role-a"] },
    ]);
    expect(node).toEqual({
      step: "branch-a",
      role: "role-a",
      concurrentSteps: ["branch-a", "branch-b"],
    });
  });
});

describe("overlayLiveSteps — catalog step/role reflects the REAL active node", () => {
  it("ACCEPTANCE (родитель T-0349): instance whose snapshot froze the NEXT step shows the LIVE first step/role", () => {
    // Snapshot froze the next node (the divergence bug); the engine token is really
    // on the current node — the catalog must report the CURRENT one.
    const projections = [snapProj("flw-1", { status: "waiting" })];
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-1", live({ step: LIVE_STEP, role: LIVE_ROLE })],
    ]);
    const out = overlayLiveSteps(projections, liveByInst);
    expect(out[0]).toMatchObject({ step: LIVE_STEP, role: LIVE_ROLE });
  });

  it("a done instance is never overlaid (kept byte-unchanged)", () => {
    const done = snapProj("flw-done", { step: "Завершено", status: "done" });
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-done", live({ step: LIVE_STEP, role: LIVE_ROLE })],
    ]);
    const out = overlayLiveSteps([done], liveByInst);
    expect(out[0]).toBe(done); // same reference — no overlay, no copy.
  });

  it("no live entry for an instance → honest degrade to the snapshot", () => {
    const p = snapProj("flw-2");
    const out = overlayLiveSteps([p], new Map());
    expect(out[0]).toBe(p); // unchanged reference — never worse than pre-T-0709.
  });

  it("empty live step/role does not blank out the snapshot", () => {
    const p = snapProj("flw-3");
    const liveByInst = new Map<string, LiveActiveNode>([["flw-3", live({ step: "", role: "" })]]);
    const out = overlayLiveSteps([p], liveByInst);
    expect(out[0]).toMatchObject({ step: SNAP_STEP, role: SNAP_ROLE });
  });

  it("live values equal to the snapshot → same reference returned (no needless copy)", () => {
    const p = snapProj("flw-4");
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-4", live({ step: SNAP_STEP, role: SNAP_ROLE })],
    ]);
    const out = overlayLiveSteps([p], liveByInst);
    expect(out[0]).toBe(p);
  });

  it("overlays only the diverged instances in a mixed batch; order preserved", () => {
    const a = snapProj("a");
    const b = proj({ inst: "b", procKey: "other", step: "step-b", role: "role-b" });
    const liveByInst = new Map<string, LiveActiveNode>([
      ["a", live({ step: LIVE_STEP, role: LIVE_ROLE })],
    ]);
    const out = overlayLiveSteps([a, b], liveByInst);
    expect(out.map((p) => p.inst)).toEqual(["a", "b"]);
    expect(out[0]).toMatchObject({ step: LIVE_STEP, role: LIVE_ROLE });
    expect(out[1]).toBe(b); // no live entry → unchanged.
  });

  it("serializeInstance(overlaid) carries the live step/role to the wire (catalog ↔ instance-detail consistency)", () => {
    const p = snapProj("flw-5");
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-5", live({ step: LIVE_STEP, role: LIVE_ROLE })],
    ]);
    const [overlaid] = overlayLiveSteps([p], liveByInst);
    expect(serializeInstance(overlaid!)).toMatchObject({
      inst: "flw-5",
      step: LIVE_STEP,
      role: LIVE_ROLE,
      status: "waiting",
    });
  });
});

describe("fallbackDefinitionName", () => {
  // T-0616 [F-2, D-064 анти-кейс fix]: this used to special-case "telLinear" to
  // the display literal "Канонический линейный ТЭЛ" (a micro-case-hardcode —
  // review T-0614 F-2). Removed: EVERY key, including "telLinear", now echoes
  // back honestly — no key gets a borrowed display name it did not earn from a
  // real choros.process_definition row.
  it("echoes the key back verbatim for ANY unnamed process, no key special-cased", () => {
    expect(fallbackDefinitionName("telLinear")).toBe("telLinear");
    expect(fallbackDefinitionName("some-other")).toBe("some-other");
  });
});
