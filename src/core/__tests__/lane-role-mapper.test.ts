/**
 * Unit tests for src/core/lane-role-mapper.ts — T-0457 [D8-R2].
 *
 * Spec: docs/specs/process-element-runtime.spec.md §3.3 (R2 dorozhka→role).
 *
 * Contract under test:
 *   - extractLaneRoleBindings: read <laneSet>/<lane>/<flowNodeRef> → role slug.
 *   - slugifyLaneRole: lane name (Cyrillic-aware) → role pool slug.
 *   - mapLanesToCandidateGroups: inject flowable:candidateGroups onto the
 *     userTasks inside a lane; idempotent; explicit roles preserved; no-op
 *     when there are no lanes.
 *
 * The resulting candidateGroups value is what executor-resolver.ts consumes as
 * `roleSlug` (executor-resolver.test.ts) — these tests assert the authoring→model
 * half of that contract.
 */

import { describe, it, expect } from "vitest";
import {
  slugifyLaneRole,
  extractLaneRoleBindings,
  mapLanesToCandidateGroups,
} from "../lane-role-mapper.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A process with one lane «Бухгалтер» containing one userTask. */
const ONE_LANE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             id="Definitions_1" targetNamespace="http://choros.io/bpmn">
  <process id="Process_1" isExecutable="true">
    <laneSet id="LaneSet_1">
      <lane id="Lane_buh" name="Бухгалтер">
        <flowNodeRef>Activity_approve</flowNodeRef>
      </lane>
    </laneSet>
    <startEvent id="StartEvent_1"/>
    <userTask id="Activity_approve" name="Согласовать счёт"/>
    <endEvent id="EndEvent_1"/>
  </process>
</definitions>`;

/** Two lanes, each with a userTask; one userTask already has an explicit role. */
const TWO_LANES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             id="Definitions_2" targetNamespace="http://choros.io/bpmn">
  <process id="Process_2" isExecutable="true">
    <laneSet id="LaneSet_2">
      <lane id="Lane_buh" name="Бухгалтер">
        <flowNodeRef>Task_buh</flowNodeRef>
      </lane>
      <lane id="Lane_dir" name="Директор">
        <flowNodeRef>Task_dir</flowNodeRef>
      </lane>
    </laneSet>
    <userTask id="Task_buh" name="Проверить счёт"/>
    <userTask id="Task_dir" name="Утвердить" flowable:candidateGroups="role-director-fixed"/>
  </process>
</definitions>`;

/** No lanes at all — the mapper must return the document unchanged. */
const NO_LANE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             id="Definitions_3" targetNamespace="http://choros.io/bpmn">
  <process id="Process_3" isExecutable="true">
    <userTask id="Task_a" name="Шаг A"/>
  </process>
