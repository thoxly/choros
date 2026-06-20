/**
 * T-0353 [E16] — outcome-branch-resolver.ts unit tests
 *
 * Covers:
 *   1. Preset resolution — each preset produces the correct named branches + target kinds.
 *   2. resolveOutcomeBranch — human-chosen outcome maps to correct {kind, target}.
 *   3. parseOutcomeButtons — tolerant JSON parse (empty on bad input).
 *   4. buildProcessOutcomeDef — assembles correctly.
 *   5. Outcome ≠ DMN guard: resolver only processes outcome-named flows, not conditions.
 *   6. Custom preset with subprocess-sync / process-async targets.
 *   7. "На доработку" back route resolves to kind='back'.
 *   8. Unmatched outcome name returns target=null.
 */

import { describe, it, expect } from "vitest";
import {
  resolveOutcomeBranch,
  parseOutcomeButtons,
  buildProcessOutcomeDef,
  type OutcomeButtonDef,
  type OutcomeFlowDef,
  type ProcessOutcomeDef,
} from "../../src/core/outcome-branch-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(outcomeName: string | null, targetRef: string, flowId?: string): OutcomeFlowDef {
  return { flowId: flowId ?? `flow-${outcomeName ?? "default"}`, outcomeName, targetRef };
}

function makeButton(name: string, targetKind: OutcomeButtonDef["targetKind"], opts?: Partial<OutcomeButtonDef>): OutcomeButtonDef {
  return { name, targetKind, ...opts };
}

function makeDef(
  taskId: string,
  buttons: OutcomeButtonDef[],
  flows: OutcomeFlowDef[],
  presetId?: string,
): ProcessOutcomeDef {
  return { taskId, presetId, buttons, flows };
}

// ---------------------------------------------------------------------------
// 1. Preset "Готово" (done) — one outcome, next
// ---------------------------------------------------------------------------

describe("resolveOutcomeBranch — preset 'Готово' (done)", () => {
  const flows = [makeFlow("Готово", "EndEvent_1")];
  const buttons = [makeButton("Готово", "next")];
  const def = makeDef("Task_1", buttons, flows, "done");

  it("resolves Готово → kind:next, target:EndEvent_1", () => {
    const r = resolveOutcomeBranch(def, "Task_1", "Готово");
    expect(r.kind).toBe("next");
    expect(r.target).toBe("EndEvent_1");
    expect(r.button?.name).toBe("Готово");
    expect(r.flow?.outcomeName).toBe("Готово");
  });
});

// ---------------------------------------------------------------------------
// 2. Preset "Решение" (decision) — two outcomes, next + end
// ---------------------------------------------------------------------------

