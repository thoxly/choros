# Spec · T-0034 — External-Effect Resources (E4.4)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-10
**Task:** E4.4 — External-effect resources (integration/messaging/account) first-class; declares = gateway-verified; pure-compute linter
**Authoritative source:** `playbooks/rbac-backlog.md#E4.4` (GT-1, founder-signed 2026-06-08) ·
`playbooks/rbac-discovery-phase1-hypothesis.md` §5 (`effect_resource`), §3 Q2, §6-A #5
**Foundation (do NOT contradict):**
- `src/core/grant-lattice.ts` (T-0018) — `ResourceType` (already includes `"effect_resource"` as a
  literal), `Grant`, `Operation` (incl. `"invoke"`), `ScopeElement`, `isNarrowerOrEqual`,
  `isEffective`, `AncestryOracle`. The `ResourceType` union's `"effect_resource"` member is the
  literal anchor for this task.
- `src/core/grant-resolver.ts` (T-0021) — `resolveFor(deps, handle, subject, op)`,
  `makeGrantResolver(deps)`, `ResolverDeps` (injectable ports: `GrantSource`/`RecordSource`/
  `AncestryOracle`), `projectFields`, `visibleFields`. T-0034 adds an **optional** new injected
  port to `ResolverDeps` — additive, no signature break.
- `src/core/object-handle.ts` (T-0015, **frozen**) — `ObjectHandle`, `ResourceRef`, `Facet`,
  `HandleResolver`, `denyAllResolver`, `assertVariableValue`, `makeHandle`, `parseHandle`.
- `migrations/008_grant.sql` — the `"grant"` table with `resource_type text NOT NULL`: T-0034's
  `effect_resource` kind is a first-class `resource_type` value stored there without DDL change.
- T-0033 `S-2` seam (T-0033 ADR §9) — T-0033 declared T-0034 as a sibling sharing the gateway
  interface: "T-0034 stacks an effect-resource verification port additively onto `ResolverDeps`,
  no second resolver edge." This spec implements exactly that seam.
- `src/core/bpmn-linter.ts` (T-0027) — the existing deploy-time linter pattern (pure function,
  no I/O, fail-closed) is the structural model for the pure-compute linter in this task.

**Siblings referenced, not built here:**
- T-0043 (E5.3 `mcp_tool` registry) — the downstream consumer: `mcp_tool.declares` is a JSON
  blob of `EffectDeclaration[]`; its `pure_compute bool` and `declares` fields are resolved by
  this task's gateway-verification seam. T-0043 imports `EffectDeclaration` and the pure-compute
  linter from this task's new module.
- T-0040 (E4.5 `role_criticality`) — consumes `effect_resource` grants to derive the
  `external_invoke` criticality bit. T-0034 owns the `effect_resource` resource type; T-0040 the
  computation. T-0040 depends on T-0034 in the build DAG.
- T-0033 (E4.3 data-classification) — parallel sibling; merges before T-0034. T-0033 thaws
  `grant-resolver.ts` for its masking extension; T-0034's optional port addition onto
  `ResolverDeps` is compatible with that extension (both edits are additive optional fields).
- T-0053 (Postgres DAO) — the `EffectSource` Postgres implementation deferred to T-0053 (mirrors
  `GrantSource`/`RecordSource`/`ClassificationSource` deferral pattern).

---

## 0. Scope resolution: what "external-effect resources first-class" means today

Choros today has the `grant` authority table, the `grant-resolver.ts` PDP, and the `ResourceType`
union already containing `"effect_resource"`. The grant lattice and gateway already handle
`op="invoke"` as a typed operation. What is NOT yet built:

1. **A first-class schema for `effect_resource`** — a typed entity whose `kind` field
   distinguishes `integration_endpoint` / `messaging_channel` / `external_account`, and whose
   `scope` is the grant-lattice scope the grant binds to.

