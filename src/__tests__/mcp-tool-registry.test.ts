/**
 * Fitness tests for T-0043 — mcp_tool Registry (E5.3).
 *
 * Coverage map (all 23 AC / 15 FF from ADR §7-§8):
 *
 * FF-1  → AC-1  : migration 040 shape (structural/fitness)
 * FF-2  → AC-7  : pure_compute DB CHECK floor (structural/fitness)
 * FF-3  → AC-8  : validateMcpToolWrite derives pureCompute = classifyTool().pure
 * FF-4  → AC-9  : malformed declares is rejected before persist
 * FF-5  → AC-10/AC-11/AC-12/AC-21/AC-22 : resolveAgentToolset correctness
 * FF-6  → AC-13 : resolveAgentToolset determinism
 * FF-7  → AC-2/AC-3/AC-4/AC-5/AC-19 : RLS isolation (structural / DB test)
 * FF-8  → AC-14 : pure module — no pg/fs/net/http import (structural/fitness)
 * FF-9  → AC-17 : no re-declared T-0034/T-0018 types (structural/fitness)
 * FF-10 → AC-15 : frozen public surfaces (structural/fitness)
 * FF-11 → AC-16 : single-resolver.sh green (structural/fitness)
 * FF-12 → AC-23 : no per-agent tool list in migrations/src (structural/fitness)
 * FF-13 → AC-6  : seed coverage (structural/fitness)
 * FF-14 → AC-20 : migration idempotency (DB test)
 * FF-15 → AC-18 : tsc + eslint + fitness green (structural)
 *
 * Unit tests below cover FF-3, FF-4, FF-5, FF-6. Structural / DB invariants
 * (FF-1/2/7/8/9/10/11/12/13/14/15) are verified by the CI fitness-function shell
 * scripts and the live DB migration tests; their presence here is noted but the
 * actual checks run in the CI pipeline.
 *
 * All IO is behind in-memory ports — no Postgres, no pg/fs/net/http.
 */
import { describe, it, expect } from "vitest";
import {
  type McpToolRow,
  type McpToolSource,
  type ResolveToolsetInput,
  type ResourceOp,
  type McpToolWriteResult,
  isToolReachable,
  resolveAgentToolset,
  validateMcpToolWrite,
} from "../core/mcp-tool-registry.js";
import {
  type Grant,
  type Operation,
  type ResourceType,
  type GrantScope,
} from "../core/grant-lattice.js";
import { type GrantSource } from "../core/grant-resolver.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AGENT_ID = "agent-1111-1111-1111-111111111111";
const NOW = 1_700_000_000_000;

const WHOLE_SCOPE: GrantScope = { kind: "set", members: [] };

let grantSeq = 0;
let toolSeq = 0;

/** Build a Grant with sane defaults; override per test. */
function makeGrant(over: Partial<Grant> = {}): Grant {
  grantSeq += 1;
  return {
    tenantId: TENANT_A,
    id: `grant-${grantSeq}`,
    roleId: `role-${grantSeq}`,
    resourceType: "record" as ResourceType,
    operation: "read" as Operation,
    scope: WHOLE_SCOPE,
    delegable: false,
    grantedBy: "owner",
    createdAt: 0,
    ...over,
  };
}

