/**
 * src/core/__tests__/timer-escalation-mapper.test.ts — T-0458 [D8-R3].
 *
 * Verifies the publish-time timer/escalation wiring:
 *   1. The typed deadline config (choros:timerDeadlineKind + choros:timerDeadline)
 *      materialises a NATIVE <timerEventDefinition> body so Flowable schedules it.
 *   2. choros:escalateTo wires flowable:candidateGroups onto the escalation-target
 *      userTask so the firing projection addresses the right pool.
 *   3. Idempotent / author-wins / no-op invariants hold.
 *   4. The mapper output passes the timer linter (round-trip coherence).
 */

import { describe, it, expect } from "vitest";
import {
  mapTimerEscalation,
  resolveEscalationRole,
  toRecordFieldExpression,
  extractTimerConfigs,
  MANAGER_ROLE_SLUG,
  OWNER_ROLE_SLUG,
} from "../timer-escalation-mapper.js";
import { lintBpmn } from "../bpmn-linter.js";

/**
 * A boundary timer guarding task-approve, escalating to task-escalate, with a typed
 * config but an EMPTY timerEventDefinition (panel state only — body not yet materialised).
 */
function makeConfiguredTimerBpmn(opts?: {
  kind?: string;
  deadline?: string;
  escalateTo?: string;
  emptyBodyStyle?: "paired" | "selfclose";
  withCandidateGroupsOnTarget?: boolean;
}): string {
  const kind = opts?.kind ?? "duration";
  const deadline = opts?.deadline ?? "PT24H";
  const escalateTo = opts?.escalateTo ?? "manager";
  const def =
    opts?.emptyBodyStyle === "selfclose"
      ? `<timerEventDefinition/>`
      : `<timerEventDefinition></timerEventDefinition>`;
  const targetCg = opts?.withCandidateGroupsOnTarget
    ? ` flowable:candidateGroups="role-existing"`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn" xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve" flowable:candidateGroups="role-approver"/>
    <boundaryEvent id="bnd-deadline" attachedToRef="task-approve" cancelActivity="true"
                   choros:timerDeadlineKind="${kind}" choros:timerDeadline="${deadline}" choros:escalateTo="${escalateTo}">
      ${def}
    </boundaryEvent>
    <userTask id="task-escalate"${targetCg}/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="task-approve" targetRef="end"/>
    <sequenceFlow id="sf-timer-esc" sourceRef="bnd-deadline" targetRef="task-escalate"/>
    <sequenceFlow id="f2" sourceRef="task-escalate" targetRef="end"/>
  </process>
</definitions>`;
}

describe("T-0458 — resolveEscalationRole", () => {
  it('maps "manager" → role-manager', () => {
    expect(resolveEscalationRole("manager")).toBe(MANAGER_ROLE_SLUG);
  });
  it('maps "owner" → role-owner', () => {
    expect(resolveEscalationRole("owner")).toBe(OWNER_ROLE_SLUG);
  });
  it("passes a conventional role slug through unchanged", () => {
    expect(resolveEscalationRole("role-approver")).toBe("role-approver");
  });
  it("slugifies a Cyrillic role name", () => {
    expect(resolveEscalationRole("Бухгалтер")).toBe("buhgalter");
  });
  it("returns empty for a blank value", () => {
    expect(resolveEscalationRole("")).toBe("");
    expect(resolveEscalationRole("   ")).toBe("");
  });
});

describe("T-0458 — toRecordFieldExpression", () => {
  it("wraps a bare field key into ${record.field}", () => {
    expect(toRecordFieldExpression("dueDate")).toBe("${record.dueDate}");
  });
  it("strips a leading record. then re-prefixes", () => {
    expect(toRecordFieldExpression("record.dueDate")).toBe("${record.dueDate}");
  });
  it("passes an already-EL expression through", () => {
    expect(toRecordFieldExpression("${record.x}")).toBe("${record.x}");
  });
});

describe("T-0458 — extractTimerConfigs", () => {
  it("reads the typed config off a boundary timer", () => {
    const cfgs = extractTimerConfigs(makeConfiguredTimerBpmn());
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]).toMatchObject({
      id: "bnd-deadline",
      kind: "boundary",
      deadlineKind: "duration",
      deadline: "PT24H",
      escalateTo: "manager",
      hasBody: false,
    });
  });

  it("detects an existing body child (hasBody=true)", () => {
    const xml = `<?xml version="1.0"?>
<definitions targetNamespace="t">
  <process id="p1">
    <boundaryEvent id="bnd" attachedToRef="t1" choros:timerDeadlineKind="duration" choros:timerDeadline="PT1H">
      <timerEventDefinition><timeDuration>PT2H</timeDuration></timerEventDefinition>
    </boundaryEvent>
  </process>
</definitions>`;
    const cfgs = extractTimerConfigs(xml);
    expect(cfgs[0]?.hasBody).toBe(true);
  });
});

describe("T-0458 — mapTimerEscalation: materialise native timer body", () => {
  it("injects <timeDuration> for a duration deadline (paired empty def)", () => {
    const out = mapTimerEscalation(makeConfiguredTimerBpmn({ kind: "duration", deadline: "PT24H" }));
    expect(out).toContain("<timeDuration>PT24H</timeDuration>");
  });

  it("injects <timeDuration> for a duration deadline (self-closing empty def)", () => {
    const out = mapTimerEscalation(
      makeConfiguredTimerBpmn({ kind: "duration", deadline: "PT8H", emptyBodyStyle: "selfclose" }),
    );
    expect(out).toContain("<timeDuration>PT8H</timeDuration>");
    // The self-closing def must have been expanded.
    expect(out).not.toContain("<timerEventDefinition/>");
  });

  it("injects <timeDate> for a fixed-date deadline", () => {
    const out = mapTimerEscalation(
      makeConfiguredTimerBpmn({ kind: "date", deadline: "2026-07-01T14:00:00Z" }),
    );
    expect(out).toContain("<timeDate>2026-07-01T14:00:00Z</timeDate>");
  });

  it("injects an EL <timeDate> for a record-field deadline", () => {
    const out = mapTimerEscalation(
      makeConfiguredTimerBpmn({ kind: "field", deadline: "dueDate" }),
    );
    expect(out).toContain("<timeDate>${record.dueDate}</timeDate>");
  });

  it("does NOT overwrite an existing timer body (author wins, idempotent)", () => {
    const xml = `<?xml version="1.0"?>
<definitions xmlns:choros="http://choros.io/bpmn" xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <userTask id="t1"/>
    <boundaryEvent id="bnd" attachedToRef="t1" choros:timerDeadlineKind="duration" choros:timerDeadline="PT1H" choros:escalateTo="manager">
      <timerEventDefinition><timeDuration>PT99H</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="esc"/>
    <sequenceFlow id="f" sourceRef="bnd" targetRef="esc"/>
  </process>
</definitions>`;
    const out = mapTimerEscalation(xml);
    expect(out).toContain("PT99H");
    expect(out).not.toContain("PT1H</timeDuration>"); // panel value did NOT replace authored body
  });

  it("is a no-op when there are no timer events", () => {
    const xml = `<?xml version="1.0"?>
<definitions targetNamespace="t"><process id="p1"><userTask id="t1"/></process></definitions>`;
    expect(mapTimerEscalation(xml)).toBe(xml);
  });
});

describe("T-0458 — mapTimerEscalation: wire escalation candidateGroups", () => {
  it("stamps flowable:candidateGroups=role-manager on the escalation-target userTask", () => {
    const out = mapTimerEscalation(makeConfiguredTimerBpmn({ escalateTo: "manager" }));
    // The target userTask (task-escalate) is now addressed to the manager pool.
    expect(out).toMatch(/<userTask\b[^>]*\bid="task-escalate"[^>]*flowable:candidateGroups="role-manager"/);
  });

  it("stamps role-owner for escalateTo=owner", () => {
    const out = mapTimerEscalation(makeConfiguredTimerBpmn({ escalateTo: "owner" }));
    expect(out).toMatch(/<userTask\b[^>]*\bid="task-escalate"[^>]*flowable:candidateGroups="role-owner"/);
  });

  it("does NOT overwrite an existing candidateGroups on the target (author/lane wins)", () => {
    const out = mapTimerEscalation(
      makeConfiguredTimerBpmn({ escalateTo: "manager", withCandidateGroupsOnTarget: true }),
    );
    expect(out).toContain('flowable:candidateGroups="role-existing"');
    expect(out).not.toContain('flowable:candidateGroups="role-manager"');
  });
});

describe("T-0458 — round-trip: mapped output passes the timer linter", () => {
  it("a configured-but-empty timer, after mapping, lints clean", () => {
    const raw = makeConfiguredTimerBpmn({ kind: "duration", deadline: "PT24H", escalateTo: "manager" });
    // Before mapping the timer body is empty → linter flags it.
    const before = lintBpmn(raw);
    expect(before.ok).toBe(false);
    // After mapping the native body exists → linter is clean.
    const mapped = mapTimerEscalation(raw);
    const after = lintBpmn(mapped);
    expect(after.ok).toBe(true);
  });
});
