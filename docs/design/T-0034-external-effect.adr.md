# ADR · T-0034 — External-Effect Resources First-Class (E4.4)

**Status:** ready  
**Phase:** DESIGN  
**Date:** 2026-06-10  
**Author:** architect (Demiurge)

---

## 1. Context

The grant authority table (`008_grant.sql`, T-0018) already carries
`resource_type = 'effect_resource'` as a valid literal, and `Operation` already
includes `"invoke"`.  What was missing before this task:

1. A **typed entity schema** for `effect_resource` rows (kind, scope, tenant
   isolation).
2. A **gateway-verification seam**: at `invoke`-time, the resolver confirms the
   subject holds a grant for every `EffectDeclaration` the tool declares — not
   trusting the `declares` field as advisory text.
3. A **pure-compute linter** (`classifyTool`) that statically marks tools with
   no effect declarations as pure-compute, deterministically.

T-0033 (E4.3, data-classification) merged before this task.  It added the
optional `classifications?: ClassificationSource` port to `ResolverDeps`
and the `buildMaskContext` / `maskFields` call inside `resolveFor`.  T-0034 is
the parallel sibling: it adds **one more optional port** to `ResolverDeps` —
`effects?: EffectSource` — and **one more additive step** inside `resolveFor`
(for `op === "invoke"` only).  Both edits are additive optional fields; neither
breaks existing callers or the pre-existing frozen public surface.

---

## 2. Decision

Build `src/core/effect-resource.ts` — a pure, no-I/O module — that owns:

* The closed `EffectKind` union and the `EffectDeclaration`/`EffectResource`
  types.
* The `EffectSource` injected port (in-memory now; Postgres DAO in T-0053,
  mirroring `GrantSource`/`RecordSource`/`ClassificationSource`).
* `classifyTool(declares)` — the deterministic pure-compute linter.
* `verifyEffectGrants(declarations, grants, now)` — the gateway-verification
  function called inside `resolveFor`.

Wire the verification into `grant-resolver.ts` **additively** (one optional
`effects?: EffectSource` field on `ResolverDeps`; a step 3.5 inside `resolveFor`
active only when `op === "invoke"` and `deps.effects` is present).

Deliver `migrations/022_effect_resource.sql` (the per-tenant table) and
`ci/checks/effect-resource-isolation.sh` (the CI purity/boundary check).

The new `"no_effect_grant"` deny reason lives in `effect-resource.ts` as a
string literal constant.  `object-handle.ts` is NOT edited (frozen).  The reason
is used only within the `resolveFor` body and returned as part of the existing
`ResolvedView` shape — callers treat the `denied: true` branch uniformly; the
`reason` field is already typed as a string union in `ResolvedView`, but
`object-handle.ts` owns its literal union.  The safe non-frozen path: the new
reason is a *type-only widening* done by the composition root or by a
discriminated-union re-export in `effect-resource.ts` — coder decides the
mechanical TS approach that satisfies `tsc --noEmit` without touching
`object-handle.ts`.  The contract is: `resolveFor` may return
`{ denied: true, reason: "no_effect_grant" }` at runtime; downstream switch
exhaustion on `reason` is handled gracefully (unrecognised literal falls to a
default branch or wildcard).

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Separate `effect-resolver.ts` — a second resolver entry-point** | Creates a second `handle→fields` edge; `single-resolver.sh` would fail. The verification must fold into the ONE `resolveFor` body (FR-8, AC-13). |
| **Encode effect-grant check in `object-handle.ts` or `grant-lattice.ts`** | Both are frozen (T-0015, T-0018). Adding a new authority dimension to frozen files would break the byte-freeze invariant (AC-15) and couple unrelated concerns. |
| **Separate `effect_permission` table alongside `grant`** | A second authority subsystem that drifts from the grant table. The hypothesis (GT-1) explicitly requires `effect_resource` to be a first-class `resource_type` value in the EXISTING `grant` table — no separate permission subsystem (FR-1). |
| **Advisory `declares` text field (no gateway verification)** | Spec FR-4 explicitly requires gateway-verified, not advisory. Advisory text enables an agent to claim any effect without a grant — defeats the purpose. |
| **Inline the effect-check logic directly in `grant-resolver.ts`** | Would couple the resolver to effect-declaration types, polluting its responsibility boundary. `effect-resource.ts` as a separate pure module keeps types and the linter self-contained; the resolver imports and calls `verifyEffectGrants`. |
| **Synchronous `EffectSource.getEffect`** | Mirrors the `ClassificationSource` pattern (which is also synchronous in the static-now layer). This is consistent and correct for in-memory ports; T-0053 can wrap async if needed without changing the static-now interface. |
| **Store `EffectDeclaration[]` in the handle (baked at handle-creation)** | Re-opens the TOCTOU hazard (T-0021 ADR §3 rejected alternatives): baking declarations at handle-mint time means a tool whose `declares` changes between mint and invoke would execute with stale verification. The tool's `declares` blob is fetched live — from `RecordSource` or an inline context — at invoke-time. |

