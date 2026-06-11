/**
 * T-0077 · config-agent toolset unit tests (E11.6).
 *
 * Tests resolveAgentToolset using in-memory fake ports seeded with
 * migration 044 data. No Postgres — all IO behind injected GrantSource /
 * McpToolSource fakes.
 *
 * Widening-cast pattern for authoring_draft (ADR §2.2, FR-3, AC-06):
 *   resourceType: "authoring_draft" as Grant["resourceType"]
 * — byte-for-byte identical to T-0024's: `resourceType: "agent" as Grant["resourceType"]`
 *   (src/__tests__/invoke-grant.test.ts:83).
 *
 * AC-06: resolveAgentToolset returns 7 tools for seed config-agent.
 * AC-07: resolveAgentToolset returns [] for agent without role_assignment.
 * AC-08: no tool in config-agent toolset reaches authoring_published.
 */

import { describe, it, expect } from "vitest";
import {
  type McpToolRow,
  type McpToolSource,
  type ResolveToolsetInput,
  resolveAgentToolset,
} from "../core/mcp-tool-registry.js";
import {
  type Grant,
  type Operation,
} from "../core/grant-lattice.js";
import { type GrantSource } from "../core/grant-resolver.js";

// ---------------------------------------------------------------------------
// Seed constants — mirror of migration 044
// ---------------------------------------------------------------------------

const DEV_TENANT = "a0000000-0000-0000-0000-000000000001";
const ROLE_CONFIG_AGENT = "e0000000-0000-0000-0000-000000000003";
const EMPLOYEE_CONFIG_AGENT = "d0000000-0000-0000-0000-000000000013";
const NOW_MS = 1_700_000_000_000;

// The 7 mcp_tool rows from migration 044 step 5.
// resource_ops use "authoring_draft" with widening-cast (ADR §2.2).
const SEED_TOOLS: McpToolRow[] = [
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-000000000004",
    name: "emit_form_code",
    description: "Create Floor-2 React component in authoring_draft",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "create" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-000000000005",
    name: "edit_jsonschema",
    description: "Update JSON Schema in authoring_draft",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "update" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-000000000006",
    name: "author_dmn",
    description: "Create/update DMN decision table in authoring_draft",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "create" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-000000000007",
    name: "scaffold_external_worker",
    description: "Generate external-task worker in authoring_draft",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "create" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-000000000008",
    name: "write_object_migration",
    description: "Create object migration in authoring_draft",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "create" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-000000000009",
    name: "open_draft_branch",
    description: "Open draft branch for edits in authoring_draft",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "create" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "10000000-0000-0000-0000-00000000000a",
    name: "request_promote",
    description: "Request promote draft -> published (human-gated)",
    declares: [],
    pureCompute: true,
    resourceOps: [{ resourceType: "authoring_draft" as Grant["resourceType"], operation: "update" as Operation }],
    createdAt: 0,
    updatedAt: 0,
  },
];

// The 7 grant rows from migration 044 step 6.
// Two distinct operations: 'create' (5 grants) and 'update' (2 grants).
const SEED_GRANTS: Grant[] = [
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000001",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000002",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "update",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
  // grants 3-7 are redundant copies of create/update but included for completeness
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000003",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000004",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000005",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000006",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
  {
    tenantId: DEV_TENANT,
    id: "e2000000-0000-0000-0000-000000000007",
    roleId: ROLE_CONFIG_AGENT,
    resourceType: "authoring_draft" as Grant["resourceType"],
    operation: "update",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: false,
    grantedBy: "seed",
    createdAt: 0,
  },
];

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

/** In-memory McpToolSource backed by the provided tools list. */
function makeToolSource(tools: McpToolRow[]): McpToolSource {
  return {
    async listTools(tenantId: string): Promise<McpToolRow[]> {
      return tools.filter((t) => t.tenantId === tenantId);
    },
  };
}

/** In-memory GrantSource returning grants for the given employee (ignores subjectId — simulates resolved grants). */
function makeGrantSource(grants: Grant[]): GrantSource {
  return {
    async getGrants(
      subject: { tenantId: string; subjectId: string },
      _nowMs: number,
    ): Promise<Grant[]> {
      return grants.filter((g) => g.tenantId === subject.tenantId);
    },
  };
}

// ---------------------------------------------------------------------------
// AC-06 — resolveAgentToolset returns 7 tools for seed config-agent
// ---------------------------------------------------------------------------