2. **The `mcp_tool.declares` gateway-verification port** — a mechanism that, at `invoke`-time,
   confirms that a tool's declared effect-resources are covered by the caller's grants, rather
   than trusting the `declares` text as advisory.

3. **The pure-compute linter** — a static classifier that, given a tool's `declares` field,
   determines whether the tool is pure-compute (no effect declarations) or effecting (≥1
   declaration). This is the T-0027/T-0028-style structural check: capability-not-text.

Day-1 deliverables (this task):
- `src/core/effect-resource.ts` — new pure module: types (`EffectKind`, `EffectResource`,
  `EffectDeclaration`, `EffectSource` port), the `classifyTool(declares)` pure-compute
  linter, and `verifyEffectGrants(declarations, grants, now)` — the gateway-verification
  function called inside `resolveFor`.
- A SQL migration (`022_effect_resource.sql`) — the `effect_resource` tenant table.
- An additive edit to `grant-resolver.ts` — an optional `EffectSource` port on `ResolverDeps`
  and the `verifyEffectGrants` call wired into the `invoke`-path of `resolveFor`.
- A CI isolation check (`ci/checks/effect-resource-isolation.sh`).

NOT day-1: runtime execution of connectors, live HTTP calls to integration endpoints,
BYO-connector execution. This task is schema + gateway-mechanic + linter.

---

## 1. Summary

Make external-effect resources (`integration_endpoint`, `messaging_channel`, `external_account`)
first-class objects in the grant model: a tool's declared effects are verified by the gateway at
`invoke`-time against the caller's held grants, not trusted as advisory text. A pure-compute
linter statically flags tools that declare no effects.

---

## 2. Functional requirements

**FR-1** — **`effect_resource` is a first-class resource type:** `effect_resource` is stored in
the `grant` authority table with `resource_type = 'effect_resource'` and a structured `scope`
(a lattice `ScopeElement`). Granting access to an external endpoint requires a proper `grant`
row for `(resource_type='effect_resource', operation='invoke', scope=<endpoint-identity>)`. No
separate permission subsystem or advisory toggle is accepted.

**FR-2** — **Typed `EffectResource` entity:** An `EffectResource` object carries:
`id` (uuid), `tenantId`, `kind ∈ {integration_endpoint, messaging_channel, external_account}`,
`scope` (a lattice `ScopeElement` or a descriptive qualifier), and optional `metadata` (opaque
jsonb). The `kind` field is a closed set; unknown kinds are rejected fail-closed.

**FR-3** — **`EffectDeclaration` — the tool's claim:** An `mcp_tool.declares` JSON blob is an
array of `EffectDeclaration = { resourceId: string; kind: EffectKind }`. Each declaration is a
claim by the tool that it invokes the named effect-resource of that kind. The claim is
structurally typed; free-text effect descriptions are not accepted.

**FR-4** — **Gateway verification at `invoke`-time:** When a subject invokes a tool, the
gateway (`resolveFor` with `op='invoke'`) verifies that the subject holds a grant covering every
`EffectDeclaration` in the tool's `declares` field. The verification is performed via an injected
`EffectSource` port (mirrors `GrantSource`/`RecordSource` pattern from T-0021). A subject lacking
a grant for any declared effect-resource is denied fail-closed; the tool is not invoked.

**FR-5** — **Pure-compute linter (`classifyTool`):** A pure function
`classifyTool(declares: EffectDeclaration[]): ToolEffectProfile` classifies a tool at linter
time:
- `{ pure: true }` — `declares` is empty (no effects declared). The tool is pure-compute.
- `{ pure: false; effects: EffectDeclaration[] }` — `declares` is non-empty (≥1 effect declared).
The linter is pure, deterministic, and has no I/O. It is the static counterpart to the runtime
gateway check.

**FR-6** — **Fail-closed on missing or malformed declarations:** A tool whose `declares` field
is absent, null, or malformed (not a valid `EffectDeclaration[]`) is treated as effecting with
unknown declarations — the gateway denies invocation fail-closed (no grant can cover an unknown
declaration). The pure-compute linter also returns `{ pure: false }` for malformed input.

