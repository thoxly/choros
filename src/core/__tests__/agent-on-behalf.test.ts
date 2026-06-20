/**
 * T-0359: Tests for agent-on-behalf grant intersection.
 *
 * CRITICAL SECURITY INVARIANTS:
 *  1. Intersection NEVER widens past the user — if the user has no grant,
 *     the agent gets no grant, even if the agent has a broad grant.
 *  2. Cross-tenant → always empty (no cross-tenant grants).
 *  3. Dormant port → intentDispatch propagates LlmDormantError.
 *  4. StubChatLlmPort → returns deterministic text (zero network).
 *
 * DB paths are marked as NOT tested here (require server PG).
 */

import { describe, it, expect } from "vitest";
import { makeIntersectionGrantSource } from "../agent-on-behalf.js";
import type { GrantSource } from "../grant-resolver.js";
import type { Grant, AncestryOracle } from "../grant-lattice.js";
import type { ResolveSubject } from "../object-handle.js";
import { dormantLlmPort, LlmDormantError } from "../llm-port.js";
import { StubChatLlmPort } from "./stub-chat-llm-port.js";
import { intentDispatch } from "../assistant-intent.js";
import type { HandlerContext } from "../assistant-intent.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";

const agentSubjectA: ResolveSubject = { tenantId: TENANT_A, subjectId: "assistant-agent" };
const userSubjectA: ResolveSubject = { tenantId: TENANT_A, subjectId: "alice" };
const userSubjectB: ResolveSubject = { tenantId: TENANT_B, subjectId: "bob" };

const flatOracle: AncestryOracle = {
  isDescendantOrSelf(_h, a, b) { return a === b; },
};

// Helpers to build minimal Grant objects.
function makeGrant(opts: {
  operation: Grant["operation"];
  resourceType: Grant["resourceType"];
  nodeId: string;
  tenantId?: string;
  validFrom?: number;
  validUntil?: number;
}): Grant {
  return {
    tenantId: opts.tenantId ?? TENANT_A,
    id: `grant-${Math.random()}`,
    roleId: `role-${Math.random()}`,
    resourceType: opts.resourceType,
    operation: opts.operation,
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: opts.nodeId,
      nodeLevel: "application",
    },
    delegable: true,
    grantedBy: "system",
    validFrom: opts.validFrom,
    validUntil: opts.validUntil,
    createdAt: Date.now(),
  };
}

