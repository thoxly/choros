/**
 * T-0043: mcp_tool Registry (E5.3) — pure TS, no DB/IO/LLM.
 *
 * Delivers the `mcp_tool` registry module: the `McpToolSource` port, the
 * `McpToolRow` row mirror, `isToolReachable` (pure predicate), `resolveAgentToolset`
 * (query-over-grants), and `validateMcpToolWrite` (write-path guard).
 *
 * Three NON-NEGOTIABLE invariants:
 *  - Pure / static-now — no pg/fs/net/http import; state only via injected ports.
 *  - Toolset = query over grants — never a stored per-agent list (NF-6, AC-23).
 *  - No re-declaration of T-0034/T-0018 types (AC-17).
 *
 * Semantic contract: docs/design/T-0043-mcp-tool-registry.adr.md.
 */

import {
  type EffectDeclaration,         // re-used, NOT re-declared (AC-17)
  type EffectKind,                // re-used, NOT re-declared (AC-17)
  classifyTool,                   // pure linter; derives pure_compute
} from "./effect-resource.js";
import {
  type Grant,
  type ResourceType,
  type Operation,
  isEffective,
} from "./grant-lattice.js";
import {
  type GrantSource,               // type-only; no runtime edge (ADR §3.2)
} from "./grant-resolver.js";

// ---------------------------------------------------------------------------
// Re-exported types from dependencies (AC-17 — no local re-declaration)
// ---------------------------------------------------------------------------

// EffectKind is re-exported so callers of this module never need to reach
// directly into effect-resource.ts for it (AC-17, zero-runtime).
export type { EffectKind };

// ResourceType and Operation are imported above for use in ResourceOp — they
// are NOT re-declared here (no `type ResourceType = ...` or `type Operation = ...`).

// ---------------------------------------------------------------------------
// T-0043 types
// ---------------------------------------------------------------------------

/** A Choros object-model resource×operation pair the tool reads/writes.
 *  Distinct axis from `declares` (external effects). Matched against `grant` rows. */
export interface ResourceOp {
  resourceType: ResourceType;     // re-used T-0018 union, NOT re-declared
  operation: Operation;           // re-used T-0018 union, NOT re-declared
}

/** TS mirror of one `choros.mcp_tool` row. `declares` is the typed claim; the
 *  raw jsonb is parsed/validated by the write-path guard before it reaches here. */
export interface McpToolRow {
  tenantId: string;
  id: string;
  name: string;
  description: string | null;
  declares: EffectDeclaration[];
  pureCompute: boolean;
  resourceOps: ResourceOp[];
  createdAt: number;
  updatedAt: number;
}

/** Injected registry-read port (mirrors GrantSource/EffectSource). In-memory in
 *  static-now; the Postgres RLS DAO lands in T-0053. NOT a ResolverDeps field. */
export interface McpToolSource {
  listTools(tenantId: string): Promise<McpToolRow[]>;
}

export interface ResolveToolsetInput {
  tenantId: string;
  employeeId: string;   // the agent's employee.id (kind='agent'); abstract — no agent_card dep
  nowMs: number;
}

// ---------------------------------------------------------------------------
// Write-path guard
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by `validateMcpToolWrite`.
 * On ok=true, `declares` and `pureCompute` are canonical and ready to persist.
 * Caller NEVER trusts a client-supplied pure_compute — it is derived here.
 */
export type McpToolWriteResult =
  | { ok: true; declares: EffectDeclaration[]; pureCompute: boolean }
  | { ok: false; error: "malformed_declares" };

/**
 * Write-path guard (FR-5, FR-8). Parses raw jsonb declares via classifyTool;
 * on malformed input returns a typed error (NOT a throw at the model layer);
 * on success returns the canonical { declares, pureCompute } the DAO must persist.
 *
 * Malformed-declares contract (ADR §3.4):
 *  - classifyTool returns { pure: true }  for valid empty array  → pureCompute = true, declares = [].
 *  - classifyTool returns { pure: false, effects: [...] } (non-empty) → pureCompute = false.
 *  - classifyTool returns { pure: false, effects: [] } for malformed (non-array / bad kind) →
 *    reject with { ok: false, error: "malformed_declares" }.
 *
 * The caller NEVER trusts a client-supplied pure_compute — it is derived here (AC-8).
 * Malformed declares is rejected before INSERT/UPDATE (AC-9).
 */