**FR-7** — **Effect-resource tenant isolation:** `effect_resource` rows are per-tenant. The
`effect_resource` table has `tenant_id` as the leading PK column, ENABLE+FORCE RLS, an isolation
policy, and is listed in `ci/checks/known_tenant_tables.txt`. A grant for an effect-resource in
tenant A does not cover a same-named resource in tenant B.

**FR-8** — **Single resolver edge maintained:** The gateway verification of effect grants is
folded into the existing `resolveFor` core as an additive step — not a second `resolveHandle`
path. The `single-resolver.sh` check remains green.

**FR-9** — **T-0043 seam contract sealed:** This task exports `EffectDeclaration`,
`EffectKind`, `ToolEffectProfile`, `classifyTool`, and the `EffectSource` port from
`src/core/effect-resource.ts`. T-0043 (`mcp_tool` registry) imports these; no re-declaration is
needed. The pure-compute `bool` of `mcp_tool` is the output of `classifyTool(tool.declares).pure`.

---

## 3. Non-functional requirements

**NF-1** — **Pure / static-now / no I/O in core module:** `src/core/effect-resource.ts` imports
no `pg`, `fs`, `net`, `http`. All DB access is behind the injected `EffectSource` port (in-memory
now; Postgres DAO in T-0053). Equal inputs → equal output for all exported pure functions.

**NF-2** — **Additive:** The changes to `grant-resolver.ts` are additive optional fields on
`ResolverDeps` only (`effects?: EffectSource`). Existing callers with no `EffectSource` compile
unchanged. The absence of `EffectSource` means effect-verification is skipped (backward
compatible); a tool `invoke` without the port degrades to grant-only enforcement (the pre-T-0034
floor).

**NF-3** — **Fail-closed:** Any doubt about an effect declaration (malformed, unknown kind,
missing grant) resolves to denial, never to permit. The "if `EffectSource` absent, skip
verification" backward-compatibility clause (NF-2) applies only when the port is NOT provided by
the composition root — a composition root that wires the port is committed to full verification.

**NF-4** — **No new dependency:** `effect-resource.ts` uses only TypeScript stdlib. The
`EffectSource` port is the only boundary with external state. No new npm packages.

**NF-5** — **Migration number is 022:** Per the run-seam instruction: T-0033 uses 017, T-0019
uses 018, T-0022 uses 019–021. T-0034's migration is **022**.

---

## 4. Out of scope

- Runtime execution of integration connectors or live HTTP calls to external endpoints.
- BYO-connector framework, webhook subscriptions, or messaging-channel adapters.
- The Postgres `EffectSource` DAO — deferred to T-0053 (mirrors `GrantSource` deferral).
- `role_criticality.external_invoke` computation — that is T-0040 (depends on T-0034).
- `egress_policy` for data leaving to external endpoints — that is T-0041 (E4.8), which joins on
  `DataClass` from T-0033, not on `EffectResource`.
- Modifying `object-handle.ts`, `grant-lattice.ts`, or `migrations/008_grant.sql` — these are
  frozen and sufficient as-is (`ResourceType` already carries `"effect_resource"`).
- Stage-2 A2A call-graph breakers or agent-runtime enforcement.

---

## 5. Acceptance criteria