</definitions>`;

// ---------------------------------------------------------------------------
// slugifyLaneRole
// ---------------------------------------------------------------------------

describe("slugifyLaneRole", () => {
  it("transliterates a Cyrillic lane name to a latin slug", () => {
    expect(slugifyLaneRole("Бухгалтер")).toBe("buhgalter");
  });

  it("lowercases and dashes a multi-word latin name", () => {
    expect(slugifyLaneRole("Finance Team")).toBe("finance-team");
  });

  it("collapses repeated separators and trims edge dashes", () => {
    expect(slugifyLaneRole("  Отдел   продаж  ")).toBe("otdel-prodazh");
  });

  it("returns empty string for a blank / whitespace-only name", () => {
    expect(slugifyLaneRole("")).toBe("");
    expect(slugifyLaneRole("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractLaneRoleBindings
// ---------------------------------------------------------------------------

describe("extractLaneRoleBindings", () => {
  it("extracts a single lane → userTask binding with the slugified role", () => {
    const bindings = extractLaneRoleBindings(ONE_LANE_XML);
    expect(bindings).toEqual([
      { flowNodeId: "Activity_approve", laneName: "Бухгалтер", roleSlug: "buhgalter" },
    ]);
  });

  it("extracts one binding per lane across multiple lanes", () => {
    const bindings = extractLaneRoleBindings(TWO_LANES_XML);
    expect(bindings).toEqual([
      { flowNodeId: "Task_buh", laneName: "Бухгалтер", roleSlug: "buhgalter" },
      { flowNodeId: "Task_dir", laneName: "Директор", roleSlug: "direktor" },
    ]);
  });

  it("returns no bindings when there are no lanes", () => {
    expect(extractLaneRoleBindings(NO_LANE_XML)).toEqual([]);
  });

  it("skips lanes with a blank name (no role intent)", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <process id="P">
        <laneSet id="LS">
          <lane id="L1" name="">
            <flowNodeRef>T1</flowNodeRef>
          </lane>
        </laneSet>
        <userTask id="T1"/>
      </process>
    </definitions>`;
    expect(extractLaneRoleBindings(xml)).toEqual([]);
  });

  it("keeps the FIRST lane when a node is (malformed) in two lanes", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <process id="P">
        <laneSet id="LS">
          <lane id="L1" name="Первая">
            <flowNodeRef>T1</flowNodeRef>
          </lane>
          <lane id="L2" name="Вторая">
            <flowNodeRef>T1</flowNodeRef>
          </lane>
        </laneSet>
        <userTask id="T1"/>
      </process>
    </definitions>`;
    const bindings = extractLaneRoleBindings(xml);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ flowNodeId: "T1", roleSlug: "pervaya" });
  });
});

// ---------------------------------------------------------------------------
// mapLanesToCandidateGroups
// ---------------------------------------------------------------------------

describe("mapLanesToCandidateGroups", () => {
  it("injects candidateGroups onto a userTask inside a named lane", () => {
    const out = mapLanesToCandidateGroups(ONE_LANE_XML);
    expect(out).toContain(
      'id="Activity_approve"',
    );
    // The userTask now carries the lane-derived role pool.
    expect(out).toMatch(
      /<userTask\b[^>]*id="Activity_approve"[^>]*flowable:candidateGroups="buhgalter"/,
    );
  });

  it("does not touch a userTask that already declares candidateGroups", () => {
    const out = mapLanesToCandidateGroups(TWO_LANES_XML);
    // Task_buh (no role) gets the lane role…
    expect(out).toMatch(
      /<userTask\b[^>]*id="Task_buh"[^>]*flowable:candidateGroups="buhgalter"/,
    );
    // …Task_dir keeps its explicit role and is NOT overwritten with "direktor".
    expect(out).toContain('flowable:candidateGroups="role-director-fixed"');
    expect(out).not.toContain('flowable:candidateGroups="direktor"');
  });

  it("returns the document unchanged when there are no lanes", () => {
    expect(mapLanesToCandidateGroups(NO_LANE_XML)).toBe(NO_LANE_XML);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = mapLanesToCandidateGroups(ONE_LANE_XML);
    const twice = mapLanesToCandidateGroups(once);
    expect(twice).toBe(once);
    // Exactly one candidateGroups attribute on the task (no double injection).
    const matches = twice.match(/candidateGroups=/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("injects on a self-closing userTask tag", () => {
    const out = mapLanesToCandidateGroups(ONE_LANE_XML);
    // ONE_LANE_XML's userTask is self-closing; the attribute must land before "/>".
    expect(out).toMatch(
      /<userTask\b[^>]*id="Activity_approve"[^>]*flowable:candidateGroups="buhgalter"\s*\/>/,
    );
  });

  it("the injected value is the bare role slug executor-resolver consumes", () => {
    // executor-resolver.ts resolveExecutor receives roleSlug === this value.
    // It must be a plain slug (NOT a 'role:' URI) so it matches role.slug.
    const out = mapLanesToCandidateGroups(ONE_LANE_XML);
    const m = out.match(/flowable:candidateGroups="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("buhgalter");
    expect(m![1]).not.toContain(":");
  });

  it("leaves non-userTask flow nodes in a lane untouched", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
                 xmlns:flowable="http://flowable.org/bpmn">
      <process id="P">
        <laneSet id="LS">
          <lane id="L1" name="Бухгалтер">
            <flowNodeRef>SVC_1</flowNodeRef>
            <flowNodeRef>UT_1</flowNodeRef>
          </lane>
        </laneSet>
        <serviceTask id="SVC_1"/>
        <userTask id="UT_1"/>
      </process>
    </definitions>`;
    const out = mapLanesToCandidateGroups(xml);
    // userTask gets the role…
    expect(out).toMatch(/<userTask\b[^>]*id="UT_1"[^>]*flowable:candidateGroups="buhgalter"/);
    // …serviceTask does NOT (candidateGroups only addresses human task pools).
    expect(out).not.toMatch(/<serviceTask\b[^>]*candidateGroups/);
  });
});
