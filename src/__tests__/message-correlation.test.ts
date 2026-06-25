/**
 * src/__tests__/message-correlation.test.ts — T-0459 [D8-R4].
 *
 * Pure correlation core tests. The load-bearing case is TENANT-FAIL-CLOSED: a
 * message for the wrong/unknown tenant is NEVER delivered cross-tenant.
 */

import { describe, it, expect } from "vitest";
import {
  validateEnvelope,
  correlateOne,
  correlateEnvelope,
  resolveCorrelationKey,
  buildThrowEffectDeclaration,
  authorizeThrowMessage,
  buildThrowPayload,
  isMessageSource,
  type MessageEnvelope,
  type MessageSubscription,
} from "../core/message-correlation.js";
import type { EffectResource, EffectSource } from "../core/effect-resource.js";
import type { Grant } from "../core/grant-lattice.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function env(over: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    tenant: TENANT_A,
    messageName: "contract-signed",
    correlationKey: "CT-100",
    payload: {},
    source: "external-human",
    ...over,
  };
}

function sub(over: Partial<MessageSubscription> = {}): MessageSubscription {
  return {
    inst: "inst-1",
    tenant: TENANT_A,
    messageName: "contract-signed",
    correlationKey: "CT-100",
    broadcast: false,
    ...over,
  };
}

describe("T-0459 — envelope validation (fail-closed)", () => {
  it("accepts a well-formed envelope", () => {
    const r = validateEnvelope(env());
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope("x").ok).toBe(false);
    expect(validateEnvelope([]).ok).toBe(false);
  });

  it("rejects missing/empty required fields", () => {
    expect(validateEnvelope(env({ tenant: "" as unknown as string })).ok).toBe(false);
    expect(validateEnvelope(env({ messageName: "" as unknown as string })).ok).toBe(false);
    expect(validateEnvelope(env({ correlationKey: "" as unknown as string })).ok).toBe(false);
  });

  it("rejects an unknown source (closed vocabulary)", () => {
    const bad = { ...env(), source: "smtp-relay" } as unknown;
    expect(validateEnvelope(bad).ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    const bad = { ...env(), payload: "blob" } as unknown;
    expect(validateEnvelope(bad).ok).toBe(false);
  });

  it("isMessageSource is a total closed predicate", () => {
    expect(isMessageSource("external-human")).toBe(true);
    expect(isMessageSource("internal-signal")).toBe(true);
    expect(isMessageSource("connector-pull")).toBe(true);
    expect(isMessageSource("anything-else")).toBe(false);
    expect(isMessageSource(42)).toBe(false);
  });
});

describe("T-0459 — correlation by record-field key", () => {
  it("matches when tenant + name + key all equal", () => {
    expect(correlateOne(env(), sub())).toEqual({ matched: true });
  });

  it("misses on a different correlation key (record-field value differs)", () => {
    const d = correlateOne(env({ correlationKey: "CT-999" }), sub());
    expect(d).toEqual({ matched: false, miss: "wrong-correlation-key" });
  });

  it("misses on a different message name", () => {
    const d = correlateOne(env({ messageName: "other" }), sub());
    expect(d).toEqual({ matched: false, miss: "wrong-message-name" });
  });

  it("fires the instance whose record field carries the matching key", () => {
    const subs = [
      sub({ inst: "inst-A", correlationKey: "CT-100" }),
      sub({ inst: "inst-B", correlationKey: "CT-200" }),
    ];
    const r = correlateEnvelope(env({ correlationKey: "CT-200" }), subs);
    expect(r.delivered).toBe(true);
    expect(r.firedInstances).toEqual(["inst-B"]);
  });
});

describe("T-0459 — TENANT-FAIL-CLOSED (wrong tenant rejected, never cross-tenant)", () => {
  it("a message for tenant B does NOT fire an identical subscription in tenant A", () => {
    // Same messageName + correlationKey, but the subscription is in tenant A and the
    // envelope is addressed to tenant B → MUST NOT deliver.
    const d = correlateOne(env({ tenant: TENANT_B }), sub({ tenant: TENANT_A }));
    expect(d).toEqual({ matched: false, miss: "wrong-tenant" });
  });

  it("correlateEnvelope never returns a cross-tenant instance even on a name+key match", () => {
    const subs = [sub({ inst: "inst-A", tenant: TENANT_A })];
    const r = correlateEnvelope(env({ tenant: TENANT_B }), subs); // same name+key, other tenant
    expect(r.delivered).toBe(false);
    expect(r.firedInstances).toEqual([]);
    // Flagged distinctly: the only "near match" was blocked SOLELY by the tenant gate.
    expect(r.tenantRejected).toBe(true);
  });

  it("the tenant gate is checked FIRST — a tenant mismatch reports wrong-tenant, not key", () => {
    // Different tenant AND different key: the tenant miss must win (gate is first).
    const d = correlateOne(
      env({ tenant: TENANT_B, correlationKey: "CT-999" }),
      sub({ tenant: TENANT_A, correlationKey: "CT-100" }),
    );
    expect(d.matched).toBe(false);
    expect(d).toEqual({ matched: false, miss: "wrong-tenant" });
  });

  it("an unknown tenant (no subscriptions) is a plain no-match, not cross-tenant delivery", () => {
    const r = correlateEnvelope(env({ tenant: "cccccccc-cccc-cccc-cccc-cccccccccccc" }), [sub()]);
    expect(r.delivered).toBe(false);
    expect(r.firedInstances).toEqual([]);
  });
});

