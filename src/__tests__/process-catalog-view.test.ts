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
  resolveLiveNodesByInstance,
  type CatalogEnginePort,
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

  it("AND-split (multiple active tasks) → primary is deterministic, concurrentSteps deduped, ambiguous flagged", () => {
    const node = pickPrimaryLiveNode([
      { name: "branch-a", candidateGroups: ["role-a"] },
      { name: "branch-b", candidateGroups: ["role-b"] },
      { name: "branch-a", candidateGroups: ["role-a"] },
    ]);
    expect(node).toEqual({
      step: "branch-a",
      role: "role-a",
      concurrentSteps: ["branch-a", "branch-b"],
      // T-0709-R-P1-1: >1 active user-task is surfaced honestly, never silently collapsed.
      ambiguous: true,
    });
  });

  it("single active task is NOT ambiguous (flag absent)", () => {
    const node = pickPrimaryLiveNode([
      { name: LIVE_STEP, candidateGroups: [LIVE_ROLE], taskDefinitionKey: "k1", id: "t1" },
    ]);
    expect(node).toMatchObject({ step: LIVE_STEP, role: LIVE_ROLE });
    expect((node as unknown as Record<string, unknown>).ambiguous).toBeUndefined();
  });

  it("T-0709-R-P1-1: primary is chosen by taskDefinitionKey order, NOT the response-array order", () => {
    // Two orderings of the SAME AND-split with DIFFERENT array positions must yield the
    // SAME primary — proving the pick is a function of the data (intrinsic key), not of
    // arrival order (the undocumented Flowable /runtime/tasks order the review flagged).
    const forward = pickPrimaryLiveNode([
      { name: "Beta", candidateGroups: ["role-b"], taskDefinitionKey: "task-b", id: "t-2" },
      { name: "Alpha", candidateGroups: ["role-a"], taskDefinitionKey: "task-a", id: "t-1" },
    ]);
    const reversed = pickPrimaryLiveNode([
      { name: "Alpha", candidateGroups: ["role-a"], taskDefinitionKey: "task-a", id: "t-1" },
      { name: "Beta", candidateGroups: ["role-b"], taskDefinitionKey: "task-b", id: "t-2" },
    ]);
    // task-a < task-b lexically ⇒ "Alpha" is primary REGARDLESS of array position.
    expect(forward?.step).toBe("Alpha");
    expect(forward?.role).toBe("role-a");
    expect(reversed).toEqual(forward); // byte-identical across the two arrival orders.
    // concurrentSteps is in the SAME deterministic (task-a, task-b) order both ways.
    expect(forward?.concurrentSteps).toEqual(["Alpha", "Beta"]);
    expect(forward?.ambiguous).toBe(true);
  });

  it("ties on taskDefinitionKey break on id (stable), then on name", () => {
    // Same defKey twice → id decides; a plain-string case (no keys) falls back to name.
    const byId = pickPrimaryLiveNode([
      { name: "Z-name", candidateGroups: ["r"], taskDefinitionKey: "same", id: "id-9" },
      { name: "A-name", candidateGroups: ["r"], taskDefinitionKey: "same", id: "id-1" },
    ]);
    expect(byId?.step).toBe("A-name"); // id-1 < id-9.
    const byName = pickPrimaryLiveNode([
      { name: "gamma", candidateGroups: ["r"] },
      { name: "alpha", candidateGroups: ["r"] },
    ]);
    expect(byName?.step).toBe("alpha"); // no keys → name order.
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

// ---------------------------------------------------------------------------
// T-0709-R-P0-1: overlayLiveSteps ALSO overlays concurrentSteps for a projection
// that carries the field (the detail plane's InstanceProjection → `nodes`). The
// catalog's ProjectionLike has no concurrentSteps, so it stays byte-identical — this
// is the single-source-of-truth mechanism that keeps catalog ↔ detail from diverging.
// ---------------------------------------------------------------------------

/** A projection WITH a concurrentSteps field (models InstanceProjection's detail plane). */
interface ProjWithConcurrent extends ProjectionLike {
  readonly concurrentSteps: readonly string[];
}
function concProj(
  inst: string,
  over: Partial<ProjWithConcurrent> = {},
): ProjWithConcurrent {
  return {
    ...proj({ inst, procKey: PROC, step: SNAP_STEP, role: SNAP_ROLE }),
    concurrentSteps: over.concurrentSteps ?? [SNAP_STEP],
    ...over,
  };
}

describe("overlayLiveSteps — detail plane concurrentSteps (nodes) reflect the live AND-split", () => {
  it("overlays concurrentSteps from the live node onto a projection that carries the field", () => {
    const p = concProj("flw-c1", { status: "waiting", concurrentSteps: [SNAP_STEP] });
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-c1", live({ step: "branch-a", role: LIVE_ROLE, concurrentSteps: ["branch-a", "branch-b"] })],
    ]);
    const [out] = overlayLiveSteps([p], liveByInst);
    expect(out).toMatchObject({
      step: "branch-a",
      role: LIVE_ROLE,
      concurrentSteps: ["branch-a", "branch-b"],
    });
  });

  it("catalog ProjectionLike (no concurrentSteps field) is NOT given one by the overlay", () => {
    // Regression: the catalog path must stay byte-identical — no concurrentSteps leaks in.
    const p = snapProj("flw-cat", { status: "waiting" });
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-cat", live({ step: LIVE_STEP, role: LIVE_ROLE, concurrentSteps: ["x", "y"] })],
    ]);
    const [out] = overlayLiveSteps([p], liveByInst);
    expect(out).toMatchObject({ step: LIVE_STEP, role: LIVE_ROLE });
    expect((out as unknown as Record<string, unknown>).concurrentSteps).toBeUndefined();
  });

  it("live node without concurrentSteps leaves the projection's own concurrentSteps intact", () => {
    const p = concProj("flw-c2", { status: "waiting", concurrentSteps: [SNAP_STEP] });
    const liveByInst = new Map<string, LiveActiveNode>([
      ["flw-c2", live({ step: LIVE_STEP, role: LIVE_ROLE })], // no concurrentSteps
    ]);
    const [out] = overlayLiveSteps([p], liveByInst);
    expect(out.step).toBe(LIVE_STEP);
    expect(out.concurrentSteps).toEqual([SNAP_STEP]); // unchanged snapshot list.
  });
});

