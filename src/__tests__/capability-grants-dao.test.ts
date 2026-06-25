/**
 * src/__tests__/capability-grants-dao.test.ts — T-0475 [E-AGENTS L4]
 *
 * Proves the DB capability resolvers (capability-grants-dao.ts) against a scripted
 * in-memory stub pg.Pool (no real DB), covering spec §6:
 *
 *   - canConfigureLlmConnection: owner OR llm_connection:configure holder → true;
 *     a plain member → false.
 *   - canActorOperateSystemAgents: a non-admin member → false; an authoring_draft
 *     holder OR a system_agent:operate holder → true; the owner → true.
 *   - isOrglessSystemAgent: TRUE for an agent_card with employee_id IS NULL and
 *     agent_type ∈ {system, assistant} (the capability check works for org-less
 *     system agents — spec §3/§4 / T-0473), FALSE for a workforce (org-attached) agent.
 *   - canOperateSystemAgentTarget: BOTH the operator capability AND an org-less
 *     target are required.
 */

import { describe, it, expect } from "vitest";
import type pg from "pg";
import {
  canConfigureLlmConnection,
  canActorOperateSystemAgents,
  isOrglessSystemAgent,
  canOperateSystemAgentTarget,
} from "../db/capability-grants-dao.js";

const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const AGENT_ID = "cccccccc-0000-0000-0000-000000000003";
const EMP_ID = "dddddddd-0000-0000-0000-000000000004";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";

interface Script {
  isOwner: boolean;
  grants: string[];
  /** agent_card lookup result: 'orgless-system' | 'workforce' | 'none'. */
  agent?: "orgless-system" | "workforce" | "none";
}

function makePool(s: Script): pg.Pool {
  const client = {
    query: async (text: string) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // isGenesisOwnerForTenant: tenant-owner lookup.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return s.isOwner ? { rows: [{ id: "ra-owner" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // getGrantsForSubject step 1: employee slug → id.
      if (text.includes("SELECT id FROM choros.employee") && text.includes("slug = $2")) {
        return { rows: [{ id: EMP_ID }], rowCount: 1 };
      }
      // getGrantsForSubject step 2: role_assignment → role_id.
      if (text.includes("SELECT ra.role_id") && text.includes("role_assignment")) {
        return { rows: [{ role_id: ROLE_ID }], rowCount: 1 };
      }
      // getGrantsForSubject step 3: grant rows.
      if (text.includes('choros."grant"') && text.includes("role_id = ANY")) {
        const rows = s.grants.map((rt, i) => ({
          id: `g-${i}`,
          role_id: ROLE_ID,
          resource_type: rt,
          resource_facet: null,
          operation: rt === "authoring_draft" ? "create" : rt === "system_agent:operate" ? "operate" : "configure",
          scope: { kind: "set", members: [] },
          constraint: null,
          delegable: false,
          granted_by: "seed",
          valid_from: null,
          valid_until: null,
          created_at: "0",
        }));
        return { rows, rowCount: rows.length };
      }
      // isOrglessSystemAgent: agent_card lookup (employee_id IS NULL + agent_type IN system/assistant).
      if (text.includes("FROM choros.agent_card") && text.includes("employee_id IS NULL")) {
        return s.agent === "orgless-system"
          ? { rows: [{ id: AGENT_ID }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-op.
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// canConfigureLlmConnection
// ---------------------------------------------------------------------------

describe("T-0475 canConfigureLlmConnection", () => {
  it("plain member (no owner, no grant) → false", async () => {
    expect(await canConfigureLlmConnection(makePool({ isOwner: false, grants: [] }), TENANT, "e-x")).toBe(false);
  });
  it("owner → true (short-circuit, no grant needed)", async () => {
    expect(await canConfigureLlmConnection(makePool({ isOwner: true, grants: [] }), TENANT, "e-owner")).toBe(true);
  });
  it("non-owner holding llm_connection:configure → true", async () => {
    expect(
      await canConfigureLlmConnection(makePool({ isOwner: false, grants: ["llm_connection:configure"] }), TENANT, "e-cfg"),
    ).toBe(true);
  });
  it("non-owner holding ONLY authoring_draft → false (distinct capability)", async () => {
    expect(
      await canConfigureLlmConnection(makePool({ isOwner: false, grants: ["authoring_draft"] }), TENANT, "e-cfg"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canActorOperateSystemAgents
// ---------------------------------------------------------------------------

describe("T-0475 canActorOperateSystemAgents", () => {
  it("plain member (no caps) → false", async () => {
    expect(await canActorOperateSystemAgents(makePool({ isOwner: false, grants: [] }), TENANT, "e-x")).toBe(false);
  });
  it("authoring_draft holder → true (tied per spec §6)", async () => {
    expect(
      await canActorOperateSystemAgents(makePool({ isOwner: false, grants: ["authoring_draft"] }), TENANT, "e-cfg"),
    ).toBe(true);
  });
  it("system_agent:operate holder → true", async () => {
    expect(
      await canActorOperateSystemAgents(makePool({ isOwner: false, grants: ["system_agent:operate"] }), TENANT, "e-op"),
    ).toBe(true);
  });
  it("owner → true", async () => {
    expect(await canActorOperateSystemAgents(makePool({ isOwner: true, grants: [] }), TENANT, "e-owner")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isOrglessSystemAgent — capability check works for employee_id IS NULL agents.
// ---------------------------------------------------------------------------

describe("T-0475 isOrglessSystemAgent (employee_id IS NULL system/assistant agents)", () => {
  it("true for an org-less system/assistant agent (employee_id IS NULL)", async () => {
    expect(await isOrglessSystemAgent(makePool({ isOwner: false, grants: [], agent: "orgless-system" }), TENANT, AGENT_ID)).toBe(true);
  });
  it("false for a workforce (org-attached) agent — the query requires employee_id IS NULL", async () => {
    expect(await isOrglessSystemAgent(makePool({ isOwner: false, grants: [], agent: "workforce" }), TENANT, AGENT_ID)).toBe(false);
  });
  it("false for a non-existent agent", async () => {
    expect(await isOrglessSystemAgent(makePool({ isOwner: false, grants: [], agent: "none" }), TENANT, AGENT_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canOperateSystemAgentTarget — operator capability AND org-less target.
// ---------------------------------------------------------------------------

describe("T-0475 canOperateSystemAgentTarget", () => {
  it("authoring_draft holder + org-less system agent → true", async () => {
    expect(
      await canOperateSystemAgentTarget(
        makePool({ isOwner: false, grants: ["authoring_draft"], agent: "orgless-system" }),
        TENANT,
        "e-cfg",
        AGENT_ID,
      ),
    ).toBe(true);
  });
  it("capable operator but target is NOT an org-less system agent → false", async () => {
    expect(
      await canOperateSystemAgentTarget(
        makePool({ isOwner: false, grants: ["authoring_draft"], agent: "workforce" }),
        TENANT,
        "e-cfg",
        AGENT_ID,
      ),
    ).toBe(false);
  });
  it("org-less system agent but operator lacks the capability → false", async () => {
    expect(
      await canOperateSystemAgentTarget(
        makePool({ isOwner: false, grants: [], agent: "orgless-system" }),
        TENANT,
        "e-plain",
        AGENT_ID,
      ),
    ).toBe(false);
  });
});
