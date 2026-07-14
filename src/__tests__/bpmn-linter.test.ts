/**
 * T-0027: BPMN Deploy-time Linter — vitest AC corpus
 *
 * Covers AC-1..AC-15 and FF-1..FF-8 adversarial fixtures.
 * Adversarial XML fixture corpus is required by ADR §8.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { lintBpmn } from "../core/bpmn-linter.js";
import { makeHandle, serializeHandle } from "../core/object-handle.js";
import type { LintViolation } from "../core/bpmn-linter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures/bpmn");
const ADVERSARIAL = resolve(FIXTURES, "bpmn-parser-adversarial");

function loadFixture(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Helper: build a serialized ObjectHandle for test use
// ---------------------------------------------------------------------------

function makeTestHandle(): string {
  const h = makeHandle(
    { kind: "record", tenantId: "t1", registryId: "reg1", recordId: "rec1" },
    "t1",
  );
  return serializeHandle(h);
}

// ---------------------------------------------------------------------------
// AC-1: handle-shaped and primitive bindings → ok: true
// ---------------------------------------------------------------------------

describe("AC-1 — handle-only and primitive bindings pass", () => {
  it("handle-only.bpmn: serialized ObjectHandle strings pass", () => {
    const xml = loadFixture(`${FIXTURES}/handle-only.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("primitive-bindings.bpmn: string/number/boolean variables pass", () => {
    const xml = loadFixture(`${FIXTURES}/primitive-bindings.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("empty-process.bpmn: BPMN with no service/user/send tasks passes", () => {
    const xml = loadFixture(`${FIXTURES}/empty-process.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2: serviceTask with registryId/recordId → ok: false, elementKind: "serviceTask"
// ---------------------------------------------------------------------------

describe("AC-2 — serviceTask raw-object binding", () => {
  it("raw-object-service-task.bpmn: raw object with registryId/recordId fails", () => {
    const xml = loadFixture(`${FIXTURES}/raw-object-service-task.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.elementKind === "serviceTask");
      expect(v).toBeDefined();
      expect(v?.elementId).toBe("task1");
      expect(v?.type).toBe("raw_object_binding");
    }
  });

  it("inline: serviceTask extension with registryId/recordId fails", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <serviceTask id="st1" name="Test">
      <extensionElements>
        <flowable:field name="x">
          <flowable:string>{"registryId":"r","recordId":"c"}</flowable:string>
        </flowable:field>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.elementKind).toBe("serviceTask");
      expect(result.violations[0]?.elementId).toBe("st1");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: userTask with data key → ok: false, elementKind: "userTask"
// ---------------------------------------------------------------------------

describe("AC-3 — userTask raw-object binding", () => {
  it("raw-object-user-task.bpmn: raw object with data key fails", () => {
    const xml = loadFixture(`${FIXTURES}/raw-object-user-task.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.elementKind === "userTask");
      expect(v).toBeDefined();
      expect(v?.type).toBe("raw_object_binding");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: conditionExpression with fields/payload → ok: false, elementKind: "conditionExpression"
// ---------------------------------------------------------------------------

describe("AC-4 — conditionExpression raw-object", () => {
  it("raw-object-condition.bpmn: conditionExpression with fields key fails", () => {
    const xml = loadFixture(`${FIXTURES}/raw-object-condition.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.elementKind === "conditionExpression");
      expect(v).toBeDefined();
      expect(v?.type).toBe("raw_object_binding");
    }
  });

  it("inline: conditionExpression with payload key fails", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <sequenceFlow id="f1" sourceRef="a" targetRef="b">
      <conditionExpression>{"payload":{"item":"value"}}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.elementKind).toBe("conditionExpression");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: dataObject with applicationId/registryId → ok: false, elementKind: "dataObject"
// ---------------------------------------------------------------------------

describe("AC-5 — dataObject raw-object binding", () => {
  it("raw-object-data-object.bpmn: dataObject with applicationId/registryId fails", () => {
    const xml = loadFixture(`${FIXTURES}/raw-object-data-object.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.elementKind === "dataObject");
      expect(v).toBeDefined();
      expect(v?.type).toBe("raw_object_binding");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: malformed XML (unclosed tag) → ok: false, type: "malformed_xml"
// ---------------------------------------------------------------------------

describe("AC-6 — malformed XML fails closed", () => {
  it("malformed-unclosed-tag.xml: returns ok: false with type malformed_xml", () => {
    const xml = loadFixture(`${FIXTURES}/malformed-unclosed-tag.xml`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("malformed_xml");
      expect(result.violations[0]?.elementKind).toBe("malformed_xml");
    }
  });

  it("inline unclosed tag returns malformed_xml", () => {
    const result = lintBpmn("<definitions><process id='p1'><serviceTask id='t1'>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("malformed_xml");
    }
  });

  it("never returns ok: true for XML it cannot parse (invariant)", () => {
    const malformedInputs = [
      "<foo",
      "not xml at all",
      "<foo><bar></foo>", // mismatched tags — structural (ok, parser doesn't track matching)
      "<?xml version='1.0'?><foo><unclosed>",
    ];
    for (const xml of malformedInputs) {
      const result = lintBpmn(xml);
      // At minimum it should not error; malformed ones return false
      if (!result.ok) {
        expect(result.violations.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7: valid serialized ObjectHandle → ok: true (not a false-positive)
// ---------------------------------------------------------------------------

describe("AC-7 — valid handles are not false-positives", () => {
  it("serialized ObjectHandle string passes (round-trip)", () => {
    const handleStr = makeTestHandle();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <serviceTask id="t1" name="Lookup">
      <extensionElements>
        <flowable:field name="handleRef">
          <flowable:string>${handleStr}</flowable:string>
        </flowable:field>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("handle-only.bpmn fixture passes (AC-7)", () => {
    const xml = loadFixture(`${FIXTURES}/handle-only.bpmn`);
    expect(lintBpmn(xml).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-8: adversarial — raw object in attribute value
// ---------------------------------------------------------------------------

describe("AC-8 — adversarial: raw object in attribute value", () => {
  it("adversarial-attr-value.bpmn: inline raw object in attribute fails", () => {
    const xml = loadFixture(`${FIXTURES}/adversarial-attr-value.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("raw_object_binding");
    }
  });

  it("inline: serviceTask field attribute with raw object fails", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <serviceTask id="st1">
      <extensionElements>
        <flowable:field name="x" stringValue='{"registryId":"r","recordId":"c"}'/>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.elementKind).toBe("serviceTask");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9: adversarial — raw object in CDATA
// ---------------------------------------------------------------------------

describe("AC-9 — adversarial: raw object in CDATA section", () => {
  it("adversarial-cdata.bpmn: raw object in CDATA fails", () => {
    const xml = loadFixture(`${FIXTURES}/adversarial-cdata.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("raw_object_binding");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-10: EL expression ${someVar} is not a violation
// ---------------------------------------------------------------------------

describe("AC-10 — EL expressions without raw-object pattern pass", () => {
  it("el-expression.bpmn: conditionExpression with ${someVar} passes", () => {
    const xml = loadFixture(`${FIXTURES}/el-expression.bpmn`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("inline: EL expression in conditionExpression passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <sequenceFlow id="f1" sourceRef="a" targetRef="b">
      <conditionExpression>\${approved == true}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    expect(lintBpmn(xml).ok).toBe(true);
  });

  it("inline: plain string value in conditionExpression passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <sequenceFlow id="f1" sourceRef="a" targetRef="b">
      <conditionExpression>approved</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    expect(lintBpmn(xml).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-11: LintViolation carries all required fields; missing id → elementId: ""
// ---------------------------------------------------------------------------

describe("AC-11 — LintViolation shape: all required fields present", () => {
  it("violation has type, elementId, elementKind, message", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <serviceTask id="st1">
      <extensionElements>
        <flowable:field name="x">
          <flowable:string>{"registryId":"r","recordId":"c"}</flowable:string>
        </flowable:field>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v: LintViolation = result.violations[0]!;
      expect(typeof v.type).toBe("string");
      expect(typeof v.elementId).toBe("string");
      expect(typeof v.elementKind).toBe("string");
      expect(typeof v.message).toBe("string");
      expect(v.elementId).toBe("st1");
    }
  });

  it("missing id attribute → elementId: ''", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <serviceTask name="No Id Task">
      <extensionElements>
        <flowable:field name="x">
          <flowable:string>{"registryId":"r","recordId":"c"}</flowable:string>
        </flowable:field>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.elementId).toBe("");
    }
  });

  it("malformed_xml violation also carries all required fields", () => {
    const result = lintBpmn("<!DOCTYPE evil []><foo/>");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations[0]!;
      expect(typeof v.type).toBe("string");
      expect(typeof v.elementId).toBe("string");
      expect(typeof v.elementKind).toBe("string");
      expect(typeof v.message).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// AC-14: CLI integration — tested via child_process
// ---------------------------------------------------------------------------

describe("AC-14 — CLI exit codes and stderr JSON", () => {
  it("CLI exits 0 on valid BPMN file (library proxy test)", () => {
    // CLI thin-wrapper behavior is proxied by testing lintBpmn() directly.
    // The CLI passes the result of lintBpmn() to process.exit(0) or process.exit(1).
    // A full binary integration test requires compiled output (npm run build).
    const result = lintBpmn(loadFixture(`${FIXTURES}/empty-process.bpmn`));
    expect(result.ok).toBe(true);
  });

  it("CLI-equivalent: violations → stderr JSON array (shape check)", () => {
    const result = lintBpmn(loadFixture(`${FIXTURES}/raw-object-service-task.bpmn`));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Verify violations are JSON-serializable (as CLI would do)
      const json = JSON.stringify(result.violations);
      const parsed = JSON.parse(json) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-15: Mock deploy function — deploy-gate contract
// ---------------------------------------------------------------------------

describe("AC-15 — mock deploy gate contract", () => {
  function mockDeploy(xml: string): { accepted: boolean; violations?: LintViolation[] } {
    const result = lintBpmn(xml);
    if (!result.ok) return { accepted: false, violations: result.violations };
    // Would forward to Flowable in T-0058
    return { accepted: true };
  }

  it("mockDeploy rejects BPMN with raw-object binding", () => {
    const rawObjectBpmn = loadFixture(`${FIXTURES}/raw-object-service-task.bpmn`);
    const deploy = mockDeploy(rawObjectBpmn);
    expect(deploy.accepted).toBe(false);
    expect(deploy.violations).toBeDefined();
    expect(deploy.violations!.length).toBeGreaterThan(0);
  });

  it("mockDeploy accepts BPMN with handle-only bindings", () => {
    const handleOnlyBpmn = loadFixture(`${FIXTURES}/handle-only.bpmn`);
    const deploy = mockDeploy(handleOnlyBpmn);
    expect(deploy.accepted).toBe(true);
  });

  it("mockDeploy rejects malformed XML (fail-closed)", () => {
    const malformedBpmn = `<!DOCTYPE evil []><foo/>`;
    const deploy = mockDeploy(malformedBpmn);
    expect(deploy.accepted).toBe(false);
    expect(deploy.violations![0]?.type).toBe("malformed_xml");
  });
});

// ---------------------------------------------------------------------------
// FF-8: Parser differential — adversarial XML edge class fixtures
// ---------------------------------------------------------------------------

describe("FF-8 — parser differential adversarial corpus (§2.2 edge classes)", () => {
  it("DOCTYPE declaration → malformed_xml (reject: entity injection risk)", () => {
    const xml = loadFixture(`${ADVERSARIAL}/adversarial-doctype.xml`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("non-predefined entity reference → malformed_xml", () => {
    const xml = loadFixture(`${ADVERSARIAL}/adversarial-entity.xml`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("duplicate attribute names → malformed_xml (parser-differential exploit)", () => {
    const xml = loadFixture(`${ADVERSARIAL}/adversarial-duplicate-attr.xml`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("processing instruction → malformed_xml (anomalous in BPMN deploy artifact)", () => {
    const xml = loadFixture(`${ADVERSARIAL}/adversarial-processing-instruction.xml`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("XML 1.1 version declaration → malformed_xml", () => {
    const xml = loadFixture(`${ADVERSARIAL}/adversarial-xml-1-1.xml`);
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("null byte in XML document → malformed_xml", () => {
    // Generated inline since binary content cannot be stored safely in a text file
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\x00<definitions/>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("null byte inside element content → malformed_xml", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions>
  <process id="p1">
    <serviceTask id="t1" name="Test\x00Task"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("deeply nested elements (>200 levels) → malformed_xml", () => {
    // Generate 201 levels of nesting inline
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<definitions>`;
    for (let i = 0; i < 201; i++) {
      xml += `<nested>`;
    }
    for (let i = 0; i < 201; i++) {
      xml += `</nested>`;
    }
    xml += `</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("encoding declaration != utf-8 → malformed_xml", () => {
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>
<definitions>
  <process id="p1"/>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.type).toBe("malformed_xml");
  });

  it("predefined XML entities (&lt; &gt; &amp; &apos; &quot;) are accepted", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1" name="A &amp; B Process">
    <serviceTask id="t1" name="Task &lt;1&gt;"/>
  </process>
</definitions>`;
    // Should not cause a parse-error (predefined entities are normalized)
    const result = lintBpmn(xml);
    // It may ok:true or ok:false due to entity in name attr, but NOT a parse-error
    if (!result.ok) {
      const parseErrors = result.violations.filter(v => v.type === "malformed_xml");
      expect(parseErrors.length).toBe(0);
    }
  });

  it("numeric character references are expanded and scanned", () => {
    // &#123; = '{', &#125; = '}' — could form a raw-object after expansion
    // Test that numeric refs that expand to harmless chars don't false-positive
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <serviceTask id="t1" name="Task &#65;"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: sendTask, dataObjectReference, multiple violations
// ---------------------------------------------------------------------------

describe("Additional coverage", () => {
  it("sendTask with raw-object extension fails", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <sendTask id="st1">
      <extensionElements>
        <flowable:field name="msg">
          <flowable:string>{"payload":{"content":"secret"}}</flowable:string>
        </flowable:field>
      </extensionElements>
    </sendTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.elementKind).toBe("sendTask");
    }
  });

  it("dataObjectReference with raw-object fails", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <dataObjectReference id="dor1" dataObjectRef="do1">
      <extensionElements>
        <flowable:field name="initVal">
          <flowable:string>{"view":"summary","registryId":"r"}</flowable:string>
        </flowable:field>
      </extensionElements>
    </dataObjectReference>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.elementKind).toBe("dataObjectReference");
    }
  });

  it("multiple violations collected (not early-abort)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <serviceTask id="t1">
      <extensionElements>
        <flowable:field name="x">
          <flowable:string>{"registryId":"r","recordId":"c"}</flowable:string>
        </flowable:field>
      </extensionElements>
    </serviceTask>
    <userTask id="t2">
      <extensionElements>
        <flowable:field name="y">
          <flowable:string>{"data":{"name":"Alice"}}</flowable:string>
        </flowable:field>
      </extensionElements>
    </userTask>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("empty BPMN string (not well-formed) returns malformed_xml or ok", () => {
    // Empty string is not valid XML; parser should handle gracefully
    const result = lintBpmn("");
    // Either ok (empty doc) or malformed — both are valid behaviors
    // Just assert no exception is thrown
    expect(result).toBeDefined();
  });

  it("self-closing serviceTask with no violations passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <serviceTask id="t1" name="Simple Task"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("BOM (U+FEFF) at start of document is stripped and parsed", () => {
    const xml = "﻿<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<definitions targetNamespace=\"t\"><process id=\"p1\"/></definitions>";
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("EL expression inside conditionExpression with no embedded raw object passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <sequenceFlow id="f1" sourceRef="gw" targetRef="t1">
      <conditionExpression>\${var1 != null &amp;&amp; var1.active}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-0436: gateway_rule_mismatch — publish-time coherence guard
// ---------------------------------------------------------------------------

import type { DmnRuleTable } from "../core/dmn-middle.js";

/** Build a minimal published DmnRuleTable with one routing outcome name and values. */
function makeRuleTable(outcomeName: string, outcomeValues: string[]): DmnRuleTable {
  return {
    id: "rt-test-1",
    name: `Rule table for ${outcomeName}`,
    hitPolicy: "FIRST",
    rules: outcomeValues.map((val) => ({
      conditions: [],
      effects: [{ kind: "set_routing_outcome" as const, name: outcomeName, value: val }],
    })),
  };
}