---

## 4. Object model

### 4.1 TypeScript — `src/core/effect-resource.ts`

```ts
/** Closed set of external-effect resource kinds. */
export type EffectKind =
  | "integration_endpoint"
  | "messaging_channel"
  | "external_account";

/** A tool's typed claim to invoke one effect-resource. */
export interface EffectDeclaration {
  resourceId: string;   // identity of the effect_resource row
  kind: EffectKind;     // must match the stored row's kind; mismatch → fail-closed
}

/** First-class effect-resource entity row — mirrors the DB table shape. */
export interface EffectResource {
  id: string;
  tenantId: string;
  kind: EffectKind;
  scope: unknown;       // ScopeElement or descriptive qualifier; opaque to linter
  metadata?: unknown;   // arbitrary jsonb; not used in access decision
}

/** Injected port — pure static-now; Postgres DAO in T-0053. */
export interface EffectSource {
  /** Resolve effect-resource by id within a tenant. null = not found → fail-closed. */
  getEffect(tenantId: string, resourceId: string): EffectResource | null;
}

/** Output of the pure-compute linter. */
export type ToolEffectProfile =
  | { pure: true }
  | { pure: false; effects: EffectDeclaration[] };

/** Output of the gateway-verification step. */
export type EffectVerifyResult =
  | { ok: true }
  | { ok: false; missingResourceId: string };
```

### 4.2 SQL — `migrations/022_effect_resource.sql`

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

**FK dry-run (T-0017 lesson):** PK `(tenant_id, id)` is self-contained — all
columns on this table.  `resource_type = 'effect_resource'` in the `grant` table
is a logical descriptor, not a row reference (same discipline as `grant.role_id`
and `data_classification.resource_type`).  No cross-table FK is attempted.
`tenant_id` leads the PK — passes `tenant_id_leading.sql`.  `kind` is CHECK-
constrained to the closed set.

### 4.3 `ResolverDeps` extension — additive field only

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

Existing callers that supply no `effects` field compile unchanged.  The absence
of `EffectSource` means the new step 3.5 is simply not entered — backward
compatible (NF-2, AC-8).

### 4.4 Step 3.5 inside `resolveFor` (invoke-path only)

Inserted **after step 3 (covering grants found, length > 0) and before step 5
(record fetch)** — only when `op === "invoke"` and `deps.effects` is present:

```
[step 3.5 — only when op === "invoke" AND deps.effects present]
  const declarations = parseEffectDeclarations(handle OR invokeContext.declares)
  // null if malformed → deny fail-closed (NF-3, AC-9)
  if (declarations === null)
    return { denied: true, reason: "no_effect_grant" }
  const result = verifyEffectGrants(declarations, covering, now, deps.effects, subject.tenantId)
  if (!result.ok)
    return { denied: true, reason: "no_effect_grant" }
```

**Wiring of `declares`:** The tool's `declares` blob is a field on the tool's
underlying record (a `jsonb NOT NULL DEFAULT '[]'::jsonb` column in T-0043's
`mcp_tool` table).  At `invoke`-time the gateway has already fetched the record
(or it is available in the handle context).  The coder decides the exact
mechanical wiring — two valid options:

