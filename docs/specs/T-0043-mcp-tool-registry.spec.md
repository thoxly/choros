# Spec · T-0043 — `mcp_tool` Registry (E5.3)

**Title:** E5.3 · `mcp_tool` registry: `declares` = gateway-verified claim; `pure_compute` bool; agent toolset = query over grants
**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** E5.3 — `mcp_tool(id, declares jsonb, pure_compute bool)`; an agent's toolset is a query over its grants; `declares` is gateway-verified (E4.4). An agent toolset is never a stored list — it is computed at resolve-time.
**Authoritative sources (do NOT re-open):**
- `playbooks/rbac-backlog.md#E5.3` (GT-1, founder-signed 2026-06-08) — canonical column set, toolset-query model, gateway-verification mandate.
- `playbooks/rbac-discovery-phase1-hypothesis.md` §3 Q2, §5, §1 caveat — "toolset = query over grants; `tool.declares` is a claim the gateway verifies, not a toggle"; "0 roles → 0 tools (least privilege structural)".
- `CONCEPT.md` §3 — "права роли определяют доступные инструменты … Least privilege, как у человека."

**Foundation (do NOT contradict):**
- `src/core/grant-lattice.ts` (T-0018) — `Grant`, `ResourceType`, `Operation`, `ScopeElement`, `isNarrowerOrEqual`, `isEffective`. The `"effect_resource"` and `"mgmt_object:*"` ResourceType literals are the relevant classes.
- `src/core/grant-resolver.ts` (T-0021) — `resolveFor`, `makeGrantResolver`, `ResolverDeps` (with optional `effects?: EffectSource`), `GrantSource`, `refToScope`. The toolset query runs AGAINST the same `GrantSource` used by the resolver.
- `src/core/effect-resource.ts` (T-0034) — `EffectDeclaration`, `EffectKind`, `EffectResource`, `EffectSource`, `ToolEffectProfile`, `classifyTool`, `verifyEffectGrants`. These are the ONLY types/functions T-0043 uses for effect-verification. T-0043 does NOT re-declare them.
- `migrations/016_employee.sql` (T-0017) — `employee(kind IN ('human','agent'))`. Agent identity: `employee.id` tenant-scoped uuid.
- T-0020 agent-card schema (parallel sister, in-flight) — provides `agent_card.employee_id` linkage. T-0043 references agent identity ABSTRACTLY as `employee.id` with `kind = 'agent'`; it does NOT depend on `agent_card` columns beyond identity. The toolset query takes `employee_id` (or equivalently `role_ids_of_employee`) as input.
- `docs/design/T-0013-tenant-isolation.adr.md` — every tenant table obeys T-0013 invariants.
- `docs/design/T-0115-tenant-rls.adr.md` — `ci/checks/known_tenant_tables.txt` is the RLS CI gate; new tenant tables must be added.
- `migrations/031_grant_confirmed2_by.sql` — last applied migration is 031. T-0020 (sister) occupies 032. T-0043 starts at **040** (and may use 041 if a second migration is needed). Migrations 032–039 are occupied or reserved by in-flight parallel tasks.

**Downstream consumers (these tasks read the `mcp_tool` schema; NOT in scope here):**
- T-0040 (E4.5 `role_criticality`) — reads `mcp_tool.declares` to derive the `external_invoke` criticality bit.
- T-0042 (E5.2 agent provisioning) — uses the toolset-query to display the resolved toolset after hire.
- Agent runtime (Stage-2) — consumes the toolset query to populate the runtime MCP server list.

---

## 0. Core design decision: `declares` as a gateway-verified claim, not an advisory toggle

The backlog and hypothesis are unambiguous: `tool.declares` is NOT a human-readable description
of what a tool does. It is a **typed, structured claim** — a JSON array of `EffectDeclaration`
objects — stating which `effect_resource` rows (by `resourceId`) and of which `kind` the tool
will reach at invoke-time. The gateway (T-0021 `resolveFor`, `op="invoke"`) verifies these
declarations against the caller's held grants at **action-time**, not at tool-registration time.