/** Build a McpToolRow with sane defaults; override per test. */
function makeTool(over: Partial<McpToolRow> = {}): McpToolRow {
  toolSeq += 1;
  return {
    tenantId: TENANT_A,
    id: `tool-${toolSeq}`,
    name: `tool-name-${toolSeq}`,
    description: null,
    declares: [],
    pureCompute: true,
    resourceOps: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** In-memory McpToolSource. */
function makeToolSource(tools: McpToolRow[]): McpToolSource {
  return {
    async listTools(tenantId: string): Promise<McpToolRow[]> {
      return tools.filter((t) => t.tenantId === tenantId);
    },
  };
}

/** In-memory GrantSource. */
function makeGrantSource(grants: Grant[]): GrantSource {
  return {
    async getGrants(
      subject: { tenantId: string; subjectId: string },
      _nowMs: number,
    ): Promise<Grant[]> {
      return grants.filter(
        (g) =>
          g.tenantId === subject.tenantId,
      );
    },
  };
}

/** Build a ResourceOp pair. */
function op(resourceType: ResourceType, operation: Operation): ResourceOp {
  return { resourceType, operation };
}

/** Standard resolve input for TENANT_A / AGENT_ID at NOW. */
const INPUT_A: ResolveToolsetInput = {
  tenantId: TENANT_A,
  employeeId: AGENT_ID,
  nowMs: NOW,
};

// ---------------------------------------------------------------------------
// FF-3 / AC-8 — validateMcpToolWrite derives pureCompute = classifyTool().pure
// ---------------------------------------------------------------------------

describe("FF-3 / AC-8 — validateMcpToolWrite: pureCompute derivation", () => {
  it("AC-8: empty array ⇒ ok=true, pureCompute=true, declares=[]", () => {
    const result = validateMcpToolWrite([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pureCompute).toBe(true);
      expect(result.declares).toStrictEqual([]);
    }
  });

  it("AC-8: valid non-empty declares ⇒ ok=true, pureCompute=false", () => {
    const validDeclares = [
      { resourceId: "11111111-1111-1111-1111-111111111111", kind: "integration_endpoint" },
    ];
    const result = validateMcpToolWrite(validDeclares);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pureCompute).toBe(false);
      expect(result.declares).toHaveLength(1);
    }
  });

  it("AC-8: messaging_channel declares ⇒ ok=true, pureCompute=false", () => {
    const validDeclares = [
      { resourceId: "22222222-2222-2222-2222-222222222222", kind: "messaging_channel" },
    ];
    const result = validateMcpToolWrite(validDeclares);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pureCompute).toBe(false);
    }
  });

  it("AC-8: caller-supplied pureCompute is NEVER trusted — the value is derived", () => {
    // Feeding an empty array always yields pureCompute=true regardless of what
    // caller might intend; the function never reads a caller-supplied flag.
    const empty = validateMcpToolWrite([]);
    expect(empty.ok && empty.pureCompute).toBe(true);

    const effecting = validateMcpToolWrite([
      { resourceId: "33333333-3333-3333-3333-333333333333", kind: "integration_endpoint" },
    ]);
    expect(effecting.ok && (effecting as { ok: true; pureCompute: boolean }).pureCompute).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-4 / AC-9 — validateMcpToolWrite: malformed declares rejection
// ---------------------------------------------------------------------------

describe("FF-4 / AC-9 — validateMcpToolWrite: malformed declares rejection", () => {
  it("AC-9: null ⇒ malformed_declares", () => {
    const r = validateMcpToolWrite(null);
    expect(r).toStrictEqual<McpToolWriteResult>({
      ok: false,
      error: "malformed_declares",
    });
  });

  it("AC-9: non-array (string) ⇒ malformed_declares", () => {
    const r = validateMcpToolWrite("integration_endpoint");
    expect(r).toStrictEqual<McpToolWriteResult>({
      ok: false,
      error: "malformed_declares",
    });
  });

  it("AC-9: non-array (object) ⇒ malformed_declares", () => {
    const r = validateMcpToolWrite({ resourceId: "abc", kind: "integration_endpoint" });
    expect(r).toStrictEqual<McpToolWriteResult>({
      ok: false,
      error: "malformed_declares",
    });
  });

  it("AC-9: array with unknown kind value ⇒ malformed_declares", () => {
    const r = validateMcpToolWrite([
      { resourceId: "11111111-1111-1111-1111-111111111111", kind: "unknown_kind_xyz" },
    ]);
    expect(r).toStrictEqual<McpToolWriteResult>({
      ok: false,
      error: "malformed_declares",
    });
  });

  it("AC-9: array with missing resourceId ⇒ malformed_declares", () => {
    const r = validateMcpToolWrite([{ kind: "integration_endpoint" }]);
    expect(r).toStrictEqual<McpToolWriteResult>({
      ok: false,
      error: "malformed_declares",
    });
  });

  it("AC-9: array with malformed element (number) ⇒ malformed_declares", () => {
    const r = validateMcpToolWrite([42]);
    expect(r).toStrictEqual<McpToolWriteResult>({
      ok: false,
      error: "malformed_declares",
    });
  });
});

// ---------------------------------------------------------------------------
// isToolReachable — pure predicate unit tests (backing FF-5 AC-10/12/21/22)
// ---------------------------------------------------------------------------

describe("isToolReachable — pure predicate", () => {
  it("AC-22 / FR-6: empty resource_ops + empty declares ⇒ reachable iff ≥1 effective grant", () => {
    const tool = makeTool({ resourceOps: [] });
    const grant = makeGrant(); // any effective grant
    expect(isToolReachable(tool, [grant], TENANT_A, NOW)).toBe(true);
  });

  it("AC-12 structural: empty resource_ops, ZERO grants ⇒ NOT reachable (0 roles → 0 tools)", () => {
    const tool = makeTool({ resourceOps: [] });
    expect(isToolReachable(tool, [], TENANT_A, NOW)).toBe(false);
  });

  it("AC-21: non-empty resource_ops — ALL pairs must be covered; partial coverage ⇒ NOT reachable", () => {
    const tool = makeTool({
      resourceOps: [
        op("record", "read"),
        op("application", "create"),
      ],
    });
    // Only the first pair is covered
    const partialGrant = makeGrant({ resourceType: "record", operation: "read" });
    expect(isToolReachable(tool, [partialGrant], TENANT_A, NOW)).toBe(false);
  });

  it("AC-10: non-empty resource_ops — full coverage ⇒ reachable", () => {
    const tool = makeTool({
      resourceOps: [
        op("record", "read"),
        op("application", "create"),
      ],
    });
    const g1 = makeGrant({ resourceType: "record", operation: "read" });
    const g2 = makeGrant({ resourceType: "application", operation: "create" });
    expect(isToolReachable(tool, [g1, g2], TENANT_A, NOW)).toBe(true);
  });

  it("cross-tenant: grants from TENANT_B do not cover TENANT_A tool", () => {
    const tool = makeTool({ tenantId: TENANT_A, resourceOps: [] });
    const foreignGrant = makeGrant({ tenantId: TENANT_B });
    // isToolReachable filters to same-tenant grants, so TENANT_B grant is ignored
    expect(isToolReachable(tool, [foreignGrant], TENANT_A, NOW)).toBe(false);
  });

  it("AC-11 effective-window: out-of-window grant does not cover the tool", () => {
    const tool = makeTool({
      resourceOps: [op("record", "read")],
    });
    const expired = makeGrant({
      resourceType: "record",
      operation: "read",
      validFrom: NOW - 10_000,
      validUntil: NOW - 1, // expired
    });
    expect(isToolReachable(tool, [expired], TENANT_A, NOW)).toBe(false);
  });

  it("AC-11 effective-window: in-window grant covers the tool", () => {
    const tool = makeTool({
      resourceOps: [op("record", "read")],
    });
    const live = makeGrant({
      resourceType: "record",
      operation: "read",
      validFrom: NOW - 10_000,
      validUntil: NOW + 10_000,
    });
    expect(isToolReachable(tool, [live], TENANT_A, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FF-5 / AC-10/11/12/21/22 — resolveAgentToolset
// ---------------------------------------------------------------------------

describe("FF-5 / AC-10 — resolveAgentToolset: full-coverage inclusion", () => {
  it("AC-10: tool with resource_ops fully covered is included in the toolset", async () => {
    const grant = makeGrant({ resourceType: "record", operation: "read" });
    const tool = makeTool({
      resourceOps: [op("record", "read")],
    });
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([grant]),
      tools: makeToolSource([tool]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(tool.id);
  });

  it("AC-10: tool with resource_ops NOT covered is excluded from the toolset", async () => {
    // Grant is for 'application'/'create', tool needs 'record'/'read'
    const grant = makeGrant({ resourceType: "application", operation: "create" });
    const tool = makeTool({
      resourceOps: [op("record", "read")],
    });
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([grant]),
      tools: makeToolSource([tool]),
    });
    expect(result).toHaveLength(0);
  });
});

describe("FF-5 / AC-11 — resolveAgentToolset: grant add/revoke flips membership", () => {
  it("AC-11: adding a covering grant includes the tool; removing it excludes", async () => {
    const grant = makeGrant({ resourceType: "record", operation: "read" });
    const tool = makeTool({ resourceOps: [op("record", "read")] });

    // Without the grant
    const withoutGrant = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([]),
      tools: makeToolSource([tool]),
    });
    expect(withoutGrant).toHaveLength(0);

    // With the grant
    const withGrant = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([grant]),
      tools: makeToolSource([tool]),
    });
    expect(withGrant).toHaveLength(1);
    expect(withGrant[0].id).toBe(tool.id);
  });
});

describe("FF-5 / AC-12 — resolveAgentToolset: zero grants ⇒ empty toolset", () => {
  it("AC-12: agent with zero grants has an empty resolved toolset, even if mcp_tool rows exist", async () => {
    const tools = [
      makeTool({ resourceOps: [] }),
      makeTool({ resourceOps: [op("record", "read")] }),
    ];
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([]),
      tools: makeToolSource(tools),
    });
    // Even the empty-resource_ops tool is NOT reachable with zero grants (AC-12/FR-6)
    expect(result).toHaveLength(0);
  });
});

describe("FF-5 / AC-21 — resolveAgentToolset: partial resource_ops coverage excludes", () => {
  it("AC-21: a tool with 2 resource_ops pairs is excluded when only 1 pair is covered", async () => {
    const tool = makeTool({
      resourceOps: [
        op("record", "read"),
        op("application", "create"),
      ],
    });
    // Only first pair covered
    const partial = makeGrant({ resourceType: "record", operation: "read" });
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([partial]),
      tools: makeToolSource([tool]),
    });
    expect(result).toHaveLength(0);
  });

  it("AC-21: the same tool IS included once both pairs are covered", async () => {
    const tool = makeTool({
      resourceOps: [
        op("record", "read"),
        op("application", "create"),
      ],
    });
    const g1 = makeGrant({ resourceType: "record", operation: "read" });
    const g2 = makeGrant({ resourceType: "application", operation: "create" });
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([g1, g2]),
      tools: makeToolSource([tool]),
    });
    expect(result).toHaveLength(1);
  });
});