1. Fetch the `declares` field from the `raw` record immediately after step 3 (the
   record source is called at step 5 anyway; hoisting the call or accessing the
   already-fetched raw within step 3.5 is equivalent).
2. Accept an optional `invokeContext?: { declares: unknown }` on `resolveFor`
   (an additive optional 5th argument — no signature break for callers that omit
   it).

The constraint the spec mandates: the verification uses `verifyEffectGrants` from
`effect-resource.ts`, runs inside the single `resolveFor` body, and the denial
reason is `"no_effect_grant"`.

### 4.5 `verifyEffectGrants` algorithm (pure function)

```
verifyEffectGrants(
  declarations: EffectDeclaration[],
  coveringGrants: Grant[],
  nowMs: number,
  source: EffectSource,
  tenantId: string,
): EffectVerifyResult

For each decl in declarations:
  1. Validate decl.kind ∈ EffectKind closed set → fail-closed if not.
  2. Fetch row = source.getEffect(tenantId, decl.resourceId) → null ⇒ fail-closed.
  3. Verify row.kind === decl.kind → mismatch ⇒ fail-closed.
  4. Check that at least one covering grant satisfies:
       g.resourceType === "effect_resource"
       AND g.operation === "invoke"
       AND isEffective(g, nowMs)
       AND g.tenantId === tenantId
       AND scope of g covers the effect-resource's scope (using isNarrowerOrEqual
           or a direct resourceId match — the scope of an effect_resource grant
           identifies the specific resource).
     If no covering grant for this declaration → return { ok: false, missingResourceId: decl.resourceId }
All declarations covered → return { ok: true }
```

All-or-nothing: first failing declaration short-circuits (AC-7).

---

## 5. Seam: `ResolvedView` and the `"no_effect_grant"` reason

`object-handle.ts` is frozen.  The existing `ResolvedView` denied-reason union is
`"no_grant" | "cross_tenant" | "not_found"`.

**Non-frozen path chosen:** The new literal `"no_effect_grant"` is defined in
`effect-resource.ts` and applied inside the `resolveFor` body via a TypeScript
type assertion on the returned object — specifically, `resolveFor`'s return type
is widened at the call site (the composition root / the test harness) to
`ResolvedView | EffectDeniedView`, where `EffectDeniedView` is exported from
`effect-resource.ts`.  The coder may also use a discriminated-union re-export
alias `ExtendedResolvedView` in `effect-resource.ts` that is the union of the
frozen `ResolvedView` plus `{ denied: true; reason: "no_effect_grant" }`.

Neither approach edits `object-handle.ts`.  The `resolveFor` function signature
stays `Promise<ResolvedView>` at its declaration; the body returns the wider type
via `as unknown as ResolvedView` where needed, or the function signature is
locally widened in `grant-resolver.ts` to `Promise<ResolvedView | EffectDeniedView>`.
Coder picks the cleanest `tsc --noEmit`-clean path; the constraint is
`object-handle.ts` is byte-frozen.

---

## 6. Module boundary and isolation

`src/core/effect-resource.ts` has no I/O imports:
- No `pg`, `fs`, `net`, `http`, `node:*`.
- Only TypeScript stdlib and one import from `./grant-lattice.js` (for
  `isEffective`, `Grant`, `EffectKind`-compatible operation types).
- DB access is ONLY behind the injected `EffectSource` port.

No parallel effect-ACL store is introduced. The module does not reference
`_acl`, `effect_visibility`, `effectRights`, or `effectAcl` tokens.

---

## 7. CI isolation check — `ci/checks/effect-resource-isolation.sh`

Modelled on `data-classification-isolation.sh`.  Asserts:

1. **ER-ISO1** — No parallel effect-ACL tokens in `src/core/effect-resource.ts`:
   `_acl`, `effect_visibility`, `effectRights`, `effectAcl` absent.
2. **ER-ISO2** — No forbidden I/O imports in `src/core/effect-resource.ts`:
   `pg`, `fs`, `net`, `http`.