Structural invariant inherited from the model: **a tool whose `declares` the caller's role lacks
grants for is physically absent from the resolved toolset + audited** (capability-not-text,
hypothesis §1 and red-lines). There is no advisory "enabled/disabled" toggle per agent per tool.

The toolset itself is a **query**: given `employee_id` (and its roles), which `mcp_tool` rows
have their declared resource-ops covered by at least one effective grant held by those roles?
Adding a role to an agent changes the resolved toolset with no per-agent tool configuration.
A role revocation removes tools immediately on the next resolve, without a toolset migration.

---

## 1. Summary

Introduce the `mcp_tool` table (one row per registered MCP tool, tenant-isolated), a pure-TS
module `src/core/mcp-tool-registry.ts` implementing the toolset-query and the gateway-seam
needed for `resolveFor`'s `op="invoke"` path, and a CI isolation check. The agent toolset is
resolved from grants — no stored per-agent tool list exists. The `pure_compute` bool on each
`mcp_tool` row is derived from `classifyTool(declares)` at write-time and stored for fast
lookup. Gateway verification at invoke-time uses `verifyEffectGrants` from `effect-resource.ts`.

---

## 2. Functional Requirements

### FR-1 — `mcp_tool` table

`mcp_tool` is a **tenant-isolated, FORCE-RLS** table with the following column set:

