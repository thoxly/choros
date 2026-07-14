/**
 * Unit tests for T-0379 [D4] objective-compiler.ts — the F1 compiler.
 *
 * Covers (pure, no DB / network / LLM key):
 *   - readStepDef: extracts BpmnStepDef from raw job.variables safely.
 *   - compileObjective: BPMN step def + published instruction → compiled neutral prompt.
 *   - Motor integration: the compiled objective's prompt is non-empty, deterministic,
 *     and includes the key structured fields the motor passes to the LLM port.
 *   - Edge / degenerate cases: empty inputs, absent instruction, long field values.
 */

import { describe, it, expect } from "vitest";
import {
  readStepDef,
  compileObjective,
  type BpmnStepDef,
} from "../objective-compiler.js";

// ---------------------------------------------------------------------------
// readStepDef
// ---------------------------------------------------------------------------

describe("readStepDef — extract BpmnStepDef from job.variables", () => {
  it("extracts all declared fields when present", () => {
    const vars: Record<string, unknown> = {
      stepName: "Триаж",
      topic: "tel-intake",
      procKey: "telLinear",
      step_inputs: ["subject", "amount", "justification"],
      step_outputs: ["decision", "confidence"],
      contextHint: "Focus on the monetary amount",
      fields: { subject: "Purchase", amount: 5500000, justification: "Needed for Q3" },
    };

    const def = readStepDef(vars, "tel-intake", "telLinear");

    expect(def.stepName).toBe("Триаж");
    expect(def.topic).toBe("tel-intake");
    expect(def.procKey).toBe("telLinear");
    expect(def.inputFields).toEqual(["subject", "amount", "justification"]);
    expect(def.outputFields).toEqual(["decision", "confidence"]);
    expect(def.contextHint).toBe("Focus on the monetary amount");
    expect(def.fieldValues).toEqual({ subject: "Purchase", amount: 5500000, justification: "Needed for Q3" });
  });

  it("falls back to topic param when job.variables has no topic", () => {
    const def = readStepDef({}, "tel-intake", "telLinear");
    expect(def.topic).toBe("tel-intake");
  });

  it("falls back to procKey param when job.variables has no procKey", () => {
    const def = readStepDef({}, "tel-intake", "telLinear");
    expect(def.procKey).toBe("telLinear");
  });

  it("accepts snake_case key aliases", () => {
    const vars: Record<string, unknown> = {
      step_name: "Intake",
      proc_key: "onboarding",
      context_hint: "NL hint",
    };
    const def = readStepDef(vars, "onb-topic", "onboarding");
    expect(def.stepName).toBe("Intake");
    expect(def.procKey).toBe("onboarding");
    expect(def.contextHint).toBe("NL hint");
  });

  it("returns empty arrays for absent step_inputs / step_outputs", () => {
    const def = readStepDef({ fields: {} }, "t", "p");
    expect(def.inputFields).toEqual([]);
    expect(def.outputFields).toEqual([]);
  });

  it("filters non-string entries in step_inputs array", () => {
    const vars = { step_inputs: ["a", 42, null, "b"] };
    const def = readStepDef(vars, "t", "p");
    expect(def.inputFields).toEqual(["a", "b"]);
  });

  it("returns empty fieldValues when fields is absent or malformed", () => {
    expect(readStepDef({}, "t", "p").fieldValues).toEqual({});
    expect(readStepDef({ fields: null }, "t", "p").fieldValues).toEqual({});
    expect(readStepDef({ fields: "bad" }, "t", "p").fieldValues).toEqual({});
  });

  it("null stepName when stepName is absent", () => {
    const def = readStepDef({ procKey: "p" }, "t", "p");
    expect(def.stepName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compileObjective
// ---------------------------------------------------------------------------

const FULL_DEF: BpmnStepDef = {
  stepName: "Триаж",
  topic: "tel-intake",
  procKey: "telLinear",
  inputFields: ["subject", "amount", "justification"],
  outputFields: ["decision", "confidence"],
  contextHint: "Focus on amount threshold",
  fieldValues: { subject: "Purchase request", amount: 5500000, justification: "Q3 equipment" },
};

const INSTR = { instructionText: "Evaluate the triage request", answerForm: "agent_step_v1" };

describe("compileObjective — BPMN step + instruction → neutral prompt", () => {
  it("produces a non-empty prompt when all fields are present", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes the step name in the prompt", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("Триаж");
  });

  it("includes the process key in the prompt", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("telLinear");
  });

  it("includes the topic in the prompt", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("tel-intake");
  });

  it("includes declared input field names in the prompt", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("subject");
    expect(prompt).toContain("amount");
    expect(prompt).toContain("justification");
  });

  it("includes actual field values from the snapshot", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("Purchase request");
    expect(prompt).toContain("5500000");
  });

  it("includes declared output field names", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("decision");
    expect(prompt).toContain("confidence");
  });

  it("includes the configurator NL context hint", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("Focus on amount threshold");
  });

  it("includes the published instruction text", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    expect(prompt).toContain("Evaluate the triage request");
  });

  it("uses the answerForm from the published instruction", () => {
    const { answerForm } = compileObjective(FULL_DEF, INSTR);
    expect(answerForm).toBe("agent_step_v1");
  });

  it("defaults answerForm to 'agent_step_v1' when instruction is null", () => {
    const { answerForm } = compileObjective(FULL_DEF, null);
    expect(answerForm).toBe("agent_step_v1");
  });

  it("defaults answerForm to 'agent_step_v1' when instruction.answerForm is null", () => {
    const { answerForm } = compileObjective(FULL_DEF, { instructionText: "do X", answerForm: null });
    expect(answerForm).toBe("agent_step_v1");
  });

  it("uses a custom answerForm from the published instruction", () => {
    const { answerForm } = compileObjective(FULL_DEF, { instructionText: "x", answerForm: "custom_v2" });
    expect(answerForm).toBe("custom_v2");
  });

  it("is deterministic — same inputs → same output (NF-6)", () => {
    const a = compileObjective(FULL_DEF, INSTR);
    const b = compileObjective(FULL_DEF, INSTR);
    expect(a.prompt).toBe(b.prompt);
    expect(a.answerForm).toBe(b.answerForm);
  });

  it("uses topic as step label when stepName is null", () => {
    const def: BpmnStepDef = { ...FULL_DEF, stepName: null };
    const { prompt } = compileObjective(def, INSTR);
    expect(prompt).toContain("tel-intake");
  });

  it("falls back to field values when no inputFields declared", () => {
    const def: BpmnStepDef = {
      ...FULL_DEF,
      inputFields: [],
      outputFields: [],
    };
    const { prompt } = compileObjective(def, INSTR);
    // Should still include the fieldValues snapshot
    expect(prompt).toContain("Purchase request");
  });

  it("produces a non-empty prompt even with completely empty inputs", () => {
    const emptyDef: BpmnStepDef = {
      stepName: null,
      topic: "t",
      procKey: "p",
      inputFields: [],
      outputFields: [],
      contextHint: null,
      fieldValues: {},
    };
    const { prompt } = compileObjective(emptyDef, null);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("truncates very long field values (MAX_FIELD_VALUE_CHARS=200)", () => {
    const longValue = "x".repeat(300);
    const def: BpmnStepDef = {
      ...FULL_DEF,
      inputFields: ["bigField"],
      fieldValues: { bigField: longValue },
    };
    const { prompt } = compileObjective(def, INSTR);
    // The truncated value ends with "…" and is at most 200+1 chars
    expect(prompt).toContain("…");
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("omits context hint section when contextHint is null", () => {
    const def: BpmnStepDef = { ...FULL_DEF, contextHint: null };
    const { prompt } = compileObjective(def, INSTR);
    expect(prompt).not.toContain("Additional context");
  });

  it("omits instruction section when published is null", () => {
    const { prompt } = compileObjective(FULL_DEF, null);
    expect(prompt).not.toContain("Evaluate the triage request");
  });

  it("omits outputs section when outputFields is empty", () => {
    const def: BpmnStepDef = { ...FULL_DEF, outputFields: [] };
    const { prompt } = compileObjective(def, INSTR);
    expect(prompt).not.toContain("Outputs expected");
  });
});

// ---------------------------------------------------------------------------
// Motor integration contract: compiled objective feeds run-agent-step correctly.
// ---------------------------------------------------------------------------

describe("compileObjective → motor integration contract", () => {
  it("prompt is a plain string (not JSON) suitable as an LLM document block", () => {
    const { prompt } = compileObjective(FULL_DEF, INSTR);
    // The motor uses prompt as a human-readable document; it must be a string
    expect(typeof prompt).toBe("string");
    // And it should NOT be a raw JSON blob (the compiler produces prose, not JSON)
    expect(() => JSON.parse(prompt)).toThrow();
  });

  it("answerForm is a non-empty string (never null/undefined)", () => {
    const r1 = compileObjective(FULL_DEF, INSTR);
    const r2 = compileObjective(FULL_DEF, null);
    expect(typeof r1.answerForm).toBe("string");
    expect(r1.answerForm.length).toBeGreaterThan(0);
    expect(typeof r2.answerForm).toBe("string");
    expect(r2.answerForm.length).toBeGreaterThan(0);
  });

  it("roundtrip: readStepDef → compileObjective produces a motor-ready objective", () => {
    const vars: Record<string, unknown> = {
      stepName: "Триаж",
      procKey: "telLinear",
      step_inputs: ["amount"],
      step_outputs: ["decision"],
      contextHint: "Check amount",
      fields: { amount: 5000000 },
    };
    const def = readStepDef(vars, "tel-intake", "telLinear");
    const { prompt, answerForm } = compileObjective(def, {
      instructionText: "Evaluate the request",
      answerForm: "agent_step_v1",
    });

    // All key elements present in the final compiled objective
    expect(prompt).toContain("Триаж");
    expect(prompt).toContain("amount");
    expect(prompt).toContain("5000000");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("Check amount");
    expect(prompt).toContain("Evaluate the request");
    expect(answerForm).toBe("agent_step_v1");
  });
});