3. **ER-ISO3** — `grant-resolver.ts` import surface preserved: `resolveFor`,
   `makeGrantResolver`, `projectFields`, `visibleFields`, `grantFacetFields`
   present; `ResolverDeps` gains only `effects?: EffectSource` (grep confirms
   no existing field removed).

---

## 8. Migration seam

Migration number is **022** (per run-seam instruction).  Migrations 019–021 are
owned by T-0022 (role/assignment table, in flight).  T-0034's file
`022_effect_resource.sql` MUST NOT reference tables from 019–021 (they may not
exist yet when 022 is applied in a bare schema sequence).  The self-contained PK
design (§4.2) guarantees zero cross-migration FK — safe regardless of apply order.

`known_tenant_tables.txt` gains the entry `effect_resource` additively.

---

## 9. T-0043 seam contract sealed

T-0043 (`mcp_tool` registry) imports from `src/core/effect-resource.ts`:

```ts
import {
  type EffectKind,
  type EffectDeclaration,
  type EffectResource,
  type EffectSource,
  type ToolEffectProfile,
  classifyTool,
  verifyEffectGrants,
} from "./effect-resource.js";
```

`mcp_tool.pure_compute` boolean = `classifyTool(tool.declares).pure`.
`mcp_tool.declares` column = `jsonb NOT NULL DEFAULT '[]'::jsonb`.
T-0043 does not re-declare `EffectKind` or `EffectDeclaration`.

---

## 10. Fitness functions (CI-executable)

| ID | Rule | CI check |
|----|------|----------|
| FF-ER1 | `effect_resource` is a tenant table: `tenant_id` leading PK, ENABLE+FORCE RLS, isolation policy, `choros_app` grant, in `known_tenant_tables.txt`. | `ci/checks/db/force_rls.sql` + `tenant_id_leading.sql` return 0 rows; `known_tenant_tables.txt` contains `effect_resource`. |
| FF-ER2 | Cross-tenant isolation: an `effect_resource` row under tenant A is invisible to a session bound to tenant B. | `ci/checks/db/cross_tenant.test.ts` two-tenant probe — red without RLS, green with FORCE. |
| FF-ER3 | Pure-compute linter determinism: `classifyTool(x)` called twice with same input → deep-equal output; `classifyTool([])` always `{ pure: true }`. | Pure-TS vitest unit test in `src/__tests__/effect-resource.test.ts`. |
| FF-ER4 | Fail-closed on malformed declares: `classifyTool(null as any)`, `classifyTool([{kind:"unknown"} as any])` return `{ pure: false }`, never `{ pure: true }`. | Pure-TS unit test. |
| FF-ER5 | Gateway deny on missing effect grant: `resolveFor` with `EffectSource` wired, normal grants present, tool declares an effect the subject has no grant for → `{ denied: true, reason: "no_effect_grant" }`. | Pure-TS unit test. |
| FF-ER6 | Gateway permit on complete effect grants: `resolveFor` with `EffectSource` wired, subject holds all effect grants → `{ denied: false, ... }`. | Pure-TS unit test. |
| FF-ER7 | All-or-nothing: 2-effect tool, subject holds 1 of 2 grants → denied. | Pure-TS unit test. |
| FF-ER8 | Backward compat (no `effects` port): `resolveFor` without `effects` in `ResolverDeps` behaves identically to pre-T-0034. All existing `grant-resolver.test.ts` pass unchanged. | `vitest run` on existing test suite. |
| FF-ER9 | Isolation — no parallel effect-ACL store: `ci/checks/effect-resource-isolation.sh` bans `_acl`/`effect_visibility`/`effectRights`/`effectAcl` tokens and `pg`/`fs`/`net`/`http` imports in `src/core/effect-resource.ts`. | `bash ci/checks/effect-resource-isolation.sh`. |
| FF-ER10 | T-0043 seam exports present: all seven symbols (`EffectKind`, `EffectDeclaration`, `EffectResource`, `EffectSource`, `ToolEffectProfile`, `classifyTool`, `verifyEffectGrants`) importable from `src/core/effect-resource.ts` without cast. | `tsc --noEmit` on a consumer that imports all symbols. |
| FF-ER11 | Frozen modules untouched: `src/core/grant-lattice.ts` and `src/core/object-handle.ts` are byte-identical to their dev-branch versions after T-0034's commit. | `git diff dev -- src/core/grant-lattice.ts src/core/object-handle.ts` exits clean. |
| FF-ER12 | `grant-resolver.ts` import surface preserved: `resolveFor`, `makeGrantResolver`, `projectFields`, `visibleFields`, `grantFacetFields`, `refToScope` all remain exported; `ResolverDeps` gains only one optional field; no existing field is changed. | `bash ci/checks/effect-resource-isolation.sh` (ER-ISO3) + `tsc --noEmit`. |
| FF-ER13 | Single-resolver check green: `ci/checks/single-resolver.sh` exits 0 after T-0034's commit. | `bash ci/checks/single-resolver.sh`. |
| FF-ER14 | No regression on pre-existing fitness suite: all checks in `ci/checks/` that were green before T-0034 remain green. | `npm run fitness`. |

