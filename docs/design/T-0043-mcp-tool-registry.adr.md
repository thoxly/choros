# ADR · T-0043 — `mcp_tool` Registry (E5.3)

**Status:** ready (DESIGN). No founder escalation.
**Phase:** DESIGN (architect). Implementation is NOT written here.
**Task:** E5.3 — `mcp_tool(id, declares jsonb, pure_compute bool)`; an agent's toolset is a
query over its grants; `declares` is gateway-verified (T-0034). No stored per-agent tool list.
**Date:** 2026-06-11
**Spec:** `docs/specs/T-0043-mcp-tool-registry.spec.md` (commit fbf65ae), 23 AC.

---

## 1. Context & the one hard decision

The backlog (GT-1, founder-signed) and the T-0034 ADR §4.5 already sealed every product
question: `declares` is a typed `EffectDeclaration[]` claim verified at invoke-time, never an
advisory toggle; `pure_compute = classifyTool(declares).pure`; the toolset is a **query over
grants**, never a stored list. The architect's job is the thin **mechanical** layer that makes
those decisions storable and queryable without re-introducing free-text dependency or a second
authority subsystem.

The single non-obvious design move is **`resource_ops` as a column distinct from `declares`**
(spec FR-11). It is forced, not invented: the toolset query must decide reachability
*mechanically*. `declares` answers "which external `effect_resource` rows does the tool touch"
(verified against `effect_resource`/`invoke` grants by `verifyEffectGrants`). It says nothing
about which **Choros object-model** resources (`application`/`registry`/`record`/`mgmt_object:*`)
the tool reads or writes. Matching a tool to grants from `declares` alone would require semantic
interpretation of free text — exactly the anti-pattern the model forbids. `resource_ops` is the
typed `{resourceType, operation}[]` surface the grant rows match against directly. The two
columns are **orthogonal axes**: `declares` → effect grants; `resource_ops` → object-model grants.
A tool is reachable iff BOTH axes are covered.

## 2. Decision

1. **New tenant table `choros.mcp_tool`** — 9 columns, `PK(tenant_id, id)`, `UNIQUE(tenant_id, name)`,
   FORCE RLS per T-0013, a DB CHECK floor on `pure_compute`, migration **040** with idempotent dev seed.
2. **One new pure module `src/core/mcp-tool-registry.ts`** — exports the `McpToolSource` port, the
   `McpToolRow` row mirror, `isToolReachable` (pure predicate), `resolveAgentToolset` (the
   query-over-grants), and `validateMcpToolWrite` (the write-path guard wrapping `classifyTool`).
   It imports `EffectDeclaration`/`EffectKind`/`classifyTool`/`verifyEffectGrants` from
   `./effect-resource.js` and `Grant`/`ResourceType`/`Operation`/`isEffective` from
   `./grant-lattice.js` — **re-declaring none of them** (AC-17).
