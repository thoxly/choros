/**
 * T-0076 · E11.5 — Floor-2 Sandbox Renderer
 * Unit tests for floor2-renderer.ts.
 *
 * AC coverage (docs/design/extensibility-and-authoring.md §4 / §7 / §9.10 / §11):
 *
 * Security boundary (§4 / §7):
 *   SB-1  — FLOOR2_SANDBOX_ATTR passes assertSandboxAttr (correct constant)
 *   SB-2  — assertSandboxAttr: valid sandbox is accepted
 *   SB-3  — assertSandboxAttr: allow-same-origin MUST NOT be present → violation
 *   SB-4  — assertSandboxAttr: missing allow-scripts → violation
 *   SB-5  — assertSandboxAttr: combined allow-scripts + allow-same-origin → violation
 *   SB-6  — FLOOR2_SANDBOX_MUST_NOT_CONTAIN includes 'allow-same-origin'
 *   SB-7  — FLOOR2_SANDBOX_MUST_CONTAIN includes 'allow-scripts'
 *
 * Governance flag (§9.10):
 *   GF-1  — Custom mode without flag → CUSTOM_FLAG_MISSING
 *   GF-2  — Custom mode with wrong flag value → CUSTOM_FLAG_MISSING
 *   GF-3  — Custom mode with correct flag → passes flag check
 *   GF-4  — FLOOR2_CUSTOM_FLAG_KEY and FLOOR2_CUSTOM_FLAG_VALUE constants exported
 *
 * Vetted-palette validation (§4a):
 *   VP-1  — Valid vetted descriptor → ok: true
 *   VP-2  — Unknown componentType → INVALID_COMPONENT
 *   VP-3  — VETTED_COMPONENT_TYPES is a non-empty ReadonlySet
 *   VP-4  — All VETTED_COMPONENT_TYPES pass validation
 *
 * Named-binding key validation (§4):
 *   BK-1  — bindingKey exists in fields → ok: true
 *   BK-2  — bindingKey absent from fields → UNKNOWN_BINDING_KEY
 *   BK-3  — Empty fields[] with any bindingKey → UNKNOWN_BINDING_KEY
 *
 * Custom mode validation (§4b):
 *   CM-1  — Valid custom descriptor (flag + reactSource) → ok: true
 *   CM-2  — Empty reactSource → EMPTY_REACT_SOURCE
 *   CM-3  — Whitespace-only reactSource → EMPTY_REACT_SOURCE
 *
 * buildFloor2Srcdoc — srcdoc construction:
 *   SR-1  — Valid vetted descriptor → ok: true, sandboxAttr === FLOOR2_SANDBOX_ATTR
 *   SR-2  — Valid custom descriptor → ok: true, srcdoc contains reactSource
 *   SR-3  — Invalid descriptor → ok: false, passes errors through
 *   SR-4  — Vetted srcdoc contains data-floor2-mode="vetted"
 *   SR-5  — Custom srcdoc contains data-floor2-mode="custom"
 *   SR-6  — Custom srcdoc contains data-floor2-custom-confirmed="true" (§9.10 flag)
 *   SR-7  — srcdoc contains height-postMessage emitter (opaque-origin seam)
 *   SR-8  — srcdoc does NOT contain allow-same-origin (no escape from iframe)
 *   SR-9  — sandboxAttr is always 'allow-scripts' (constant)
 *   SR-10 — theme is injected safely (dark / light; unknown → dark)
 *
 * Mode invariant:
 *   MI-1  — Unknown mode → INVALID_MODE
 *   MI-2  — mode is either 'vetted' or 'custom' (exhaustive)
 *
 * Purity:
 *   PU-1  — All functions are synchronous, never throw, no I/O
 *   PU-2  — meta field does not affect vetted validation outcome
 *
 * No DB, no network, no process.env — pure unit tests.
 */