describe("resolveOutcomeBranch — preset 'Решение' (decision)", () => {
  const flows = [
    makeFlow("Согласовать", "Task_Next"),
    makeFlow("Отклонить", "EndEvent_Reject"),
  ];
  const buttons = [
    makeButton("Согласовать", "next", { color: "success" }),
    makeButton("Отклонить",   "end",  { color: "danger" }),
  ];
  const def = makeDef("Task_Approve", buttons, flows, "decision");

  it("Согласовать → kind:next, target:Task_Next", () => {
    const r = resolveOutcomeBranch(def, "Task_Approve", "Согласовать");
    expect(r.kind).toBe("next");
    expect(r.target).toBe("Task_Next");
    expect(r.button?.color).toBe("success");
  });

  it("Отклонить → kind:end, target:EndEvent_Reject", () => {
    const r = resolveOutcomeBranch(def, "Task_Approve", "Отклонить");
    expect(r.kind).toBe("end");
    expect(r.target).toBe("EndEvent_Reject");
    expect(r.button?.color).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// 3. Preset "Решение с доработкой" — three outcomes, back route
// ---------------------------------------------------------------------------

describe("resolveOutcomeBranch — preset 'Решение с доработкой'", () => {
  const flows = [
    makeFlow("Согласовать",  "Task_Payment"),
    makeFlow("Отклонить",    "EndEvent_1"),
    makeFlow("На доработку", "Task_Revision"),
  ];
  const buttons = [
    makeButton("Согласовать",  "next",    { color: "success" }),
    makeButton("Отклонить",    "end",     { color: "danger" }),
    makeButton("На доработку", "back",    { color: "warning" }),
  ];
  const def = makeDef("Task_Decision", buttons, flows, "decision-rework");

  it("Согласовать → kind:next", () => {
    const r = resolveOutcomeBranch(def, "Task_Decision", "Согласовать");
    expect(r.kind).toBe("next");
    expect(r.target).toBe("Task_Payment");
  });

  it("Отклонить → kind:end", () => {
    const r = resolveOutcomeBranch(def, "Task_Decision", "Отклонить");
    expect(r.kind).toBe("end");
    expect(r.target).toBe("EndEvent_1");
  });

  it("На доработку → kind:back, target:Task_Revision (structural back flow)", () => {
    const r = resolveOutcomeBranch(def, "Task_Decision", "На доработку");
    expect(r.kind).toBe("back");
    expect(r.target).toBe("Task_Revision");
    expect(r.button?.targetKind).toBe("back");
  });

  it("На доработку with explicit back target override", () => {
    // When the button config carries an explicit target (e.g. "Task_FillForm"),
    // that overrides the structural flow targetRef.
    const overrideDef = makeDef("Task_Decision", [
      ...buttons.slice(0, 2),
      makeButton("На доработку", "back", { color: "warning", target: "Task_FillForm" } as OutcomeButtonDef),
    ], flows, "decision-rework");
    const r = resolveOutcomeBranch(overrideDef, "Task_Decision", "На доработку");
    expect(r.kind).toBe("back");
    // explicit button.target wins over flow.targetRef
    expect(r.target).toBe("Task_FillForm");
  });
});

// ---------------------------------------------------------------------------
// 4. subprocess-sync and process-async targets
// ---------------------------------------------------------------------------

describe("resolveOutcomeBranch — subprocess / process-async targets", () => {
  it("subprocess-sync uses button.target over flow.targetRef", () => {
    const flows = [makeFlow("Запустить проверку", "SubProcess_KYC")];
    const buttons = [
      makeButton("Запустить проверку", "subprocess-sync", { target: "SubProcess_KYC_explicit" }),
    ];
    const def = makeDef("Task_Trigger", buttons, flows);
    const r = resolveOutcomeBranch(def, "Task_Trigger", "Запустить проверку");
    expect(r.kind).toBe("subprocess-sync");
    expect(r.target).toBe("SubProcess_KYC_explicit");
  });

  it("subprocess-sync falls back to flow.targetRef when button.target absent", () => {
    const flows = [makeFlow("Запустить проверку", "SubProcess_KYC")];
    const buttons = [makeButton("Запустить проверку", "subprocess-sync")];
    const def = makeDef("Task_Trigger", buttons, flows);
    const r = resolveOutcomeBranch(def, "Task_Trigger", "Запустить проверку");
    expect(r.kind).toBe("subprocess-sync");
    expect(r.target).toBe("SubProcess_KYC");
  });

  it("process-async uses button.target (process key)", () => {
    const flows = [makeFlow("Уведомить CRM", "EndEvent_1")];
    const buttons = [
      makeButton("Уведомить CRM", "process-async", { target: "crm-notify-process" }),
    ];
    const def = makeDef("Task_Trigger", buttons, flows);
    const r = resolveOutcomeBranch(def, "Task_Trigger", "Уведомить CRM");
    expect(r.kind).toBe("process-async");
    expect(r.target).toBe("crm-notify-process");
  });
});

// ---------------------------------------------------------------------------
// 5. Unmatched outcome name → target null, kind defaults to 'next'
// ---------------------------------------------------------------------------

describe("resolveOutcomeBranch — unmatched outcome", () => {
  it("returns target:null when no flow or button matches", () => {
    const flows: OutcomeFlowDef[] = [];
    const buttons: OutcomeButtonDef[] = [];
    const def = makeDef("Task_1", buttons, flows);
    const r = resolveOutcomeBranch(def, "Task_1", "Несуществующий исход");
    expect(r.target).toBeNull();
    expect(r.kind).toBe("next");    // default when no button config
    expect(r.button).toBeNull();
    expect(r.flow).toBeNull();
  });

  it("returns target:null even when button exists but flow is absent", () => {
    const buttons = [makeButton("Согласовать", "next")];
    const def = makeDef("Task_1", buttons, []);
    const r = resolveOutcomeBranch(def, "Task_1", "Согласовать");
    expect(r.kind).toBe("next");
    expect(r.target).toBeNull();    // no flow to route along
    expect(r.button?.name).toBe("Согласовать");
  });
});

// ---------------------------------------------------------------------------
// 6. Legacy task (no buttons config) — flow-only fallback
// ---------------------------------------------------------------------------

describe("resolveOutcomeBranch — legacy task (no buttons)", () => {
  it("falls back to kind:next using flow.targetRef", () => {
    const flows = [makeFlow("Готово", "Task_NextStep")];
    const def = makeDef("LegacyTask", [], flows);
    const r = resolveOutcomeBranch(def, "LegacyTask", "Готово");
    expect(r.kind).toBe("next");
    expect(r.target).toBe("Task_NextStep");
    expect(r.button).toBeNull();
    expect(r.flow?.outcomeName).toBe("Готово");
  });
});

// ---------------------------------------------------------------------------
// 7. Outcome ≠ DMN: flows without outcomeName are unconditional (ignored here)
// ---------------------------------------------------------------------------

describe("outcome ≠ DMN guard", () => {
  it("flows with null outcomeName are not matched by outcome name lookup", () => {
    // This is what a DMN-controlled or unconditional flow looks like.
    // The resolver MUST NOT pick it up by accident.
    const flows = [
      makeFlow(null, "Task_DMNBranch"),     // unconditional / DMN-controlled — no outcome name
      makeFlow("Согласовать", "Task_Next"), // named-branch outcome
    ];
    const buttons = [makeButton("Согласовать", "next")];
    const def = makeDef("Task_Mixed", buttons, flows);

    const r = resolveOutcomeBranch(def, "Task_Mixed", "Согласовать");
    expect(r.target).toBe("Task_Next");  // picks the named-branch flow, not the DMN flow
  });

  it("resolving an outcome when only DMN (null-named) flows exist returns target:null", () => {
    const flows = [makeFlow(null, "Task_DMNBranch")];
    const buttons = [makeButton("Согласовать", "next")];
    const def = makeDef("Task_Mixed", buttons, flows);

    const r = resolveOutcomeBranch(def, "Task_Mixed", "Согласовать");
    expect(r.target).toBeNull(); // no outcome-named flow found
  });
});

// ---------------------------------------------------------------------------
// 8. parseOutcomeButtons — tolerant JSON parse
// ---------------------------------------------------------------------------

describe("parseOutcomeButtons", () => {
  it("returns empty array for null/undefined", () => {
    expect(parseOutcomeButtons(null)).toEqual([]);
    expect(parseOutcomeButtons(undefined)).toEqual([]);
    expect(parseOutcomeButtons("")).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseOutcomeButtons("{not valid json")).toEqual([]);
  });

  it("returns empty array when parsed value is not an array", () => {
    expect(parseOutcomeButtons('{"name":"x"}')).toEqual([]);
  });

  it("parses a valid buttons JSON correctly", () => {
    const json = JSON.stringify([
      { name: "Согласовать", targetKind: "next", color: "success" },
      { name: "Отклонить",   targetKind: "end",  color: "danger", requiresComment: true },
    ]);
    const buttons = parseOutcomeButtons(json);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].name).toBe("Согласовать");
    expect(buttons[0].targetKind).toBe("next");
    expect(buttons[1].requiresComment).toBe(true);
  });

  it("filters out entries without name or targetKind", () => {
    const json = JSON.stringify([
      { name: "Согласовать", targetKind: "next" },
      { name: "Bad" },            // missing targetKind → filtered
      { targetKind: "end" },      // missing name → filtered
      null,                        // null → filtered
    ]);
    const buttons = parseOutcomeButtons(json);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].name).toBe("Согласовать");
  });
});

// ---------------------------------------------------------------------------
// 9. buildProcessOutcomeDef — assembles correctly
// ---------------------------------------------------------------------------

describe("buildProcessOutcomeDef", () => {
  it("assembles a ProcessOutcomeDef from components", () => {
    const buttonsJson = JSON.stringify([
      { name: "Готово", targetKind: "next", color: "primary" },
    ]);
    const flows = [{ flowId: "f1", outcomeName: "Готово", targetRef: "End_1" }];
    const def = buildProcessOutcomeDef("Task_1", "done", buttonsJson, flows);
    expect(def.taskId).toBe("Task_1");
    expect(def.presetId).toBe("done");
    expect(def.buttons).toHaveLength(1);
    expect(def.buttons[0].name).toBe("Готово");
    expect(def.flows).toHaveLength(1);
    expect(def.flows[0].outcomeName).toBe("Готово");
  });

  it("handles missing buttonsJson gracefully", () => {
    const def = buildProcessOutcomeDef("Task_X", undefined, null, []);
    expect(def.buttons).toEqual([]);
    expect(def.presetId).toBeUndefined();
  });
});
