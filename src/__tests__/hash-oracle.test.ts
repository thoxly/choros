/**
 * T-0118 (E4.3-fu) — fitness suite for the keyed-digest `hash` transform that
 * closes the cross-tenant equality-oracle surfaced by TEST T-0033
 * (`F-1-hash-equality-oracle`).
 *
 * Each describe block maps to a fitness function (FF-T118-*) and its AC id.
 * The two adversarial inversions of the TEST finding are FF-T118-2 (cross-tenant
 * oracle killed) and FF-T118-3 (within-tenant determinism preserved).
 *
 * Coverage seam: the behavioural change lives in `maskFields` (the keyed `hash`
 * branch on `MaskContext`) and in the `makeKeyedDigest` port. These tests drive
 * both directly — the same `MaskContext`/port the resolver assembles at
 * `buildMaskContext` (grant-resolver.ts) and the composition root (main.ts).
 *
 * AC-12 (no regression) is covered by the unchanged T-0033 suites
 * (`data-classification.test.ts`, `grant-resolver.test.ts`) staying green; this
 * file only asserts the NEW `hash` semantics.
 *
 * All functions under test are pure (the HMAC port is functionally pure given a
 * bound key); no IO, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  type ClassificationRow,
  type MaskContext,
  selectTransform,
  maskFields,
} from "../core/data-classification.js";
import {
  type KeyedDigest,
  type KeyedDigestInput,
  makeKeyedDigest,
} from "../core/keyed-digest.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const RT = "record";
const V = 1; // facet schema version
const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";

const KEY1 = Buffer.from("a".repeat(64), "hex"); // 32 bytes
const KEY2 = Buffer.from("b".repeat(64), "hex"); // 32 bytes, different

/** Classification row keyed on (resourceType, facetField, version). */
function row(facetField: string, cls = "restricted" as const, schemaVersion = V): ClassificationRow {
  return { resourceType: RT, facetField, facetSchemaVersion: schemaVersion, class: cls };
}

/**
 * Build a MaskContext that routes a `restricted` field to the `hash` transform.
 * `selectTransform("restricted", "public")` is gap 3 ⇒ `hash` (the widest
 * non-drop reader — the one that must not get an equality oracle). The keyed
 * digest fn is bound from `port` (the same shape buildMaskContext threads in).
 */
function hashCtx(opts: {
  rows: ClassificationRow[];
  tenantId?: string;
  resourceType?: string;
  port?: KeyedDigest;
}): MaskContext {
  const { rows, tenantId, resourceType, port } = opts;
  return {
    governed: true,
    rows,
    clearance: "public", // public reader of a restricted field ⇒ gap 3 ⇒ hash
    facetSchemaVersion: V,
    resourceType,
    tenantId,
    keyedDigest: port ? (input) => port.digest(input) : undefined,
  };
}

/** The pre-T-0118 keyless djb2, reproduced inline for the anti-keyless assertions. */
function oldKeylessDjb2(input: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (Math.imul(31, h1) + c) >>> 0;
    h2 = (Math.imul(29, h2) + c) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

// A KeyedDigest whose digest() always yields undefined (no key for the tenant).
const NO_KEY_PORT: KeyedDigest = { digest: () => undefined };

const V_SSN = "123456789";
const RAW = { ssn: V_SSN };
const VISIBLE = new Set(["ssn"]);

// Sanity: the fixture really does route `ssn` to the `hash` transform.
describe("fixture sanity — restricted field at public clearance routes to hash", () => {
  it("selectTransform(restricted, public) === hash (gap 3)", () => {
    expect(selectTransform("restricted", "public")).toBe("hash");
  });
});

// ---------------------------------------------------------------------------
// FF-T118-2 — cross-tenant oracle killed (AC-1, adversarial)
// ---------------------------------------------------------------------------

describe("FF-T118-2 cross-tenant oracle killed [AC-1]", () => {
  it("same value V + same field under tenant A vs B ⇒ DIFFERENT digests", () => {
    const port = makeKeyedDigest(KEY1);
    const outA = maskFields(RAW, VISIBLE, hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT, port }));
    const outB = maskFields(RAW, VISIBLE, hashCtx({ rows: [row("ssn")], tenantId: TENANT_B, resourceType: RT, port }));
    expect(outA.ssn).toBeTypeOf("string");
    expect(outB.ssn).toBeTypeOf("string");
    expect(outA.ssn).not.toBe(outB.ssn); // the oracle: identical values must NOT collide across tenants
    expect(outA.ssn).not.toBe(V_SSN); // raw never present
    expect(outB.ssn).not.toBe(V_SSN);
  });
});

