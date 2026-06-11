/**
 * T-0068 · Unit tests for src/core/audit-preimage.ts (FF-3 / AC-3).
 *
 * The golden digest is the vocab=1 lock: any change to the field set, order,
 * encoding, hash, or genesis constants flips it and reddens CI (forcing a
 * deliberate VOCAB_VERSION bump). Also asserts determinism, JCS key-permutation
 * invariance, and NULL ≠ "" length-unambiguity.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalPreimage,
  rowHash,
  GENESIS_PREV_HASH,
  GENESIS_SEQ,
  VOCAB_VERSION,
  type CanonicalAuditRow,
} from "../core/audit-preimage.js";

// ---------------------------------------------------------------------------
// Pinned golden fixture (vocab_version = 1).
// ---------------------------------------------------------------------------

const FIXTURE: CanonicalAuditRow = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  seq: 1,
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  type: "instance.started",
  actor: "e-larina",
  subject: "pi-9001",
  scope: null,
  via: "engine",
  proposed_by: null,
  confirmed_by: null,
  payload: { actorType: "human", instanceId: "pi-9001", processKey: "invoice" },
  occurred_at: 1700000000000,
  prev_hash: GENESIS_PREV_HASH,
  vocab_version: 1,
};

// vocab=1 golden — DO NOT EDIT to make a failing test pass; a drift here means the
// encoding changed and VOCAB_VERSION must be bumped deliberately (ADR §4.3).
const GOLDEN_DIGEST = "bc181598487b917e2509c2376cae60e83c158a82c6cec34d366ffe2bc3e45eca";

describe("audit-preimage (FF-3 / AC-3)", () => {
  it("genesis + vocab constants are pinned", () => {
    expect(GENESIS_SEQ).toBe(1);
    expect(VOCAB_VERSION).toBe(1);
    expect(GENESIS_PREV_HASH.length).toBe(32);
    expect(GENESIS_PREV_HASH.every((b) => b === 0)).toBe(true);
  });

  it("row_hash matches the pinned golden digest (vocab=1)", () => {
    expect(rowHash(FIXTURE).toString("hex")).toBe(GOLDEN_DIGEST);
  });

  it("is deterministic — same input yields identical bytes", () => {
    expect(canonicalPreimage(FIXTURE).equals(canonicalPreimage({ ...FIXTURE }))).toBe(true);
  });

  it("row_hash = SHA-256(preimage)", () => {
    const expected = createHash("sha256").update(canonicalPreimage(FIXTURE)).digest("hex");
    expect(rowHash(FIXTURE).toString("hex")).toBe(expected);
  });

  it("JCS — permuted jsonb keys yield an identical preimage", () => {
    const permuted: CanonicalAuditRow = {
      ...FIXTURE,
      payload: { processKey: "invoice", instanceId: "pi-9001", actorType: "human" },
    };
    expect(canonicalPreimage(FIXTURE).equals(canonicalPreimage(permuted))).toBe(true);
  });

  it("JCS — non-ASCII / supra-BMP jsonb keys sort deterministically (R-4 pin)", () => {
    // RFC 8785 §3.2.3 sorts on UTF-16 code units. Pin the ordering under vocab=1
    // so any future change to the comparator (e.g. localeCompare / code-point sort)
    // flips this fixture. Keys: a non-ASCII key, an emoji key (surrogate pair above
    // U+FFFF), and an ASCII key — supplied in two different insertion orders.
    const orderA: CanonicalAuditRow = {
      ...FIXTURE,
      payload: { "тип": "h", "😀": 1, actorType: "human" },
    };
    const orderB: CanonicalAuditRow = {
      ...FIXTURE,
      payload: { actorType: "human", "😀": 1, "тип": "h" },
    };
    // Insertion-order independence (the sort is the only thing that can order them).
    expect(canonicalPreimage(orderA).equals(canonicalPreimage(orderB))).toBe(true);
    // And it is a real, stable digest distinct from the ASCII-only golden.
    expect(rowHash(orderA).equals(rowHash(orderB))).toBe(true);
    expect(rowHash(orderA).toString("hex")).not.toBe(GOLDEN_DIGEST);
  });

  it("NULL ≠ empty string (length-unambiguous)", () => {
    const withNull: CanonicalAuditRow = { ...FIXTURE, subject: null };
    const withEmpty: CanonicalAuditRow = { ...FIXTURE, subject: "" };
    expect(canonicalPreimage(withNull).equals(canonicalPreimage(withEmpty))).toBe(false);
  });

  it("NULL scope ≠ empty-object scope", () => {
    const nullScope: CanonicalAuditRow = { ...FIXTURE, scope: null };
    const emptyScope: CanonicalAuditRow = { ...FIXTURE, scope: {} };
    expect(canonicalPreimage(nullScope).equals(canonicalPreimage(emptyScope))).toBe(false);
  });

  it("changing payload.actorType changes the row_hash (tamper-detectable, AC-12)", () => {
    const tampered: CanonicalAuditRow = {
      ...FIXTURE,
      payload: { ...(FIXTURE.payload as Record<string, unknown>), actorType: "service" },
    };
    expect(rowHash(tampered).toString("hex")).not.toBe(GOLDEN_DIGEST);
  });

  it("rejects unsupported jsonb value types (Date/bigint)", () => {
    const bad: CanonicalAuditRow = {
      ...FIXTURE,
      payload: { when: new Date() as unknown },
    };
    expect(() => canonicalPreimage(bad)).toThrow();
  });

  it("rejects a null payload (audit_event.payload is NOT NULL)", () => {
    const bad = { ...FIXTURE, payload: null } as unknown as CanonicalAuditRow;
    expect(() => canonicalPreimage(bad)).toThrow();
  });
});
