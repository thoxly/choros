/**
 * T-0087 · env-tier unit tests (static-now, no IO).
 *
 * Covers FF-6 (readTierScope), FF-7 (decidePromote agent gate),
 * and the assertWritable guard (FF-2 app-layer half).
 */
import { describe, it, expect } from "vitest";
import {
  assertWritable,
  decidePromote,
  readTierScope,
  type Tier,
} from "../core/env-tier.js";

// ---------------------------------------------------------------------------
// assertWritable — FF-2 app-layer half (AC-2 / FR-4)
// ---------------------------------------------------------------------------

describe("assertWritable", () => {
  it("returns ok:true for draft tier", () => {
    const result = assertWritable("draft");
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false / PUBLISHED_LOCKED for published tier", () => {
    const result = assertWritable("published");
    expect(result).toEqual({ ok: false, code: "PUBLISHED_LOCKED" });
  });
});

// ---------------------------------------------------------------------------
// decidePromote — FF-7 agent gate + tier check (AC-7 / FR-3)
// ---------------------------------------------------------------------------

describe("decidePromote", () => {
  it("agent actor returns FORBIDDEN_AGENT_SELF_PROMOTE (AC-7)", () => {
    const result = decidePromote({ currentTier: "draft", actorType: "agent" });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN_AGENT_SELF_PROMOTE" });
  });

  it("agent actor with published tier still returns FORBIDDEN_AGENT_SELF_PROMOTE (agent check first)", () => {
    const result = decidePromote({ currentTier: "published", actorType: "agent" });
    expect(result).toEqual({ ok: false, code: "FORBIDDEN_AGENT_SELF_PROMOTE" });
  });

  it("human actor with draft tier returns ok:true (AC-7 happy path)", () => {
    const result = decidePromote({ currentTier: "draft", actorType: "human" });
    expect(result).toEqual({ ok: true, from: "draft", to: "published" });
  });

  it("human actor with published tier returns NOT_IN_DRAFT", () => {
    const result = decidePromote({ currentTier: "published", actorType: "human" });
    expect(result).toEqual({ ok: false, code: "NOT_IN_DRAFT" });
  });

  it("ok result has exact fields: ok, from, to", () => {
    const result = decidePromote({ currentTier: "draft", actorType: "human" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe("draft");
      expect(result.to).toBe("published");
    }
  });
});

// ---------------------------------------------------------------------------
// readTierScope — FF-6 (AC-6 / FR-5)
// ---------------------------------------------------------------------------

describe("readTierScope", () => {
  it("returns published when draftRequested is absent (default context)", () => {
    const tier: Tier = readTierScope({});
    expect(tier).toBe("published");
  });

  it("returns published when draftRequested is false", () => {
    const tier: Tier = readTierScope({ draftRequested: false });
    expect(tier).toBe("published");
  });

  it("returns published when draftRequested is undefined", () => {
    const tier: Tier = readTierScope({ draftRequested: undefined });
    expect(tier).toBe("published");
  });

  it("returns draft only when draftRequested is explicitly true", () => {
    const tier: Tier = readTierScope({ draftRequested: true });
    expect(tier).toBe("draft");
  });

  it("never reads process.env / CHOROS_ENV (orthogonality FR-6 / AC-9)", () => {
    // Inject a CHOROS_ENV that looks prod-like; readTierScope must NOT change.
    const origEnv = process.env["CHOROS_ENV"];
    const origNodeEnv = process.env["NODE_ENV"];
    process.env["CHOROS_ENV"] = "production";
    process.env["NODE_ENV"] = "production";
    try {
      expect(readTierScope({})).toBe("published");
      expect(readTierScope({ draftRequested: true })).toBe("draft");
    } finally {
      if (origEnv === undefined) delete process.env["CHOROS_ENV"];
      else process.env["CHOROS_ENV"] = origEnv;
      if (origNodeEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = origNodeEnv;
    }
  });
});