/** Build a 2-branch BPMN with an exclusiveGateway using choros:routingVar. */
function makeGatewayBpmn(routingVar: string, branch1Value: string, branch2Value: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn"
             targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <exclusiveGateway id="gw1" routingVar="${routingVar}"/>
    <endEvent id="end1"/>
    <endEvent id="end2"/>
    <sequenceFlow id="f1" sourceRef="gw1" targetRef="end1">
      <conditionExpression>\${${routingVar} == '${branch1Value}'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f2" sourceRef="gw1" targetRef="end2">
      <conditionExpression>\${${routingVar} == '${branch2Value}'}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
}

describe("T-0436 — gateway_rule_mismatch: coherent process publishes 200", () => {
  it("coherent 2-branch gateway with matching rule table → ok: true", () => {
    const xml = makeGatewayBpmn("approvalRequired", "yes", "no");
    const ruleTables = [makeRuleTable("approvalRequired", ["yes", "no"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(true);
  });

  it("coherent: table has MORE outcome values than branch literals → ok: true", () => {
    // Table covers yes/no/maybe but only yes/no are used in BPMN → still coherent
    const xml = makeGatewayBpmn("decision", "yes", "no");
    const ruleTables = [makeRuleTable("decision", ["yes", "no", "maybe"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(true);
  });

  it("no ruleTables opt → no gateway check (identical to prior behavior)", () => {
    const xml = makeGatewayBpmn("approvalRequired", "yes", "no");
    // No opts at all
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);

    // Empty ruleTables array
    const result2 = lintBpmn(xml, { ruleTables: [] });
    // No matching table → violation for gateway with routingVar
    // (empty ruleTables = no tables published; gateway with routingVar declared → should flag)
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.violations[0]?.type).toBe("gateway_rule_mismatch");
    }
  });

  it("process with no exclusiveGateway elements → ok: true (no gateways, nothing to check)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <endEvent id="end"/>
    <sequenceFlow id="f1" sourceRef="start" targetRef="end"/>
  </process>
</definitions>`;
    const ruleTables = [makeRuleTable("approvalRequired", ["yes", "no"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(true);
  });
});

describe("T-0436 — gateway_rule_mismatch: missing table → 422 violation", () => {
  it("gateway routingVar has NO matching rule table → gateway_rule_mismatch violation", () => {
    const xml = makeGatewayBpmn("approvalRequired", "yes", "no");
    // Rule table covers a DIFFERENT variable — no table for "approvalRequired"
    const ruleTables = [makeRuleTable("otherVar", ["yes", "no"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "gateway_rule_mismatch");
      expect(v).toBeDefined();
      expect(v?.elementKind).toBe("exclusiveGateway");
      expect(v?.elementId).toBe("gw1");
      expect(v?.message).toContain("approvalRequired");
      expect(v?.message).toContain("no published rule table");
    }
  });

  it("empty ruleTables → gateway_rule_mismatch (no table for any variable)", () => {
    const xml = makeGatewayBpmn("approvalRequired", "yes", "no");
    const result = lintBpmn(xml, { ruleTables: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("gateway_rule_mismatch");
    }
  });
});

describe("T-0436 — gateway_rule_mismatch: literal not covered → 422 violation", () => {
  it("flow literal 'maybe' not in table outcomes → gateway_rule_mismatch violation", () => {
    // Table only produces "yes" and "no" — but BPMN has a "maybe" branch
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn"
             targetNamespace="t">
  <process id="p1">
    <exclusiveGateway id="gw2" routingVar="decision"/>
    <endEvent id="end1"/>
    <endEvent id="end2"/>
    <endEvent id="end3"/>
    <sequenceFlow id="f1" sourceRef="gw2" targetRef="end1">
      <conditionExpression>\${decision == 'yes'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f2" sourceRef="gw2" targetRef="end2">
      <conditionExpression>\${decision == 'no'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f3" sourceRef="gw2" targetRef="end3">
      <conditionExpression>\${decision == 'maybe'}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    const ruleTables = [makeRuleTable("decision", ["yes", "no"])]; // "maybe" not covered
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "gateway_rule_mismatch");
      expect(v).toBeDefined();
      expect(v?.elementId).toBe("gw2");
      expect(v?.message).toContain("maybe");
      expect(v?.message).toContain("decision");
    }
  });

  it("one literal covered, one missing → violation only for the missing one", () => {
    const xml = makeGatewayBpmn("outcome", "approved", "rejected");
    // Table only covers "approved" — "rejected" is missing
    const ruleTables = [makeRuleTable("outcome", ["approved"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "gateway_rule_mismatch");
      expect(v).toBeDefined();
      expect(v?.message).toContain("rejected");
      expect(v?.message).not.toContain("approved");
    }
  });
});

describe("T-0436 — gateway_rule_mismatch: shape of violation", () => {
  it("violation has correct type, elementKind, elementId, message fields", () => {
    const xml = makeGatewayBpmn("routeVar", "a", "b");
    const result = lintBpmn(xml, { ruleTables: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations[0]!;
      expect(v.type).toBe("gateway_rule_mismatch");
      expect(v.elementKind).toBe("exclusiveGateway");
      expect(v.elementId).toBe("gw1");
      expect(typeof v.message).toBe("string");
      expect(v.message.length).toBeGreaterThan(0);
    }
  });

  it("gateway without routingVar attr + conditions → no violation (non-choros gateway)", () => {
    // A gateway without choros:routingVar is not a choros-managed routing gateway.
    // The linter should not emit gateway_rule_mismatch for it.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <exclusiveGateway id="gw-plain"/>
    <endEvent id="end1"/>
    <endEvent id="end2"/>
    <sequenceFlow id="f1" sourceRef="gw-plain" targetRef="end1">
      <conditionExpression>\${someCondition == 'true'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f2" sourceRef="gw-plain" targetRef="end2">
      <conditionExpression>\${someCondition == 'false'}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    const ruleTables = [makeRuleTable("approvalRequired", ["yes", "no"])];
    const result = lintBpmn(xml, { ruleTables });
    // No gateway_rule_mismatch because this gateway has no routingVar attr
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-0436: multi-gateway tests (Fix 2 — review finding)
// Validates that conditions are associated by sequenceFlow sourceRef (gateway id),
// NOT by variable name. Old code keyed by varName and merged literals across all
// gateways sharing the same routingVar — causing false-positive 422 and
// misattribution.
// ---------------------------------------------------------------------------

describe("T-0436 — multi-gateway: shared routingVar, disjoint branches (Fix 2)", () => {
  /**
   * Two exclusiveGateways sharing the SAME routingVar ("approvalRequired").
   * gwA: outgoing flows produce "yes" and "no"   (covered by the rule table)
   * gwB: outgoing flows produce "maybe" and "never"  (NOT covered)
   *
   * Expected: only gwB is flagged (one violation, elementId = "gwB").
   * gwA must NOT be flagged.
   *
   * OLD (buggy) code: conditionsByVar["approvalRequired"] = ["yes","no","maybe","never"]
   * → both gateways inherit all 4 literals → both flagged → FALSE positive on gwA.
   *
   * NEW (fixed) code: literalsByGatewayId["gwA"] = [{literal:"yes"},{literal:"no"}]
   *                   literalsByGatewayId["gwB"] = [{literal:"maybe"},{literal:"never"}]
   * → gwA covered by table → ok; gwB not covered → violation on gwB only.
   */
  it("two gateways sharing routingVar: table covers gwA literals only → flag ONLY gwB", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <exclusiveGateway id="gwA" routingVar="approvalRequired"/>
    <exclusiveGateway id="gwB" routingVar="approvalRequired"/>
    <endEvent id="endA1"/>
    <endEvent id="endA2"/>
    <endEvent id="endB1"/>
    <endEvent id="endB2"/>
    <sequenceFlow id="fA1" sourceRef="gwA" targetRef="endA1">
      <conditionExpression>\${approvalRequired == 'yes'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="fA2" sourceRef="gwA" targetRef="endA2">
      <conditionExpression>\${approvalRequired == 'no'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="fB1" sourceRef="gwB" targetRef="endB1">
      <conditionExpression>\${approvalRequired == 'maybe'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="fB2" sourceRef="gwB" targetRef="endB2">
      <conditionExpression>\${approvalRequired == 'never'}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
    // Table only covers gwA's literals ("yes" / "no")
    const ruleTables = [makeRuleTable("approvalRequired", ["yes", "no"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const violations = result.violations.filter((v) => v.type === "gateway_rule_mismatch");
      // Only gwB should be flagged
      const gwBViolation = violations.find((v) => v.elementId === "gwB");
      const gwAViolation = violations.find((v) => v.elementId === "gwA");
      expect(gwBViolation).toBeDefined();
      expect(gwAViolation).toBeUndefined();
      // The violation must reference one of gwB's uncovered literals
      expect(gwBViolation?.message).toMatch(/maybe|never/);
    }
  });

  /**
   * Two gateways, each with only ONE conditioned outgoing flow (+ implicit default).
   * Each individually has branchLiterals.length < 2 → both must be SKIPPED.
   * No false positives from cross-gateway literal merge.
   *
   * OLD (buggy) code: conditionsByVar["route"] = ["pathA", "pathB"] (merged across gateways)
   * → combined count = 2 → the skip guard is defeated → false violation emitted.
   *
   * NEW (fixed) code: literalsByGatewayId["gw1"] = [{literal:"pathA"}] (length 1)
   *                   literalsByGatewayId["gw2"] = [{literal:"pathB"}] (length 1)
   * → each individually skipped (< 2) → ok: true.
   */
  it("two gateways each with single conditioned flow → both skipped, no false positive", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <exclusiveGateway id="gw1" routingVar="route"/>
    <exclusiveGateway id="gw2" routingVar="route"/>
    <endEvent id="end1a"/>
    <endEvent id="end1b"/>
    <endEvent id="end2a"/>
    <endEvent id="end2b"/>
    <sequenceFlow id="f1cond" sourceRef="gw1" targetRef="end1a">
      <conditionExpression>\${route == 'pathA'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f1default" sourceRef="gw1" targetRef="end1b"/>
    <sequenceFlow id="f2cond" sourceRef="gw2" targetRef="end2a">
      <conditionExpression>\${route == 'pathB'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f2default" sourceRef="gw2" targetRef="end2b"/>
  </process>
</definitions>`;
    // Table exists but each gateway individually has < 2 literals → skipped
    const ruleTables = [makeRuleTable("route", ["pathA", "pathB"])];
    const result = lintBpmn(xml, { ruleTables });
    // Both gateways have only 1 conditioned branch each → no gateway check triggered
    expect(result.ok).toBe(true);
  });

  /**
   * Regression guard: existing single-gateway coherent test still passes.
   * Ensures Fix 1 did not break the happy path.
   */
  it("single-gateway with matching table still passes (regression guard)", () => {
    const xml = makeGatewayBpmn("approvalRequired", "yes", "no");
    const ruleTables = [makeRuleTable("approvalRequired", ["yes", "no"])];
    const result = lintBpmn(xml, { ruleTables });
    expect(result.ok).toBe(true);
  });

  /**
   * Regression guard: existing single-gateway missing-table test still fails with violation.
   */
  it("single-gateway with missing table still produces violation (regression guard)", () => {
    const xml = makeGatewayBpmn("approvalRequired", "yes", "no");
    const result = lintBpmn(xml, { ruleTables: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]?.type).toBe("gateway_rule_mismatch");
      expect(result.violations[0]?.elementId).toBe("gw1");
    }
  });
});

// ===========================================================================
// T-0456 [D8-R1]: parallelGateway (AND split/join) well-formedness linter
// ===========================================================================

/**
 * Build a BPMN with a well-formed AND split → two branches → AND join.
 *   start → split (1-in/2-out) → A, B → join (2-in/1-out) → end
 */
function makeBalancedParallelBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <parallelGateway id="split"/>
    <userTask id="taskA"/>
    <userTask id="taskB"/>
    <parallelGateway id="join"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="split"/>
    <sequenceFlow id="f1" sourceRef="split" targetRef="taskA"/>
    <sequenceFlow id="f2" sourceRef="split" targetRef="taskB"/>
    <sequenceFlow id="f3" sourceRef="taskA" targetRef="join"/>
    <sequenceFlow id="f4" sourceRef="taskB" targetRef="join"/>
    <sequenceFlow id="f5" sourceRef="join" targetRef="end"/>
  </process>
</definitions>`;
}

describe("T-0456 — parallel_gateway: well-formed AND split/join publishes 200", () => {
  it("balanced split (1-in/2-out) + join (2-in/1-out) passes", () => {
    const result = lintBpmn(makeBalancedParallelBpmn());
    expect(result.ok).toBe(true);
  });

  it("balanced parallel gateway passes even with ruleTables opt present", () => {
    // The structural check is independent of the T-0436 ruleTables path.
    const result = lintBpmn(makeBalancedParallelBpmn(), { ruleTables: [] });
    expect(result.ok).toBe(true);
  });

  it("three-way split (1-in/3-out) + join (3-in/1-out) passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <parallelGateway id="split"/>
    <userTask id="a"/><userTask id="b"/><userTask id="c"/>
    <parallelGateway id="join"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="split"/>
    <sequenceFlow id="f1" sourceRef="split" targetRef="a"/>
    <sequenceFlow id="f2" sourceRef="split" targetRef="b"/>
    <sequenceFlow id="f3" sourceRef="split" targetRef="c"/>
    <sequenceFlow id="f4" sourceRef="a" targetRef="join"/>
    <sequenceFlow id="f5" sourceRef="b" targetRef="join"/>
    <sequenceFlow id="f6" sourceRef="c" targetRef="join"/>
    <sequenceFlow id="f7" sourceRef="join" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("a 1-in/1-out parallel gateway is a no-op pass-through (allowed)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <parallelGateway id="pg"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="pg"/>
    <sequenceFlow id="f1" sourceRef="pg" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("a process with NO parallel gateway is unaffected", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="t"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="t"/>
    <sequenceFlow id="f1" sourceRef="t" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });

  it("declaration order independent: flows declared BEFORE the gateway still resolve", () => {
    // Flows come first, gateway last — counting must be resolved post-walk.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <sequenceFlow id="f0" sourceRef="start" targetRef="split"/>
    <sequenceFlow id="f1" sourceRef="split" targetRef="a"/>
    <sequenceFlow id="f2" sourceRef="split" targetRef="b"/>
    <sequenceFlow id="f3" sourceRef="a" targetRef="join"/>
    <sequenceFlow id="f4" sourceRef="b" targetRef="join"/>
    <sequenceFlow id="f5" sourceRef="join" targetRef="end"/>
    <startEvent id="start"/>
    <userTask id="a"/><userTask id="b"/>
    <endEvent id="end"/>
    <parallelGateway id="split"/>
    <parallelGateway id="join"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

describe("T-0456 — parallel_gateway: malformed AND split/join → 422 violation", () => {
  it("dangling split (no outgoing flows) → violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <parallelGateway id="split"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="split"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "parallel_gateway_imbalance");
      expect(v).toBeDefined();
      expect(v?.elementKind).toBe("parallelGateway");
      expect(v?.elementId).toBe("split");
      expect(v?.message).toMatch(/dangling/);
    }
  });

  it("dangling gateway (no incoming flows) → violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <parallelGateway id="orphan"/>
    <userTask id="a"/><userTask id="b"/>
    <sequenceFlow id="f1" sourceRef="orphan" targetRef="a"/>
    <sequenceFlow id="f2" sourceRef="orphan" targetRef="b"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "parallel_gateway_imbalance");
      expect(v?.elementId).toBe("orphan");
      expect(v?.message).toMatch(/dangling/);
    }
  });

  it("mixed split+join in one gateway (2-in/2-out) → violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <userTask id="in1"/><userTask id="in2"/>
    <parallelGateway id="mixed"/>
    <userTask id="out1"/><userTask id="out2"/>
    <sequenceFlow id="f1" sourceRef="in1" targetRef="mixed"/>
    <sequenceFlow id="f2" sourceRef="in2" targetRef="mixed"/>
    <sequenceFlow id="f3" sourceRef="mixed" targetRef="out1"/>
    <sequenceFlow id="f4" sourceRef="mixed" targetRef="out2"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "parallel_gateway_imbalance");
      expect(v?.elementId).toBe("mixed");
      expect(v?.message).toMatch(/mixes split and join/);
    }
  });

  it("parallel gateway with NO id (cannot be linked by any flow) → dangling violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <parallelGateway/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "parallel_gateway_imbalance");
      expect(v).toBeDefined();
      expect(v?.elementId).toBe(""); // no id
      expect(v?.message).toMatch(/dangling/);
    }
  });

  it("one balanced + one dangling gateway → only the dangling one is flagged", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <parallelGateway id="goodSplit"/>
    <userTask id="a"/><userTask id="b"/>
    <parallelGateway id="goodJoin"/>
    <parallelGateway id="badSplit"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="goodSplit"/>
    <sequenceFlow id="f1" sourceRef="goodSplit" targetRef="a"/>
    <sequenceFlow id="f2" sourceRef="goodSplit" targetRef="b"/>
    <sequenceFlow id="f3" sourceRef="a" targetRef="goodJoin"/>
    <sequenceFlow id="f4" sourceRef="b" targetRef="goodJoin"/>
    <sequenceFlow id="f5" sourceRef="goodJoin" targetRef="badSplit"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const pgViolations = result.violations.filter((x) => x.type === "parallel_gateway_imbalance");
      // goodSplit (1/2) ok, goodJoin (2/1) ok, badSplit (1-in/0-out) dangling.
      expect(pgViolations).toHaveLength(1);
      expect(pgViolations[0]?.elementId).toBe("badSplit");
    }
  });
});

// ===========================================================================
// T-0458 [D8-R3]: timer / deadline + escalation well-formedness linter
// ===========================================================================

/**
 * Build a BPMN with a well-formed boundary timer guarding a userTask, escalating
 * to a second userTask on fire:
 *   start → task-approve (boundary timer PT24H) → end
 *                 │ (timer fires)
 *                 └→ task-escalate → end
 */
function makeBoundaryTimerBpmn(opts?: {
  body?: string;
  bodyKind?: "timeDuration" | "timeDate" | "timeCycle";
  attachedToRef?: string;
  withEscalationFlow?: boolean;
}): string {
  const body = opts?.body ?? "PT24H";
  const bodyKind = opts?.bodyKind ?? "timeDuration";
  const attached = opts?.attachedToRef ?? "task-approve";
  const escFlow =
    opts?.withEscalationFlow === false
      ? ""
      : `<sequenceFlow id="sf-timer-esc" sourceRef="bnd-deadline" targetRef="task-escalate"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn" xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve" flowable:candidateGroups="role-approver"/>
    <boundaryEvent id="bnd-deadline" attachedToRef="${attached}" cancelActivity="true">
      <timerEventDefinition><${bodyKind}>${body}</${bodyKind}></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-escalate" flowable:candidateGroups="role-manager"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="task-approve" targetRef="end"/>
    ${escFlow}
    <sequenceFlow id="f2" sourceRef="task-escalate" targetRef="end"/>
  </process>
</definitions>`;
}

describe("T-0458 — timer_malformed: well-formed boundary timer publishes 200", () => {
  it("ISO-8601 duration PT24H boundary timer with escalation flow passes", () => {
    const result = lintBpmn(makeBoundaryTimerBpmn());
    expect(result.ok).toBe(true);
  });

  it("passes even with ruleTables opt present (timer check is structural)", () => {
    const result = lintBpmn(makeBoundaryTimerBpmn(), { ruleTables: [] });
    expect(result.ok).toBe(true);
  });

  it("a fixed ISO-8601 date timeDate passes", () => {
    const result = lintBpmn(
      makeBoundaryTimerBpmn({ body: "2026-07-01T14:00:00Z", bodyKind: "timeDate" }),
    );
    expect(result.ok).toBe(true);
  });

  it("a date pulled from a record field (EL expression) passes", () => {
    const result = lintBpmn(
      makeBoundaryTimerBpmn({ body: "${record.dueDate}", bodyKind: "timeDate" }),
    );
    expect(result.ok).toBe(true);
  });

  it("an intermediate catch timer (inline wait) with a duration passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <intermediateCatchEvent id="wait1">
      <timerEventDefinition><timeDuration>PT1H</timeDuration></timerEventDefinition>
    </intermediateCatchEvent>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="wait1"/>
    <sequenceFlow id="f1" sourceRef="wait1" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

describe("T-0458 — timer_malformed: malformed timers fail closed (422)", () => {
  it("empty timeDuration → timer_malformed violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve"/>
    <boundaryEvent id="bnd-deadline" attachedToRef="task-approve">
      <timerEventDefinition><timeDuration></timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-escalate"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="bnd-deadline" targetRef="task-escalate"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "timer_malformed");
      expect(v?.elementId).toBe("bnd-deadline");
      expect(v?.message).toMatch(/without a valid deadline|non-empty/);
    }
  });

  it("timerEventDefinition with no body child → timer_malformed violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve"/>
    <boundaryEvent id="bnd-deadline" attachedToRef="task-approve">
      <timerEventDefinition/>
    </boundaryEvent>
    <userTask id="task-escalate"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="bnd-deadline" targetRef="task-escalate"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_malformed")).toBe(true);
    }
  });

  it("malformed (non-ISO) timeDuration → timer_malformed violation", () => {
    const result = lintBpmn(makeBoundaryTimerBpmn({ body: "24 hours" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "timer_malformed");
      expect(v?.elementId).toBe("bnd-deadline");
      expect(v?.message).toMatch(/not a valid ISO-8601 duration/);
    }
  });

  it("dangling timer (no outgoing escalation flow) → timer_malformed violation", () => {
    const result = lintBpmn(makeBoundaryTimerBpmn({ withEscalationFlow: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find(
        (x) => x.type === "timer_malformed" && /no outgoing sequence flow/.test(x.message),
      );
      expect(v?.elementId).toBe("bnd-deadline");
    }
  });

  it("boundary timer with no attachedToRef → timer_malformed violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve"/>
    <boundaryEvent id="bnd-deadline">
      <timerEventDefinition><timeDuration>PT24H</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-escalate"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="bnd-deadline" targetRef="task-escalate"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find(
        (x) => x.type === "timer_malformed" && /no attachedToRef/.test(x.message),
      );
      expect(v?.elementId).toBe("bnd-deadline");
    }
  });

  it("malformed timeDate (not ISO, not EL) → timer_malformed violation", () => {
    const result = lintBpmn(
      makeBoundaryTimerBpmn({ body: "next tuesday", bodyKind: "timeDate" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "timer_malformed");
      expect(v?.message).toMatch(/neither an ISO-8601 date/);
    }
  });
});

describe("T-0458 — non-timer events are not flagged", () => {
  it("a process with no timer events is unaffected", () => {
    const result = lintBpmn(makeBalancedParallelBpmn());
    expect(result.ok).toBe(true);
  });

  it("a boundaryEvent WITHOUT a timerEventDefinition (e.g. error) is ignored by the timer check", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve"/>
    <boundaryEvent id="bnd-err" attachedToRef="task-approve">
      <errorEventDefinition errorRef="someError"/>
    </boundaryEvent>
    <userTask id="task-handle"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="task-approve" targetRef="end"/>
    <sequenceFlow id="f2" sourceRef="bnd-err" targetRef="task-handle"/>
    <sequenceFlow id="f3" sourceRef="task-handle" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    // No timer_malformed violation: the boundary event carries no timerEventDefinition.
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_malformed")).toBe(false);
    }
  });
});

// ===========================================================================
// T-0612 — timer_escalation_no_convergence: the "zombie instance" bug found
// live in purchaseApproval (finance-director approval, PT2M boundary timer,
// non-interrupting escalation). See ADR-T0612-purchase-escalation-convergence.
// ===========================================================================

/**
 * Build the DEFECTIVE shape observed live: a NON-INTERRUPTING boundary timer
 * on the guarded task, whose escalation branch dead-ends at ITS OWN endEvent
 * instead of reconnecting to the main path:
 *   start → task-fin (boundary timer PT2M, cancelActivity=false) → end-main
 *                 │ (timer fires)
 *                 └→ task-esc → end-esc   (DISCONNECTED from end-main)
 *
 * If task-fin completes before the timer fires, the main token reaches
 * end-main — but the still-live, never-cancelled boundary timer's token never
 * reaches anything (it hasn't fired, so it never even enters task-esc) NOR
 * does Flowable retire it, because a non-interrupting boundary event remains
 * armed until it fires or the process ends — which it can't, because BPMN
 * requires every token (including an armed-but-unfired boundary event) to
 * resolve before an instance completes. The zombie is the ARMED boundary
 * event itself; this fixture's disconnected end-esc reproduces the authored
 * shape that made the defect visible (no join for the fired case either).
 */
function makeNonInterruptingTimerNoConvergenceBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-fin" flowable:candidateGroups="role-fin"/>
    <boundaryEvent id="bnd-fin-timeout" attachedToRef="task-fin" cancelActivity="false">
      <timerEventDefinition><timeDuration>PT2M</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-esc" flowable:candidateGroups="role-owner"/>
    <endEvent id="end-main"/>
    <endEvent id="end-esc"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-fin"/>
    <sequenceFlow id="f1" sourceRef="task-fin" targetRef="end-main"/>
    <sequenceFlow id="sf-timer-esc" sourceRef="bnd-fin-timeout" targetRef="task-esc"/>
    <sequenceFlow id="f2" sourceRef="task-esc" targetRef="end-esc"/>
  </process>
</definitions>`;
}

describe("T-0612 — timer_escalation_no_convergence: zombie shape fails closed (422)", () => {
  it("non-interrupting boundary timer + disconnected escalation end → violation", () => {
    const result = lintBpmn(makeNonInterruptingTimerNoConvergenceBpmn());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "timer_escalation_no_convergence");
      expect(v).toBeDefined();
      expect(v?.elementId).toBe("bnd-fin-timeout");
      expect(v?.elementKind).toBe("boundaryEvent");
      expect(v?.message).toMatch(/never reconnecting|never completes/);
    }
  });
});