| ID | Text | verifiable_as |
|---|---|---|
| AC-1 | **`EffectKind` is a closed set:** `classifyTool` and `verifyEffectGrants` reject any `EffectDeclaration` whose `kind` is not in `{integration_endpoint, messaging_channel, external_account}` — treat as malformed → fail-closed (FR-6). A TypeScript `type EffectKind = "integration_endpoint" \| "messaging_channel" \| "external_account"` is exported; no string cast can widen it. | test |
| AC-2 | **`classifyTool([]) === { pure: true }`:** A tool with an empty `declares` array is classified pure-compute. | test |
| AC-3 | **`classifyTool([...]) === { pure: false, effects: [...] }`:** A tool with ≥1 valid `EffectDeclaration` is classified effecting; the `effects` array equals the input. | test |
| AC-4 | **`classifyTool(malformed) === { pure: false }`:** A tool whose `declares` is null, not an array, or contains a malformed declaration is classified effecting (fail-closed, not pure). | test |
| AC-5 | **Gateway denies `invoke` when subject lacks an effect-resource grant:** `resolveFor(deps, handle, subject, "invoke")` with an `EffectSource` wired and a tool that declares effect E, where the subject holds no grant for E, returns `{ denied: true, reason: "no_effect_grant" }`. | test |
| AC-6 | **Gateway permits `invoke` when subject holds all declared effect-resource grants:** `resolveFor` with a subject that holds a covering grant for every `EffectDeclaration` in the tool's `declares` returns `{ denied: false, ... }` (effect verification passes; standard grant check also passes). | test |
| AC-7 | **All-or-nothing effect-grant check:** A tool that declares two effects, where the subject holds a grant for one but not the other, is denied fail-closed. | test |
| AC-8 | **Absent `EffectSource` port skips effect verification (backward compat):** `resolveFor` with no `effects` port in `ResolverDeps` behaves exactly as pre-T-0034 (no `no_effect_grant` denial path is reached). Existing tests pass unchanged. | test |
| AC-9 | **Malformed `declares` field denies fail-closed at gateway:** When `EffectSource` is wired and the tool's `declares` blob is null or not a valid `EffectDeclaration[]`, `resolveFor` returns `{ denied: true, reason: "no_effect_grant" }`. | test |
| AC-10 | **`effect_resource` table is a tenant table:** `022_effect_resource.sql` creates `choros.effect_resource` with `tenant_id uuid NOT NULL` as the leading PK column, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, a `<table>_tenant_isolation` policy on `current_setting('choros.tenant_id', true)::uuid`, `GRANT ... TO choros_app`, and the table name is listed in `ci/checks/known_tenant_tables.txt`. | fitness |
| AC-11 | **Cross-tenant isolation for effect resources:** A query for an effect-resource under tenant B inside a session bound to tenant A returns zero rows. | fitness |
| AC-12 | **Isolation check — no parallel effect-ACL store:** `ci/checks/effect-resource-isolation.sh` exits 0: no `_acl` / `effect_visibility` / `effectRights` token appears in `src/core/effect-resource.ts`; no `pg`/`fs`/`net`/`http` import appears in that module. | fitness |
| AC-13 | **Single projection seam maintained:** `ci/checks/single-resolver.sh` remains green. No second `handle→fields` path is introduced. The `invoke` verification is an additive step inside the existing `resolveFor` core, not a parallel resolver. | fitness |
| AC-14 | **`grant-resolver.ts` import surface preserved (FE-W23-0008):** `resolveFor`, `makeGrantResolver`, `projectFields`, `visibleFields`, `grantFacetFields`, `refToScope` remain exported. `ResolverDeps` gains only an optional `effects?: EffectSource` field; no existing field is changed. All callers lacking `effects` compile unchanged. A grep confirms the existing exported symbols are present. | fitness |
| AC-15 | **`grant-lattice.ts` and `object-handle.ts` are byte-frozen:** The commit for T-0034 does NOT include edits to `src/core/grant-lattice.ts` or `src/core/object-handle.ts`. `tsc --noEmit` passes. | fitness |
| AC-16 | **T-0043 seam exports present:** `src/core/effect-resource.ts` exports `EffectKind`, `EffectDeclaration`, `EffectResource`, `EffectSource`, `ToolEffectProfile`, `classifyTool`, and `verifyEffectGrants`. A TypeScript import of these symbols in a consumer module compiles with no cast. | fitness |
| AC-17 | **Determinism and purity of `classifyTool` and `verifyEffectGrants`:** Same inputs → same outputs in two consecutive calls. No IO outside the `EffectSource` injected port. | test |
| AC-18 | **No regression on pre-existing fitness checks:** `single-resolver.sh`, `no-record-in-variable.sh`, `object-handle-isolation.sh`, `grant-resolver-isolation.sh`, `mutation-gateway-isolation.sh`, `audit_append_only.sh`, `bpmn-linter-isolation.sh` all remain green after T-0034's commit. | fitness |

