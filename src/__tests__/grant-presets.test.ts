/**
 * T-0135 — Grant presets unit tests.
 *
 * Verifies AC-01..AC-08 (shape, vocabulary, specific preset contents,
 * non-degeneracy) against DICT_PRESETS exported from src/http/grants.ts.
 *
 * No DB, no server — pure data-shape assertions.
 */
import { describe, it, expect } from "vitest";
import { DICT_PRESETS } from "../http/grants.js";

// The valid Operation union from grant-lattice.ts.
const VALID_OPERATIONS = new Set([
  "read", "create", "update", "delete", "approve", "transition", "invoke",
]);

// The valid resource URIs from DICT_RESOURCES (same as grants.ts DICT_RESOURCES).
const VALID_RESOURCE_URIS = new Set([
  "mcp://ledger.invoices",
  "mcp://ledger.recon",
  "mcp://payments.initiate",
  "mcp://payments.refund",
  "mcp://counterparty.kyc",
  "mcp://contracts.lookup",
  "mcp://support.queue",
  "mcp://crm.customer",
  "mcp://kb.search",
  "mcp://escalations.queue",
]);

// ---------------------------------------------------------------------------
// AC-01 — at least 10 presets
// ---------------------------------------------------------------------------
describe("AC-01: DICT_PRESETS count", () => {
  it("has at least 10 presets", () => {
    expect(DICT_PRESETS.length).toBeGreaterThanOrEqual(10);
  });

  it("ids are unique", () => {
    const ids = DICT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// AC-02 — each preset has required fields; each atom has resource_type + operation
// ---------------------------------------------------------------------------
describe("AC-02: preset shape invariants", () => {
  for (const preset of DICT_PRESETS) {
    it(`preset ${preset.id} has id, label, desc, grants`, () => {
      expect(typeof preset.id).toBe("string");
      expect(preset.id.length).toBeGreaterThan(0);
      expect(typeof preset.label).toBe("string");
      expect(preset.label.length).toBeGreaterThan(0);
      expect(typeof preset.desc).toBe("string");
      expect(preset.desc.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.grants)).toBe(true);
    });

    for (const atom of preset.grants) {
      it(`preset ${preset.id} atom has resource_type and operation`, () => {
        expect(typeof atom.resource_type).toBe("string");
        expect(typeof atom.operation).toBe("string");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// AC-03 — resource_type in each atom is a valid DICT_RESOURCES URI
// ---------------------------------------------------------------------------
describe("AC-03: resource_type vocabulary", () => {
  for (const preset of DICT_PRESETS) {
    for (const atom of preset.grants) {
      it(`preset ${preset.id} atom resource_type "${atom.resource_type}" is in DICT_RESOURCES`, () => {
        expect(VALID_RESOURCE_URIS.has(atom.resource_type)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// AC-04 — operation in each atom is a valid Operation literal
// ---------------------------------------------------------------------------
describe("AC-04: operation vocabulary", () => {
  for (const preset of DICT_PRESETS) {
    for (const atom of preset.grants) {
      it(`preset ${preset.id} atom operation "${atom.operation}" is valid`, () => {
        expect(VALID_OPERATIONS.has(atom.operation)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// AC-05 — p-budget-approver: exactly 2 atoms, ledger.invoices:read + approve
// ---------------------------------------------------------------------------
describe("AC-05: p-budget-approver content", () => {
  const preset = DICT_PRESETS.find((p) => p.id === "p-budget-approver");

  it("preset p-budget-approver exists", () => {
    expect(preset).toBeDefined();
  });

  it("has exactly 2 grant atoms", () => {
    expect(preset!.grants).toHaveLength(2);
  });

  it("contains mcp://ledger.invoices:read", () => {
    const has = preset!.grants.some(
      (a) => a.resource_type === "mcp://ledger.invoices" && a.operation === "read",
    );
    expect(has).toBe(true);
  });

  it("contains mcp://ledger.invoices:approve", () => {
    const has = preset!.grants.some(
      (a) => a.resource_type === "mcp://ledger.invoices" && a.operation === "approve",
    );
    expect(has).toBe(true);
  });

  it("is not marked critical", () => {
    expect(preset!.critical).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// AC-06 — p-treasury-exec: 4 atoms, critical:true, covers ledger.invoices / ledger.recon / payments.initiate
// ---------------------------------------------------------------------------
describe("AC-06: p-treasury-exec content", () => {
  const preset = DICT_PRESETS.find((p) => p.id === "p-treasury-exec");

  it("preset p-treasury-exec exists", () => {
    expect(preset).toBeDefined();
  });

  it("is marked critical:true", () => {
    expect(preset!.critical).toBe(true);
  });

  it("contains ledger.invoices:read", () => {
    expect(preset!.grants.some(
      (a) => a.resource_type === "mcp://ledger.invoices" && a.operation === "read",
    )).toBe(true);
  });

  it("contains ledger.recon:read", () => {
    expect(preset!.grants.some(
      (a) => a.resource_type === "mcp://ledger.recon" && a.operation === "read",
    )).toBe(true);
  });

  it("contains ledger.recon:update", () => {
    expect(preset!.grants.some(
      (a) => a.resource_type === "mcp://ledger.recon" && a.operation === "update",
    )).toBe(true);
  });

  it("contains payments.initiate:invoke", () => {
    expect(preset!.grants.some(
      (a) => a.resource_type === "mcp://payments.initiate" && a.operation === "invoke",
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-07 — p-pay-init-limited: critical:true, payments.initiate:invoke with constraint.amount_le=250000
// ---------------------------------------------------------------------------
describe("AC-07: p-pay-init-limited content", () => {
  const preset = DICT_PRESETS.find((p) => p.id === "p-pay-init-limited");

  it("preset p-pay-init-limited exists", () => {
    expect(preset).toBeDefined();
  });

  it("is marked critical:true", () => {
    expect(preset!.critical).toBe(true);
  });

  it("contains payments.initiate:invoke", () => {
    expect(preset!.grants.some(
      (a) => a.resource_type === "mcp://payments.initiate" && a.operation === "invoke",
    )).toBe(true);
  });

  it("has constraint.amount_le = 250000 on the invoke atom", () => {
    const atom = preset!.grants.find(
      (a) => a.resource_type === "mcp://payments.initiate" && a.operation === "invoke",
    );
    expect(atom).toBeDefined();
    expect((atom!.constraint as Record<string, unknown>)?.["amount_le"]).toBe(250000);
  });
});

// ---------------------------------------------------------------------------
// AC-08 — no preset has an empty grants array
// ---------------------------------------------------------------------------
describe("AC-08: non-degeneracy", () => {
  for (const preset of DICT_PRESETS) {
    it(`preset ${preset.id} grants array is non-empty`, () => {
      expect(preset.grants.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Bonus: p-refund-operator critical + constraint
// ---------------------------------------------------------------------------
describe("p-refund-operator content", () => {
  const preset = DICT_PRESETS.find((p) => p.id === "p-refund-operator");

  it("preset p-refund-operator exists", () => {
    expect(preset).toBeDefined();
  });

  it("is marked critical:true", () => {
    expect(preset!.critical).toBe(true);
  });

  it("contains payments.refund:invoke with constraint.amount_le = 30000", () => {
    const atom = preset!.grants.find(
      (a) => a.resource_type === "mcp://payments.refund" && a.operation === "invoke",
    );
    expect(atom).toBeDefined();
    expect((atom!.constraint as Record<string, unknown>)?.["amount_le"]).toBe(30000);
  });
});
