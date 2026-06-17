/**
 * src/core/customer-subscription/__tests__/status-model.test.ts — T-0244
 *
 * Unit tests for the customer-subscription record_schema and status-machine.
 * FF-1 (schema validates), FF-2 (status enum), FF-3 (transitions correct).
 * AC-2, AC-3, AC-4, AC-5.
 */

import { describe, it, expect } from "vitest";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  CUSTOMER_STATUS_VALUES,
  CUSTOMER_TRANSITIONS,
  availableTransitions,
  isAllowedTransition,
  isCustomerStatus,
  type CustomerStatus,
} from "../status-model.js";

// ---------------------------------------------------------------------------
// Load record_schema JSON (resolved relative to this test file)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "../../../../seed/vendor-crm/customer-subscription.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

// AJV instance (no ajv-formats – we do format checks separately)
const ajv = new Ajv({ allErrors: true });
// Disable format assertions so ajv doesn't fail on unknown format validators
// (email / date / date-time — we test presence by field name / value shape)
ajv.addFormat("email", true);
ajv.addFormat("date", true);
ajv.addFormat("date-time", true);
const validate = ajv.compile(schema);

// ---------------------------------------------------------------------------
// FF-1 / AC-2: schema validates required fields
// ---------------------------------------------------------------------------
describe("customer-subscription record_schema (FF-1, AC-2)", () => {
  const VALID_RECORD = {
    company_name: "ООО Ромашка",
    contact_name: "Иван Петров",
    contact_email: "ivan@romashka.ru",
    plan: "pilot",
    not_after: "2026-12-31",
    status: "draft",
  };

  it("accepts a conformant record", () => {
    expect(validate(VALID_RECORD)).toBe(true);
  });

  it("rejects record missing company_name", () => {
    const { company_name: _, ...r } = VALID_RECORD;
    expect(validate(r)).toBe(false);
  });

  it("rejects record missing contact_name", () => {
    const { contact_name: _, ...r } = VALID_RECORD;
    expect(validate(r)).toBe(false);
  });

  it("rejects record missing contact_email", () => {
    const { contact_email: _, ...r } = VALID_RECORD;
    expect(validate(r)).toBe(false);
  });

  it("rejects record missing plan", () => {
    const { plan: _, ...r } = VALID_RECORD;
    expect(validate(r)).toBe(false);
  });

  it("rejects record missing not_after", () => {
    const { not_after: _, ...r } = VALID_RECORD;
    expect(validate(r)).toBe(false);
  });

  it("rejects record missing status", () => {
    const { status: _, ...r } = VALID_RECORD;
    expect(validate(r)).toBe(false);
  });

  it("rejects record with additionalProperties (FF-1: additionalProperties:false)", () => {
    const r = { ...VALID_RECORD, extra_field: "bad" };
    expect(validate(r)).toBe(false);
  });

  it("accepts optional circuit_id field", () => {
    const r = { ...VALID_RECORD, circuit_id: "cid-001" };
    expect(validate(r)).toBe(true);
  });

  it("accepts optional activation_key_issued_at field", () => {
    const r = { ...VALID_RECORD, activation_key_issued_at: "2026-01-01T12:00:00.000Z" };
    expect(validate(r)).toBe(true);
  });

  it("rejects invalid plan value", () => {
    const r = { ...VALID_RECORD, plan: "enterprise-plus" };
    expect(validate(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-2 / AC-3: status enum exactly matches CustomerStatus
// ---------------------------------------------------------------------------
describe("status enum (FF-2, AC-3)", () => {
  const schemaStatusEnum: string[] = schema.properties.status.enum;

  it("schema enum EXACTLY matches CUSTOMER_STATUS_VALUES (same set)", () => {
    const schemaSet = new Set(schemaStatusEnum);
    const tsSet = new Set<string>(CUSTOMER_STATUS_VALUES);
    expect(schemaSet.size).toBe(tsSet.size);
    for (const v of schemaSet) expect(tsSet.has(v)).toBe(true);
    for (const v of tsSet) expect(schemaSet.has(v)).toBe(true);
  });

  it("rejects status outside enum", () => {
    const r = {
      company_name: "X",
      contact_name: "Y",
      contact_email: "x@y.com",
      plan: "pilot",
      not_after: "2026-12-31",
      status: "UNKNOWN_STATUS",
    };
    expect(validate(r)).toBe(false);
  });

  it("isCustomerStatus recognizes all valid statuses", () => {
    for (const v of CUSTOMER_STATUS_VALUES) {
      expect(isCustomerStatus(v)).toBe(true);
    }
    expect(isCustomerStatus("BOGUS")).toBe(false);
    expect(isCustomerStatus(null)).toBe(false);
    expect(isCustomerStatus(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-3 / AC-4, AC-5: transition table
// ---------------------------------------------------------------------------
describe("availableTransitions and isAllowedTransition (FF-3, AC-4, AC-5)", () => {
  it("archived is terminal — availableTransitions([archived]) === [] (AC-5)", () => {
    expect(availableTransitions("archived")).toHaveLength(0);
  });

  it("availableTransitions returns ids in to_${target} form", () => {
    const transitions = availableTransitions("draft");
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t.id).toMatch(/^to_/);
    }
  });

  const EXPECTED: Record<CustomerStatus, CustomerStatus[]> = {
    draft:    ["trial", "active", "archived"],
    trial:    ["active", "expired", "custom", "archived"],
    active:   ["expired", "custom", "archived"],
    expired:  ["active", "custom", "archived"],
    custom:   ["active", "expired", "archived"],
    archived: [],
  };

  for (const [from, targets] of Object.entries(EXPECTED) as [CustomerStatus, CustomerStatus[]][]) {
    it(`transitions from ${from}: allowed = [${targets.join(",")}]`, () => {
      for (const to of targets) {
        expect(isAllowedTransition(from as CustomerStatus, to)).toBe(true);
      }
    });

    const nonTargets = CUSTOMER_STATUS_VALUES.filter((s) => !(targets as string[]).includes(s));
    if (nonTargets.length > 0) {
      it(`transitions from ${from}: NOT allowed = [${nonTargets.join(",")}]`, () => {
        for (const to of nonTargets) {
          expect(isAllowedTransition(from as CustomerStatus, to)).toBe(false);
        }
      });
    }
  }

  it("archived→trial is NOT allowed (canonical AC-4 disallowed transition)", () => {
    expect(isAllowedTransition("archived", "trial")).toBe(false);
  });

  it("CUSTOMER_TRANSITIONS covers all CustomerStatus keys", () => {
    for (const status of CUSTOMER_STATUS_VALUES) {
      expect(status in CUSTOMER_TRANSITIONS).toBe(true);
    }
  });
});