---

## 6. Contract to T-0043 (`mcp_tool` registry)

T-0043 is the downstream consumer. It imports from `src/core/effect-resource.ts`:

```ts
import {
  type EffectKind,          // the closed kind union
  type EffectDeclaration,   // { resourceId: string; kind: EffectKind }
  type EffectResource,      // first-class entity shape
  type EffectSource,        // injected port (getEffect / listDeclared)
  type ToolEffectProfile,   // { pure: true } | { pure: false; effects: EffectDeclaration[] }
  classifyTool,             // (declares: EffectDeclaration[]) => ToolEffectProfile
  verifyEffectGrants,       // (declarations, grants, now) => EffectVerifyResult
} from "./effect-resource.js";
```

The `mcp_tool.pure_compute` boolean is derived as `classifyTool(tool.declares).pure`. T-0043 does
NOT re-declare `EffectKind` or `EffectDeclaration`; it imports them from this module.
The `mcp_tool.declares` DB column is `jsonb NOT NULL DEFAULT '[]'::jsonb` — a serialized
`EffectDeclaration[]`.

---

## 7. Object model (types, not implementation)

### 7.1 TypeScript types (exported from `src/core/effect-resource.ts`)

```ts
/** Closed set of external-effect resource kinds. */
export type EffectKind =
  | "integration_endpoint"
  | "messaging_channel"
  | "external_account";

/** A tool's claim to invoke one external effect-resource (typed, not free-text). */
export interface EffectDeclaration {
  resourceId: string;  // identity of the effect_resource row
  kind: EffectKind;    // must match the stored row's kind; mismatch → fail-closed
}

/** First-class effect-resource entity row (mirrors the DB table shape). */
export interface EffectResource {
  id: string;
  tenantId: string;
  kind: EffectKind;
  scope: unknown;      // ScopeElement or descriptive qualifier; opaque to linter
  metadata?: unknown;  // arbitrary jsonb; not used in access decision
}

/** Injected port — pure static-now; Postgres DAO in T-0053. */
export interface EffectSource {
  /** Resolve an effect-resource by id within a tenant. null = not found (→ fail-closed). */
  getEffect(tenantId: string, resourceId: string): EffectResource | null;
}

/** Output of the pure-compute linter. */
export type ToolEffectProfile =
  | { pure: true }
  | { pure: false; effects: EffectDeclaration[] };

/** Output of the gateway verification step. */
export type EffectVerifyResult =
  | { ok: true }
  | { ok: false; missingResourceId: string };
```

### 7.2 SQL — `migrations/022_effect_resource.sql` (DDL pseudocode)

```sql
CREATE TABLE choros.effect_resource (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL,
  kind       text NOT NULL,
  scope      jsonb NOT NULL,
  metadata   jsonb NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT effect_resource_kind_chk
    CHECK (kind IN ('integration_endpoint', 'messaging_channel', 'external_account'))
);

ALTER TABLE choros.effect_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.effect_resource FORCE ROW LEVEL SECURITY;

CREATE POLICY effect_resource_tenant_isolation ON choros.effect_resource
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.effect_resource TO choros_app;
```

**FK dry-run (T-0017 lesson):** PK `(tenant_id, id)` is self-contained — all columns are on this
table; no cross-table FK is needed or attempted. `resource_type = 'effect_resource'` in the
`grant` table is a logical descriptor, not a row reference. This mirrors the `008_grant.sql`
discipline for `role_id` (logical reference, deferred FK). `tenant_id` leads the PK — passes
`tenant_id_leading.sql`. `kind` is constrained by a CHECK to the closed set. ✅