| Column | Type | Nullable | Description |
|---|---|---|---|
| `tenant_id` | `uuid NOT NULL` | No | Leading PK component; T-0013 RLS key. |
| `id` | `uuid NOT NULL` | No | PK is `(tenant_id, id)`. |
| `name` | `text NOT NULL` | No | Human-readable tool name; UNIQUE per tenant. |
| `description` | `text NULL` | Yes | Optional human-readable description. NOT used in any access decision. |
| `declares` | `jsonb NOT NULL DEFAULT '[]'::jsonb` | No | `EffectDeclaration[]` — the tool's typed claim: each element has `resourceId` (uuid string) and `kind` (one of the `EffectKind` closed set). Empty array = pure compute. Verified by the gateway at invoke-time; never trusted as advisory text. |
| `pure_compute` | `boolean NOT NULL` | No | `classifyTool(declares).pure` computed at write-time and stored. `true` iff `declares` is `[]` or all declarations parse as pure (no effect). Denormalized for fast toolset filtering. Must be kept consistent with `declares` at every INSERT and UPDATE. |
| `resource_ops` | `jsonb NOT NULL DEFAULT '[]'::jsonb` | No | Canonical list of `{resourceType: ResourceType, operation: Operation}` pairs the tool requires. Used by the toolset query to match against grant rows. Each element has `resourceType` (string matching `ResourceType`) and `operation` (string matching `Operation`). |
| `created_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |
| `updated_at` | `bigint NOT NULL` | No | Unix epoch milliseconds. |

PK: `(tenant_id, id)`.
Unique: `(tenant_id, name)` — one tool name per tenant.

### FR-2 — T-0013 isolation invariants (inherited, non-negotiable)

All T-0013 invariants apply:
- `tenant_id NOT NULL`, no default, leading PK column, leading column of every composite index.
- `FORCE ROW LEVEL SECURITY` + default-DENY policy (`USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`).
- `choros_app` role: `SELECT, INSERT, UPDATE, DELETE` on `mcp_tool`; no DDL.
- Access only via `SET LOCAL choros.tenant_id = ...` inside a transaction.

### FR-3 — `ci/checks/known_tenant_tables.txt` update

`mcp_tool` MUST be added to `ci/checks/known_tenant_tables.txt` (alphabetical position). The
cross-tenant CI tests iterate over this file; the new table MUST pass existing cross-tenant
probes without modification to the test itself.

### FR-4 — Dev seed (idempotent, migration 040)

Migration 040 MUST include a seed block for at least 3 representative `mcp_tool` rows covering
the three `EffectKind` variants plus one pure-compute tool. Seed must be `ON CONFLICT DO NOTHING`.
The seed data demonstrates: one `integration_endpoint` tool, one `messaging_channel` tool, one
pure-compute tool (empty `declares`). Exact UUIDs and names are implementation details for the
architect/coder phase; this spec mandates structural coverage, not specific values.

### FR-5 — `pure_compute` consistency invariant

At every `INSERT` or `UPDATE` of an `mcp_tool` row, `pure_compute` MUST equal
`classifyTool(declares).pure`. This consistency is enforced by:
1. The TS write path calling `classifyTool` before INSERT/UPDATE and setting `pure_compute`
   accordingly (never trusting the caller-supplied value of `pure_compute` directly).
2. A DB CHECK constraint: if `declares = '[]'::jsonb` then `pure_compute = true`.

The DB CHECK is a structural floor (catches the empty-array case mechanically). The full
consistency for non-empty `declares` is enforced at the TS layer.

### FR-6 — Toolset-query: agent toolset = query over grants

A function `resolveAgentToolset(input, deps)` resolves the toolset for an agent employee:

**Input:**
- `tenantId: string`
- `employeeId: string` (the agent's `employee.id`)
- `nowMs: number`
- `GrantSource` (the same T-0021 `GrantSource` port; supplies the agent's effective grants via its roles)
- `McpToolSource` (an injected port supplying `mcp_tool` rows for the tenant; in-memory for static-now, Postgres DAO in T-0053)

**Algorithm:**
1. Fetch `grants = GrantSource.getGrants({tenantId, subjectId: employeeId}, nowMs)`.
   Keep only grants with `isEffective(g, nowMs) === true`.
2. Fetch `allTools = McpToolSource.listTools(tenantId)`.
3. For each tool in `allTools`, compute `isToolReachable(tool, grants)`:
   - For each `{resourceType, operation}` pair in `tool.resource_ops`:
     - There must exist at least one covering grant `g` in `grants` where:
       - `g.resourceType === resourceType`
       - `g.operation === operation`
       - `isEffective(g, nowMs)` (already filtered, step 1)
   - A tool is reachable iff ALL its `resource_ops` pairs are covered by at least one grant.
   - A tool with empty `resource_ops` is reachable iff the agent holds at least one grant
     (reflects "any role → toolset non-empty" but avoids returning unconstrained tools).
     **Clarification:** a tool with empty `resource_ops` AND empty `declares` (pure-compute,
     no side effects, no resource requirements) is always reachable for any agent with any grant.
     This is the safe default for utility/computation tools.
4. Return the set of reachable tools.

**Invariant:** the query is deterministic and side-effect-free. Adding a role (and its grants)
to an agent enlarges the reachable set. Revoking a role shrinks it. No per-agent tool toggle
exists.

### FR-7 — Tool absence is structural (capability-not-text)

A tool that is NOT in the resolved toolset for an agent MUST NOT appear in any API response
listing that agent's tools. There is no "disabled" state or advisory flag — the tool is
physically absent. This is enforced by the toolset query (FR-6) being the sole source of the
agent's tool list.

### FR-8 — `declares` consistency check (DB write-path guard)

On INSERT or UPDATE of `mcp_tool.declares`, the TS write path MUST call
`classifyTool(declares)` to validate the value. If `classifyTool` returns `{ pure: false, effects: [...] }`,
each `EffectDeclaration` in `effects` MUST have a valid `resourceId` (uuid) and `kind` ∈ `EffectKind`.
Malformed `declares` (fails parsing) is rejected before INSERT/UPDATE — the write path returns
a typed error, never silently stores invalid data.

### FR-9 — Gateway-seam contract (invoke path)

When a caller invokes an agent tool (op = `"invoke"`), the gateway (`resolveFor` from T-0021
with `deps.effects` wired) verifies:
1. The agent holds grants for all `resource_ops` declared by the tool (FR-6 reachability).
2. For each `EffectDeclaration` in `tool.declares`, the agent holds a grant where
   `resourceType = "effect_resource"`, `operation = "invoke"`, and the grant's scope covers
   the referenced `effect_resource` row — enforced by `verifyEffectGrants` from `effect-resource.ts`.

Step 2 is the gateway-level enforcement. Step 1 is the toolset-query (pre-filtering). Together
they ensure that a tool physically absent from the toolset cannot be invoked, and that a tool's
declared side effects require held grants. Both checks run at action-time (TOCTOU-safe).

### FR-10 — New module boundary

T-0043 delivers exactly one new TS module: `src/core/mcp-tool-registry.ts`. It:
- MUST NOT edit `src/core/grant-lattice.ts`, `src/core/object-handle.ts`,
  `src/core/effect-resource.ts` (all frozen or previously delivered by dependencies).
- MAY additively edit `src/core/grant-resolver.ts` ONLY to wire the `McpToolSource` port to
  the `resolveFor` invoke-path if architecturally required — any such edit must be additive
  (an optional field on `ResolverDeps`), not a signature break.
- Does NOT introduce a second resolver edge or a parallel authority subsystem.

### FR-11 — `resource_ops` is the grant-matching surface (not `declares`)

`declares` and `resource_ops` are distinct columns with distinct semantics:
- `declares` = the tool's side-effect claim (what external resources it will touch at invoke-time) — verified against `effect_resource` grants.
- `resource_ops` = the resource×operation pairs the tool reads/writes from the Choros object model — verified against `grant` rows of the matching `resourceType × operation`.

Both must be covered by the agent's held grants for the tool to be reachable and invokable.
A tool with empty `resource_ops` and non-empty `declares` requires only effect grants.
A tool with non-empty `resource_ops` and empty `declares` requires only resource-op grants.

---

## 3. Non-Functional Requirements

### NF-1 — Pure module (`src/core/mcp-tool-registry.ts`)

The new module MUST NOT import `pg`, `fs`, `net`, `http`, or any node built-in I/O module
directly. All storage access is behind injected ports (`McpToolSource`, `GrantSource`).

### NF-2 — Additive to existing public surfaces

No existing export in `grant-lattice.ts`, `object-handle.ts`, `effect-resource.ts`,
`grant-resolver.ts`, or `types.ts` is renamed, removed, or re-signed. The single-resolver
CI check (`ci/checks/single-resolver.sh`) remains green.

### NF-3 — Migration seam

Migrations 032–039 are occupied or reserved by in-flight tasks. T-0043 uses migration **040**
(and migration 041 if a second migration is needed). These migration numbers MUST NOT be used
by any other task.

### NF-4 — Toolset query determinism

`resolveAgentToolset` is a pure function: same inputs (same grants, same tools, same `nowMs`) →
same output. No randomness, no caching, no side effects.

### NF-5 — `pure_compute` is denormalized, never authoritative alone

`pure_compute` is stored as a query-optimization signal. It does NOT bypass gateway verification.
A `pure_compute = true` tool still requires the toolset query (FR-6) to establish reachability;
the `pure_compute` flag only means the tool declares no external side effects.

### NF-6 — No per-agent tool storage

There MUST NOT be a table or column storing "which tools does agent X have" as a list. The only
persistent store is `mcp_tool` rows (the registry) and `grant` rows (the authority). The toolset
is computed, never stored.

### NF-7 — `known_tenant_tables.txt` update

`mcp_tool` added, one line, alphabetical order. The cross-tenant test requires no source change.

---

## 4. Explicit Out of Scope

- Agent runtime tool invocation and MCP server dispatch — Stage-2 and agent-runtime tasks.
- BYO-LLM secret-handle custody — T-0025.
- Invoke-grant (agent-to-agent invocation) — T-0024.
- Agent provisioning API (`POST /agents`) — T-0042.
- `role_criticality` computation from `mcp_tool.declares` — T-0040.
- Budget reservation at invoke-time — E5.9 (Stage-2).
- BYO-LLM data-egress policy enforcement at invoke-time — E5.10 (Stage-2).
- HTTP endpoints serving the toolset query — delivered by a later HTTP-layer task.
- UI for browsing the tool registry — future task.
- Full agent-card schema — T-0020 (sister, in-flight). T-0043 references `employee.id` abstractly.
- `effect_resource` rows themselves — T-0034 owns that table. T-0043 only references them via `EffectDeclaration.resourceId`.
- Toolset enumeration at process compile-time / BPMN deploy-time — T-0027 (BPMN linter) owns that.

---

## 5. Downstream contracts (frozen seams)

### C-1 · T-0040 (`role_criticality`) — `mcp_tool.declares` read contract

T-0040 reads `mcp_tool.declares` to determine whether any grant held by a role covers an
`effect_resource` with `kind` matching `external_invoke` criticality. The `declares` column
MUST be `jsonb NOT NULL DEFAULT '[]'`. T-0040 parses it using `classifyTool` from T-0034.

### C-2 · T-0042 (agent provisioning) — toolset display

After hiring an agent, T-0042 may call `resolveAgentToolset` to display the initial toolset.
The function signature and port contract from FR-6 are fixed.

### C-3 · Stage-2 agent runtime — toolset population

The Stage-2 agent runtime consumes `resolveAgentToolset` to populate the live MCP server list
before each Agent Task execution. The contract: the function signature, the `McpToolSource` port
shape, and the `GrantSource` port shape are fixed by this spec.

### C-4 · T-0021 `resolveFor` invoke-path — `McpToolSource` seam

If the architect decides to wire `McpToolSource` into `ResolverDeps` (an optional port), that
addition is additive: an optional `mcpTools?: McpToolSource` field on `ResolverDeps`. Existing
callers that omit it are unaffected. This spec mandates the seam be additive; the exact wiring
decision is the architect's.

---

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | Migration file `migrations/040_mcp_tool.sql` exists; has `CREATE TABLE choros.mcp_tool` with PK `(tenant_id, id)`, UNIQUE `(tenant_id, name)`, and all 9 columns from FR-1 with correct types. | fitness |
| AC-2 | `mcp_tool` has `FORCE ROW LEVEL SECURITY` and a `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)` policy. | test |
| AC-3 | A cross-tenant read on `mcp_tool` (tenant B context, tenant A data) returns 0 rows. | test |
| AC-4 | A cross-tenant write on `mcp_tool` (tenant B context, tenant A `tenant_id`) is rejected (0 rows inserted / RLS violation). | test |
| AC-5 | `ci/checks/known_tenant_tables.txt` contains the line `mcp_tool`; the cross-tenant CI tests pass for `mcp_tool` without modification to the test source. | fitness |
| AC-6 | Dev seed in migration 040: at least 3 representative `mcp_tool` rows seeded with `ON CONFLICT DO NOTHING`, covering one `integration_endpoint` tool, one `messaging_channel` tool, and one pure-compute tool (empty `declares`). | fitness |
| AC-7 | `pure_compute` consistency for empty declares: a `mcp_tool` row with `declares = '[]'::jsonb` has `pure_compute = true`; the DB CHECK constraint rejects `declares = '[]'::jsonb` with `pure_compute = false`. | test |
| AC-8 | `pure_compute` consistency for non-empty declares: the TS write path sets `pure_compute = false` for any row with at least one valid `EffectDeclaration` in `declares`; the stored value matches `classifyTool(declares).pure`. | test |
| AC-9 | Malformed `declares` (invalid JSON, wrong element shape, unknown `kind` value) causes the TS write path to return a typed error before INSERT/UPDATE; the row is not persisted. | test |
| AC-10 | `resolveAgentToolset` returns only tools whose full `resource_ops` set is covered by at least one effective grant held by the agent's roles. | test |
| AC-11 | Adding a grant to a role adds the associated tool to `resolveAgentToolset`'s output for an agent holding that role; revoking the grant removes the tool. | test |
| AC-12 | An agent with zero roles has an empty resolved toolset (0 tools returned by `resolveAgentToolset`), even if `mcp_tool` rows exist. | test |
| AC-13 | `resolveAgentToolset` is deterministic: calling it twice with identical inputs (same grants snapshot, same tools, same `nowMs`) returns deep-equal results. | test |
| AC-14 | `resolveAgentToolset` uses only injected `GrantSource` and `McpToolSource` ports (no direct DB access, no pg/fs/net imports in the module). | fitness |
| AC-15 | No existing export in `grant-lattice.ts`, `object-handle.ts`, `effect-resource.ts`, or `types.ts` is modified (byte-frozen check on those files after T-0043 commit). | fitness |
| AC-16 | `ci/checks/single-resolver.sh` (T-0015 / T-0021) exits 0 after T-0043's commit. | fitness |
| AC-17 | `src/core/mcp-tool-registry.ts` imports `EffectDeclaration`, `EffectKind`, `classifyTool`, `verifyEffectGrants` from `./effect-resource.js` WITHOUT re-declaring those types (no local duplicate of `EffectKind` union or `EffectDeclaration` interface). | fitness |
| AC-18 | `tsc --noEmit`, eslint, and `npm run fitness` (existing checks) are all green after T-0043's commit. | fitness |
| AC-19 | `choros_app` role has `SELECT, INSERT, UPDATE, DELETE` on `mcp_tool` and no DDL. | test |
| AC-20 | Migration 040 is idempotent: running the migration runner twice produces no error. | test |
| AC-21 | A `mcp_tool` row with non-empty `resource_ops` is included in `resolveAgentToolset` output only when ALL `{resourceType, operation}` pairs are covered; a missing grant for even one pair excludes the tool. | test |
| AC-22 | A tool with empty `resource_ops` and empty `declares` (`pure_compute = true`, no side effects, no resource requirements) is reachable for any agent that holds at least one grant. | test |
| AC-23 | No table or column in the schema stores a per-agent tool list: `grep -r 'agent_tool\|agent_tools\|tool_list' migrations/` returns 0 matches. | fitness |

---

## 7. BLOCKING questions

**None.** All design questions were resolved by the founder-signed backlog (GT-1, 2026-06-08)
and the completed dependency ADRs:
- `mcp_tool` column set and `declares`-as-claim semantics: ratified in `playbooks/rbac-backlog.md#E5.3`.
- Gateway-verification mechanism: sealed by T-0034 ADR §9 (T-0043 seam contract).
- Toolset = query over grants (no stored list): ratified in hypothesis §3 Q2, §1 caveat.
- `pure_compute` derived from `classifyTool`: ratified in T-0034 ADR §4.5 ("mcp_tool.pure_compute boolean = classifyTool(tool.declares).pure").
- Migration seam (040): derived from task prompt (040/041 allocated to T-0043; 032–039 occupied).
- Agent identity abstraction: T-0020 sister owns the card; T-0043 takes `employee.id` abstractly.
- `resource_ops` column: a structural necessity to make the toolset query mechanical
  (without it, matching tools to grants requires semantic interpretation of `declares`,
  which re-introduces free-text dependency). The column separates "what Choros objects the
  tool accesses" (resource_ops, matched by the grant model) from "what external systems it
  touches" (declares, matched by effect grants). This is a purely autonomous implementation
  decision fully consistent with the signed model.

Status: **ready** — no founder escalation required.