// ---------------------------------------------------------------------------
// T-0709-R-P0-1 / P2-1: resolveLiveNodesByInstance — the SHARED fan-out both surfaces
// reuse. Proves single-source resolution + honest per-instance degrade + the P2 deadline
// budget (a uniformly-slow engine cannot stall the read past the budget).
// ---------------------------------------------------------------------------

function makeEnginePort(
  byInst: Record<
    string,
    { name: string; candidateGroups: string[]; taskDefinitionKey?: string; id?: string }[] | "error" | "hang"
  >,
): CatalogEnginePort {
  return {
    getActiveUserTasks: async (inst: string) => {
      const entry = byInst[inst];
      if (entry === undefined) return { ok: true as const, tasks: [] };
      if (entry === "error") return { ok: false as const, code: "ENGINE_DOWN" };
      if (entry === "hang") {
        // Never resolves within any reasonable test window — models a slow-but-alive engine.
        await new Promise((r) => setTimeout(r, 60_000));
        return { ok: true as const, tasks: [] };
      }
      return { ok: true as const, tasks: entry };
    },
  };
}

describe("resolveLiveNodesByInstance — shared live-node fan-out", () => {
  it("resolves the primary live node per running instance", async () => {
    const port = makeEnginePort({
      i1: [{ name: LIVE_STEP, candidateGroups: [LIVE_ROLE], taskDefinitionKey: "k", id: "t" }],
    });
    const map = await resolveLiveNodesByInstance(port, ["i1"]);
    expect(map.get("i1")).toMatchObject({ step: LIVE_STEP, role: LIVE_ROLE });
  });

  it("engine error / no-active-task for an instance omits it (caller keeps the snapshot)", async () => {
    const port = makeEnginePort({ i1: "error", i2: [] });
    const map = await resolveLiveNodesByInstance(port, ["i1", "i2", "i3"]);
    expect(map.has("i1")).toBe(false); // engine error → omitted.
    expect(map.has("i2")).toBe(false); // no active task → omitted.
    expect(map.has("i3")).toBe(false); // unseeded → empty tasks → omitted.
  });

  it("a rejecting getActiveUserTasks never throws past the resolver (best-effort)", async () => {
    const port: CatalogEnginePort = {
      getActiveUserTasks: async () => {
        throw new Error("engine exploded");
      },
    };
    const map = await resolveLiveNodesByInstance(port, ["i1"]);
    expect(map.size).toBe(0); // swallowed → empty map, never a throw.
  });

  it("T-0709-R-P2-1: the shared deadline bounds a uniformly-slow engine (degrade to snapshot)", async () => {
    const port = makeEnginePort({ slow: "hang" });
    const t0 = Date.now();
    const map = await resolveLiveNodesByInstance(port, ["slow"], { deadlineMs: 30 });
    const elapsed = Date.now() - t0;
    // The hang would take 60s; the deadline caps it to ~30ms → slow instance omitted.
    expect(map.has("slow")).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("an already-elapsed budget skips the call entirely (zero added latency)", async () => {
    let called = false;
    const port: CatalogEnginePort = {
      getActiveUserTasks: async () => {
        called = true;
        return { ok: true as const, tasks: [] };
      },
    };
    // deadlineMs 0 → the deadline is already at/behind `now`, so no instance is started.
    const map = await resolveLiveNodesByInstance(port, ["i1"], { deadlineMs: 0 });
    expect(map.size).toBe(0);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0709-R-P0-1: SINGLE SOURCE OF TRUTH — the catalog plane (ProjectionLike →
// serializeInstance.step) and the detail plane (a projection WITH concurrentSteps →
// projectionToInstance.node/nodes) both feed the SAME resolveLiveNodesByInstance +
// overlayLiveSteps. Given ONE live task set they MUST compute the SAME primary node.
// This is the code-level guarantee that the two surfaces cannot diverge (the whole
// point of the P0 fix); the HTTP-boundary tests (catalog + processes suites) exercise
// the real handlers, this pins the shared-core invariant directly.
// ---------------------------------------------------------------------------

describe("catalog ↔ detail derive the SAME live node from ONE source (no divergence)", () => {
  it("both planes overlay the identical primary step from the same engine tasks", async () => {
    const inst = "flw-shared";
    const port = makeEnginePort({
      [inst]: [
        { name: "Ветка Б", candidateGroups: ["role-b"], taskDefinitionKey: "task-b", id: "t-2" },
        { name: "Ветка А", candidateGroups: ["role-a"], taskDefinitionKey: "task-a", id: "t-1" },
      ],
    });
    const liveByInst = await resolveLiveNodesByInstance(port, [inst]);

    // Catalog plane: a ProjectionLike (no concurrentSteps) → serializeInstance.
    const catalog = serializeInstance(
      overlayLiveSteps([snapProj(inst, { status: "waiting" })], liveByInst)[0]!,
    );
    // Detail plane: a projection WITH concurrentSteps (models InstanceProjection).
    const detail = overlayLiveSteps([concProj(inst, { status: "waiting" })], liveByInst)[0]!;

    // SAME primary step on both surfaces — the single-source invariant.
    expect(catalog.step).toBe("Ветка А");
    expect(detail.step).toBe("Ветка А");
    expect(catalog.step).toBe(detail.step);
    // The detail plane additionally carries ALL live branches (its `nodes`).
    expect(detail.concurrentSteps).toEqual(["Ветка А", "Ветка Б"]);
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