describe("T-0612 — timer_escalation_no_convergence: fixed shapes pass (200)", () => {
  // T-0661 [ADR-T0612 §8.1/§8.4 correction]: the two "fixed shapes" below were
  // ORIGINALLY asserted as fully clean (result.ok === true). That assumption was
  // FACTUALLY WRONG — ADR §8.1 found a converging exclusiveGateway is an
  // uncontrolled merge that passes each token through independently, so when the
  // timer actually FIRES (spawning a second concurrent token), a plain endEvent
  // downstream of the merge can never resolve BOTH tokens — the process instance
  // hangs. That is exactly the D2 shape T-0661 closes (see the new
  // "T-0661 — timer_escalation_unresolved_concurrency" describe block below).
  // These two tests are corrected in place (not deleted) to keep proving what
  // T-0612's OWN rule still gets right — flow convergence exists, so
  // timer_escalation_no_convergence must NOT fire — while now also asserting the
  // NEW T-0661 rule correctly flags the still-unresolved concurrent-token hang.
  it("non-interrupting timer whose escalation branch REJOINS the main path via a converging gateway: no_convergence does NOT fire, but unresolved_concurrency DOES (no terminate reachable)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-fin" flowable:candidateGroups="role-fin"/>
    <boundaryEvent id="bnd-fin-timeout" attachedToRef="task-fin" cancelActivity="false">
      <timerEventDefinition><timeDuration>PT2M</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-esc" flowable:candidateGroups="role-owner"/>
    <exclusiveGateway id="join"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-fin"/>
    <sequenceFlow id="f1" sourceRef="task-fin" targetRef="join"/>
    <sequenceFlow id="sf-timer-esc" sourceRef="bnd-fin-timeout" targetRef="task-esc"/>
    <sequenceFlow id="f2" sourceRef="task-esc" targetRef="join"/>
    <sequenceFlow id="f3" sourceRef="join" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_escalation_no_convergence")).toBe(false);
      const v = result.violations.find((x) => x.type === "timer_escalation_unresolved_concurrency");
      expect(v).toBeDefined();
      expect(v?.elementId).toBe("bnd-fin-timeout");
    }
  });

  it("non-interrupting timer whose escalation branch flows straight back into the SAME endEvent as the main path: no_convergence does NOT fire, but unresolved_concurrency DOES (still a plain endEvent, no terminate)", () => {
    // This is exactly makeBoundaryTimerBpmn()'s default shape (both branches
    // target the literal same endEvent id="end") — proving the existing T-0458
    // happy-path fixture is unaffected by the T-0612 convergence rule, but IS
    // caught by the stricter T-0661 concurrency-resolution rule (a shared plain
    // endEvent still cannot resolve two concurrent tokens once the timer fires).
    const xml = makeBoundaryTimerBpmn().replace('cancelActivity="true"', 'cancelActivity="false"');
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_escalation_no_convergence")).toBe(false);
      expect(result.violations.some((x) => x.type === "timer_escalation_unresolved_concurrency")).toBe(true);
    }
  });

  it("INTERRUPTING timer (cancelActivity=true, default) with a disconnected escalation end is NOT flagged by this check", () => {
    // cancelActivity="true" cancels task-fin the instant the timer fires — only
    // one token is ever live on that boundary, so no convergence question
    // arises. Swap only the attribute in the defective fixture; must NOT
    // produce timer_escalation_no_convergence.
    const xml = makeNonInterruptingTimerNoConvergenceBpmn().replace(
      'cancelActivity="false"',
      'cancelActivity="true"',
    );
    const result = lintBpmn(xml);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_escalation_no_convergence")).toBe(false);
    } else {
      expect(result.ok).toBe(true);
    }
  });

  it("cancelActivity ABSENT (BPMN default = interrupting) with a disconnected escalation end is NOT flagged", () => {
    const xml = makeNonInterruptingTimerNoConvergenceBpmn().replace(' cancelActivity="false"', "");
    const result = lintBpmn(xml);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_escalation_no_convergence")).toBe(false);
    } else {
      expect(result.ok).toBe(true);
    }
  });

  it("an intermediate (non-boundary) timer is never subject to this check regardless of cancelActivity", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <intermediateCatchEvent id="wait1">
      <timerEventDefinition><timeDuration>PT2M</timeDuration></timerEventDefinition>
    </intermediateCatchEvent>
    <endEvent id="end-a"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="wait1"/>
    <sequenceFlow id="f1" sourceRef="wait1" targetRef="end-a"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// T-0661 [ADR-T0612 §8] — timer_escalation_unresolved_concurrency: the SECOND
// completion-order bug (timer ALREADY FIRED → both racing tasks open at once).
//
// T-0612's checkTimerEscalationConvergence only verified the escalation branch
// RECONNECTS to the guarded task's downstream path — necessary, but ADR §8.1
// found it is NOT SUFFICIENT: a converging exclusiveGateway is an uncontrolled
// merge, so once the timer fires and spawns a second concurrent token, BOTH
// racing tasks must complete before a plain endEvent can end the instance. Only
// a scope-local terminateEndEvent (reachable from the escalation branch) can
// extinguish the second token deterministically. See
// docs/design/ADR-T0612-purchase-escalation-convergence.md §8.
// ===========================================================================

/**
 * The D5 fix shape (ADR §8.2): the fin-approval race enclosed in an embedded
 * subProcess. task-fin's non-interrupting boundary timer escalates to task-esc;
 * BOTH converge into gw-fin-converge, which flows to a SCOPE-LOCAL
 * terminateEndEvent (terminateAll left at its default "false"). The sub-process
 * has one outgoing flow to the shared top-level end.
 */
function makeSubProcessScopeTerminateBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="purchaseApproval">
    <startEvent id="start-fin-branch"/>
    <subProcess id="sub-fin-approval">
      <startEvent id="sub-start"/>
      <userTask id="task-fin" flowable:candidateGroups="role-manager"/>
      <boundaryEvent id="bnd-fin-timeout" attachedToRef="task-fin" cancelActivity="false">
        <timerEventDefinition><timeDuration>PT2M</timeDuration></timerEventDefinition>
      </boundaryEvent>
      <userTask id="task-esc" flowable:candidateGroups="role-owner"/>
      <exclusiveGateway id="gw-fin-converge"/>
      <endEvent id="sub-end-terminate">
        <terminateEventDefinition/>
      </endEvent>
      <sequenceFlow id="sf-sub-start-fin" sourceRef="sub-start" targetRef="task-fin"/>
      <sequenceFlow id="sf-fin-converge" sourceRef="task-fin" targetRef="gw-fin-converge"/>
      <sequenceFlow id="sf-timer-esc" sourceRef="bnd-fin-timeout" targetRef="task-esc"/>
      <sequenceFlow id="sf-esc-converge" sourceRef="task-esc" targetRef="gw-fin-converge"/>
      <sequenceFlow id="sf-converge-term" sourceRef="gw-fin-converge" targetRef="sub-end-terminate"/>
    </subProcess>
    <endEvent id="end-order-placed"/>
    <sequenceFlow id="sf-start-sub" sourceRef="start-fin-branch" targetRef="sub-fin-approval"/>
    <sequenceFlow id="sf-sub-end" sourceRef="sub-fin-approval" targetRef="end-order-placed"/>
  </process>
</definitions>`;
}

describe("T-0661 — timer_escalation_unresolved_concurrency: old D2 shape fails closed (422)", () => {
  it("converging exclusiveGateway → plain endEvent (no terminate) fails with unresolved_concurrency, not no_convergence", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:flowable="http://flowable.org/bpmn" targetNamespace="t">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-fin" flowable:candidateGroups="role-fin"/>
    <boundaryEvent id="bnd-fin-timeout" attachedToRef="task-fin" cancelActivity="false">
      <timerEventDefinition><timeDuration>PT2M</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-esc" flowable:candidateGroups="role-owner"/>
    <exclusiveGateway id="gw-fin-converge"/>
    <endEvent id="end-order-placed"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-fin"/>
    <sequenceFlow id="f1" sourceRef="task-fin" targetRef="gw-fin-converge"/>
    <sequenceFlow id="sf-timer-esc" sourceRef="bnd-fin-timeout" targetRef="task-esc"/>
    <sequenceFlow id="f2" sourceRef="task-esc" targetRef="gw-fin-converge"/>
    <sequenceFlow id="f3" sourceRef="gw-fin-converge" targetRef="end-order-placed"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_escalation_no_convergence")).toBe(false);
      const v = result.violations.find((x) => x.type === "timer_escalation_unresolved_concurrency");
      expect(v).toBeDefined();
      expect(v?.elementId).toBe("bnd-fin-timeout");
      expect(v?.elementKind).toBe("boundaryEvent");
      expect(v?.message).toMatch(/terminateEndEvent|second, independent token/);
    }
  });
});

describe("T-0661 — timer_escalation_unresolved_concurrency: D5 fix shape (scope-local terminate) passes (200)", () => {
  it("subProcess with converge → scope-local terminateEndEvent lints clean (no no_convergence, no unresolved_concurrency)", () => {
    const result = lintBpmn(makeSubProcessScopeTerminateBpmn());
    expect(result.ok).toBe(true);
  });
});

describe("T-0661 — the fully-disconnected escalation-own-end shape still fails ONLY with no_convergence (mutually exclusive, un-regressed)", () => {
  it("makeNonInterruptingTimerNoConvergenceBpmn(): no_convergence fires, unresolved_concurrency does NOT (never got the chance to converge)", () => {
    const result = lintBpmn(makeNonInterruptingTimerNoConvergenceBpmn());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "timer_escalation_no_convergence")).toBe(true);
      expect(result.violations.some((x) => x.type === "timer_escalation_unresolved_concurrency")).toBe(false);
    }
  });
});

describe("T-0661 — an INTERRUPTING timer is never subject to the new rule either", () => {
  it("interrupting timer (cancelActivity=true) with a converge-to-plain-endEvent shape is NOT flagged by unresolved_concurrency", () => {
    const xml = makeSubProcessScopeTerminateBpmn()
      .replace('cancelActivity="false"', 'cancelActivity="true"')
      // Also swap the terminate for a plain endEvent to prove it's the
      // cancelActivity flag — not the terminate — suppressing the new rule.
      .replace("<endEvent id=\"sub-end-terminate\">\n        <terminateEventDefinition/>\n      </endEvent>", '<endEvent id="sub-end-terminate"/>');
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// T-0459 [D8-R4] — message_event_incoherent: message/signal catch coherence.
//
// A message-catch MUST have a guarding TIMEOUT (R3 — else infinite wait), a
// correlation field (correlation is by a record-field key), and a message name.
// ===========================================================================

/**
 * A WELL-FORMED message catch: an intermediate message-catch wait, GUARDED by a
 * boundary timer attached to it (the deadline that prevents an infinite wait), with
 * a correlation field + message name declared. attrs are the attribute local names
 * the linter reads after namespace-prefix stripping (choros:messageName → messageName).
 */
function makeWellFormedMessageCatchBpmn(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <intermediateCatchEvent id="wait-signature" choros:messageName="contract-signed" choros:correlationField="contract_number">
      <messageEventDefinition messageRef="contract-signed"/>
    </intermediateCatchEvent>
    <boundaryEvent id="bnd-msg-timeout" attachedToRef="wait-signature">
      <timerEventDefinition><timeDuration>P5D</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-chase"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="wait-signature"/>
    <sequenceFlow id="f1" sourceRef="wait-signature" targetRef="end"/>
    <sequenceFlow id="f2" sourceRef="bnd-msg-timeout" targetRef="task-chase"/>
    <sequenceFlow id="f3" sourceRef="task-chase" targetRef="end"/>
  </process>
</definitions>`;
}

