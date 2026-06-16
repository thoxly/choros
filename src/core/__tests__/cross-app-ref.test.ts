/**
 * T-0080 / E11.9 — Pure unit tests for cross-app-ref.ts
 *
 * No DB, no IO. All injected ports are in-memory stubs.
 *
 * Coverage:
 *  CR-1  — per-hop deny: no_grant → redacted projection (label/id only, no fields)
 *  CR-2  — per-hop deny: not_found → redacted projection
 *  CR-3  — hop-cap exceeded → denied(hop_cap_exceeded), no traversal
 *  CR-4  — dangling ref: ref_field missing → denied(dangling_ref)
 *  CR-5  — dangling ref: ref_field null → denied(dangling_ref)
 *  CR-6  — dangling ref: ref_field not a string → denied(dangling_ref)
 *  CR-7  — allowed hop: returns fields already-PDP-projected (pass-through, no re-redaction)
 *  CR-8  — redacted projection is structurally DISTINCT from present-but-null
 *           (no `value` key on denied hop — F-3 mirror for cross-ref)
 *  CR-9  — hop chain: all allowed → all results returned
 *  CR-10 — hop chain: first hop denied → stops at first denial (fail-fast, no info leak)
 *  CR-11 — hop chain: second hop denied → first allowed + second denied
 *  CR-12 — hop chain: depth accumulates correctly across hops
 *  CR-13 — hop-cap: HOP_CAP = 3; depth 2 + 1 still allowed, depth 3 + 1 denied
 *  CR-14 — cross_tenant deny: fetcher returns cross_tenant → redacted projection
 *  CR-15 — buildRedactedHopProjection: produces correct sentinel shape
 *  CR-16 — empty chain returns empty results
 */

import { describe, it, expect, vi } from "vitest";
import {
  type CrossAppRefDef,
  type CrossAppRefDeps,
  type CrossAppHopFetcher,
  HOP_CAP,
  resolveHop,
  resolveHopChain,
  buildRedactedHopProjection,
} from "../cross-app-ref.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT = "tenant-11111111-1111-1111-1111-111111111111";
const SRC_REG = "src-reg-22222222-2222-2222-2222-222222222222";
const TGT_REG = "tgt-reg-33333333-3333-3333-3333-333333333333";
const REF_DEF_ID = "refdef-44444444-4444-4444-4444-444444444444";
const TGT_RECORD_ID = "tgt-rec-55555555-5555-5555-5555-555555555555";
const NOW = 1_000_000;