// ---------------------------------------------------------------------------
// FF-T118-3 — within-(tenant,field) determinism preserved (AC-2, adversarial)
// ---------------------------------------------------------------------------

describe("FF-T118-3 within-(tenant,field) determinism preserved [AC-2]", () => {
  it("same tenant+field+value, two mask calls ⇒ SAME digest (join-preserving)", () => {
    const port = makeKeyedDigest(KEY1);
    const ctx = hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT, port });
    const out1 = maskFields(RAW, VISIBLE, ctx);
    const out2 = maskFields(RAW, VISIBLE, ctx);
    expect(out1.ssn).toBeTypeOf("string");
    expect(out1.ssn).toBe(out2.ssn); // T-0033 AC-13 not regressed
  });
});

// ---------------------------------------------------------------------------
// FF-T118-4 — cross-field separation (AC-3)
// ---------------------------------------------------------------------------

describe("FF-T118-4 cross-field separation [AC-3]", () => {
  it("same tenant+value in two different facetFields ⇒ DIFFERENT digests", () => {
    const port = makeKeyedDigest(KEY1);
    // Same raw value under two different field names, both restricted ⇒ hash.
    const rawTwo = { ssn: V_SSN, alt: V_SSN };
    const out = maskFields(
      rawTwo,
      new Set(["ssn", "alt"]),
      hashCtx({ rows: [row("ssn"), row("alt")], tenantId: TENANT_A, resourceType: RT, port }),
    );
    expect(out.ssn).toBeTypeOf("string");
    expect(out.alt).toBeTypeOf("string");
    expect(out.ssn).not.toBe(out.alt); // field-identity is part of the preimage (C-1)
  });
});

// ---------------------------------------------------------------------------
// FF-T118-5 — keyed, not keyless (AC-4, anti-rainbow)
// ---------------------------------------------------------------------------

describe("FF-T118-5 keyed not keyless [AC-4]", () => {
  it("two different injected keys ⇒ different digests for identical input", () => {
    const input: KeyedDigestInput = { value: V_SSN, tenantId: TENANT_A, resourceType: RT, facetField: "ssn" };
    const d1 = makeKeyedDigest(KEY1).digest(input);
    const d2 = makeKeyedDigest(KEY2).digest(input);
    expect(d1).toBeTypeOf("string");
    expect(d2).toBeTypeOf("string");
    expect(d1).not.toBe(d2);
  });

  it("the keyed digest of V is NOT the old keyless djb2 of V", () => {
    const port = makeKeyedDigest(KEY1);
    const out = maskFields(RAW, VISIBLE, hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT, port }));
    expect(out.ssn).not.toBe(oldKeylessDjb2(V_SSN)); // rainbow attack on djb2 no longer applies
  });
});

// ---------------------------------------------------------------------------
// FF-T118-6 — fail-closed on absent key (AC-5 / D-3)
// ---------------------------------------------------------------------------

describe("FF-T118-6 fail-closed on absent key [AC-5]", () => {
  it("port present but digest() returns undefined (no key) ⇒ hash field DROPPED, raw absent", () => {
    const out = maskFields(
      RAW,
      VISIBLE,
      hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT, port: NO_KEY_PORT }),
    );
    expect("ssn" in out).toBe(false); // key omitted (drop), capability-not-text
    expect(Object.values(out)).not.toContain(V_SSN); // raw never present
  });
});

// ---------------------------------------------------------------------------
// FF-T118-7 — no-port degrade is fail-closed (AC-6 / D-4, negative)
// ---------------------------------------------------------------------------

describe("FF-T118-7 no-port degrade is fail-closed [AC-6]", () => {
  it("NO keyedDigest injected ⇒ hash field DROPPED; keyless djb2 NOT emitted; raw absent", () => {
    // port omitted ⇒ ctx.keyedDigest === undefined (the pre-T-0118 wiring shape)
    const out = maskFields(RAW, VISIBLE, hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT }));
    expect("ssn" in out).toBe(false); // D-4: no port ⇒ drop, never keyless
    const leak = oldKeylessDjb2(V_SSN);
    expect(Object.values(out)).not.toContain(leak); // the vulnerable keyless digest is gone
    expect(Object.values(out)).not.toContain(V_SSN); // raw never present
  });
});

