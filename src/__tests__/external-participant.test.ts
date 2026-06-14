// T-0205 · ADR T-0122 §2.1 (FR-1) — external participant v1 = directory record.
//
// Static-now unit tests for the v1 data-shape validator. These run in the main
// vitest job (no Postgres). Live DB create/get/list + tenant-isolation probes live
// in ci/checks/db/external_participant.test.ts (the `db` CI job).
//
// SCOPE: v1 = DATA ONLY. The validator covers the descriptive directory record
// shape; there is NO token/auth field to validate (the external surface channel is
// Stage-2, out of scope).

import { describe, it, expect } from "vitest";
import {
  validateParticipantData,
  EXTERNAL_PARTICIPANT_REGISTRY_ID,
} from "../db/external-participant.js";

describe("validateParticipantData (T-0205 v1)", () => {
  it("accepts a minimal valid counterparty", () => {
    const d = validateParticipantData({
      display_name: "ООО Вектор",
      kind: "counterparty",
    });
    expect(d).toEqual({ display_name: "ООО Вектор", kind: "counterparty" });
  });

  it("accepts a visitor with optional descriptive fields", () => {
    const d = validateParticipantData({
      display_name: "Иван",
      kind: "visitor",
      inn: "7700000000",
      contact_email: "i@example.com",
      note: "QR посетитель",
    });
    expect(d.kind).toBe("visitor");
    expect(d.inn).toBe("7700000000");
    expect(d.contact_email).toBe("i@example.com");
    expect(d.note).toBe("QR посетитель");
  });

  it("drops unknown fields (only the declared v1 shape survives)", () => {
    const d = validateParticipantData({
      display_name: "X",
      kind: "counterparty",
      // an attacker-supplied field that must NOT silently become data:
      access_token: "should-be-ignored",
    } as unknown);
    expect(Object.keys(d).sort()).toEqual(["display_name", "kind"]);
    expect((d as unknown as Record<string, unknown>)["access_token"]).toBeUndefined();
  });

  it("rejects missing display_name", () => {
    expect(() => validateParticipantData({ kind: "counterparty" })).toThrow(
      /display_name/,
    );
  });

  it("rejects empty display_name", () => {
    expect(() =>
      validateParticipantData({ display_name: "   ", kind: "visitor" }),
    ).toThrow(/display_name/);
  });

  it("rejects unknown kind (closed enum counterparty|visitor)", () => {
    expect(() =>
      validateParticipantData({ display_name: "X", kind: "admin" }),
    ).toThrow(/kind/);
  });

  it("rejects non-string optional field", () => {
    expect(() =>
      validateParticipantData({
        display_name: "X",
        kind: "counterparty",
        inn: 12345,
      }),
    ).toThrow(/inn/);
  });

  it("rejects non-object / null input", () => {
    expect(() => validateParticipantData("nope")).toThrow();
    expect(() => validateParticipantData(null)).toThrow();
    expect(() => validateParticipantData([1, 2])).toThrow();
  });

  it("exposes the well-known directory registry id (matches migration 056)", () => {
    expect(EXTERNAL_PARTICIPANT_REGISTRY_ID).toBe(
      "a5000000-0000-0000-0000-000000000002",
    );
  });
});
