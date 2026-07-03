/**
 * T-0607 (б) · configurator owner short-circuit unit tests.
 *
 * ZERO NETWORK / ZERO DB / ZERO COST — StubChatLlmPort + in-memory GrantSource.
 *
 * Invariant (AC-4): the server-side rights gate (hasAuthoringDraftGrant, applied
 * BEFORE the LLM) must apply the owner short-circuit that canOperateSystemAgent's
 * contract assigns to the caller. A genesis OWNER whose authority flows from
 * OWNERSHIP (no explicit intersecting grant) must be ADMITTED — not falsely
 * refused (the live defect). A non-owner with no capability must still be REFUSED,
 * deterministically, by the server (not the LLM).
 */

import { describe, it, expect } from "vitest";
import { handleConfigurator } from "../core/assistant-configurator.js";
import { AUTHORING_ACCESS_DENIED_MESSAGE } from "../core/assistant-configurator.js";
import type { HandlerContext } from "../core/assistant-intent.js";
import { StubChatLlmPort } from "../core/__tests__/stub-chat-llm-port.js";
import type { GrantSource } from "../core/grant-resolver.js";
import type { AncestryOracle } from "../core/grant-lattice.js";
import type { ResolveSubject } from "../core/object-handle.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const emptyGrants: GrantSource = { async getGrants() { return []; } };
const flatOracle: AncestryOracle = { isDescendantOrSelf(_h, d, a) { return d === a; } };

function makeCtx(opts: {
  isTenantOwner?: () => Promise<boolean>;
  grants?: GrantSource;
}): HandlerContext {
  return {
    tenantId: TENANT,
    userSubject: { tenantId: TENANT, subjectId: "u-owner" } as ResolveSubject,
    agentSubject: { tenantId: TENANT, subjectId: "assistant-agent" } as ResolveSubject,
    intersectionGrants: opts.grants ?? emptyGrants,
    ancestry: flatOracle,
    llm: new StubChatLlmPort(),
    threadId: "t-1",
    messageId: "m-1",
    isTenantOwner: opts.isTenantOwner,
  };
}

describe("configurator owner short-circuit (T-0607 б / AC-4)", () => {
  it("OWNER without any intersecting grant → ADMITTED (no access-denied text)", async () => {
    const ctx = makeCtx({ isTenantOwner: async () => true, grants: emptyGrants });
    const result = await handleConfigurator("создай приложение Клиенты", ctx);
    expect(result.text).not.toContain(AUTHORING_ACCESS_DENIED_MESSAGE);
  });

  it("NON-owner without any grant → deterministic server refusal", async () => {
    const ctx = makeCtx({ isTenantOwner: async () => false, grants: emptyGrants });
    const result = await handleConfigurator("создай приложение Клиенты", ctx);
    expect(result.text).toContain(AUTHORING_ACCESS_DENIED_MESSAGE);
  });

  it("owner predicate UNDEFINED (test/stub) → falls back to grant check (refused when empty)", async () => {
    const ctx = makeCtx({ grants: emptyGrants }); // isTenantOwner not provided
    const result = await handleConfigurator("создай приложение Клиенты", ctx);
    expect(result.text).toContain(AUTHORING_ACCESS_DENIED_MESSAGE);
  });

  it("owner predicate that THROWS → falls through to grant check (fail-closed)", async () => {
    const ctx = makeCtx({
      isTenantOwner: async () => { throw new Error("resolver down"); },
      grants: emptyGrants,
    });
    const result = await handleConfigurator("создай приложение Клиенты", ctx);
    expect(result.text).toContain(AUTHORING_ACCESS_DENIED_MESSAGE);
  });
});