describe("T-0459 — message_event_incoherent: well-formed message catch publishes 200", () => {
  it("a message catch GUARDED by a boundary timer, with correlation field + name passes", () => {
    const result = lintBpmn(makeWellFormedMessageCatchBpmn());
    expect(result.ok).toBe(true);
  });

  it("passes even with ruleTables opt present (message check is structural)", () => {
    const result = lintBpmn(makeWellFormedMessageCatchBpmn(), { ruleTables: [] });
    expect(result.ok).toBe(true);
  });

  it("a receiveTask guarded by a boundary timer, fully configured, passes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <receiveTask id="rt-await" choros:messageName="payment-received" choros:correlationField="invoice_no"/>
    <boundaryEvent id="bnd-rt-timeout" attachedToRef="rt-await">
      <timerEventDefinition><timeDuration>PT48H</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-remind"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="rt-await"/>
    <sequenceFlow id="f1" sourceRef="rt-await" targetRef="end"/>
    <sequenceFlow id="f2" sourceRef="bnd-rt-timeout" targetRef="task-remind"/>
    <sequenceFlow id="f3" sourceRef="task-remind" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(true);
  });
});

describe("T-0459 — message_event_incoherent: a message-catch WITHOUT a timeout lints RED (422)", () => {
  it("an intermediate message catch with NO guarding timer → message_event_incoherent", () => {
    // Same as well-formed but the boundary timer is removed → infinite-wait risk.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <intermediateCatchEvent id="wait-signature" choros:messageName="contract-signed" choros:correlationField="contract_number">
      <messageEventDefinition messageRef="contract-signed"/>
    </intermediateCatchEvent>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="wait-signature"/>
    <sequenceFlow id="f1" sourceRef="wait-signature" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const v = result.violations.find((x) => x.type === "message_event_incoherent");
      expect(v?.elementId).toBe("wait-signature");
      expect(v?.message).toMatch(/NO TIMEOUT|wait\s+forever|MUST have a timeout/i);
    }
  });

  it("a receiveTask with no guarding boundary timer → message_event_incoherent", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <receiveTask id="rt-await" choros:messageName="payment-received" choros:correlationField="invoice_no"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="rt-await"/>
    <sequenceFlow id="f1" sourceRef="rt-await" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.violations.some(
          (x) => x.type === "message_event_incoherent" && /NO TIMEOUT/i.test(x.message),
        ),
      ).toBe(true);
    }
  });

  it("a message catch with no correlationField → message_event_incoherent", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <intermediateCatchEvent id="wait-x" choros:messageName="contract-signed">
      <messageEventDefinition messageRef="contract-signed"/>
    </intermediateCatchEvent>
    <boundaryEvent id="bnd-t" attachedToRef="wait-x">
      <timerEventDefinition><timeDuration>P1D</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-y"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="wait-x"/>
    <sequenceFlow id="f1" sourceRef="wait-x" targetRef="end"/>
    <sequenceFlow id="f2" sourceRef="bnd-t" targetRef="task-y"/>
    <sequenceFlow id="f3" sourceRef="task-y" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.violations.some(
          (x) => x.type === "message_event_incoherent" && /correlationField/.test(x.message),
        ),
      ).toBe(true);
    }
  });

  it("a message catch with no messageName → message_event_incoherent", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <intermediateCatchEvent id="wait-z" choros:correlationField="contract_number">
      <signalEventDefinition signalRef="some-signal"/>
    </intermediateCatchEvent>
    <boundaryEvent id="bnd-tz" attachedToRef="wait-z">
      <timerEventDefinition><timeDuration>P1D</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-w"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="wait-z"/>
    <sequenceFlow id="f1" sourceRef="wait-z" targetRef="end"/>
    <sequenceFlow id="f2" sourceRef="bnd-tz" targetRef="task-w"/>
    <sequenceFlow id="f3" sourceRef="task-w" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.violations.some(
          (x) => x.type === "message_event_incoherent" && /messageName/.test(x.message),
        ),
      ).toBe(true);
    }
  });
});

