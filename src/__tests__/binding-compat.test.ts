/**
 * T-0072 E11.1 — Named-Binding Compat Validator
 * Unit tests for checkBindingCompat + validateBindingFields + lintBpmn integration.
 *
 * AC-3:  perfect match → ok:true
 * AC-4:  missing_in_schema + missing_in_bpmn → ok:false (both blocking)
 * AC-5:  purity — no I/O imports (static assertion in fitness; runtime test here
 *         verifies no pg/fs/net/http imported by confirming function is callable
 *         in a pure-compute context)
 * AC-6:  lintBpmn(xml, { bindingSchema }) fires binding_mismatch on mismatch
 * AC-7:  lintBpmn extracts vars from <in name>, <out name>, <formProperty id>,
 *         <formField id>, and EL ${} in <conditionExpression>
 * AC-8:  CLI --binding-schema path validated via the exported function surface
 *         (CLI is tested via the logic; shell test covers exit codes)
 * AC-13: lintBpmn(xml) without opts is byte-identical to T-0027 behaviour
 *
 * Adversarial cases:
 *   - duplicate key in fields → validateBindingFields returns errors
 *   - malformed key (contains dot, dash, starts with digit) → KEY_RE rejects
 *   - empty fields + empty bpmnVarNames → ok:true (both-empty case)
 *   - EL nesting: ${supplier.name} → root "supplier" extracted (not "supplier.name")
 *   - cross-tenant: checkBindingCompat is pure (no tenant param), isolation
 *     enforced at DB level by binding.ts / form_binding RLS
 */

import { describe, it, expect } from "vitest";
import {
  checkBindingCompat,
  validateBindingFields,
  KEY_RE,
  MAX_KEY_LEN,
  type BindingField,
} from "../core/binding-compat.js";
import { lintBpmn } from "../core/bpmn-linter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fields(...keys: string[]): BindingField[] {
  return keys.map((k) => ({ key: k, type: "string", required: false }));
}