export function validateMcpToolWrite(rawDeclares: unknown): McpToolWriteResult {
  const profile = classifyTool(rawDeclares);

  if (profile.pure) {
    // Empty valid declares → pure-compute tool.
    return { ok: true, declares: [], pureCompute: true };
  }

  // profile.pure === false: either effecting (effects.length > 0) or malformed (effects.length === 0).
  if (profile.effects.length === 0) {
    // Malformed: classifyTool failed to parse → reject (AC-9).
    return { ok: false, error: "malformed_declares" };
  }

  // Valid non-empty declares → effecting tool.
  return { ok: true, declares: profile.effects, pureCompute: false };
}

// ---------------------------------------------------------------------------
// Pure reachability predicate
// ---------------------------------------------------------------------------

/**
 * Pure reachability predicate (NF-4 deterministic, no IO).
 *
 * A tool is reachable iff EVERY resource_ops pair is covered by ≥1 grant that is
 * same-tenant ∧ resourceType-match ∧ operation-match ∧ isEffective(g, nowMs).
 *
 * Empty resource_ops ⇒ reachable iff grants.length >= 1 (FR-6 step 3, AC-22):
 * a pure-compute tool with no resource requirements is reachable for any grant-holder.
 *
 * Zero grants ⇒ always false (AC-12 structural guarantee — "0 roles → 0 tools").
 */
export function isToolReachable(
  tool: McpToolRow,
  grants: readonly Grant[],
  tenantId: string,
  nowMs: number,
): boolean {
  // Filter to same-tenant effective grants (pre-check, used in all branches).
  const effectiveGrants = grants.filter(
    (g) => g.tenantId === tenantId && isEffective(g, nowMs),
  );

  if (tool.resourceOps.length === 0) {
    // Empty resource_ops: reachable iff at least one effective grant exists (AC-22).
    return effectiveGrants.length >= 1;
  }

  // Non-empty resource_ops: every pair must be covered by ≥1 effective grant.
  return tool.resourceOps.every((op) =>
    effectiveGrants.some(
      (g) => g.resourceType === op.resourceType && g.operation === op.operation,
    ),
  );
}

// ---------------------------------------------------------------------------
// Toolset query
// ---------------------------------------------------------------------------

/**
 * The toolset = query over grants (FR-6). Async (getGrants is async).
 *
 * Algorithm:
 *  1. grants = await GrantSource.getGrants({tenantId, subjectId: employeeId}, nowMs),
 *     kept iff isEffective(g, nowMs).
 *  2. tools = await McpToolSource.listTools(tenantId).
 *  3. return tools.filter(t => isToolReachable(t, grants, tenantId, nowMs)).
 *
 * No stored per-agent list (NF-6); deterministic (NF-4); ports-only (NF-1, AC-14).
 */
export async function resolveAgentToolset(
  input: ResolveToolsetInput,
  deps: { grants: GrantSource; tools: McpToolSource },
): Promise<McpToolRow[]> {
  const { tenantId, employeeId, nowMs } = input;

  // Step 1: Resolve grants for the agent employee at call-time.
  const allGrants = await deps.grants.getGrants(
    { tenantId, subjectId: employeeId },
    nowMs,
  );
  // Keep only effective grants (belt-and-suspenders; GrantSource may return all).
  const grants = allGrants.filter((g) => isEffective(g, nowMs));

  // Step 2: Fetch all tools for the tenant.
  const allTools = await deps.tools.listTools(tenantId);

  // Step 3: Filter to reachable tools.
  return allTools.filter((tool) =>
    isToolReachable(tool, grants, tenantId, nowMs),
  );
}