function makeRefDef(overrides: Partial<CrossAppRefDef> = {}): CrossAppRefDef {
  return {
    tenantId: TENANT,
    id: REF_DEF_ID,
    sourceRegistryId: SRC_REG,
    targetRegistryId: TGT_REG,
    refField: "counterparty_id",
    label: "Counterparty",
    refStrength: "weak",
    createdAt: NOW - 1000,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSourceRecord(refValue: unknown = TGT_RECORD_ID): Record<string, unknown> {
  return { id: "src-rec", name: "Order #42", counterparty_id: refValue };
}

/** Stub fetcher that always allows with given fields. */
function allowingFetcher(fields: Record<string, unknown> = {}): CrossAppHopFetcher {
  return {
    async fetchHop(_params) {
      return { ok: true, fields };
    },
  };
}

/** Stub fetcher that always denies with given reason. */
function denyingFetcher(
  reason: "no_grant" | "not_found" | "cross_tenant",
): CrossAppHopFetcher {
  return {
    async fetchHop(_params) {
      return { ok: false, reason };
    },
  };
}


// ---------------------------------------------------------------------------
// CR-1: per-hop deny: no_grant → redacted projection
// ---------------------------------------------------------------------------

describe("CR-1: no_grant → CrossAppHopDenied with redacted projection", () => {
  it("returns allowed=false, reason=no_grant, and a redacted projection sentinel", async () => {
    const deps: CrossAppRefDeps = { fetcher: denyingFetcher("no_grant") };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("no_grant");
      // The sentinel is the T-0081 FieldProjection shape: visible=false, redacted=true, label.
      expect(result.redactedProjection.visible).toBe(false);
      expect(result.redactedProjection.redacted).toBe(true);
      expect(result.redactedProjection.key).toBe("counterparty_id");
      expect(result.redactedProjection.label).toBe("Counterparty");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-2: per-hop deny: not_found → redacted projection
// ---------------------------------------------------------------------------

describe("CR-2: not_found → CrossAppHopDenied", () => {
  it("returns reason=not_found with redacted projection", async () => {
    const deps: CrossAppRefDeps = { fetcher: denyingFetcher("not_found") };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("not_found");
      expect(result.redactedProjection.visible).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// CR-3: hop-cap exceeded
// ---------------------------------------------------------------------------

describe("CR-3: hop_cap_exceeded when depth + 1 > HOP_CAP", () => {
  it("denies at depth=HOP_CAP without calling the fetcher", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = {
      fetcher: { fetchHop: mockFetcher },
    };

    // depth = HOP_CAP means depth + 1 = HOP_CAP + 1 > HOP_CAP → denied
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), HOP_CAP, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("hop_cap_exceeded");
    }
    // The fetcher must NOT be called — no wasted work, no info leak.
    expect(mockFetcher).not.toHaveBeenCalled();
  });

  it("HOP_CAP is 3", () => {
    expect(HOP_CAP).toBe(3);
  });

  it("depth = HOP_CAP - 1 (= 2) is still allowed when fetcher allows", async () => {
    const deps: CrossAppRefDeps = { fetcher: allowingFetcher({ name: "target" }) };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), HOP_CAP - 1, deps);
    // depth + 1 = HOP_CAP = 3, which is NOT > HOP_CAP, so allowed.
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CR-4: dangling ref: ref_field missing
// ---------------------------------------------------------------------------

describe("CR-4: dangling_ref when ref_field is missing from source record", () => {
  it("returns reason=dangling_ref", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };
    const sourceWithoutRef: Record<string, unknown> = { id: "src-rec", name: "Order" };

    const result = await resolveHop(makeRefDef(), sourceWithoutRef, 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("dangling_ref");
    }
    expect(mockFetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CR-5: dangling ref: ref_field null
// ---------------------------------------------------------------------------

describe("CR-5: dangling_ref when ref_field is null", () => {
  it("returns reason=dangling_ref for null ref value", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };

    const result = await resolveHop(makeRefDef(), makeSourceRecord(null), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("dangling_ref");
    }
    expect(mockFetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CR-6: dangling ref: ref_field not a string (object or number)
// ---------------------------------------------------------------------------

describe("CR-6: dangling_ref when ref_field is not a string", () => {
  it("returns dangling_ref for a number ref value", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };

    const result = await resolveHop(makeRefDef(), makeSourceRecord(42), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("dangling_ref");
    }
    expect(mockFetcher).not.toHaveBeenCalled();
  });

  it("returns dangling_ref for an object ref value", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };

    const result = await resolveHop(makeRefDef(), makeSourceRecord({ nested: "val" }), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("dangling_ref");
    }
  });

  it("returns dangling_ref for an empty string ref value", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };

    const result = await resolveHop(makeRefDef(), makeSourceRecord(""), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("dangling_ref");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-7: allowed hop returns already-PDP-projected fields (no re-redaction)
// ---------------------------------------------------------------------------

describe("CR-7: allowed hop passes through PDP-projected fields unchanged", () => {
  it("returns allowed=true with the exact fields from the fetcher", async () => {
    const tgtFields = {
      name: "Acme Corp",
      contract_value: 50000,
      // Imagine financial_details was already redacted by the PDP (T-0081):
      // it is simply absent from this record — no re-redaction needed here.
    };
    const deps: CrossAppRefDeps = { fetcher: allowingFetcher(tgtFields) };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.fields).toEqual(tgtFields);
      expect(result.targetRecordId).toBe(TGT_RECORD_ID);
      expect(result.targetRegistryId).toBe(TGT_REG);
      expect(result.depth).toBe(1);
    }
  });

  it("passes the correct targetRecordId and targetRegistryId to the fetcher", async () => {
    const fetchHopSpy = vi.fn(async (_params: { tenantId: string; targetRegistryId: string; targetRecordId: string }) => ({
      ok: true as const,
      fields: { name: "Target" },
    }));
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: fetchHopSpy } };

    await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(fetchHopSpy).toHaveBeenCalledWith({
      tenantId: TENANT,
      targetRegistryId: TGT_REG,
      targetRecordId: TGT_RECORD_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// CR-8: redacted projection has NO `value` key (structurally distinct from null)
// ---------------------------------------------------------------------------

describe("CR-8: redacted projection is structurally distinct from present-but-null", () => {
  it("denied hop has no `value` key on the redactedProjection", async () => {
    const deps: CrossAppRefDeps = { fetcher: denyingFetcher("no_grant") };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // F-3 mirror: a redacted projection must NOT carry a `value` key.
      expect("value" in result.redactedProjection).toBe(false);
      // Verify the structural sentinel is present.
      expect(result.redactedProjection.redacted).toBe(true);
      expect(result.redactedProjection.visible).toBe(false);
    }
  });

  it("allowed hop result has fields (present-with-value, not redacted)", async () => {
    const deps: CrossAppRefDeps = { fetcher: allowingFetcher({ status: "active" }) };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // Not a redacted projection — fields are a plain record.
      expect(result.fields).toHaveProperty("status", "active");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-9: hop chain all allowed → all results
// ---------------------------------------------------------------------------

describe("CR-9: resolveHopChain — all allowed", () => {
  it("returns one allowed result per refDef", async () => {
    const refDef1 = makeRefDef({
      id: "rd-1",
      refField: "counterparty_id",
      targetRegistryId: "reg-2",
      label: "Counterparty",
    });
    const refDef2 = makeRefDef({
      id: "rd-2",
      refField: "address_id",
      sourceRegistryId: "reg-2",
      targetRegistryId: "reg-3",
      label: "Address",
    });

    // First fetcher returns record with address_id; second returns address fields.
    let callCount = 0;
    const fetcher: CrossAppHopFetcher = {
      async fetchHop(_params) {
        const idx = callCount++;
        if (idx === 0) {
          // Hop 1: counterparty record with address_id field.
          return { ok: true, fields: { id: "cpty-1", name: "Acme", address_id: "addr-99" } };
        }
        // Hop 2: address record.
        return { ok: true, fields: { id: "addr-99", city: "Moscow" } };
      },
    };

    const sourceRecord: Record<string, unknown> = {
      id: "order-1",
      counterparty_id: "cpty-1",
    };
    const deps: CrossAppRefDeps = { fetcher };

    const results = await resolveHopChain([refDef1, refDef2], sourceRecord, deps);

    expect(results).toHaveLength(2);
    expect(results[0]!.allowed).toBe(true);
    expect(results[1]!.allowed).toBe(true);
    if (results[0]!.allowed) {
      expect(results[0]!.depth).toBe(1);
    }
    if (results[1]!.allowed) {
      expect(results[1]!.depth).toBe(2);
      expect((results[1]! as { fields: Record<string, unknown> }).fields).toHaveProperty("city", "Moscow");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-10: hop chain first hop denied → stops at first denial
// ---------------------------------------------------------------------------

describe("CR-10: resolveHopChain — fail-fast on first denied hop", () => {
  it("returns only one result (the denied hop) and does not call fetcher again", async () => {
    const refDef1 = makeRefDef({ id: "rd-1", refField: "counterparty_id", label: "Counterparty" });
    const refDef2 = makeRefDef({ id: "rd-2", refField: "address_id", label: "Address" });

    const fetchHopSpy = vi.fn(async () => ({ ok: false as const, reason: "no_grant" as const }));
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: fetchHopSpy } };

    const results = await resolveHopChain(
      [refDef1, refDef2],
      makeSourceRecord(),
      deps,
    );

    // Should stop after the first denied hop — only one result returned.
    expect(results).toHaveLength(1);
    expect(results[0]!.allowed).toBe(false);
    // Fetcher was only called once (not twice).
    expect(fetchHopSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CR-11: hop chain second hop denied → first allowed + second denied
// ---------------------------------------------------------------------------

describe("CR-11: resolveHopChain — second hop denied", () => {
  it("returns first allowed + second denied, stops traversal", async () => {
    const refDef1 = makeRefDef({ id: "rd-1", refField: "counterparty_id", label: "Counterparty" });
    const refDef2 = makeRefDef({ id: "rd-2", refField: "address_id", label: "Address" });

    let callCount = 0;
    const fetcher: CrossAppHopFetcher = {
      async fetchHop(_params) {
        const idx = callCount++;
        if (idx === 0) {
          // First hop allowed.
          return { ok: true, fields: { id: "cpty-1", name: "Acme", address_id: "addr-99" } };
        }
        // Second hop denied.
        return { ok: false, reason: "no_grant" };
      },
    };

    const results = await resolveHopChain(
      [refDef1, refDef2],
      makeSourceRecord(),
      { fetcher },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.allowed).toBe(true);
    expect(results[1]!.allowed).toBe(false);
    if (!results[1]!.allowed) {
      expect(results[1]!.reason).toBe("no_grant");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-12: depth accumulates correctly across hops
// ---------------------------------------------------------------------------

describe("CR-12: depth accumulates across chain hops", () => {
  it("depth increments: hop1 → depth=1, hop2 → depth=2", async () => {
    const refDef1 = makeRefDef({ id: "rd-1", refField: "a_id", label: "A" });
    const refDef2 = makeRefDef({ id: "rd-2", refField: "b_id", label: "B" });

    const fetcher: CrossAppHopFetcher = {
      async fetchHop(_params) {
        return { ok: true, fields: { a_id: "next-1", b_id: "next-2", name: "record" } };
      },
    };

    const results = await resolveHopChain(
      [refDef1, refDef2],
      { id: "src", a_id: "next-1" },
      { fetcher },
    );

    expect(results[0]!.allowed).toBe(true);
    if (results[0]!.allowed) expect((results[0]! as { depth: number }).depth).toBe(1);

    expect(results[1]!.allowed).toBe(true);
    if (results[1]!.allowed) expect((results[1]! as { depth: number }).depth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CR-13: hop-cap boundary: depth=2 allowed, depth=3 (= HOP_CAP) denied
// ---------------------------------------------------------------------------

describe("CR-13: HOP_CAP boundary — depth=HOP_CAP-1 allowed, depth=HOP_CAP denied", () => {
  it("depth = HOP_CAP - 1 is allowed (depth + 1 = HOP_CAP, which is NOT > HOP_CAP)", async () => {
    const deps: CrossAppRefDeps = { fetcher: allowingFetcher({ ok: true }) };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), HOP_CAP - 1, deps);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.depth).toBe(HOP_CAP);
    }
  });

  it("depth = HOP_CAP is denied (depth + 1 = HOP_CAP + 1 > HOP_CAP)", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), HOP_CAP, deps);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("hop_cap_exceeded");
    }
    expect(mockFetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CR-14: cross_tenant deny
// ---------------------------------------------------------------------------

describe("CR-14: cross_tenant deny from fetcher", () => {
  it("returns denied with reason=cross_tenant and redacted projection", async () => {
    const deps: CrossAppRefDeps = { fetcher: denyingFetcher("cross_tenant") };
    const result = await resolveHop(makeRefDef(), makeSourceRecord(), 0, deps);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("cross_tenant");
      expect(result.redactedProjection.visible).toBe(false);
      expect(result.redactedProjection.redacted).toBe(true);
      expect(result.redactedProjection.label).toBe("Counterparty");
    }
  });
});

// ---------------------------------------------------------------------------
// CR-15: buildRedactedHopProjection produces correct sentinel
// ---------------------------------------------------------------------------

describe("CR-15: buildRedactedHopProjection", () => {
  it("produces the T-0081 FieldProjection sentinel shape", () => {
    const proj = buildRedactedHopProjection("counterparty_id", "Counterparty");
    expect(proj.key).toBe("counterparty_id");
    expect(proj.visible).toBe(false);
    expect(proj.redacted).toBe(true);
    expect(proj.label).toBe("Counterparty");
    // Must NOT have a `value` key (F-3 mirror).
    expect("value" in proj).toBe(false);
  });

  it("works for arbitrary field names and labels", () => {
    const proj = buildRedactedHopProjection("financial_contact_id", "Financial Contact");
    expect(proj.key).toBe("financial_contact_id");
    expect(proj.label).toBe("Financial Contact");
  });
});

// ---------------------------------------------------------------------------
// CR-16: empty chain returns empty results
// ---------------------------------------------------------------------------

describe("CR-16: empty refDefs chain returns empty result array", () => {
  it("resolveHopChain with empty refDefs returns []", async () => {
    const mockFetcher = vi.fn();
    const deps: CrossAppRefDeps = { fetcher: { fetchHop: mockFetcher } };

    const results = await resolveHopChain([], { id: "src" }, deps);

    expect(results).toEqual([]);
    expect(mockFetcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CR-SECURITY: verify no second authority path — test that the module
// does NOT resolve grants internally (it only calls the fetcher port which
// itself goes through the single PDP). This is a structural test.
// ---------------------------------------------------------------------------

describe("SECURITY: cross-app-ref does not resolve grants internally", () => {
  it("uses only the injected fetcher port for ACL checks (no inline grant algebra)", async () => {
    // If the module called grant resolution internally, the result would change
    // when the fetcher mock always denies — but the refDef has a valid tenantId/registryId.
    // The ONLY authority is the fetcher port response.
    const fetchHopSpy = vi.fn(async (_params: unknown) => ({
      ok: false as const,
      reason: "no_grant" as const,
    }));

    const result = await resolveHop(
      makeRefDef(),
      makeSourceRecord(),
      0,
      { fetcher: { fetchHop: fetchHopSpy } },
    );

    expect(result.allowed).toBe(false);
    // The fetcher was called exactly once — the module defers to it, not to
    // inline grant resolution.
    expect(fetchHopSpy).toHaveBeenCalledTimes(1);
  });
});