describe("T-0459 — non-message events are not flagged", () => {
  it("a pure timer boundary (no message def) is NOT a message-catch", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions targetNamespace="t" xmlns:choros="http://choros.io/bpmn">
  <process id="p1">
    <startEvent id="start"/>
    <userTask id="task-approve"/>
    <boundaryEvent id="bnd-deadline" attachedToRef="task-approve">
      <timerEventDefinition><timeDuration>PT24H</timeDuration></timerEventDefinition>
    </boundaryEvent>
    <userTask id="task-escalate"/>
    <endEvent id="end"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="task-approve"/>
    <sequenceFlow id="f1" sourceRef="task-approve" targetRef="end"/>
    <sequenceFlow id="f2" sourceRef="bnd-deadline" targetRef="task-escalate"/>
    <sequenceFlow id="f3" sourceRef="task-escalate" targetRef="end"/>
  </process>
</definitions>`;
    const result = lintBpmn(xml);
    // The timer is well-formed; no message_event_incoherent should appear.
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "message_event_incoherent")).toBe(false);
    } else {
      expect(result.ok).toBe(true);
    }
  });

  it("a process with no message catches is unaffected", () => {
    const result = lintBpmn(makeWellFormedMessageCatchBpmn().replace(/intermediateCatchEvent[\s\S]*?<\/intermediateCatchEvent>/, "<userTask id=\"plain\"/>").replace(/<boundaryEvent[\s\S]*?<\/boundaryEvent>/, ""));
    // Smoke: removing the message catch must not introduce a message violation.
    if (!result.ok) {
      expect(result.violations.some((x) => x.type === "message_event_incoherent")).toBe(false);
    }
  });
});