// ---------------------------------------------------------------------------
// FF-T118-8 — tenant binding is real, not cosmetic (AC-11)
// ---------------------------------------------------------------------------

describe("FF-T118-8 tenant binding real not cosmetic [AC-11]", () => {
  it("vary ONLY tenantId (resourceType, facetField, value, key fixed) ⇒ digest changes", () => {
    const port = makeKeyedDigest(KEY1);
    const base = { value: V_SSN, resourceType: RT, facetField: "ssn" };
    const dA = port.digest({ ...base, tenantId: TENANT_A });
    const dB = port.digest({ ...base, tenantId: TENANT_B });
    expect(dA).toBeTypeOf("string");
    expect(dA).not.toBe(dB); // tenant is an actual HMAC input, not appended decoratively
  });
});

// ---------------------------------------------------------------------------
// FF-T118-9 (vitest half) — single projection: human-path == agent-path
// (the shell half is ci/checks/single-resolver.sh, run in `npm run fitness`)
// ---------------------------------------------------------------------------

describe("FF-T118-9 single projection — human-path == agent-path on a hash-masked field [AC-8]", () => {
  it("two projections of the same hash-masked record via the ONE maskFields path are byte-identical", () => {
    const port = makeKeyedDigest(KEY1);
    const ctx = hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT, port });
    // The single resolver core runs maskFields once; both the human form and the
    // agent payload derive from the SAME masked projection. Same inputs ⇒ identical.
    const human = maskFields(RAW, VISIBLE, ctx);
    const agent = maskFields(RAW, VISIBLE, ctx);
    expect(human).toEqual(agent);
    expect(JSON.stringify(human)).toBe(JSON.stringify(agent));
  });
});

// ---------------------------------------------------------------------------
// FF-T118-11 — determinism overall (AC-10)
// ---------------------------------------------------------------------------

describe("FF-T118-11 determinism overall [AC-10]", () => {
  it("deeply-equal full inputs (record, rows, tenant, key) ⇒ deeply-equal masked output; double-invoke deep-equal", () => {
    const buildBundle = () => {
      const port = makeKeyedDigest(Buffer.from("c".repeat(64), "hex"));
      const rows = [row("ssn"), row("alt")];
      const ctx = hashCtx({ rows, tenantId: TENANT_A, resourceType: RT, port });
      const raw = { ssn: V_SSN, alt: "telephone" };
      return maskFields(raw, new Set(["ssn", "alt"]), ctx);
    };
    const a = buildBundle();
    const b = buildBundle();
    expect(a).toEqual(b);

    // Double-invoke on one ctx is also deep-equal.
    const port = makeKeyedDigest(Buffer.from("d".repeat(64), "hex"));
    const ctx = hashCtx({ rows: [row("ssn")], tenantId: TENANT_A, resourceType: RT, port });
    expect(maskFields(RAW, VISIBLE, ctx)).toEqual(maskFields(RAW, VISIBLE, ctx));
  });
});

// ---------------------------------------------------------------------------
// Port-level: makeKeyedDigest factory honest-degrade (AC-5/AC-6 unit anchor)
// ---------------------------------------------------------------------------

describe("makeKeyedDigest factory — empty/undefined key honest-degrades to undefined", () => {
  it("undefined key ⇒ digest() always undefined (fail-closed)", () => {
    const port = makeKeyedDigest(undefined);
    expect(port.digest({ value: V_SSN, tenantId: TENANT_A, resourceType: RT, facetField: "ssn" })).toBeUndefined();
  });

  it("empty buffer key ⇒ digest() always undefined (present-but-keyless == no key)", () => {
    const port = makeKeyedDigest(Buffer.alloc(0));
    expect(port.digest({ value: V_SSN, tenantId: TENANT_A, resourceType: RT, facetField: "ssn" })).toBeUndefined();
  });

  it("a bound key yields a stable hex digest", () => {
    const port = makeKeyedDigest(KEY1);
    const d = port.digest({ value: V_SSN, tenantId: TENANT_A, resourceType: RT, facetField: "ssn" });
    expect(d).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });
});