describe("T-0459 — broadcast signal (within-tenant only)", () => {
  it("fires EVERY matching subscription in the same tenant", () => {
    const subs = [
      sub({ inst: "inst-A", broadcast: true, messageName: "status-changed", correlationKey: "STATUS" }),
      sub({ inst: "inst-B", broadcast: true, messageName: "status-changed", correlationKey: "STATUS" }),
    ];
    const r = correlateEnvelope(env({ messageName: "status-changed", correlationKey: "STATUS" }), subs);
    expect(r.delivered).toBe(true);
    expect(r.firedInstances.sort()).toEqual(["inst-A", "inst-B"]);
  });

  it("a broadcast NEVER crosses the tenant boundary", () => {
    const subs = [
      sub({ inst: "inst-A", tenant: TENANT_A, broadcast: true }),
      sub({ inst: "inst-B", tenant: TENANT_B, broadcast: true }),
    ];
    const r = correlateEnvelope(env({ tenant: TENANT_A }), subs);
    expect(r.firedInstances).toEqual(["inst-A"]); // tenant B's instance is never fired.
  });
});

describe("T-0459 — resolveCorrelationKey (key from a record field)", () => {
  it("reads a string field", () => {
    expect(resolveCorrelationKey({ contract_number: "CT-100" }, "contract_number")).toBe("CT-100");
  });
  it("coerces number/boolean", () => {
    expect(resolveCorrelationKey({ n: 42 }, "n")).toBe("42");
    expect(resolveCorrelationKey({ b: true }, "b")).toBe("true");
  });
  it("returns null for absent / empty / non-scalar fields", () => {
    expect(resolveCorrelationKey({}, "x")).toBeNull();
    expect(resolveCorrelationKey({ x: "  " }, "x")).toBeNull();
    expect(resolveCorrelationKey({ x: { a: 1 } }, "x")).toBeNull();
    expect(resolveCorrelationKey(null, "x")).toBeNull();
    expect(resolveCorrelationKey({ x: "v" }, "")).toBeNull();
  });
});

describe("T-0459 — throw side = invoke-grant on messaging_channel (T-0034)", () => {
  const CHANNEL = "dddddddd-dddd-dddd-dddd-dddddddddddd";

  function effectSource(row: EffectResource | null): EffectSource {
    return { getEffect: () => row };
  }
  function channelRow(): EffectResource {
    return { id: CHANNEL, tenantId: TENANT_A, kind: "messaging_channel", scope: { kind: "tags", tags: [CHANNEL] } };
  }
  function invokeGrant(): Grant {
    return {
      tenantId: TENANT_A,
      id: "11111111-1111-1111-1111-111111111111",
      roleId: "role-x",
      resourceType: "effect_resource",
      operation: "invoke",
      // A tags scope whose tag set contains the channel resource id (identity match).
      scope: { kind: "tags", tags: [CHANNEL] },
      delegable: false,
      grantedBy: "owner",
      createdAt: 0,
    } as Grant;
  }

  it("builds an EffectDeclaration for the configured channel", () => {
    const decl = buildThrowEffectDeclaration({
      messageName: "notify", channelResourceId: CHANNEL, payloadFields: [],
    });
    expect(decl).toEqual({ resourceId: CHANNEL, kind: "messaging_channel" });
  });

  it("returns null (fail-closed) when no channel is configured", () => {
    expect(buildThrowEffectDeclaration({ messageName: "x", channelResourceId: "", payloadFields: [] })).toBeNull();
  });

  it("authorizes a throw when a covering invoke-grant exists", () => {
    const r = authorizeThrowMessage(
      { messageName: "notify", channelResourceId: CHANNEL, payloadFields: [] },
      [invokeGrant()],
      1000,
      effectSource(channelRow()),
      TENANT_A,
    );
    expect(r.ok).toBe(true);
  });

  it("DENIES a throw with no channel (fail-closed)", () => {
    const r = authorizeThrowMessage(
      { messageName: "notify", channelResourceId: "", payloadFields: [] },
      [invokeGrant()],
      1000,
      effectSource(channelRow()),
      TENANT_A,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-channel");
  });

  it("DENIES a throw with no covering invoke-grant (fail-closed)", () => {
    const r = authorizeThrowMessage(
      { messageName: "notify", channelResourceId: CHANNEL, payloadFields: [] },
      [], // no grants
      1000,
      effectSource(channelRow()),
      TENANT_A,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-invoke-grant");
  });

  it("buildThrowPayload projects ONLY the declared fields (no full-record dump)", () => {
    const payload = buildThrowPayload(
      { amount: 100, vendor: "Acme", secret: "x" },
      ["amount", "vendor", "missing"],
    );
    expect(payload).toEqual({ amount: 100, vendor: "Acme" });
  });
});
