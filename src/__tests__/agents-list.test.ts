/**
 * src/__tests__/agents-list.test.ts — T-0473 (E-AGENTS L1)
 *
 * No-DB unit tests for serializeAgent (src/http/agents-list.ts): the pure
 * row→public-shape mapping. Covers the L1 decoupling shape — org-attached
 * (workforce) vs org-less (system/assistant) agents — plus the existing
 * no-secret-leak invariant.
 *
 * This file is the FF-25-3 custody allow-set sibling for src/http/agents-list.ts
 * (it references the llm_secret_handle column field only to assert it never
 * egresses — the same custody class as the agents_list live db probe).
 */

import { describe, it, expect } from "vitest";
import { serializeAgent, deriveLlmProvider } from "../http/agents-list.js";

const base = {
  kc_client_id: "agent-config",
  llm_endpoint: null as string | null,
  llm_model: null as string | null,
  llm_secret_handle: null as string | null,
  position_title: null as string | null,
  department_name: null as string | null,
};

describe("T-0473 serializeAgent — org-attached vs org-less", () => {
  it("addresses a workforce (org-attached) agent by employee_id", () => {
    const out = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-1",
      employee_id: "emp-uuid-1",
      agent_type: "workforce",
      slug: "recon-bot",
      display_name: "Сверка-агент",
      kc_client_id: "agent-recon",
      position_title: "Controller",
      department_name: "Finance",
    });
    expect(out.id).toBe("emp-uuid-1"); // employee_id, not the surrogate
    expect(out.has_org_place).toBe(true);
    expect(out.agent_type).toBe("workforce");
    expect(out.position).toBe("Controller");
    expect(out.department).toBe("Finance");
  });

  it("addresses an org-less (system/assistant) agent by its surrogate id, falls back to kc_client_id", () => {
    const out = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-2",
      employee_id: null,
      agent_type: "assistant",
      slug: null,
      display_name: null,
      kc_client_id: "tenant-assistant",
    });
    expect(out.id).toBe("card-uuid-2"); // surrogate, since no employee_id
    expect(out.has_org_place).toBe(false);
    expect(out.agent_type).toBe("assistant");
    expect(out.slug).toBe("tenant-assistant"); // kc_client_id fallback
    expect(out.display_name).toBe("tenant-assistant");
    expect(out.position).toBeNull();
    expect(out.department).toBeNull();
  });

  it("never leaks the raw secret handle — only llm_bound", () => {
    const fixtureHandle = "vault://secret/test/should-never-egress";
    const out = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-3",
      employee_id: "emp-uuid-3",
      agent_type: "workforce",
      slug: "x",
      display_name: "X",
      llm_secret_handle: fixtureHandle,
    });
    expect(out.llm_bound).toBe(true);
    expect(JSON.stringify(out)).not.toContain("should-never-egress");
  });

  it("derives the provider host from the endpoint, never the key", () => {
    expect(deriveLlmProvider("https://api.openai.com/v1")).toBe("api.openai.com");
    expect(deriveLlmProvider(null)).toBeNull();
  });
});
