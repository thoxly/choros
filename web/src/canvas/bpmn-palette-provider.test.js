/**
 * T-0634 [W3/столп4/P0-2] — palette "Agent Task" export-XML test.
 *
 * Live-proof finding (T-0586): dragging «Agent Task — ИИ-агент» from the
 * palette produced a BARE bpmn:ServiceTask in the exported XML — no
 * choros:executorType attribute at all — indistinguishable from the plain
 * «External Task — сервис» entry. Root cause: the old createAction() passed
 * `{ 'choros:executorType': 'agent' }` straight into
 * elementFactory.createShape(...), but bpmn-js's ElementFactory only lifts a
 * small, fixed allow-list of keys (processRef / isInterrupting /
 * eventDefinitionType / isExpanded / isHorizontal / triggeredByEvent /
 * cancelActivity — see node_modules/bpmn-js/lib/features/modeling/
 * ElementFactory.js createElement()) onto the created businessObject; any
 * other key (including a raw 'choros:executorType') is silently assigned onto
 * the returned SHAPE object itself, never onto businessObject or
 * businessObject.$attrs. So the attribute never existed to be exported.
 *
 * This test instantiates the REAL bpmn-js ElementFactory/BpmnFactory + a real
 * BpmnModdle (with the choros namespace registered) — all headless, no DOM
 * container needed (mirrors bpmn-ensure-layout.test.js's precedent: this repo
 * deliberately avoids instantiating the full BpmnModeler, which needs a DOM,
 * in vitest's node environment). It drives the ACTUAL palette entries
 * returned by ChorosPaletteProvider.getPaletteEntries(), then serialises the
 * resulting element via moddle.toXML to prove the fix end-to-end: click the
 * palette entry → businessObject carries the attribute → saveXML emits
 * choros:executorType="agent"/"service" in the real output XML.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import BpmnModdle from 'bpmn-moddle';
import Ids from 'ids';
import BpmnFactory from 'bpmn-js/lib/features/modeling/BpmnFactory.js';
import ElementFactory from 'bpmn-js/lib/features/modeling/ElementFactory.js';
import ChorosModdleDescriptor from './choros-moddle-extension.js';
import { ChorosPaletteProvider } from './bpmn-palette-provider.js';

/** Build a headless (DOM-free) element-creation stack + palette entries. */
function buildPalette() {
  const moddle = new BpmnModdle({ choros: ChorosModdleDescriptor });
  // bpmn-js's BaseModeler attaches an id tracker the same way (see
  // node_modules/bpmn-js/lib/BaseModeler.js: `moddle.ids = new Ids([32, 36, 1])`)
  // — BpmnFactory._ensureId() needs it when creating any element without an
  // explicit id (every task the palette creates). We are not instantiating
  // BaseModeler (it needs a DOM container), so this one line is replicated
  // headlessly.
  moddle.ids = new Ids([32, 36, 1]);
  const bpmnFactory = new BpmnFactory(moddle);
  const elementFactory = new ElementFactory(bpmnFactory, moddle);

  const fakePalette = { registerProvider: () => {} };
  let startedShape = null;
  const fakeCreate = {
    start(_event, shape) {
      startedShape = shape;
    },
  };
  const translate = (s) => s;

  const provider = new ChorosPaletteProvider(fakePalette, fakeCreate, elementFactory, translate);
  const entries = provider.getPaletteEntries();

  return {
    moddle,
    entries,
    // Fire the palette entry's click handler and return the shape bpmn-js
    // handed to create.start() — exactly what happens on a real drag/drop.
    clickEntry(key) {
      startedShape = null;
      entries[key].action.click({});
      return startedShape;
    },
  };
}

