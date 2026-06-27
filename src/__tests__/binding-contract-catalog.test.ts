/**
 * T-0399 [D7-K] — binding-contract-catalog unit tests.
 *
 * Asserts the catalog is the closed, frozen single source of truth and that
 * derivation/resolution helpers behave per PD-18:
 *   - every kind has a descriptor; defaultPresentation ∈ presentations;
 *   - FieldType → contract mapping is total and stable;
 *   - resolvePresentation never returns a mode the contract doesn't declare;
 *   - getBindingContract degrades unknown kinds to scalar (never throws);
 *   - BindingField carries contract/presentation/options through validation.
 */

import { describe, it, expect } from "vitest";
import {
  BINDING_CONTRACT_CATALOG,
  BINDING_CONTRACT_KINDS,
  deriveContractFromFieldType,
  getBindingContract,
  isBindingContractKind,
  resolvePresentation,
  type BindingContractKind,
} from "../core/binding-contract-catalog.js";
import { validateBindingFields } from "../core/binding-compat.js";
import type { FieldType } from "../core/field-type-dictionary.js";

describe("catalog shape — closed, frozen, internally consistent", () => {
  it("every kind in BINDING_CONTRACT_KINDS has a descriptor keyed by itself", () => {
    for (const kind of BINDING_CONTRACT_KINDS) {
      const d = BINDING_CONTRACT_CATALOG[kind];
      expect(d).toBeDefined();
      expect(d.kind).toBe(kind);
    }
  });

  it("catalog has exactly the eleven contract kinds (PD-18 + T-0512 multi-select/person)", () => {
    expect([...BINDING_CONTRACT_KINDS].sort()).toEqual(
      [
        "collection",
        "date-range",
        "enum",
        "file",
        "matrix-lookup",
        "money",
        "multi-select",
        "person",
        "relation",
        "rollup",
        "scalar",
      ].sort(),
    );
  });

  it("defaultPresentation is always one of the declared presentations", () => {
    for (const kind of BINDING_CONTRACT_KINDS) {
      const d = BINDING_CONTRACT_CATALOG[kind];
      expect(d.presentations.length).toBeGreaterThan(0);
      expect(d.presentations).toContain(d.defaultPresentation);
    }
  });

  it("derived contracts (rollup, matrix-lookup) are read-only", () => {
    expect(BINDING_CONTRACT_CATALOG.rollup.editable).toBe(false);
    expect(BINDING_CONTRACT_CATALOG["matrix-lookup"].editable).toBe(false);
  });

  it("the catalog object is frozen (cannot be mutated)", () => {
    expect(Object.isFrozen(BINDING_CONTRACT_CATALOG)).toBe(true);
  });
});

describe("deriveContractFromFieldType — total over FieldType", () => {
  const cases: Array<[FieldType, BindingContractKind, string]> = [
    ["text", "scalar", "text"],
    ["textarea", "scalar", "textarea"],
    ["number", "scalar", "number"],
    ["date", "scalar", "date"],
    ["boolean", "scalar", "checkbox"],
    ["enum", "enum", "select"],
    // T-0516: url and email → scalar with their own presentation
    ["url", "scalar", "url"],
    ["email", "scalar", "email"],
    // T-0516 Part 2: person and multi-select → their own catalog contracts
    ["person", "person", "person"],
    ["multi-select", "multi-select", "multi-select"],
  ];
  for (const [type, kind, presentation] of cases) {
    it(`${type} → contract ${kind} / presentation ${presentation}`, () => {
      const r = deriveContractFromFieldType(type);
      expect(r.kind).toBe(kind);
      expect(r.presentation).toBe(presentation);
      // The derived presentation must be a mode the contract supports.
      expect(BINDING_CONTRACT_CATALOG[kind].presentations).toContain(r.presentation);
    });
  }
});

describe("T-0516: deriveContractFromFieldType person/multi-select — Part 2 residual fix", () => {
  it("person → kind:'person', presentation:'person' (NOT scalar/text)", () => {
    const r = deriveContractFromFieldType("person");
    expect(r.kind).toBe("person");
    expect(r.presentation).toBe("person");
  });

  it("multi-select → kind:'multi-select', presentation:'multi-select' (NOT scalar/text)", () => {
    const r = deriveContractFromFieldType("multi-select");
    expect(r.kind).toBe("multi-select");
    expect(r.presentation).toBe("multi-select");
  });

  it("person derives to an editable catalog contract", () => {
    const r = deriveContractFromFieldType("person");
    expect(BINDING_CONTRACT_CATALOG[r.kind].editable).toBe(true);
  });

  it("multi-select derives to an editable catalog contract", () => {
    const r = deriveContractFromFieldType("multi-select");
    expect(BINDING_CONTRACT_CATALOG[r.kind].editable).toBe(true);
  });
});

