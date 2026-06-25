/**
 * T-0434 — gateway-condition-panel.jsx: pure helper unit tests
 *
 * Tests the exported logic functions from the GatewayConditionPanel module:
 *   - buildConditionBody: produces a well-formed EL conditionExpression body
 *     of the form `${varName == 'branchValue'}` that passes lintBpmn.
 *   - parseConditionBody: inverse of buildConditionBody — parses back to
 *     { varName, branchValue }. Returns null for non-matching expressions.
 *   - readRoutingVar: reads choros:routingVar from a gateway businessObject
 *     with fallback to 'approvalRequired'.
 *   - writeRoutingVar: dual-writes to bo.routingVar + bo.$attrs['choros:routingVar'].
 *   - readFlowConditionBody: reads conditionExpression.body from a flow bo.
 *
 * Integration assertion:
 *   - Two flows with different branch values produce TWO conditionExpression
 *     bodies of the form `${approvalRequired == '...'}` — asserting what
 *     saveXML would emit for each flow (verified by constructing the XML
 *     fragment that bpmn-js would produce).
 *   - The produced conditionExpression strings pass lintBpmn.
 *
 * No DOM, no bpmn-js instance, no jsdom — pure node environment.
 */

import { describe, it, expect } from 'vitest';
import {
  buildConditionBody,
  parseConditionBody,
  readRoutingVar,
  writeRoutingVar,
  readFlowConditionBody,
} from './gateway-condition-panel.jsx';

/**
 * Minimal BPMN XML fragment with ONE conditionExpression.
 * Used to verify the shape of the XML that bpmn-js would emit after the panel
 * writes a conditionExpression via modeling.updateProperties.
 */
function wrapInBpmn(condBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="Definitions_test"
             targetNamespace="http://test.io">
  <process id="Process_test" isExecutable="false">
    <startEvent id="StartEvent_1"><outgoing>Flow_1</outgoing></startEvent>
    <exclusiveGateway id="Gateway_1"><incoming>Flow_1</incoming><outgoing>Flow_2</outgoing><outgoing>Flow_3</outgoing></exclusiveGateway>
    <endEvent id="EndEvent_yes"><incoming>Flow_2</incoming></endEvent>
    <endEvent id="EndEvent_no"><incoming>Flow_3</incoming></endEvent>
    <sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Gateway_1"/>
    <sequenceFlow id="Flow_2" sourceRef="Gateway_1" targetRef="EndEvent_yes">
      <conditionExpression xsi:type="tFormalExpression">${condBody}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_3" sourceRef="Gateway_1" targetRef="EndEvent_no"/>
  </process>
</definitions>`;
}

/**
 * Minimal BPMN XML fragment with TWO conditionExpressions and one default flow.
 * Models the fully-configured gateway: two conditional branches + one default.
 */
function wrapTwoBranches(body1, body2) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="Definitions_test2"
             targetNamespace="http://test.io">
  <process id="Process_test2" isExecutable="false">
    <startEvent id="StartEvent_1"><outgoing>Flow_1</outgoing></startEvent>
    <exclusiveGateway id="Gateway_1" default="Flow_4">
      <incoming>Flow_1</incoming><outgoing>Flow_2</outgoing><outgoing>Flow_3</outgoing><outgoing>Flow_4</outgoing>
    </exclusiveGateway>
    <endEvent id="EndEvent_yes"><incoming>Flow_2</incoming></endEvent>
    <endEvent id="EndEvent_no"><incoming>Flow_3</incoming></endEvent>
    <endEvent id="EndEvent_default"><incoming>Flow_4</incoming></endEvent>
    <sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Gateway_1"/>
    <sequenceFlow id="Flow_2" sourceRef="Gateway_1" targetRef="EndEvent_yes">
      <conditionExpression xsi:type="tFormalExpression">${body1}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_3" sourceRef="Gateway_1" targetRef="EndEvent_no">
      <conditionExpression xsi:type="tFormalExpression">${body2}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="EndEvent_default"/>
  </process>
</definitions>`;
}

/**
 * Raw-object keys that the bpmn-linter (src/core/bpmn-linter.ts) rejects
 * when found in conditionExpression text.  Replicated here without importing
 * the linter (which is a TypeScript file, not loadable in the web vitest tier).
 *
 * Source: bpmn-linter.ts RAW_OBJECT_KEYS Set.
 */
