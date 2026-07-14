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
  llm_connection_id: null as string | null,
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

  // T-0599 (AC-3): serializeAgent's llm_bound = (row.llm_secret_handle !== null)
  // is a PURE decision over the SQL-resolved value. The SQL layer
  // (listAgentsTx, agents-list.ts) now feeds it COALESCE(lc.secret_handle,
  // ac.llm_secret_handle) instead of the bare deprecated column — these 4
  // cases enumerate every combination of (connection secret_handle, inline
  // llm_secret_handle) and assert the value `serializeAgent` WOULD receive
  // post-COALESCE (mirroring SQL COALESCE semantics: first non-null wins).
  // This locks the decision function's honesty contract even though the JOIN
  // itself is only provable against live Postgres (ci/checks/db/
  // assistant-llm-binding.test.ts T-0599 FF-1/FF-2).
  describe("T-0599 llm_bound honesty — 4 combinations of (connection secret, inline secret)", () => {
    const coalesce = (connectionSecret: string | null, inlineSecret: string | null) =>
      connectionSecret ?? inlineSecret; // mirrors SQL: COALESCE(lc.secret_handle, ac.llm_secret_handle)

    it("connection bound (non-null), inline null → resolved non-null → llm_bound:true (the T-0498 current path)", () => {
      const resolved = coalesce("vault://secret/connection-only", null);
      const out = serializeAgent({ ...base, agent_card_id: "c1", employee_id: "e1", agent_type: "workforce", slug: "x", display_name: "X", llm_secret_handle: resolved });
      expect(out.llm_bound).toBe(true);
    });

    it("connection null, inline bound (non-null) → resolved non-null → llm_bound:true (legacy inline path)", () => {
      const resolved = coalesce(null, "vault://secret/inline-only");
      const out = serializeAgent({ ...base, agent_card_id: "c2", employee_id: "e2", agent_type: "workforce", slug: "x", display_name: "X", llm_secret_handle: resolved });
      expect(out.llm_bound).toBe(true);
    });

    it("connection bound AND inline bound → connection wins per COALESCE order → llm_bound:true either way", () => {
      const resolved = coalesce("vault://secret/connection-wins", "vault://secret/inline-shadowed");
      expect(resolved).toBe("vault://secret/connection-wins");
      const out = serializeAgent({ ...base, agent_card_id: "c3", employee_id: "e3", agent_type: "workforce", slug: "x", display_name: "X", llm_secret_handle: resolved });
      expect(out.llm_bound).toBe(true);
    });

    it("connection null, inline null → resolved null → llm_bound:false (the honest dormant case, T-0599's own bug fixture)", () => {
      const resolved = coalesce(null, null);
      const out = serializeAgent({ ...base, agent_card_id: "c4", employee_id: "e4", agent_type: "workforce", slug: "x", display_name: "X", llm_secret_handle: resolved });
      expect(out.llm_bound).toBe(false);
    });
  });

  it("T-0498: surfaces the named-connection FK (llm_connection_id) for the UI dropdown", () => {
    const bound = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-9",
      employee_id: "emp-uuid-9",
      agent_type: "workforce",
      slug: "x",
      display_name: "X",
      llm_connection_id: "ffffffff-0000-0000-0000-000000000006",
    });
    expect(bound.llm_connection_id).toBe("ffffffff-0000-0000-0000-000000000006");

    const unbound = serializeAgent({
      ...base,
      agent_card_id: "card-uuid-10",
      employee_id: "emp-uuid-10",
      agent_type: "workforce",
      slug: "y",
      display_name: "Y",
    });
    expect(unbound.llm_connection_id).toBeNull();
  });
});
