/**
 * src/core/__tests__/bpmn-process-meta.test.ts — T-0732.
 *
 * Proves parseBpmnProcessMeta extracts { processKey, name } from BPMN DATA (the
 * <process id name> pair) robustly, and degrades to null when there is no human
 * name to register — so the read path keeps its honest keyDemoted fallback.
 *
 * Fixtures use GENERIC process names/keys (never a real product process) — the
 * point is that the value is read from the XML, not baked into platform code.
 */

import { describe, it, expect } from "vitest";
import { parseBpmnProcessMeta } from "../bpmn-process-meta.js";

const WRAP = (proc: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://test">
  ${proc}
</definitions>`;

describe("parseBpmnProcessMeta", () => {
  it("extracts id + name from a <process name=…> element (attribute order irrelevant)", () => {
    const xml = WRAP(`<process id="vacationRequest" name="Заявка на отпуск" isExecutable="true">
      <startEvent id="s1"/>
    </process>`);
    expect(parseBpmnProcessMeta(xml)).toEqual({
      processKey: "vacationRequest",
      name: "Заявка на отпуск",
    });
  });

  it("reads the name regardless of attribute ordering", () => {
    const xml = WRAP(`<process name="Purchase Approval" isExecutable="true" id="purchaseApproval"/>`);
    expect(parseBpmnProcessMeta(xml)).toEqual({
      processKey: "purchaseApproval",
      name: "Purchase Approval",
    });
  });

  it("handles a namespaced <bpmn:process> prefix (tokenizer strips the prefix)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://test">
  <bpmn:process id="onboarding" name="Онбординг клиента" isExecutable="true">
    <bpmn:startEvent id="s1"/>
  </bpmn:process>
</bpmn:definitions>`;
    expect(parseBpmnProcessMeta(xml)).toEqual({
      processKey: "onboarding",
      name: "Онбординг клиента",
    });
  });

  it("decodes XML entities in the name", () => {
    const xml = WRAP(`<process id="p1" name="Ремонт &amp; сервис" isExecutable="true"/>`);
    expect(parseBpmnProcessMeta(xml)).toEqual({
      processKey: "p1",
      name: "Ремонт & сервис",
    });
  });

  it("returns null when the process has an id but NO name attribute", () => {
    const xml = WRAP(`<process id="noName" isExecutable="true">
      <startEvent id="s1"/>
    </process>`);
    expect(parseBpmnProcessMeta(xml)).toBeNull();
  });

  it("returns null when the name is present but empty/whitespace", () => {
    const xml = WRAP(`<process id="blank" name="   " isExecutable="true"/>`);
    expect(parseBpmnProcessMeta(xml)).toBeNull();
  });

  it("returns null when there is no <process> element at all", () => {
    const xml = WRAP(`<message id="m1" name="Some Message"/>`);
    expect(parseBpmnProcessMeta(xml)).toBeNull();
  });

  it("picks the FIRST process that carries a non-empty name (deterministic)", () => {
    const xml = WRAP(`<process id="unnamed" isExecutable="false"/>
  <process id="named" name="Второй процесс" isExecutable="true"/>`);
    expect(parseBpmnProcessMeta(xml)).toEqual({
      processKey: "named",
      name: "Второй процесс",
    });
  });

  it("returns null on malformed XML (fail-closed — linter owns the rejection)", () => {
    expect(parseBpmnProcessMeta(`<process id="x" name=`)).toBeNull();
    expect(parseBpmnProcessMeta("")).toBeNull();
    // @ts-expect-error — non-string input degrades to null, never throws.
    expect(parseBpmnProcessMeta(undefined)).toBeNull();
  });
});