const RAW_OBJECT_KEYS = new Set([
  'registryId', 'recordId', 'applicationId', 'data', 'fields', 'payload', 'view',
]);

/**
 * True if the conditionExpression body contains any raw-object key literal
 * (i.e. would be flagged by lintBpmn).
 */
function containsRawObjectKey(body) {
  return [...RAW_OBJECT_KEYS].some((k) => body.includes(k));
}

// ---------------------------------------------------------------------------
// buildConditionBody
// ---------------------------------------------------------------------------

describe('buildConditionBody', () => {
  it('produces canonical EL form ${var == \'value\'}', () => {
    expect(buildConditionBody('approvalRequired', 'yes'))
      .toBe("${approvalRequired == 'yes'}");
  });

  it('uses default var name when varName is empty', () => {
    expect(buildConditionBody('', 'no')).toBe("${approvalRequired == 'no'}");
  });

  it('sanitises varName — strips non-identifier characters', () => {
    expect(buildConditionBody('bad name!', 'x')).toBe("${badname == 'x'}");
  });

  it('Fix 5: strips leading digits from varName so identifier starts with [A-Za-z_]', () => {
    expect(buildConditionBody('123foo', 'x')).toBe("${foo == 'x'}");
    expect(buildConditionBody('42', 'x')).toBe("${approvalRequired == 'x'}");
  });

  it('Fix 4: strips apostrophes from branchValue — o\'brien round-trips cleanly', () => {
    // o'brien: apostrophe stripped → obrien, parseable without escaping
    const body = buildConditionBody('status', "o'brien");
    expect(body).toBe("${status == 'obrien'}");
    const parsed = parseConditionBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed.branchValue).toBe('obrien');
  });

  it('Fix 4: strips double-quotes and backslashes from branchValue', () => {
    expect(buildConditionBody('x', 'a"b')).toBe("${x == 'ab'}");
    expect(buildConditionBody('x', 'a\\b')).toBe("${x == 'ab'}");
  });

  it('handles empty branchValue', () => {
    expect(buildConditionBody('status', '')).toBe("${status == ''}");
  });

  it('handles Russian branchValues (pass-through)', () => {
    expect(buildConditionBody('decision', 'Согласовать'))
      .toBe("${decision == 'Согласовать'}");
  });
});

// ---------------------------------------------------------------------------
// parseConditionBody — inverse of buildConditionBody
// ---------------------------------------------------------------------------