describe("isBindingContractKind / getBindingContract", () => {
  it("accepts known kinds, rejects unknown", () => {
    expect(isBindingContractKind("enum")).toBe(true);
    expect(isBindingContractKind("relation")).toBe(true);
    expect(isBindingContractKind("nope")).toBe(false);
    expect(isBindingContractKind(undefined)).toBe(false);
    expect(isBindingContractKind(42)).toBe(false);
  });

  it("getBindingContract degrades unknown/undefined to scalar (never throws)", () => {
    expect(getBindingContract("enum").kind).toBe("enum");
    expect(getBindingContract("nope").kind).toBe("scalar");
    expect(getBindingContract(undefined).kind).toBe("scalar");
  });
});

describe("resolvePresentation — never returns an unsupported mode", () => {
  it("uses the override when the contract supports it", () => {
    expect(resolvePresentation("enum", "radio")).toBe("radio");
    expect(resolvePresentation("scalar", "textarea")).toBe("textarea");
  });

  it("falls back to defaultPresentation when the override is unsupported", () => {
    // enum supports select/radio only — "text" is not valid for enum.
    expect(resolvePresentation("enum", "text")).toBe("select");
    // scalar supports text/textarea/number/checkbox/date — "select" invalid.
    expect(resolvePresentation("scalar", "select")).toBe("text");
  });

  it("uses defaultPresentation when no override given", () => {
    expect(resolvePresentation("enum", undefined)).toBe("select");
    expect(resolvePresentation("money", undefined)).toBe("money");
  });

  it("unknown kind degrades to scalar's default (text)", () => {
    expect(resolvePresentation("nope", undefined)).toBe("text");
  });
});

describe("T-0512: multi-select and person catalog entries", () => {
  it("multi-select is in the catalog with correct descriptor", () => {
    const d = BINDING_CONTRACT_CATALOG["multi-select"];
    expect(d).toBeDefined();
    expect(d.kind).toBe("multi-select");
    expect(d.schemaSlot).toBe("property");
    expect(d.presentations).toContain("multi-select");
    expect(d.defaultPresentation).toBe("multi-select");
    expect(d.editable).toBe(true);
  });

  it("person is in the catalog with correct descriptor", () => {
    const d = BINDING_CONTRACT_CATALOG["person"];
    expect(d).toBeDefined();
    expect(d.kind).toBe("person");
    expect(d.schemaSlot).toBe("property");
    expect(d.presentations).toContain("person");
    expect(d.defaultPresentation).toBe("person");
    expect(d.editable).toBe(true);
  });

  it("isBindingContractKind accepts multi-select and person", () => {
    expect(isBindingContractKind("multi-select")).toBe(true);
    expect(isBindingContractKind("person")).toBe(true);
  });

  it("getBindingContract resolves multi-select and person correctly", () => {
    expect(getBindingContract("multi-select").kind).toBe("multi-select");
    expect(getBindingContract("person").kind).toBe("person");
  });

  it("resolvePresentation for multi-select and person uses their own mode", () => {
    expect(resolvePresentation("multi-select", undefined)).toBe("multi-select");
    expect(resolvePresentation("person", undefined)).toBe("person");
  });

  it("validateBindingFields accepts multi-select and person contracts", () => {
    const r = validateBindingFields([
      {
        key: "tags",
        type: "multi-select",
        required: false,
        label: "Теги",
        contract: "multi-select",
        presentation: "multi-select",
        options: ["A", "B", "C"],
      },
      {
        key: "owner",
        type: "person",
        required: false,
        label: "Владелец",
        contract: "person",
        presentation: "person",
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields[0].contract).toBe("multi-select");
      expect(r.fields[1].contract).toBe("person");
    }
  });
});

describe("BindingField carries contract/presentation/options (spec §2 fix)", () => {
  it("validateBindingFields preserves a full contract field", () => {
    const r = validateBindingFields([
      {
        key: "category",
        type: "string",
        required: true,
        label: "Категория",
        contract: "enum",
        presentation: "select",
        options: ["A", "B", "C"],
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.fields[0];
      expect(f.contract).toBe("enum");
      expect(f.presentation).toBe("select");
      expect(f.options).toEqual(["A", "B", "C"]);
    }
  });

  it("legacy field (no contract/options) stays valid — backward compatible", () => {
    const r = validateBindingFields([{ key: "name", type: "string", required: false }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields[0].contract).toBeUndefined();
      expect(r.fields[0].options).toBeUndefined();
    }
  });

  it("rejects an unknown contract kind", () => {
    const r = validateBindingFields([
      { key: "x", type: "string", required: false, contract: "bogus" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("rejects non-string options", () => {
    const r = validateBindingFields([
      { key: "x", type: "string", required: false, options: ["ok", 7] },
    ]);
    expect(r.ok).toBe(false);
  });
});