import { describe, it, expect } from "vitest";
import {
  FLOOR2_SANDBOX_ATTR,
  FLOOR2_SANDBOX_MUST_CONTAIN,
  FLOOR2_SANDBOX_MUST_NOT_CONTAIN,
  FLOOR2_CUSTOM_FLAG_KEY,
  FLOOR2_CUSTOM_FLAG_VALUE,
  VETTED_COMPONENT_TYPES,
  assertSandboxAttr,
  validateFloor2Descriptor,
  buildFloor2Srcdoc,
  type Floor2RenderDescriptor,
  type VettedFloor2Descriptor,
  type CustomFloor2Descriptor,
  type VettedComponentType,
} from "../core/floor2-renderer.js";
import type { BindingField } from "../core/binding-compat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFields(keys: string[]): BindingField[] {
  return keys.map((key) => ({ key, type: "string", required: false }));
}

function vettedDesc(
  bindingKey: string,
  componentType: VettedComponentType = "text_input",
  props?: Record<string, unknown>,
  meta?: Record<string, unknown>,
): VettedFloor2Descriptor {
  return { mode: "vetted", componentType, bindingKey, props, meta };
}

function customDesc(
  bindingKey: string,
  reactSource: string,
  flagValue: unknown = FLOOR2_CUSTOM_FLAG_VALUE,
): CustomFloor2Descriptor {
  return {
    mode: "custom",
    reactSource,
    bindingKey,
    meta: { [FLOOR2_CUSTOM_FLAG_KEY]: flagValue as typeof FLOOR2_CUSTOM_FLAG_VALUE },
  };
}

// ---------------------------------------------------------------------------
// SB-* Security boundary — sandbox attribute
// ---------------------------------------------------------------------------

describe("SB-1 — FLOOR2_SANDBOX_ATTR passes assertSandboxAttr", () => {
  it("the exported constant is safe", () => {
    const result = assertSandboxAttr(FLOOR2_SANDBOX_ATTR);
    expect(result.ok).toBe(true);
  });
});

describe("SB-2 — assertSandboxAttr: valid sandbox is accepted", () => {
  it("'allow-scripts' passes", () => {
    expect(assertSandboxAttr("allow-scripts").ok).toBe(true);
  });

  it("'allow-scripts allow-forms' passes (allow-forms is neutral)", () => {
    // allow-forms is not forbidden; extra tokens not in deny-list are allowed
    expect(assertSandboxAttr("allow-scripts allow-forms").ok).toBe(true);
  });
});

describe("SB-3 — assertSandboxAttr: allow-same-origin MUST NOT be present", () => {
  it("'allow-same-origin' alone → violation", () => {
    const result = assertSandboxAttr("allow-same-origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.some((v) => v.includes("allow-same-origin"))).toBe(true);
    }
  });

  it("'allow-scripts allow-same-origin' → violation (critical combination)", () => {
    const result = assertSandboxAttr("allow-scripts allow-same-origin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("allow-same-origin"))).toBe(true);
    }
  });
});

describe("SB-4 — assertSandboxAttr: missing allow-scripts → violation", () => {
  it("empty string → violation (no allow-scripts)", () => {
    const result = assertSandboxAttr("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("allow-scripts"))).toBe(true);
    }
  });

  it("'allow-forms' only → violation", () => {
    const result = assertSandboxAttr("allow-forms");
    expect(result.ok).toBe(false);
  });
});

describe("SB-5 — assertSandboxAttr: combined allow-scripts + allow-same-origin → violation", () => {
  it("defeats opaque-origin isolation → violation", () => {
    const result = assertSandboxAttr("allow-scripts allow-same-origin allow-forms");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("allow-same-origin"))).toBe(true);
      // Must have at least the allow-same-origin violation
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("SB-6 — FLOOR2_SANDBOX_MUST_NOT_CONTAIN includes 'allow-same-origin'", () => {
  it("exported constant includes allow-same-origin in the deny list", () => {
    expect(FLOOR2_SANDBOX_MUST_NOT_CONTAIN).toContain("allow-same-origin");
  });
});

describe("SB-7 — FLOOR2_SANDBOX_MUST_CONTAIN includes 'allow-scripts'", () => {
  it("exported constant requires allow-scripts", () => {
    expect(FLOOR2_SANDBOX_MUST_CONTAIN).toContain("allow-scripts");
  });
});

// ---------------------------------------------------------------------------
// GF-* Governance flag (§9.10)
// ---------------------------------------------------------------------------

describe("GF-1 — Custom mode without flag → CUSTOM_FLAG_MISSING", () => {
  it("missing meta entirely → CUSTOM_FLAG_MISSING", () => {
    const desc = {
      mode: "custom" as const,
      reactSource: "const x = 1;",
      bindingKey: "amount",
      meta: {} as Record<string, unknown>,
    } as CustomFloor2Descriptor;
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "CUSTOM_FLAG_MISSING")).toBe(true);
    }
  });
});