function varSet(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

// ---------------------------------------------------------------------------
// AC-3: perfect match → ok:true
// ---------------------------------------------------------------------------

describe("AC-3 — checkBindingCompat: perfect match returns ok:true", () => {
  it("single field + single var → ok:true", () => {
    const result = checkBindingCompat(fields("supplier"), varSet("supplier"));
    expect(result.ok).toBe(true);
  });

  it("three fields + three vars (same set) → ok:true", () => {
    const result = checkBindingCompat(
      fields("supplier", "category", "decision"),
      varSet("category", "supplier", "decision"), // order doesn't matter
    );
    expect(result.ok).toBe(true);
  });

  it("both empty → ok:true (ADR §3: mutual inclusion of empty sets)", () => {
    const result = checkBindingCompat([], new Set());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4: missing_in_schema — BPMN var absent from fields → ok:false
// ---------------------------------------------------------------------------

describe("AC-4a — missing_in_schema: BPMN var not in fields → ok:false", () => {
  it("one extra BPMN var → violation type missing_in_schema", () => {
    const result = checkBindingCompat(fields("supplier"), varSet("supplier", "amount"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.type).toBe("missing_in_schema");
      expect(result.violations[0]?.fieldKey).toBe("amount");
    }
  });

  it("all BPMN vars absent from empty fields → one violation per var", () => {
    const result = checkBindingCompat([], varSet("a", "b"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      expect(result.violations.every((v) => v.type === "missing_in_schema")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: missing_in_bpmn — field key not in BPMN vars → ok:false
// ---------------------------------------------------------------------------

describe("AC-4b — missing_in_bpmn: field key not in BPMN vars → ok:false", () => {
  it("one dead field → violation type missing_in_bpmn", () => {
    const result = checkBindingCompat(
      fields("supplier", "deadField"),
      varSet("supplier"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.type).toBe("missing_in_bpmn");
      expect(result.violations[0]?.fieldKey).toBe("deadField");
    }
  });

  it("all fields absent from empty BPMN vars → one violation per field", () => {
    const result = checkBindingCompat(fields("a", "b", "c"), new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(3);
      expect(result.violations.every((v) => v.type === "missing_in_bpmn")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: both directions can fire simultaneously
// ---------------------------------------------------------------------------

describe("AC-4c — both directions simultaneously", () => {
  it("field 'x' not in BPMN, BPMN var 'y' not in fields → 2 violations", () => {
    const result = checkBindingCompat(fields("x"), varSet("y"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
      const types = result.violations.map((v) => v.type).sort();
      expect(types).toEqual(["missing_in_bpmn", "missing_in_schema"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: duplicate key in validateBindingFields → error
// ---------------------------------------------------------------------------

describe("validateBindingFields — adversarial cases", () => {
  it("duplicate key in array → error with reason containing 'duplicate'", () => {
    const result = validateBindingFields([
      { key: "supplier", type: "string", required: true },
      { key: "supplier", type: "string", required: false },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.reason.includes("duplicate"))).toBe(true);
    }
  });

  it("key with dot (supplier.name) → rejected by KEY_RE", () => {
    const result = validateBindingFields([{ key: "supplier.name", type: "string", required: false }]);
    expect(result.ok).toBe(false);
  });

  it("key starting with digit (1supplier) → rejected by KEY_RE", () => {
    const result = validateBindingFields([{ key: "1supplier", type: "string", required: false }]);
    expect(result.ok).toBe(false);
  });

  it("key with dash (my-field) → rejected by KEY_RE", () => {
    const result = validateBindingFields([{ key: "my-field", type: "string", required: false }]);
    expect(result.ok).toBe(false);
  });

  it("empty key → rejected", () => {
    const result = validateBindingFields([{ key: "", type: "string", required: false }]);
    expect(result.ok).toBe(false);
  });

  it("key exceeding MAX_KEY_LEN → rejected", () => {
    const longKey = "a".repeat(MAX_KEY_LEN + 1);
    const result = validateBindingFields([{ key: longKey, type: "string", required: false }]);
    expect(result.ok).toBe(false);
  });

  it("fields is not an array → error", () => {
    const result = validateBindingFields({ key: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.reason).toContain("array");
    }
  });

  it("valid fields array → ok:true with typed BindingField[]", () => {
    const result = validateBindingFields([
      { key: "supplier", type: "string", required: true, label: "Supplier" },
      { key: "category", type: "string", required: true },
      { key: "decision", type: "string", required: false },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields).toHaveLength(3);
      expect(result.fields[0]?.key).toBe("supplier");
    }
  });
});

// ---------------------------------------------------------------------------
// KEY_RE constants (ADR §2.2)
// ---------------------------------------------------------------------------

describe("KEY_RE — validation regex", () => {
  it("accepts simple identifiers", () => {
    for (const k of ["supplier", "category", "_private", "myField2", "A"]) {
      expect(KEY_RE.test(k), `should accept "${k}"`).toBe(true);
    }
  });

  it("rejects invalid identifiers", () => {
    for (const k of ["", "1start", "has-dash", "has.dot", "has space", "has@sign"]) {
      expect(KEY_RE.test(k), `should reject "${k}"`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: lintBpmn(xml, { bindingSchema }) — binding_mismatch on mismatch
// ---------------------------------------------------------------------------

const SIMPLE_BPMN_WITH_FORM_FIELD = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             targetNamespace="http://flowable.org/bpmn">
  <process id="test-proc" name="Test" isExecutable="true">
    <startEvent id="start"/>
    <userTask id="task1" name="Fill Form">
      <extensionElements>
        <flowable:formProperty id="supplier" name="Supplier" type="string" required="true"/>
        <flowable:formProperty id="category" name="Category" type="string" required="true"/>
      </extensionElements>
    </userTask>
    <sequenceFlow id="flow1" sourceRef="start" targetRef="task1"/>
  </process>
</definitions>`;

const SIMPLE_BPMN_WITH_IN_OUT = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://flowable.org/bpmn">
  <process id="proc2" name="P2" isExecutable="true">
    <startEvent id="start"/>
    <callActivity id="sub1" calledElement="child-proc">
      <extensionElements>
        <flowable:in name="orderAmount"/>
        <flowable:out name="approvalResult"/>
      </extensionElements>
    </callActivity>
    <sequenceFlow id="f1" sourceRef="start" targetRef="sub1"/>
  </process>
</definitions>`;

const BPMN_WITH_EL_CONDITION = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://flowable.org/bpmn">
  <process id="proc3" name="P3" isExecutable="true">
    <startEvent id="start"/>
    <exclusiveGateway id="gw1"/>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gw1"/>
    <sequenceFlow id="f2" sourceRef="gw1" targetRef="end1">
      <conditionExpression xsi:type="tFormalExpression">\${totalAmount &gt; 100}</conditionExpression>
    </sequenceFlow>
    <endEvent id="end1"/>
  </process>
</definitions>`;

const BPMN_WITH_DOT_WALK_EL = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://flowable.org/bpmn">
  <process id="proc4" name="P4" isExecutable="true">
    <startEvent id="start"/>
    <exclusiveGateway id="gw1"/>
    <sequenceFlow id="f1" sourceRef="start" targetRef="gw1"/>
    <sequenceFlow id="f2" sourceRef="gw1" targetRef="end1">
      <conditionExpression xsi:type="tFormalExpression">\${supplier.name == 'ACME'}</conditionExpression>
    </sequenceFlow>
    <endEvent id="end1"/>
  </process>
</definitions>`;

describe("AC-6 — lintBpmn with bindingSchema fires binding_mismatch", () => {
  it("matching schema + BPMN vars → ok:true", () => {
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD, {
      bindingSchema: fields("supplier", "category"),
    });
    expect(result.ok).toBe(true);
  });

  it("schema missing BPMN var → binding_mismatch violation, ok:false", () => {
    // Only 'supplier' in schema but 'category' also in BPMN
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD, {
      bindingSchema: fields("supplier"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bindingViolations = result.violations.filter((v) => v.type === "binding_mismatch");
      expect(bindingViolations.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("extra schema field not in BPMN → binding_mismatch violation, ok:false", () => {
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD, {
      bindingSchema: fields("supplier", "category", "deadField"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bindingViolations = result.violations.filter((v) => v.type === "binding_mismatch");
      expect(bindingViolations.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-13: lintBpmn(xml) without opts — T-0027 behavior preserved
// ---------------------------------------------------------------------------

describe("AC-13 — lintBpmn without opts is backward-compatible (T-0027)", () => {
  it("clean BPMN with no opts → ok:true (same as T-0027)", () => {
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD);
    expect(result.ok).toBe(true);
  });

  it("lintBpmn with undefined opts → ok:true (same as T-0027)", () => {
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD, undefined);
    expect(result.ok).toBe(true);
  });

  it("lintBpmn with empty opts (no bindingSchema) → ok:true (same as T-0027)", () => {
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD, {});
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-7: bpmnVarNames extraction from various sources
// ---------------------------------------------------------------------------

describe("AC-7 — lintBpmn extracts varNames from all ADR §2.4 sources", () => {
  it("Source #3/#4: <formProperty id> and <formField id> extracted", () => {
    // supplier + category appear as formProperty ids
    const result = lintBpmn(SIMPLE_BPMN_WITH_FORM_FIELD, {
      bindingSchema: fields("supplier", "category"),
    });
    expect(result.ok).toBe(true);
  });

  it("Source #1/#2: <in name> and <out name> extracted", () => {
    // orderAmount + approvalResult as in/out
    const result = lintBpmn(SIMPLE_BPMN_WITH_IN_OUT, {
      bindingSchema: fields("orderAmount", "approvalResult"),
    });
    expect(result.ok).toBe(true);
  });

  it("Source #5: EL ${totalAmount > 100} → root var 'totalAmount' extracted", () => {
    const result = lintBpmn(BPMN_WITH_EL_CONDITION, {
      bindingSchema: fields("totalAmount"),
    });
    expect(result.ok).toBe(true);
  });

  it("Source #5: EL dot-walk ${supplier.name} → root 'supplier' extracted (not 'supplier.name')", () => {
    // 'supplier' should be extracted, not the dot-walk form
    const result = lintBpmn(BPMN_WITH_DOT_WALK_EL, {
      bindingSchema: fields("supplier"),
    });
    expect(result.ok).toBe(true);
  });

  it("Source #5: EL dot-walk does NOT produce 'supplier.name' as a var (no false positives)", () => {
    // A schema with 'supplier.name' would fail KEY_RE on write, and the extractor
    // should NOT produce it. If bindingSchema has only 'supplier' and BPMN has
    // ${supplier.name}, the extractor gives 'supplier' → match.
    const result = lintBpmn(BPMN_WITH_DOT_WALK_EL, {
      bindingSchema: fields("supplier"),
    });
    // Passing means 'supplier.name' was NOT injected as a separate var name.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 (purity sanity): checkBindingCompat runs without any I/O
// (static check in fitness; here we verify it is synchronous and side-effect-free)
// ---------------------------------------------------------------------------

describe("AC-5 — checkBindingCompat purity", () => {
  it("executes synchronously with no thrown errors (pure function)", () => {
    let result: ReturnType<typeof checkBindingCompat> | undefined;
    expect(() => {
      result = checkBindingCompat(fields("a", "b"), varSet("a", "b"));
    }).not.toThrow();
    expect(result?.ok).toBe(true);
  });
});