3. **`grant-resolver.ts` is NOT edited.** The T-0034 invoke-path seam already lives inside the
   single `resolveFor` body (`op === "invoke"`, `deps.effects`, `invokeCtx.declares`). T-0043's
   gateway contract is satisfied by *callers passing `mcp_tool.declares` into the existing
   `InvokeContext.declares`* — no new resolver edge, no new optional `ResolverDeps` field. This is
   the most proportionate reading of spec FR-10/C-4 ("any such edit must be additive … the exact
   wiring decision is the architect's"): the additive seam already exists; adding a second one
   would create a parallel authority path and risk `single-resolver.sh`. **`McpToolSource` is a
   registry-read port, not a resolver dependency** — the registry (which tools exist) and the
   authority (which grants the caller holds) stay separate stores, joined only by the pure query.
4. **`resolveAgentToolset` is async** because `GrantSource.getGrants` returns `Promise<Grant[]>`
   (T-0021). It performs two awaited port reads (`getGrants`, `listTools`) then a pure fold.

## 3. Object model (the single field/type contract)

### 3.1 DB entity `choros.mcp_tool` (migration 040)

| Column | DB type | Null | Semantics |
|---|---|---|---|
| `tenant_id` | `uuid` | NOT NULL | Leading PK; T-0013 RLS key; no default. |
| `id` | `uuid` | NOT NULL | `PK(tenant_id, id)`. |
| `name` | `text` | NOT NULL | `UNIQUE(tenant_id, name)`. |
| `description` | `text` | NULL | Human text; never in an access decision. |
| `declares` | `jsonb` | NOT NULL DEFAULT `'[]'::jsonb` | Serialized `EffectDeclaration[]`. |
| `pure_compute` | `boolean` | NOT NULL | `classifyTool(declares).pure`, stored at write-time. |
| `resource_ops` | `jsonb` | NOT NULL DEFAULT `'[]'::jsonb` | Serialized `ResourceOp[]`. |
| `created_at` | `bigint` | NOT NULL | Unix epoch ms. |
| `updated_at` | `bigint` | NOT NULL | Unix epoch ms. |

`PK(tenant_id, id)` · `UNIQUE(tenant_id, name)` · CHECK `mcp_tool_pure_empty_chk`:
`(declares <> '[]'::jsonb) OR (pure_compute = true)` — the structural floor of FR-5 (empty
`declares` ⇒ `pure_compute` must be `true`; the full non-empty consistency is the TS layer's job).

### 3.2 TS types in `src/core/mcp-tool-registry.ts`

```ts
import {
  type EffectDeclaration,           // re-used, NOT re-declared (AC-17)
  classifyTool,                     // pure linter; derives pure_compute
} from "./effect-resource.js";
import {
  type Grant,
  type ResourceType,
  type Operation,
  isEffective,
} from "./grant-lattice.js";

/** A Choros object-model resource×operation pair the tool reads/writes.
 *  Distinct axis from `declares` (external effects). Matched against `grant` rows. */
export interface ResourceOp {
  resourceType: ResourceType;       // re-used T-0018 union, NOT re-declared
  operation: Operation;             // re-used T-0018 union, NOT re-declared
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
  employeeId: string;               // the agent's employee.id (kind='agent'); abstract — no agent_card dep
  nowMs: number;
}
```

### 3.3 Function signatures (the frozen seam — C-2, C-3, C-4)

```ts
/** Pure reachability predicate (NF-4 deterministic, no IO).
 *  A tool is reachable iff EVERY resource_ops pair is covered by ≥1 grant that is
 *  same-tenant ∧ resourceType-match ∧ operation-match ∧ isEffective(g, nowMs).
 *  Empty resource_ops ⇒ reachable iff grants.length >= 1 (FR-6 step 3, AC-22). */
export function isToolReachable(
  tool: McpToolRow,
  grants: readonly Grant[],
  tenantId: string,
  nowMs: number,
): boolean;

/** The toolset = query over grants (FR-6). Async (getGrants is async).
 *  1. grants = await GrantSource.getGrants({tenantId, subjectId: employeeId}, nowMs),
 *     kept iff isEffective(g, nowMs).
 *  2. tools = await McpToolSource.listTools(tenantId).
 *  3. return tools.filter(t => isToolReachable(t, grants, tenantId, nowMs)).
 *  No stored per-agent list (NF-6); deterministic (NF-4); ports-only (NF-1, AC-14). */
export function resolveAgentToolset(
  input: ResolveToolsetInput,
  deps: { grants: GrantSource; tools: McpToolSource },
): Promise<McpToolRow[]>;

/** Write-path guard (FR-5, FR-8). Parses raw jsonb declares via classifyTool;
 *  on malformed input returns a typed error (NOT a throw at the model layer);
 *  on success returns the canonical { declares, pureCompute } the DAO must persist.
 *  The caller NEVER trusts a client-supplied pure_compute — it is derived here. */
export type McpToolWriteResult =
  | { ok: true; declares: EffectDeclaration[]; pureCompute: boolean }
  | { ok: false; error: "malformed_declares" };
export function validateMcpToolWrite(rawDeclares: unknown): McpToolWriteResult;
```

`GrantSource` is imported (as a `type`) from `./grant-resolver.js` — the **same** T-0021 port the
resolver uses (spec FR-6: "the toolset query runs AGAINST the same `GrantSource`"). This is a
type-only import; it adds no runtime edge and no `grant-resolver.ts` edit.

### 3.4 `classifyTool` fail-closed reuse (the malformed-declares contract)

`classifyTool` returns `{pure:false, effects:[]}` for BOTH "malformed" and (never) genuine-empty —
genuine-empty is `{pure:true}`. `validateMcpToolWrite` therefore distinguishes the two using the
same discipline as `resolveFor` step 3.5: `pure:true` ⇒ `pureCompute=true, declares=[]`;
`pure:false ∧ effects.length===0` ⇒ `malformed_declares` error (reject, do not persist — AC-9);
`pure:false ∧ effects.length>0` ⇒ `pureCompute=false, declares=effects`. No re-implementation of
the linter — the canonical T-0034 function is the sole parser.

## 4. Gateway-seam (invoke path) — no new resolver edge

At invoke-time the existing `resolveFor(deps, handle, subject, "invoke", invokeCtx)` already:
1. resolves covering grants for the invoke `op` (object-model authority floor), then
2. when `deps.effects` is wired and `invokeCtx.declares` is passed, runs `classifyTool` +
   `verifyEffectGrants` over the declared `effect_resource` rows (T-0034 §4.4 step 3.5).

T-0043's contribution is purely the **registry**: the composition root reads the `mcp_tool` row
(via `McpToolSource`) and passes `row.declares` into `InvokeContext.declares`. The two-axis
guarantee (FR-9) is the conjunction: object-model `resource_ops` are enforced by the toolset
pre-filter (`isToolReachable`, run before invoke) AND `resolveFor`'s own covering-grant step; the
external-effect `declares` are enforced by `verifyEffectGrants` inside the one resolver body.
A tool absent from the toolset (FR-7) is never offered, hence never invoked — physical absence,
not a flag.

## 5. Proportionality / rejected alternatives

- **Edit `grant-resolver.ts` to add `mcpTools?: McpToolSource` on `ResolverDeps`** — rejected.
  The invoke-path effect seam already exists (`invokeCtx.declares`); a registry read inside the
  resolver would couple the authority PDP to the tool registry, create a second handle→data-ish
  edge, and put `single-resolver.sh`/AC-16 at risk for zero benefit. The registry read belongs at
  the composition root, which already owns wiring `deps.effects`.
- **Match the toolset from `declares` alone (drop `resource_ops`)** — rejected. Forces semantic
  interpretation of effect claims to infer object-model access ⇒ re-introduces free-text
  dependency, the exact anti-pattern (CONCEPT.md §3, hypothesis §1).
- **Store the resolved toolset (per-agent tool list / cache)** — rejected (NF-6, AC-12, AC-23).
  Breaks "0 roles → 0 tools" liveness; a revocation would need a toolset migration. The query is cheap and TOCTOU-safe.
- **Make `resolveAgentToolset` sync** — rejected: `GrantSource.getGrants` is `Promise<Grant[]>`;
  a sync wrapper would fork the port.
- **DB-level full `pure_compute` consistency trigger** — rejected as over-engineering. The closed
  `EffectKind` set lives in TS (`classifyTool`); a PL/pgSQL re-implementation would duplicate the
  authority axis in the DB. The DB CHECK covers only the mechanical empty-array floor (FR-5);
  the TS write-path owns the non-empty case. Fitness FF-2/FF-3 guard both.

## 6. Runtime target

Static-now: the module is pure TS (no `pg`/`fs`/`net`/`http`), state behind injected ports
(`McpToolSource`, `GrantSource`). The Postgres RLS-backed `McpToolSource` DAO + live migration 040
apply land in **T-0053** (the substrate task), exactly as `EffectSource`/`GrantSource` defer their
DAOs. Live DDL is not applied in this DESIGN phase; migration 040 is delivered as the authoritative
DDL and its correctness is a CI obligation (fitness FF-1, FF-7).

## 7. Fitness functions (machine-checkable boundaries)

| ID | Boundary it defends | CI check |
|---|---|---|
| FF-1 | Migration 040 shape | `grep -E 'CREATE TABLE +choros\.mcp_tool' migrations/040_mcp_tool.sql` and assert PK `(tenant_id, id)`, `UNIQUE (tenant_id, name)`, all 9 columns present with the FR-1 types (AC-1). |
| FF-2 | `pure_compute` empty-array floor | assert `migrations/040_mcp_tool.sql` contains the CHECK `(declares <> '[]'::jsonb) OR (pure_compute = true)`; a DB test inserting `declares='[]', pure_compute=false` is rejected (AC-7). |
| FF-3 | `pure_compute` write-path derivation | unit test: `validateMcpToolWrite` returns `pureCompute=false` for any valid non-empty declares and `true` for `[]`; equals `classifyTool(declares).pure` (AC-8). |
| FF-4 | malformed-declares rejection | unit test: `validateMcpToolWrite` on invalid JSON shape / unknown `kind` / non-array returns `{ok:false,error:"malformed_declares"}`; row never persisted (AC-9). |
| FF-5 | toolset = query over grants | unit tests on `resolveAgentToolset`: full-coverage inclusion (AC-10), grant add/revoke flips membership (AC-11), zero-role agent → `[]` (AC-12), partial `resource_ops` coverage excludes (AC-21), empty resource_ops + empty declares reachable for any grant-holder (AC-22). |
| FF-6 | determinism | unit test: two identical calls to `resolveAgentToolset` deep-equal (AC-13). |
| FF-7 | RLS isolation | `mcp_tool` line present in `ci/checks/known_tenant_tables.txt` (alphabetical); the existing cross-tenant probe passes for `mcp_tool` with no test-source change (AC-5); FORCE RLS + isolation policy + `choros_app` DML-only present in 040 (AC-2, AC-19). |
| FF-8 | pure module | `grep -nE "from \"(pg\|fs\|net\|http\|node:.*)\"\|require\(" src/core/mcp-tool-registry.ts` returns nothing (AC-14). |
| FF-9 | no re-declared T-0034/T-0018 types | `grep -nE "type EffectKind\b\|interface EffectDeclaration\b\|type ResourceType\b\|type Operation\b" src/core/mcp-tool-registry.ts` returns nothing; the imports from `./effect-resource.js` and `./grant-lattice.js` are present (AC-17). |
| FF-10 | frozen public surfaces | `git diff --exit-code <base> -- src/core/grant-lattice.ts src/core/object-handle.ts src/core/effect-resource.ts src/core/types.ts` is clean; `git diff --exit-code <base> -- src/core/grant-resolver.ts` is clean (architect chose no resolver edit) (AC-15, NF-2). |
| FF-11 | single resolver intact | `bash ci/checks/single-resolver.sh` exits 0 (AC-16). |
| FF-12 | no per-agent tool list | `grep -rE 'agent_tool\|agent_tools\|tool_list' migrations/ src/` returns 0 matches (AC-23, NF-6). |
| FF-13 | seed coverage | `migrations/040_mcp_tool.sql` seed block has ≥3 rows `ON CONFLICT DO NOTHING`: one `integration_endpoint` declares, one `messaging_channel` declares, one pure-compute (`declares='[]'`) (AC-6). |
| FF-14 | idempotent migration | running the migration runner twice over a fresh schema exits 0, no error, identical row counts (AC-20); seed uses `ON CONFLICT DO NOTHING`. |
| FF-15 | build green | `tsc --noEmit` + eslint + `npm run fitness` all green after commit (AC-18). |

## 8. Traceability — all 23 AC covered

AC-1→FF-1; AC-2→FF-7; AC-3/AC-4→FF-7 (existing cross-tenant probe over `known_tenant_tables.txt`);
AC-5→FF-7; AC-6→FF-13; AC-7→FF-2; AC-8→FF-3; AC-9→FF-4; AC-10/11/12/21/22→FF-5; AC-13→FF-6;
AC-14→FF-8; AC-15→FF-10; AC-16→FF-11; AC-17→FF-9; AC-18→FF-15; AC-19→FF-7; AC-20→FF-14;
AC-23→FF-12.