### 7.3 `ResolverDeps` extension (additive edit to `grant-resolver.ts`)

```ts
// grant-resolver.ts — additive optional field ONLY
export interface ResolverDeps {
  grants: GrantSource;
  records: RecordSource;
  ancestry: AncestryOracle;
  classifications?: ClassificationSource;  // T-0033 (already merged)
  effects?: EffectSource;                  // T-0034 (NEW, optional)
  now?: () => number;
}
```

Inside `resolveFor`, after covering grants are found (step 3) and before the record fetch (step
5), an additional step is inserted **only for `op === "invoke"`**:

```
[step 3.5 — only when op === "invoke" AND deps.effects is present]
  const declarations = parseEffectDeclarations(tool.declares)
  // declarations = null if malformed → deny fail-closed
  if declarations === null → return { denied: true, reason: "no_effect_grant" }
  const result = verifyEffectGrants(declarations, covering, now)
  if !result.ok → return { denied: true, reason: "no_effect_grant" }
```

The tool's `declares` blob is passed in via the `ObjectHandle` or a new `invokeContext` parameter
on the handle — **the architect decides the exact wiring**; the spec constrains only the shape and
the outcome. What the spec mandates:
- The verification is inside the single `resolveFor` body.
- It uses `verifyEffectGrants` from `effect-resource.ts`.
- The deny reason is `"no_effect_grant"` (a new literal added to `ResolvedView`'s `reason` union
  — additive).

### 7.4 `ResolvedView` extension (additive)

```ts
// object-handle.ts is FROZEN — this extension is declared in effect-resource.ts
// as a TypeScript module augmentation OR carried as a new exported type alias.
// The architect chooses the safe non-frozen path.

// Concretely: the existing ResolvedView denied-reason union grows one member:
// "no_grant" | "cross_tenant" | "not_found" | "no_effect_grant"
// object-handle.ts is NOT edited. The new reason is defined in effect-resource.ts
// and ResolvedView is widened via intersection/union in the composition root.
// Exact mechanism → architect.
```

---

## 8. Fitness functions (CI-executable architecture rules)

| ID | Rule | CI check |
|----|------|----------|
| **FF-ER1** | `effect_resource` is a tenant table: `tenant_id` leading PK, ENABLE+FORCE RLS, isolation policy, `choros_app` grant, listed in `known_tenant_tables.txt`. | `ci/checks/db/force_rls.sql` + `tenant_id_leading.sql` return 0 rows; `known_tenant_tables.txt` contains `effect_resource`. |
| **FF-ER2** | Cross-tenant isolation: an `effect_resource` row under tenant A is invisible to a session bound to tenant B. | Two-tenant probe (red without RLS, green with FORCE). |
| **FF-ER3** | Pure-compute linter determinism: `classifyTool(x)` called twice with the same input yields deep-equal output. `classifyTool([])` always returns `{ pure: true }`. | Pure-TS unit test. |
| **FF-ER4** | Fail-closed on malformed declares: `classifyTool(null as any)`, `classifyTool([{kind:"unknown"} as any])` return `{ pure: false }`, never `{ pure: true }`. | Pure-TS unit test. |
| **FF-ER5** | Gateway deny on missing effect grant: `resolveFor` with `EffectSource` wired, all normal grants present, tool declares an effect the subject holds no grant for → `{ denied: true, reason: "no_effect_grant" }`. | Pure-TS unit test. |
| **FF-ER6** | Gateway permit on complete effect grants: `resolveFor` with `EffectSource` wired, subject holds all effect grants → `{ denied: false, ... }`. | Pure-TS unit test. |
| **FF-ER7** | All-or-nothing effect check: 2-effect tool, subject holds 1 of 2 grants → denied. | Pure-TS unit test. |
| **FF-ER8** | Backward compat (no `effects` port): `resolveFor` without `effects` in `ResolverDeps` behaves identically to pre-T-0034. All existing `grant-resolver.test.ts` pass unchanged. | `vitest run` on existing test suite. |
| **FF-ER9** | Isolation — no parallel effect-ACL store: `ci/checks/effect-resource-isolation.sh` bans `_acl`/`effect_visibility`/`effectRights`/`effectAcl` tokens and `pg`/`fs`/`net`/`http` imports in `src/core/effect-resource.ts`. | `bash ci/checks/effect-resource-isolation.sh`. |
| **FF-ER10** | T-0043 seam exports present: all six symbols (`EffectKind`, `EffectDeclaration`, `EffectResource`, `EffectSource`, `ToolEffectProfile`, `classifyTool`) importable from `src/core/effect-resource.ts` without cast; `verifyEffectGrants` also exported. | `tsc --noEmit` on a consumer that imports all symbols. |
| **FF-ER11** | Frozen modules untouched: `src/core/grant-lattice.ts` and `src/core/object-handle.ts` are byte-identical to their dev-branch versions after T-0034's commit. | `git diff dev -- src/core/grant-lattice.ts src/core/object-handle.ts` exits clean. |
| **FF-ER12** | `grant-resolver.ts` import surface preserved: `resolveFor`, `makeGrantResolver`, `projectFields`, `visibleFields`, `grantFacetFields`, `refToScope` all remain exported. `ResolverDeps` gains only one optional field. | grep export-symbol presence; `tsc --noEmit`. |
| **FF-ER13** | Single-resolver check green: `ci/checks/single-resolver.sh` exits 0 after T-0034's commit. | `bash ci/checks/single-resolver.sh`. |
| **FF-ER14** | No regression on pre-existing fitness suite: all existing checks in `ci/checks/` that were green before T-0034 remain green. | `npm run fitness`. |