describe("AC-06: resolveAgentToolset returns 7 tools for seed config-agent", () => {
  it("returns array of length 7 with all authoring_draft tools", async () => {
    const input: ResolveToolsetInput = {
      tenantId: DEV_TENANT,
      employeeId: EMPLOYEE_CONFIG_AGENT,
      nowMs: NOW_MS,
    };
    const result = await resolveAgentToolset(input, {
      grants: makeGrantSource(SEED_GRANTS),
      tools: makeToolSource(SEED_TOOLS),
    });

    expect(result).toHaveLength(7);
    for (const tool of result) {
      // Every tool must have resourceOps[0].resourceType === 'authoring_draft'
      expect(tool.resourceOps).toHaveLength(1);
      expect(tool.resourceOps[0].resourceType).toBe("authoring_draft");
    }
  });

  it("returned tool names match the 7 seed names exactly", async () => {
    const input: ResolveToolsetInput = {
      tenantId: DEV_TENANT,
      employeeId: EMPLOYEE_CONFIG_AGENT,
      nowMs: NOW_MS,
    };
    const result = await resolveAgentToolset(input, {
      grants: makeGrantSource(SEED_GRANTS),
      tools: makeToolSource(SEED_TOOLS),
    });

    const names = result.map((t) => t.name).sort();
    expect(names).toEqual([
      "author_dmn",
      "edit_jsonschema",
      "emit_form_code",
      "open_draft_branch",
      "request_promote",
      "scaffold_external_worker",
      "write_object_migration",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-07 — resolveAgentToolset returns [] for agent without role_assignment
// ---------------------------------------------------------------------------

describe("AC-07: resolveAgentToolset returns [] for agent without role_assignment", () => {
  it("agent with zero grants has empty toolset, even with authoring_draft tools available", async () => {
    const freshAgentId = "d0000000-0000-0000-0000-000000000099"; // no role_assignment
    const input: ResolveToolsetInput = {
      tenantId: DEV_TENANT,
      employeeId: freshAgentId,
      nowMs: NOW_MS,
    };
    const result = await resolveAgentToolset(input, {
      grants: makeGrantSource([]), // zero grants — no role_assignment
      tools: makeToolSource(SEED_TOOLS),
    });

    expect(result).toHaveLength(0);
  });

  it("authoring_draft tools are available in the pool but zero grants yields empty toolset", async () => {
    // Confirms AC-07 is specific to authoring_draft resource_ops tools
    const input: ResolveToolsetInput = {
      tenantId: DEV_TENANT,
      employeeId: "d0000000-0000-0000-0000-000000000099",
      nowMs: NOW_MS,
    };
    // Only authoring_draft tools in pool, no grants
    const result = await resolveAgentToolset(input, {
      grants: makeGrantSource([]),
      tools: makeToolSource(SEED_TOOLS),
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-08 — no tool in config-agent toolset reaches authoring_published
// ---------------------------------------------------------------------------

describe("AC-08: no config-agent tool reaches authoring_published", () => {
  it("toolset from AC-06 contains zero tools with resourceType=authoring_published", async () => {
    const input: ResolveToolsetInput = {
      tenantId: DEV_TENANT,
      employeeId: EMPLOYEE_CONFIG_AGENT,
      nowMs: NOW_MS,
    };
    const result = await resolveAgentToolset(input, {
      grants: makeGrantSource(SEED_GRANTS),
      tools: makeToolSource(SEED_TOOLS),
    });

    const AUTHORING_PUBLISHED = "authoring_published" as Grant["resourceType"];
    const publishedTools = result.filter((t) =>
      t.resourceOps.some((op) => op.resourceType === AUTHORING_PUBLISHED),
    );
    expect(publishedTools).toHaveLength(0);
  });

  it("if an authoring_published tool exists in pool but no grant for it, it is excluded", async () => {
    // Adds a hypothetical published tool; it must be excluded since no grant covers it
    const publishedTool: McpToolRow = {
      tenantId: DEV_TENANT,
      id: "99000000-0000-0000-0000-000000000001",
      name: "publish_form",
      description: "Publish a form to authoring_published (human-gated, no agent grant)",
      declares: [],
      pureCompute: true,
      resourceOps: [{ resourceType: "authoring_published" as Grant["resourceType"], operation: "create" as Operation }],
      createdAt: 0,
      updatedAt: 0,
    };

    const input: ResolveToolsetInput = {
      tenantId: DEV_TENANT,
      employeeId: EMPLOYEE_CONFIG_AGENT,
      nowMs: NOW_MS,
    };
    const result = await resolveAgentToolset(input, {
      grants: makeGrantSource(SEED_GRANTS), // only authoring_draft grants
      tools: makeToolSource([...SEED_TOOLS, publishedTool]),
    });

    // Still 7 — the published tool is not reachable
    expect(result).toHaveLength(7);
    expect(result.find((t) => t.name === "publish_form")).toBeUndefined();
  });
});