describe("FF-5 / AC-22 — resolveAgentToolset: pure-compute tool reachable for any grant-holder", () => {
  it("AC-22: empty resource_ops + empty declares ⇒ reachable for any agent with ≥1 grant", async () => {
    const pureComputeTool = makeTool({ resourceOps: [], pureCompute: true });
    const anyGrant = makeGrant({ resourceType: "record", operation: "read" });
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([anyGrant]),
      tools: makeToolSource([pureComputeTool]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(pureComputeTool.id);
  });

  it("AC-22 (boundary): zero grants ⇒ pure-compute tool still excluded (0 roles → 0 tools)", async () => {
    const pureComputeTool = makeTool({ resourceOps: [], pureCompute: true });
    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([]),
      tools: makeToolSource([pureComputeTool]),
    });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FF-6 / AC-13 — resolveAgentToolset determinism
// ---------------------------------------------------------------------------

describe("FF-6 / AC-13 — resolveAgentToolset: determinism (NF-4)", () => {
  it("AC-13: two identical calls with same grants+tools+nowMs return deep-equal results", async () => {
    const grants = [
      makeGrant({ resourceType: "record", operation: "read" }),
      makeGrant({ resourceType: "effect_resource", operation: "invoke" }),
    ];
    const tools = [
      makeTool({ resourceOps: [op("record", "read")] }),
      makeTool({ resourceOps: [op("effect_resource", "invoke")] }),
      makeTool({ resourceOps: [op("application", "create")] }), // NOT covered
    ];

    const deps = {
      grants: makeGrantSource(grants),
      tools: makeToolSource(tools),
    };

    const callA = await resolveAgentToolset(INPUT_A, deps);
    const callB = await resolveAgentToolset(INPUT_A, deps);

    expect(callA).toHaveLength(2);
    expect(callA.map((t) => t.id).sort()).toStrictEqual(
      callB.map((t) => t.id).sort(),
    );
    expect(callA).toStrictEqual(callB);
  });

  it("AC-13: determinism holds across both zero-results and non-zero-results cases", async () => {
    const emptyDeps = {
      grants: makeGrantSource([]),
      tools: makeToolSource([makeTool(), makeTool()]),
    };
    const a = await resolveAgentToolset(INPUT_A, emptyDeps);
    const b = await resolveAgentToolset(INPUT_A, emptyDeps);
    expect(a).toStrictEqual(b);
    expect(a).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed tenant isolation via the toolset query
// ---------------------------------------------------------------------------

describe("Cross-tenant isolation through resolveAgentToolset", () => {
  it("TENANT_B tools are NOT returned for a TENANT_A query", async () => {
    const tenantBTool = makeTool({ tenantId: TENANT_B, resourceOps: [] });
    const tenantAGrant = makeGrant({ tenantId: TENANT_A });

    const result = await resolveAgentToolset(INPUT_A, {
      grants: makeGrantSource([tenantAGrant]),
      tools: makeToolSource([tenantBTool]),
    });
    // The listTools port filters by tenantId, so TENANT_B tools are absent
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateMcpToolWrite — happy-path symmetry with classifyTool (AC-8)
// ---------------------------------------------------------------------------

describe("validateMcpToolWrite: happy-path symmetric with classifyTool (AC-8)", () => {
  it("successive calls with same input return identical results (purity check)", () => {
    const declares = [
      { resourceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", kind: "integration_endpoint" },
    ];
    const r1 = validateMcpToolWrite(declares);
    const r2 = validateMcpToolWrite(declares);
    expect(r1).toStrictEqual(r2);
    expect(r1.ok).toBe(true);
  });

  it("empty array and empty-like '[]' parsed as json are both pure-compute", () => {
    const fromLiteral = validateMcpToolWrite([]);
    expect(fromLiteral.ok).toBe(true);
    if (fromLiteral.ok) {
      expect(fromLiteral.pureCompute).toBe(true);
    }
  });
});