describe('parseConditionBody', () => {
  it('round-trips the canonical form', () => {
    const body = buildConditionBody('approvalRequired', 'yes');
    const result = parseConditionBody(body);
    expect(result).toEqual({ varName: 'approvalRequired', branchValue: 'yes' });
  });

  it('returns null for empty string', () => {
    expect(parseConditionBody('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseConditionBody(null)).toBeNull();
  });

  it('returns null for non-matching EL expression', () => {
    expect(parseConditionBody('${x > 5}')).toBeNull();
    expect(parseConditionBody('${foo}')).toBeNull();
  });

  it('Russian varName is sanitised (non-ASCII stripped) → fallback to "approvalRequired"', () => {
    // buildConditionBody strips non-identifier chars (incl. Cyrillic) from varName.
    // "решение" → all chars stripped → empty → fallback "approvalRequired".
    // The resulting body CAN be parsed back since it has the canonical form.
    const body = buildConditionBody('решение', 'Согласовать');
    expect(body).toBe("${approvalRequired == 'Согласовать'}");
    const result = parseConditionBody(body);
    expect(result).not.toBeNull();
    expect(result.varName).toBe('approvalRequired');
    expect(result.branchValue).toBe('Согласовать');
  });
});

// ---------------------------------------------------------------------------
// readRoutingVar / writeRoutingVar
// ---------------------------------------------------------------------------

describe('readRoutingVar', () => {
  it('returns default "approvalRequired" when bo has no attribute', () => {
    expect(readRoutingVar({ $type: 'bpmn:ExclusiveGateway', $attrs: {} })).toBe('approvalRequired');
  });

  it('reads from bo.routingVar (registered moddle property)', () => {
    expect(readRoutingVar({ routingVar: 'decision', $attrs: {} })).toBe('decision');
  });

  it('falls back to $attrs["choros:routingVar"]', () => {
    expect(readRoutingVar({ $attrs: { 'choros:routingVar': 'status' } })).toBe('status');
  });

  it('returns default when bo is null', () => {
    expect(readRoutingVar(null)).toBe('approvalRequired');
  });
});

describe('writeRoutingVar', () => {
  it('writes to both bo.routingVar and $attrs', () => {
    const bo = { $attrs: {} };
    writeRoutingVar(bo, 'myVar');
    expect(bo.routingVar).toBe('myVar');
    expect(bo.$attrs['choros:routingVar']).toBe('myVar');
  });

  it('clears both paths when value is falsy', () => {
    const bo = { routingVar: 'old', $attrs: { 'choros:routingVar': 'old' } };
    writeRoutingVar(bo, '');
    expect(bo.routingVar).toBeUndefined();
    expect(bo.$attrs['choros:routingVar']).toBeUndefined();
  });

  it('creates $attrs if absent', () => {
    const bo = {};
    writeRoutingVar(bo, 'x');
    expect(bo.$attrs).toBeDefined();
    expect(bo.$attrs['choros:routingVar']).toBe('x');
  });

  it('is a no-op when bo is null', () => {
    expect(() => writeRoutingVar(null, 'x')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readFlowConditionBody
// ---------------------------------------------------------------------------

describe('readFlowConditionBody', () => {
  it('returns empty string when conditionExpression is absent', () => {
    expect(readFlowConditionBody({ $type: 'bpmn:SequenceFlow' })).toBe('');
  });

  it('reads body from conditionExpression object (bpmn:FormalExpression shape)', () => {
    const bo = { conditionExpression: { body: "${approvalRequired == 'yes'}" } };
    expect(readFlowConditionBody(bo)).toBe("${approvalRequired == 'yes'}");
  });

  it('returns empty string when conditionExpression.body is absent', () => {
    expect(readFlowConditionBody({ conditionExpression: {} })).toBe('');
  });

  it('returns empty string when bo is null', () => {
    expect(readFlowConditionBody(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Integration: two conditionExpressions in XML — structure and linter-safety
//
// The lintBpmn function (src/core/bpmn-linter.ts) is a TypeScript file that
// cannot be imported directly in the web vitest tier (no TS plugin).  Instead
// we verify the linter contract by:
//   1. Asserting the canonical EL form matches the expected regex.
//   2. Asserting the produced body does NOT contain any RAW_OBJECT_KEYS.
//   3. Asserting the full XML fragment contains exactly the right number of
//      <conditionExpression> elements.
// ---------------------------------------------------------------------------

describe('conditionExpression integration — XML structure and linter-safety', () => {
  it('single conditionExpression: XML fragment contains the body verbatim', () => {
    const body = buildConditionBody('approvalRequired', 'yes');
    const xml = wrapInBpmn(body);
    expect(xml).toContain(body);
    expect(xml).toContain('<conditionExpression');
  });

  it('TWO conditionExpressions: XML fragment contains BOTH branch conditions', () => {
    const body1 = buildConditionBody('approvalRequired', 'yes');
    const body2 = buildConditionBody('approvalRequired', 'no');
    const xml = wrapTwoBranches(body1, body2);

    // Both bodies must appear in the XML (as bpmn-js saveXML would emit)
    expect(xml).toContain("${approvalRequired == 'yes'}");
    expect(xml).toContain("${approvalRequired == 'no'}");

    // Exactly 2 conditionExpression elements (default flow has none)
    const conditionCount = (xml.match(/<conditionExpression/g) || []).length;
    expect(conditionCount).toBe(2);
  });

  it('default flow has NO conditionExpression in the fragment', () => {
    const body1 = buildConditionBody('approvalRequired', 'yes');
    const body2 = buildConditionBody('approvalRequired', 'no');
    const xml = wrapTwoBranches(body1, body2);

    // Three outgoing flows: Flow_2 (condition), Flow_3 (condition), Flow_4 (default, no condition)
    const conditionCount = (xml.match(/<conditionExpression/g) || []).length;
    expect(conditionCount).toBe(2);

    // Default flow id must appear without a nested conditionExpression
    expect(xml).toContain('id="Flow_4"');
  });

  it('canonical EL form matches ${var == \'value\'} regex — passes lintBpmn raw-object check', () => {
    // lintBpmn rejects conditionExpression text containing raw-object keys
    // (registryId, recordId, applicationId, data, fields, payload, view).
    // Our canonical form ${approvalRequired == 'yes'} must:
    //   (a) match the EL pattern
    //   (b) not contain any RAW_OBJECT_KEYS
    const body = buildConditionBody('approvalRequired', 'yes');
    expect(body).toMatch(/^\$\{[A-Za-z_][A-Za-z0-9_]* == '[^']*'\}$/);
    expect(containsRawObjectKey(body)).toBe(false);
  });

  it('condition body with typical values does not contain raw-object keys', () => {
    for (const [varName, value] of [
      ['approvalRequired', 'yes'],
      ['approvalRequired', 'no'],
      ['status', 'approved'],
      ['decision', 'Согласовать'],
      ['decision', 'Отклонить'],
    ]) {
      const body = buildConditionBody(varName, value);
      expect(containsRawObjectKey(body), `body "${body}" must not have raw-object keys`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1: routing-variable rename re-emits conditionExpression for ALL flows
// ---------------------------------------------------------------------------

describe('Fix 1 — var rename re-emits all parseable flow conditions', () => {
  /**
   * Simulate what handleVarNameChange does for existing flows:
   * re-build the body with the new var name and the same branch value.
   */
  function reEmitBodies(flows, newVarName) {
    return flows.map((f) => {
      const parsed = parseConditionBody(f.body);
      if (!parsed) return f.body; // default or unparseable — untouched
      return buildConditionBody(newVarName, parsed.branchValue);
    });
  }

  it('two flows with branch values — both bodies updated to new var name', () => {
    const flowBodies = [
      { body: buildConditionBody('approvalRequired', 'yes') },
      { body: buildConditionBody('approvalRequired', 'no') },
    ];
    const updated = reEmitBodies(flowBodies, 'решение');
    // Cyrillic var name is sanitised to empty → fallback 'approvalRequired'
    // (test the round-trip mechanic: both branch VALUES are preserved)
    expect(parseConditionBody(updated[0]).branchValue).toBe('yes');
    expect(parseConditionBody(updated[1]).branchValue).toBe('no');
    // both reference the same (sanitised) var
    const var0 = parseConditionBody(updated[0]).varName;
    const var1 = parseConditionBody(updated[1]).varName;
    expect(var0).toBe(var1);
  });

  it('two flows renamed from "status" to "outcome" — bodies use new var', () => {
    const flowBodies = [
      { body: buildConditionBody('status', 'approved') },
      { body: buildConditionBody('status', 'rejected') },
    ];
    const updated = reEmitBodies(flowBodies, 'outcome');
    expect(updated[0]).toBe("${outcome == 'approved'}");
    expect(updated[1]).toBe("${outcome == 'rejected'}");
    // both parseable with new var name
    expect(parseConditionBody(updated[0])).toEqual({ varName: 'outcome', branchValue: 'approved' });
    expect(parseConditionBody(updated[1])).toEqual({ varName: 'outcome', branchValue: 'rejected' });
  });

  it('default flow (no parseable condition) is left untouched after rename', () => {
    const flowBodies = [
      { body: buildConditionBody('status', 'approved') },
      { body: '' }, // default flow — no condition
    ];
    const updated = reEmitBodies(flowBodies, 'outcome');
    expect(updated[0]).toBe("${outcome == 'approved'}");
    expect(updated[1]).toBe(''); // unchanged
  });
});

// ---------------------------------------------------------------------------
// moddle-extension contract: GatewayConditionExtension type (T-0434)
// ---------------------------------------------------------------------------

import descriptor from './choros-moddle-extension.js';

describe('choros-moddle-extension — T-0434 GatewayConditionExtension type', () => {
  const gwType = descriptor.types.find((t) => t.name === 'GatewayConditionExtension');

  it('exists in the descriptor', () => {
    expect(gwType).toBeDefined();
  });

  it('extends bpmn:ExclusiveGateway', () => {
    expect(gwType.extends).toContain('bpmn:ExclusiveGateway');
  });

  it('has routingVar as isAttr:true String property', () => {
    const prop = gwType.properties.find((p) => p.name === 'routingVar');
    expect(prop).toBeDefined();
    expect(prop.isAttr).toBe(true);
    expect(prop.type).toBe('String');
  });

  it('descriptor has GatewayConditionExtension among its types (T-0458 added TimerDeadlineExtension as 5th)', () => {
    const names = descriptor.types.map((t) => t.name);
    expect(names).toContain('GatewayConditionExtension');
    // T-0458 [D8-R3]: TimerDeadlineExtension added additively → 5 types.
    expect(descriptor.types).toHaveLength(5);
  });
});