function makeGrantSource(grantsBySubject: Record<string, Grant[]>): GrantSource {
  return {
    async getGrants(subject: ResolveSubject, _nowMs: number): Promise<Grant[]> {
      return grantsBySubject[subject.subjectId] ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Intersection invariant: cannot widen past the user
// ---------------------------------------------------------------------------

describe("makeIntersectionGrantSource", () => {
  it("INV-1: agent with broad grant but user with NO grant → empty intersection", async () => {
    const agentGrant = makeGrant({ operation: "read", resourceType: "record", nodeId: "app-1" });
    const base = makeGrantSource({
      "assistant-agent": [agentGrant],
      "alice": [], // user has NO grants
    });

    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    const grants = await intersection.getGrants(agentSubjectA, Date.now());
    expect(grants).toHaveLength(0);
  });

  it("INV-2: agent grant ⊑ user grant (same node) → grant passes through", async () => {
    const sharedNode = "app-shared";
    const agentGrant = makeGrant({ operation: "read", resourceType: "record", nodeId: sharedNode });
    const userGrant = makeGrant({ operation: "read", resourceType: "record", nodeId: sharedNode });
    const base = makeGrantSource({
      "assistant-agent": [agentGrant],
      "alice": [userGrant],
    });

    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    const grants = await intersection.getGrants(agentSubjectA, Date.now());
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(agentGrant.id);
  });

  it("INV-3: agent has write but user only has read → write grant excluded", async () => {
    const nodeId = "app-1";
    const agentGrantWrite = makeGrant({ operation: "update", resourceType: "record", nodeId });
    const agentGrantRead = makeGrant({ operation: "read", resourceType: "record", nodeId });
    const userGrantRead = makeGrant({ operation: "read", resourceType: "record", nodeId });
    const base = makeGrantSource({
      "assistant-agent": [agentGrantWrite, agentGrantRead],
      "alice": [userGrantRead], // user cannot write
    });

    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    const grants = await intersection.getGrants(agentSubjectA, Date.now());

    // Only the read grant survives — write grant is excluded.
    expect(grants).toHaveLength(1);
    expect(grants[0].operation).toBe("read");
  });

  it("INV-4: different resource types — agent record:read not covered by user application:read", async () => {
    const agentGrant = makeGrant({ operation: "read", resourceType: "record", nodeId: "node-1" });
    const userGrant = makeGrant({ operation: "read", resourceType: "application", nodeId: "node-1" });
    const base = makeGrantSource({
      "assistant-agent": [agentGrant],
      "alice": [userGrant],
    });

    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    const grants = await intersection.getGrants(agentSubjectA, Date.now());
    expect(grants).toHaveLength(0);
  });

  it("INV-5: freeform scope on agent grant → excluded from intersection (fail-closed)", async () => {
    const agentGrant: Grant = {
      tenantId: TENANT_A,
      id: "freeform-grant",
      roleId: "role-1",
      resourceType: "record",
      operation: "read",
      scope: { kind: "freeform", predicate: "owner_only" },
      delegable: false,
      grantedBy: "system",
      createdAt: Date.now(),
    };
    const userGrant = makeGrant({ operation: "read", resourceType: "record", nodeId: "any" });
    const base = makeGrantSource({
      "assistant-agent": [agentGrant],
      "alice": [userGrant],
    });

    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    const grants = await intersection.getGrants(agentSubjectA, Date.now());
    expect(grants).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Cross-tenant rejected
  // ---------------------------------------------------------------------------

  it("CROSS-TENANT: agent tenant A, user tenant B → empty (no cross-tenant)", async () => {
    const agentGrantA = makeGrant({ operation: "read", resourceType: "record", nodeId: "node-1" });
    const userGrantB = makeGrant({ operation: "read", resourceType: "record", nodeId: "node-1", tenantId: TENANT_B });
    const base = makeGrantSource({
      "assistant-agent": [agentGrantA],
      "bob": [userGrantB],
    });

    // Agent in TENANT_A, user in TENANT_B — cross-tenant.
    const intersection = makeIntersectionGrantSource(
      base,
      agentSubjectA,              // tenantId = TENANT_A
      userSubjectB,               // tenantId = TENANT_B
      flatOracle,
    );
    const grants = await intersection.getGrants(agentSubjectA, Date.now());
    expect(grants).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Expired user grant not counted
  // ---------------------------------------------------------------------------

  it("EXPIRED: expired user grant does not count as coverage", async () => {
    const now = Date.now();
    const agentGrant = makeGrant({ operation: "read", resourceType: "record", nodeId: "node-1" });
    const userGrantExpired = makeGrant({
      operation: "read",
      resourceType: "record",
      nodeId: "node-1",
      validFrom: 0,
      validUntil: now - 1000, // expired 1 second ago
    });
    const base = makeGrantSource({
      "assistant-agent": [agentGrant],
      "alice": [userGrantExpired],
    });

    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    const grants = await intersection.getGrants(agentSubjectA, now);
    expect(grants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Dormant port → LlmDormantError propagated (not a crash)
// ---------------------------------------------------------------------------

describe("dormantLlmPort.chat", () => {
  it("throws LlmDormantError (fail-closed default)", async () => {
    await expect(dormantLlmPort.chat({ system: "test", messages: [] })).rejects.toThrow(
      LlmDormantError,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. StubChatLlmPort — deterministic, zero network
// ---------------------------------------------------------------------------

describe("StubChatLlmPort", () => {
  it("succeed mode returns deterministic text (zero network)", async () => {
    const stub = new StubChatLlmPort();
    const result = await stub.chat({ system: "sys", messages: [{ role: "user", content: "hello" }] });
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    // NF-6: same input → same output
    const result2 = await stub.chat({ system: "sys", messages: [{ role: "user", content: "hello" }] });
    expect(result2.text).toBe(result.text);
  });

  it("dormant mode throws LlmDormantError", async () => {
    const stub = new StubChatLlmPort({ mode: "dormant" });
    await expect(stub.chat({ system: "s", messages: [] })).rejects.toThrow(LlmDormantError);
  });

  it("error mode throws generic Error", async () => {
    const stub = new StubChatLlmPort({ mode: "error" });
    await expect(stub.chat({ system: "s", messages: [] })).rejects.toThrow(/llm_error/);
  });

  it("records calls in chatCalls array", async () => {
    const stub = new StubChatLlmPort();
    await stub.chat({ system: "s", messages: [{ role: "user", content: "q1" }] });
    await stub.chat({ system: "s", messages: [{ role: "user", content: "q2" }] });
    expect(stub.chatCalls).toHaveLength(2);
    expect(stub.chatCalls[0].messages[0].content).toBe("q1");
    expect(stub.chatCalls[1].messages[0].content).toBe("q2");
  });

  it("fixedText override works", async () => {
    const stub = new StubChatLlmPort({ fixedText: "custom reply" });
    const result = await stub.chat({ system: "s", messages: [] });
    expect(result.text).toBe("custom reply");
  });
});

// ---------------------------------------------------------------------------
// 6. intentDispatch — dormant → LlmDormantError, stub → text
// ---------------------------------------------------------------------------

describe("intentDispatch", () => {
  function makeCtx(llm: StubChatLlmPort | typeof dormantLlmPort): HandlerContext {
    const base = makeGrantSource({ "assistant-agent": [], "alice": [] });
    const intersection = makeIntersectionGrantSource(base, agentSubjectA, userSubjectA, flatOracle);
    return {
      tenantId: TENANT_A,
      userSubject: userSubjectA,
      agentSubject: agentSubjectA,
      intersectionGrants: intersection,
      ancestry: flatOracle,
      llm,
      threadId: "thread-1",
      messageId: "msg-1",
    };
  }

  it("dormant port → intentDispatch propagates LlmDormantError", async () => {
    const ctx = makeCtx(dormantLlmPort);
    await expect(intentDispatch("отчёт по продажам", ctx)).rejects.toThrow(LlmDormantError);
  });

  it("stub port + analyst intent → result has intent='analyst'", async () => {
    const stub = new StubChatLlmPort({ fixedText: "Анализ готов" });
    const ctx = makeCtx(stub);
    const result = await intentDispatch("отчёт по продажам", ctx);
    expect(result.intent).toBe("analyst");
    expect(result.text).toBe("Анализ готов");
  });

  it("stub port + configurator intent → result has intent='configurator'", async () => {
    const stub = new StubChatLlmPort({ fixedText: "Настройка готова" });
    const ctx = makeCtx(stub);
    const result = await intentDispatch("настрой раздел продаж", ctx);
    expect(result.intent).toBe("configurator");
    expect(result.text).toBe("Настройка готова");
  });

  it("unknown intent falls back to analyst (safe read-only default)", async () => {
    const stub = new StubChatLlmPort({ fixedText: "Понял задачу" });
    const ctx = makeCtx(stub);
    const result = await intentDispatch("расскажи мне что-то", ctx);
    expect(result.intent).toBe("analyst"); // fallback
  });
});
