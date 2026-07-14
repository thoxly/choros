/**
 * src/core/__tests__/capability-authz.test.ts — T-0475 [E-AGENTS L4]
 *
 * Pure-predicate coverage for the capability-authz module (spec §6):
 *   - holdsLlmConnectionConfigure: only an llm_connection:configure grant unlocks.
 *   - canOperateSystemAgent: authoring_draft (create/update) OR system_agent:operate
 *     unlocks; a plain member (no caps / unrelated grant) does NOT.
 *
 * These are the same predicates the route gate (capability-grants-dao) and the
 * configurator gate (assistant-configurator.hasAuthoringDraftGrant) run, so the
 * lattice-level authority decision is proven here at $0.
 */

import { describe, it, expect } from "vitest";
import type { Grant } from "../grant-lattice.js";
import {
  holdsLlmConnectionConfigure,
  canOperateSystemAgent,
  LLM_CONNECTION_CONFIGURE,
  SYSTEM_AGENT_OPERATE,
  AUTHORING_DRAFT,
} from "../capability-authz.js";

function grant(resourceType: string, operation: Grant["operation"]): Grant {
  return {
    tenantId: "t",
    id: "g",
    roleId: "r",
    resourceType: resourceType as Grant["resourceType"],
    operation,
    scope: { kind: "set", members: [] },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  };
}

describe("T-0475 holdsLlmConnectionConfigure", () => {
  it("true for an llm_connection:configure grant", () => {
    expect(holdsLlmConnectionConfigure([grant(LLM_CONNECTION_CONFIGURE, "configure" as Grant["operation"])])).toBe(true);
  });

  it("false for an empty grant set (plain member)", () => {
    expect(holdsLlmConnectionConfigure([])).toBe(false);
  });

  it("false for an authoring_draft grant — connection config is its OWN capability", () => {
    expect(holdsLlmConnectionConfigure([grant(AUTHORING_DRAFT, "create")])).toBe(false);
  });

  it("false for an unrelated record:read grant", () => {
    expect(holdsLlmConnectionConfigure([grant("record", "read")])).toBe(false);
  });
});

describe("T-0475 canOperateSystemAgent (tied to authoring_draft per spec §6)", () => {
  it("true for a system_agent:operate grant", () => {
    expect(canOperateSystemAgent([grant(SYSTEM_AGENT_OPERATE, "operate" as Grant["operation"])])).toBe(true);
  });

  it("true for an authoring_draft/create grant (the configurator IS a system agent)", () => {
    expect(canOperateSystemAgent([grant(AUTHORING_DRAFT, "create")])).toBe(true);
  });

  it("true for an authoring_draft/update grant", () => {
    expect(canOperateSystemAgent([grant(AUTHORING_DRAFT, "update")])).toBe(true);
  });

  it("false for an empty grant set (plain member cannot operate system agents)", () => {
    expect(canOperateSystemAgent([])).toBe(false);
  });

  it("false for an authoring_draft grant with a non-author operation (read)", () => {
    expect(canOperateSystemAgent([grant(AUTHORING_DRAFT, "read")])).toBe(false);
  });

  it("false for an llm_connection:configure grant alone — distinct capability", () => {
    expect(canOperateSystemAgent([grant(LLM_CONNECTION_CONFIGURE, "configure" as Grant["operation"])])).toBe(false);
  });
});