---

## 9. Adversarial cases

The test suite for `src/__tests__/effect-resource.test.ts` MUST cover:

1. **Missing grant for declared resource:** tool declares `[{resourceId:"ep-1", kind:"integration_endpoint"}]`; subject has no `effect_resource` grant → `no_effect_grant`.
2. **Partial grant coverage:** tool declares effects for `ep-1` and `ep-2`; subject holds grant for `ep-1` only → `no_effect_grant`.
3. **Full grant coverage:** subject holds grants for every declared effect → `denied: false`.
4. **Empty `declares` array:** `classifyTool([])` → `{ pure: true }`. Gateway with `op=invoke` and empty declares, all normal grants satisfied → `denied: false` (no effect to check).
5. **Malformed `declares` — null:** `classifyTool(null as any)` → `{ pure: false }`. Gateway → `no_effect_grant`.
6. **Malformed `declares` — wrong kind:** `[{resourceId:"x", kind:"unknown_kind"}]` → `classifyTool` returns `{ pure: false }`; gateway denies fail-closed.
7. **Cross-tenant effect isolation:** subject in tenant A has a grant for `effect_resource` in tenant A; the `EffectSource` returns `null` for the same `resourceId` under tenant B → denied (FR-7).
8. **No `EffectSource` port in deps:** `resolveFor` called without `effects` in `ResolverDeps`, same `op=invoke` → no `no_effect_grant` path reached, behaves as pre-T-0034 (AC-8).
9. **`effect_resource` kind mismatch:** tool declares `{resourceId:"ep-1", kind:"messaging_channel"}` but the stored row has `kind:"integration_endpoint"` → gateway denies fail-closed.

---

## 10. No blocking questions

No BLOCKING questions exist. The scope is mechanically derived from the GT-1-signed hypothesis
(§5 `effect_resource`, §3 Q2, §6-A #5) and the merged T-0021/T-0018/T-0015/T-0027 foundation.
The migration number (022) is given by the orchestrator's run-seam instruction. The T-0033 seam
contract (S-2, ADR §9) specifies exactly how T-0034 stacks onto `ResolverDeps` — no divergence
is possible. The T-0043 downstream contract is sealed in §6. No product-direction fork is opened.