/** Serialise a single businessObject inside a minimal process + definitions. */
async function toXml(moddle, businessObject) {
  const process = moddle.create('bpmn:Process', { id: 'Process_1' });
  process.get('flowElements').push(businessObject);
  businessObject.$parent = process;
  const definitions = moddle.create('bpmn:Definitions', {
    targetNamespace: 'http://choros.io/test',
    rootElements: [process],
  });
  process.$parent = definitions;
  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

describe('ChorosPaletteProvider — Agent Task palette entry stamps choros:executorType', () => {
  let ctx;
  beforeEach(() => {
    ctx = buildPalette();
  });

  it('create.choros-agent-task → businessObject.executorType === "agent" (moddle property)', () => {
    const shape = ctx.clickEntry('create.choros-agent-task');
    expect(shape.type).toBe('bpmn:ServiceTask');
    expect(shape.businessObject.$type).toBe('bpmn:ServiceTask');
    expect(shape.businessObject.executorType).toBe('agent');
  });

  it('create.choros-agent-task → businessObject.$attrs carries the legacy choros:executorType fallback', () => {
    const shape = ctx.clickEntry('create.choros-agent-task');
    expect(shape.businessObject.$attrs).toBeTruthy();
    expect(shape.businessObject.$attrs['choros:executorType']).toBe('agent');
  });

  it('EXPORT-XML PROOF: saveXML-equivalent (moddle.toXML) emits choros:executorType="agent" — NOT a bare serviceTask', async () => {
    const shape = ctx.clickEntry('create.choros-agent-task');
    const xml = await toXml(ctx.moddle, shape.businessObject);
    // moddle.toXML (headless, no BpmnModeler namespace-alias config) prefixes
    // the local bpmn namespace as "bpmn:"; the real app's saveXML uses the
    // unprefixed default-namespace convention (<serviceTask>) — either way the
    // load-bearing fact under test is the choros:executorType attribute value.
    expect(xml).toMatch(/<bpmn:serviceTask[^>]*\bchoros:executorType="agent"/);
    // Regression guard for the exact live-proof symptom: a serviceTask with NO
    // executorType attribute at all (the old, broken behavior).
    expect(xml).not.toMatch(/<bpmn:serviceTask\s*\/>/);
    expect(xml).not.toMatch(/<bpmn:serviceTask id="[^"]*"\s*\/>/);
  });

  it('create.choros-service-task → businessObject.executorType === "service" (regression: sibling entry unaffected)', () => {
    const shape = ctx.clickEntry('create.choros-service-task');
    expect(shape.businessObject.executorType).toBe('service');
  });

  it('EXPORT-XML PROOF: External Task entry emits choros:executorType="service"', async () => {
    const shape = ctx.clickEntry('create.choros-service-task');
    const xml = await toXml(ctx.moddle, shape.businessObject);
    expect(xml).toMatch(/<bpmn:serviceTask[^>]*\bchoros:executorType="service"/);
  });

  it('regression: create.choros-user-task creates a plain bpmn:UserTask with NO executorType stamped', () => {
    // The human-task entry never called createAction with an executorType —
    // must not regress into always stamping something.
    const shape = ctx.clickEntry('create.choros-user-task');
    expect(shape.type).toBe('bpmn:UserTask');
    expect(shape.businessObject.executorType).toBeUndefined();
    expect(shape.businessObject.$attrs && shape.businessObject.$attrs['choros:executorType']).toBeFalsy();
  });

  it('regression: create.choros-timer still seeds eventDefinitionType (shapeAttrs path unaffected by the executorType fix)', () => {
    const shape = ctx.clickEntry('create.choros-timer');
    expect(shape.type).toBe('bpmn:IntermediateCatchEvent');
    const defs = shape.businessObject.eventDefinitions || [];
    expect(defs.some((d) => d.$type === 'bpmn:TimerEventDefinition')).toBe(true);
    // No stray executorType leaked onto a timer event.
    expect(shape.businessObject.executorType).toBeUndefined();
  });

  it('agent-task-external-mapper contract: the attribute VALUE matches AGENT_EXECUTOR_TYPE ("agent")', async () => {
    // Cross-check against the backend contract this task references: the
    // publish-transform (src/core/agent-task-external-mapper.ts) reads the
    // local (namespace-stripped) attribute name "executorType" and compares
    // it against AGENT_EXECUTOR_TYPE = "agent". Pin the value literally here
    // (not by importing the backend module — this is a frontend-only task and
    // must not runtime-import src/) so a future rename on either side is
    // caught by a failing test on whichever side changes first.
    const shape = ctx.clickEntry('create.choros-agent-task');
    expect(shape.businessObject.executorType).toBe('agent');
  });
});