---

## 11. Traceability

| AC | Covered by |
|----|-----------|
| AC-1 | §4.1 `EffectKind` closed union; §4.5 step 1 (`kind` validation); FF-ER4 |
| AC-2 | §4.1 `classifyTool` spec (`declares === []` → `{ pure: true }`); FF-ER3 |
| AC-3 | §4.1 `classifyTool` spec (non-empty → `{ pure: false, effects: [...] }`); FF-ER3 |
| AC-4 | §4.1 `classifyTool` fail-closed on malformed; NF-3; FF-ER4 |
| AC-5 | §4.4 step 3.5 + §4.5 (`verifyEffectGrants`, no-grant → `no_effect_grant`); FF-ER5 |
| AC-6 | §4.5 (all declarations covered → `ok: true`); §4.4 resolveFor permit path; FF-ER6 |
| AC-7 | §4.5 all-or-nothing: first failure short-circuits; FF-ER7 |
| AC-8 | §4.3 `effects?` optional field; §4.4 step 3.5 guarded by `deps.effects` presence; FF-ER8 |
| AC-9 | §4.4 `parseEffectDeclarations` returns null on malformed → `no_effect_grant`; NF-3; FF-ER5 |
| AC-10 | §4.2 DDL: `tenant_id` leading PK, ENABLE+FORCE RLS, `known_tenant_tables.txt`; FF-ER1 |
| AC-11 | §4.2 RLS policy; §4.5 `source.getEffect(tenantId, ...)` — tenant-scoped lookup; FF-ER2 |
| AC-12 | §6 module boundary; `ci/checks/effect-resource-isolation.sh`; FF-ER9 |
| AC-13 | §4.3 + §4.4: step 3.5 is additive inside `resolveFor`; no second resolver edge; FF-ER13 |
| AC-14 | §4.3 `ResolverDeps` additive field only; FF-ER12 |
| AC-15 | §5 frozen path (no edit to `object-handle.ts`/`grant-lattice.ts`); FF-ER11 |
| AC-16 | §4.1 + §9: seven symbols exported from `effect-resource.ts`; FF-ER10 |
| AC-17 | §6 purity (no I/O outside `EffectSource`); §4.5 determinism; FF-ER3 |
| AC-18 | FF-ER14 (`npm run fitness` all existing checks green) |

---

## 12. Runtime target

In-process, static-now (pure TS, no external resource provisioning required).
Postgres-backed `EffectSource` DAO defers to T-0053.  Fitness suite runs under
vitest in `npm run ci`.  The isolated Postgres probe for cross-tenant RLS
(FF-ER2) follows the same pattern as existing `ci/checks/db/two_tenant.test.ts`,
using the isolated test DB at `POSTGRES_PORT=55447`.

---

## 13. No escalation

No product-direction fork: scope is mechanically derived from GT-1-signed
hypothesis (§5 `effect_resource`) + the merged T-0021/T-0018/T-0015/T-0027
foundation.  T-0033 seam (S-2) specifies exactly how T-0034 stacks onto
`ResolverDeps`.  No new authority algebra, no second resolver edge, no new
external service.  Migration number (022) given by orchestrator.
