/**
 * src/core/__tests__/bpmn-deploy-normalizer.test.ts — T-0505.
 *
 * Proves normalizeBpmnForDeploy fixes the two publish→run blockers:
 *   4a. isExecutable="false" → "true" (Flowable 500 / «движок недоступен»)
 *   4b. <process id="Process_…"> renamed to the choros process_key AND the
 *       matching BPMNDI plane bpmnElement re-pointed to the same id.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeBpmnForDeploy,
  InvalidProcessKeyForDeployError,
} from "../bpmn-deploy-normalizer.js";

/** A modeler-shaped doc: false-executable, bpmn-js id, BPMNDI plane on that id. */
const MODELER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" targetNamespace="http://test">
  <process id="Process_new" isExecutable="false">
    <startEvent id="StartEvent_1"/>
    <endEvent id="EndEvent_1"/>
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_new">
      <bpmndi:BPMNShape id="Shape_Start" bpmnElement="StartEvent_1"/>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

describe("normalizeBpmnForDeploy", () => {
  it("flips isExecutable false→true, renames <process id> + plane bpmnElement to the key", () => {
    const out = normalizeBpmnForDeploy(MODELER_BPMN, "my-key");

    expect(out).toContain('isExecutable="true"');
    expect(out).not.toContain('isExecutable="false"');
    expect(out).toContain('<process id="my-key"');
    expect(out).not.toContain('id="Process_new"');
    // The BPMNDI plane that pointed at the process must follow the rename.
    expect(out).toContain('bpmnElement="my-key"');
    expect(out).not.toContain('bpmnElement="Process_new"');
    // Flow-node shape references are untouched.
    expect(out).toContain('bpmnElement="StartEvent_1"');
  });

  it("adds isExecutable when the process has none", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1"><startEvent id="s"/></process></definitions>`;
    const out = normalizeBpmnForDeploy(xml, "k");
    expect(out).toContain('isExecutable="true"');
    expect(out).toContain('<process id="k"');
  });

  it("adds an id when the process has none", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process isExecutable="false"><startEvent id="s"/></process></definitions>`;
    const out = normalizeBpmnForDeploy(xml, "the-key");
    expect(out).toContain('<process id="the-key"');
    expect(out).toContain('isExecutable="true"');
  });

  it("handles a single namespaced process tag (bpmn2:process)", () => {
    const xml = `<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"><bpmn2:process id="Process_1" isExecutable="false"/><bpmndi:BPMNDiagram><bpmndi:BPMNPlane bpmnElement="Process_1"/></bpmndi:BPMNDiagram></bpmn2:definitions>`;
    const out = normalizeBpmnForDeploy(xml, "slug-key");
    expect(out).toContain('id="slug-key"');
    expect(out).toContain('isExecutable="true"');
    expect(out).toContain('bpmnElement="slug-key"');
    expect(out).not.toContain('Process_1');
  });

  it("is idempotent — a normalized doc is unchanged on re-run", () => {
    const once = normalizeBpmnForDeploy(MODELER_BPMN, "my-key");
    const twice = normalizeBpmnForDeploy(once, "my-key");
    expect(twice).toBe(once);
  });

  it("is a no-op when there is no <process> element", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>`;
    expect(normalizeBpmnForDeploy(xml, "k")).toBe(xml);
  });

  it("is a no-op on malformed XML (linter owns rejection)", () => {
    const bad = `<definitions><process id="P" isExecutable="false"`;
    expect(normalizeBpmnForDeploy(bad, "k")).toBe(bad);
  });

  it("does not corrupt unrelated attributes/elements", () => {
    const out = normalizeBpmnForDeploy(MODELER_BPMN, "my-key");
    expect(out).toContain('targetNamespace="http://test"');
    expect(out).toContain('<startEvent id="StartEvent_1"/>');
    expect(out).toContain('<endEvent id="EndEvent_1"/>');
  });

  it("normalizes the executable process when multiple processes exist", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="Lib_1" isExecutable="false"/><process id="Main_1" isExecutable="true"><startEvent id="s"/></process></definitions>`;
    const out = normalizeBpmnForDeploy(xml, "main-key");
    // The runnable (isExecutable not false) process is the one renamed.
    expect(out).toContain('<process id="main-key" isExecutable="true"');
    // The library process is left as-is.
    expect(out).toContain('<process id="Lib_1" isExecutable="false"');
  });

  // -------------------------------------------------------------------------
  // REVIEW FIX (T-0505): replacement-string injection + honest-reject.
  //
  // BUG: processKey was interpolated into a String.prototype.replace REPLACEMENT
  // STRING, so `$1`/`$&`/`` $` `` were treated as substitution patterns and a key
  // with a `"` could emit malformed XML (id="evil"x"). process_key is client-
  // supplied (POST /api/process-defs trims only). Fix = replacement FUNCTIONS
  // (so `$` lands literally) + reject XML-attr-breaking keys with a typed error.
  // -------------------------------------------------------------------------

  it("injects a $-bearing key LITERALLY (replacement-function fix, not substitution)", () => {
    // `$` is XML-attr-safe → ALLOWED. With a replacement STRING, "k$1x" would
    // mis-substitute ($1 = whole-match backreference); the function fix makes the
    // `$1` land verbatim. Prove it on the process id AND the plane bpmnElement.
    // (NB: `$&` would contain `&`, which is XML-breaking → rejected — see throw
    // tests below; the literal-$ proof therefore uses a `&`-free key.)
    const out = normalizeBpmnForDeploy(MODELER_BPMN, "k$1x");
    expect(out).toContain('<process id="k$1x"');
    expect(out).toContain('bpmnElement="k$1x"');
    // No silent substitution leaked the old id / a backreference into the output.
    expect(out).not.toContain('id="Process_new"');
    expect(out).not.toContain('bpmnElement="Process_new"');
  });

  it("keeps a plain $-key ($1 sequence) literal in the process id", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="false"><startEvent id="s"/></process></definitions>`;
    const out = normalizeBpmnForDeploy(xml, "price$total");
    expect(out).toContain('<process id="price$total"');
    const outBackref = normalizeBpmnForDeploy(xml, "k$1x");
    expect(outBackref).toContain('<process id="k$1x"');
  });

  it("keeps a $-key literal when inserting a missing id (add-id branch)", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process isExecutable="false"><startEvent id="s"/></process></definitions>`;
    // add-id branch: `(m) => \`${m} id="${processKey}"\`` — the $1 must land literal.
    const out = normalizeBpmnForDeploy(xml, "k$1x");
    expect(out).toContain('<process id="k$1x"');
    expect(out).toContain('isExecutable="true"');
  });

  it("THROWS InvalidProcessKeyForDeployError on a key with a double-quote", () => {
    expect(() => normalizeBpmnForDeploy(MODELER_BPMN, 'evil"x')).toThrow(
      InvalidProcessKeyForDeployError,
    );
  });

  it("THROWS on keys with &, <, >, single-quote, or whitespace (XML-breaking)", () => {
    for (const bad of ["a&b", "a<b", "a>b", "a'b", "a b", "a\tb", "a\nb"]) {
      expect(() => normalizeBpmnForDeploy(MODELER_BPMN, bad)).toThrow(
        InvalidProcessKeyForDeployError,
      );
    }
  });

  it("does NOT throw on normal slugs (incl. leading-digit) — they pass", () => {
    for (const ok of ["novyy-protsess", "equipment-purchase", "2024-otchet"]) {
      expect(() => normalizeBpmnForDeploy(MODELER_BPMN, ok)).not.toThrow();
      const out = normalizeBpmnForDeploy(MODELER_BPMN, ok);
      expect(out).toContain(`<process id="${ok}"`);
    }
  });
});