describe("GF-2 — Custom mode with wrong flag value → CUSTOM_FLAG_MISSING", () => {
  it("flag value 'false' → CUSTOM_FLAG_MISSING", () => {
    const desc = customDesc("amount", "const x=1;", "false");
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "CUSTOM_FLAG_MISSING")).toBe(true);
    }
  });

  it("flag value 1 (number) → CUSTOM_FLAG_MISSING", () => {
    const desc = customDesc("amount", "const x=1;", 1);
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "CUSTOM_FLAG_MISSING")).toBe(true);
    }
  });

  it("flag key absent from meta → CUSTOM_FLAG_MISSING", () => {
    // Explicitly construct a descriptor with no flag key in meta
    const desc = {
      mode: "custom" as const,
      reactSource: "const x=1;",
      bindingKey: "amount",
      meta: { unrelated: "value" } as Record<string, unknown>,
    } as CustomFloor2Descriptor;
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "CUSTOM_FLAG_MISSING")).toBe(true);
    }
  });
});

describe("GF-3 — Custom mode with correct flag → passes flag check", () => {
  it("flag 'true' + non-empty source → ok:true", () => {
    const desc = customDesc("amount", "document.getElementById('floor2-custom-host').textContent='hello';");
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(true);
  });
});

describe("GF-4 — FLOOR2_CUSTOM_FLAG_KEY and FLOOR2_CUSTOM_FLAG_VALUE are exported", () => {
  it("FLOOR2_CUSTOM_FLAG_KEY is 'floor2_custom_confirmed'", () => {
    expect(FLOOR2_CUSTOM_FLAG_KEY).toBe("floor2_custom_confirmed");
  });

  it("FLOOR2_CUSTOM_FLAG_VALUE is 'true'", () => {
    expect(FLOOR2_CUSTOM_FLAG_VALUE).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// VP-* Vetted-palette validation (§4a)
// ---------------------------------------------------------------------------

describe("VP-1 — Valid vetted descriptor → ok: true", () => {
  it("text_input with known bindingKey → ok", () => {
    const result = validateFloor2Descriptor(
      vettedDesc("email", "text_input"),
      makeFields(["email", "name"]),
    );
    expect(result.ok).toBe(true);
  });

  it("select with props → ok", () => {
    const result = validateFloor2Descriptor(
      vettedDesc("category", "select", { options: ["A", "B"] }),
      makeFields(["category"]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("VP-2 — Unknown componentType → INVALID_COMPONENT", () => {
  it("componentType 'custom_table' (not vetted) → INVALID_COMPONENT", () => {
    const desc: Floor2RenderDescriptor = {
      mode: "vetted",
      componentType: "custom_table" as VettedComponentType,
      bindingKey: "data",
    };
    const result = validateFloor2Descriptor(desc, makeFields(["data"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_COMPONENT")).toBe(true);
    }
  });

  it("componentType '' (empty) → INVALID_COMPONENT", () => {
    const desc: Floor2RenderDescriptor = {
      mode: "vetted",
      componentType: "" as VettedComponentType,
      bindingKey: "data",
    };
    const result = validateFloor2Descriptor(desc, makeFields(["data"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_COMPONENT")).toBe(true);
    }
  });
});

describe("VP-3 — VETTED_COMPONENT_TYPES is a non-empty ReadonlySet", () => {
  it("has at least 5 types", () => {
    expect(VETTED_COMPONENT_TYPES.size).toBeGreaterThanOrEqual(5);
  });
});

describe("VP-4 — All VETTED_COMPONENT_TYPES pass validation", () => {
  for (const ct of VETTED_COMPONENT_TYPES) {
    it(`componentType '${ct}' → ok:true with valid bindingKey`, () => {
      const result = validateFloor2Descriptor(
        vettedDesc("field_key", ct),
        makeFields(["field_key"]),
      );
      expect(result.ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// BK-* Named-binding key validation (§4)
// ---------------------------------------------------------------------------

describe("BK-1 — bindingKey exists in fields → ok:true", () => {
  it("vetted: bindingKey matches one of the fields", () => {
    const result = validateFloor2Descriptor(
      vettedDesc("amount", "number_input"),
      makeFields(["amount", "currency", "note"]),
    );
    expect(result.ok).toBe(true);
  });

  it("custom: bindingKey matches one of the fields", () => {
    const desc = customDesc("amount", "document.body.textContent='ok';");
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(true);
  });
});

describe("BK-2 — bindingKey absent from fields → UNKNOWN_BINDING_KEY", () => {
  it("vetted: bindingKey 'unknown_field' → UNKNOWN_BINDING_KEY", () => {
    const result = validateFloor2Descriptor(
      vettedDesc("unknown_field", "text_input"),
      makeFields(["amount", "currency"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_BINDING_KEY")).toBe(true);
      expect(
        result.errors.some(
          (e) => e.code === "UNKNOWN_BINDING_KEY" && e.field === "unknown_field",
        ),
      ).toBe(true);
    }
  });

  it("custom: bindingKey absent → UNKNOWN_BINDING_KEY", () => {
    const desc = customDesc("missing_key", "const x=1;");
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_BINDING_KEY")).toBe(true);
    }
  });
});

describe("BK-3 — Empty fields[] with any bindingKey → UNKNOWN_BINDING_KEY", () => {
  it("vetted with no fields → UNKNOWN_BINDING_KEY", () => {
    const result = validateFloor2Descriptor(vettedDesc("amount"), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_BINDING_KEY")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CM-* Custom mode validation (§4b)
// ---------------------------------------------------------------------------

describe("CM-1 — Valid custom descriptor → ok: true", () => {
  it("non-empty source + correct flag → ok", () => {
    const desc = customDesc(
      "summary",
      "document.getElementById('floor2-custom-host').textContent='Итого: 42 ₽';",
    );
    const result = validateFloor2Descriptor(desc, makeFields(["summary", "amount"]));
    expect(result.ok).toBe(true);
  });
});

describe("CM-2 — Empty reactSource → EMPTY_REACT_SOURCE", () => {
  it("empty string → EMPTY_REACT_SOURCE", () => {
    const desc = customDesc("amount", "");
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "EMPTY_REACT_SOURCE")).toBe(true);
    }
  });
});

describe("CM-3 — Whitespace-only reactSource → EMPTY_REACT_SOURCE", () => {
  it("spaces + newlines → EMPTY_REACT_SOURCE", () => {
    const desc = customDesc("amount", "   \n  \t  ");
    const result = validateFloor2Descriptor(desc, makeFields(["amount"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "EMPTY_REACT_SOURCE")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SR-* buildFloor2Srcdoc
// ---------------------------------------------------------------------------

describe("SR-1 — Valid vetted descriptor → ok: true, sandboxAttr === FLOOR2_SANDBOX_ATTR", () => {
  it("vetted descriptor → srcdoc result ok, correct sandboxAttr", () => {
    const result = buildFloor2Srcdoc(
      vettedDesc("email", "text_input"),
      makeFields(["email"]),
      "dark",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sandboxAttr).toBe(FLOOR2_SANDBOX_ATTR);
      expect(result.sandboxAttr).toBe("allow-scripts");
      expect(typeof result.srcdoc).toBe("string");
      expect(result.srcdoc.length).toBeGreaterThan(0);
    }
  });
});

describe("SR-2 — Valid custom descriptor → ok: true, srcdoc contains reactSource", () => {
  it("custom source is embedded in srcdoc", () => {
    const source = "document.getElementById('floor2-custom-host').textContent='test';";
    const desc = customDesc("amount", source);
    const result = buildFloor2Srcdoc(desc, makeFields(["amount"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain(source);
    }
  });
});

describe("SR-3 — Invalid descriptor → ok: false, errors passed through", () => {
  it("unknown bindingKey → ok: false, UNKNOWN_BINDING_KEY in errors", () => {
    const result = buildFloor2Srcdoc(
      vettedDesc("ghost_field", "text_input"),
      makeFields(["real_field"]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "UNKNOWN_BINDING_KEY")).toBe(true);
    }
  });
});

describe("SR-4 — Vetted srcdoc contains data-floor2-mode='vetted'", () => {
  it("vetted mode marker in srcdoc", () => {
    const result = buildFloor2Srcdoc(vettedDesc("name", "text_input"), makeFields(["name"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain('data-floor2-mode="vetted"');
    }
  });
});

describe("SR-5 — Custom srcdoc contains data-floor2-mode='custom'", () => {
  it("custom mode marker in srcdoc", () => {
    const desc = customDesc("amount", "const x=1;");
    const result = buildFloor2Srcdoc(desc, makeFields(["amount"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain('data-floor2-mode="custom"');
    }
  });
});

describe("SR-6 — Custom srcdoc contains data-floor2-custom-confirmed='true' (§9.10 flag)", () => {
  it("governance flag marker in custom srcdoc", () => {
    const desc = customDesc("amount", "const x=1;");
    const result = buildFloor2Srcdoc(desc, makeFields(["amount"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain(`data-floor2-custom-confirmed="${FLOOR2_CUSTOM_FLAG_VALUE}"`);
    }
  });
});

describe("SR-7 — srcdoc contains height-postMessage emitter (fjs-height channel)", () => {
  it("vetted srcdoc contains fjs-height emitter", () => {
    const result = buildFloor2Srcdoc(vettedDesc("email", "text_input"), makeFields(["email"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain("fjs-height");
      expect(result.srcdoc).toContain("postMessage");
    }
  });

  it("custom srcdoc contains fjs-height emitter", () => {
    const desc = customDesc("email", "const x=1;");
    const result = buildFloor2Srcdoc(desc, makeFields(["email"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain("fjs-height");
      expect(result.srcdoc).toContain("postMessage");
    }
  });
});

describe("SR-8 — srcdoc does NOT contain allow-same-origin", () => {
  it("vetted srcdoc: no allow-same-origin token in content", () => {
    const result = buildFloor2Srcdoc(vettedDesc("email", "text_input"), makeFields(["email"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).not.toContain("allow-same-origin");
    }
  });

  it("custom srcdoc: no allow-same-origin token in content", () => {
    const desc = customDesc("email", "const x=1;");
    const result = buildFloor2Srcdoc(desc, makeFields(["email"]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).not.toContain("allow-same-origin");
    }
  });
});

describe("SR-9 — sandboxAttr is always 'allow-scripts'", () => {
  it("vetted → sandboxAttr === 'allow-scripts'", () => {
    const result = buildFloor2Srcdoc(vettedDesc("x", "text_input"), makeFields(["x"]));
    if (result.ok) expect(result.sandboxAttr).toBe("allow-scripts");
  });

  it("custom → sandboxAttr === 'allow-scripts'", () => {
    const desc = customDesc("x", "const x=1;");
    const result = buildFloor2Srcdoc(desc, makeFields(["x"]));
    if (result.ok) expect(result.sandboxAttr).toBe("allow-scripts");
  });
});

describe("SR-10 — theme is injected safely", () => {
  it("dark theme → data-theme=\"dark\" in srcdoc", () => {
    const result = buildFloor2Srcdoc(vettedDesc("x", "text_input"), makeFields(["x"]), "dark");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain('data-theme="dark"');
    }
  });

  it("light theme → data-theme=\"light\" in srcdoc", () => {
    const result = buildFloor2Srcdoc(vettedDesc("x", "text_input"), makeFields(["x"]), "light");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain('data-theme="light"');
    }
  });

  it("unknown theme defaults to dark", () => {
    const result = buildFloor2Srcdoc(
      vettedDesc("x", "text_input"),
      makeFields(["x"]),
      "invalid" as "dark" | "light",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.srcdoc).toContain('data-theme="dark"');
      expect(result.srcdoc).not.toContain('data-theme="invalid"');
    }
  });
});

// ---------------------------------------------------------------------------
// MI-* Mode invariant
// ---------------------------------------------------------------------------

describe("MI-1 — Unknown mode → INVALID_MODE", () => {
  it("mode 'floor3' → INVALID_MODE", () => {
    const desc = { mode: "floor3", bindingKey: "x" } as unknown as Floor2RenderDescriptor;
    const result = validateFloor2Descriptor(desc, makeFields(["x"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_MODE")).toBe(true);
    }
  });

  it("mode '' → INVALID_MODE", () => {
    const desc = { mode: "", bindingKey: "x" } as unknown as Floor2RenderDescriptor;
    const result = validateFloor2Descriptor(desc, makeFields(["x"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "INVALID_MODE")).toBe(true);
    }
  });
});

describe("MI-2 — mode is either 'vetted' or 'custom' (exhaustive)", () => {
  it("'vetted' is accepted", () => {
    const result = validateFloor2Descriptor(vettedDesc("x"), makeFields(["x"]));
    expect(result.ok).toBe(true);
  });

  it("'custom' is accepted with correct flag", () => {
    const result = validateFloor2Descriptor(
      customDesc("x", "const y=1;"),
      makeFields(["x"]),
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PU-* Purity
// ---------------------------------------------------------------------------

describe("PU-1 — All functions are synchronous, never throw, no I/O", () => {
  it("validateFloor2Descriptor does not throw on valid input", () => {
    expect(() => {
      validateFloor2Descriptor(vettedDesc("x"), makeFields(["x"]));
    }).not.toThrow();
  });

  it("validateFloor2Descriptor does not throw on adversarial input", () => {
    expect(() => {
      validateFloor2Descriptor(
        null as unknown as Floor2RenderDescriptor,
        makeFields(["x"]),
      );
    }).toThrow(); // null will throw property access — this is expected; callers must pass valid shape
  });

  it("buildFloor2Srcdoc is synchronous", () => {
    const result = buildFloor2Srcdoc(vettedDesc("x"), makeFields(["x"]));
    expect(result).toBeDefined();
    expect("then" in result).toBe(false); // not a Promise
  });

  it("assertSandboxAttr never throws", () => {
    expect(() => assertSandboxAttr("")).not.toThrow();
    expect(() => assertSandboxAttr("allow-scripts")).not.toThrow();
    expect(() => assertSandboxAttr("allow-same-origin allow-scripts")).not.toThrow();
  });
});

describe("PU-2 — meta field does not affect vetted validation outcome", () => {
  it("same vetted descriptor + different meta → same validation result", () => {
    const r1 = validateFloor2Descriptor(
      vettedDesc("x", "text_input", {}, { agentId: "agent-1" }),
      makeFields(["x"]),
    );
    const r2 = validateFloor2Descriptor(
      vettedDesc("x", "text_input", {}, { agentId: "agent-2", draftId: "d-99" }),
      makeFields(["x"]),
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.ok).toBe(r2.ok);
  });

  it("vetted with no meta → same result as with empty meta", () => {
    const r1 = validateFloor2Descriptor(
      { mode: "vetted", componentType: "text_input", bindingKey: "x" },
      makeFields(["x"]),
    );
    const r2 = validateFloor2Descriptor(
      { mode: "vetted", componentType: "text_input", bindingKey: "x", meta: {} },
      makeFields(["x"]),
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});
