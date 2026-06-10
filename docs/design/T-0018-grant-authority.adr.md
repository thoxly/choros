# ADR · T-0018 — `grant` Authority Table + Closed Scope Lattice

**Status:** ready (no founder escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
**Task:** E2.3 — `grant` authority table + closed scope lattice (provable monotonic narrowing)
**Spec:** `docs/specs/T-0018-grant-authority.spec.md` + `docs/specs/T-0018.spec.contract.json` (FR-1..FR-8, NF-1..NF-6, AC-1..AC-15)
**Foundation (does NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (every grant table is a FORCE-RLS default-DENY tenant table, `tenant_id` leading, accessed via `withTenant` + `choros.tenant_id` GUC) · `docs/design/T-0014-registry-model.adr.md` §5 (`ResourceRef` — immutable UUID discriminated union: `application | registry | record`)
**Siblings consumed-by / not-built-here:** T-0021 (E2.5 PDP/resolver — *reads* this), T-0016 (E2.8 audit floor — receives the emitted events), T-0022/T-0017 (E3.2/E3.1 `role`/`assignment` + org/admin scope — distinct from resource scope here), T-0053 (E0.3 Postgres-in-compose — DDL/RLS land there)

---

## 1. Context

This is a **DESIGN-only, two-deliverable** task. Choros is today an in-memory TS/Node app — no Postgres, no migrations. Like its merged sibling T-0013/T-0014, T-0018 pins **invariants, object model, contracts, and fitness functions** that any correct `grant`-authority implementation MUST satisfy; the SQL DDL / RLS policy bodies are deferred to **T-0053**, the resolver/PDP to **T-0021**, and the audit ledger to **T-0016**.

But unlike T-0013/T-0014, T-0018 has a **static-now buildable core**: the **closed scope-lattice algebra** (elements, partial order `⊑`, meet `⊓`, canonical form, and the write-time subset gate) is **pure TS with no DB dependency**. The SPEC analyst flagged this explicitly, and the acceptance criteria (AC-3..AC-9) are written as `static-now` vitest checks. So this ADR does two jobs:

1. Pin the **`grant` row shape, lattice formalism, write-time subset invariant, and audit obligation** as the contract the resolver (T-0021) and DDL (T-0053) consume — the design-only part.
2. Pin a **build contract** (§5) for a follow-on coder to implement the static-now lattice algebra as a self-contained pure-TS module with vitest fitness tests, immediately after this ADR.

The load-bearing decision: authority is **one** table whose permission floor is `resource_type × operation × scope`, and `scope` is drawn from a **closed algebra** whose decidable structural partial order makes **monotonic narrowing provable at write-time** — self-elevation is structurally impossible, not merely audited.

---

## 2. Decision

**Adopt a single `grant` authority table (the only object encoding "who may do what to which resources") whose permission floor is `resource_type × operation × scope`, where `scope` is an element of a closed lattice `(S, ⊑, ⊓, ⊥)` over four element kinds — hierarchy-node (subtree containment), tag-set (set inclusion), numeric-interval (canonical containment), and scope-set (union of the prior) — stored in canonical form. The lattice's structural, decidable partial order `⊑` powers a write-time subset gate: a delegated grant is rejected before persistence unless `child.scope ⊑ granter.scope` and its facet/constraint do not widen the parent. The genesis tenant-owner is the un-parented root of the delegation lattice; free-form predicate scopes sit outside the lattice, are owner-only, and are `delegable = false`. Tools, masked fields, and record-level rights are *derived projections* of `grant` rows resolved by T-0021 — there is no second permission subsystem. Grant create/revoke emit first-class events into the T-0016 audit floor. The lattice algebra is built NOW as a self-contained pure-TS module `src/core/grant-lattice.ts` with vitest fitness tests (§5); the `grant` DDL/RLS land in T-0053 and the resolver in T-0021.**

The mechanism is **proportional** (rubric axis 5): the lattice is four small element kinds and three structural comparison rules; there is no policy engine, no rule DSL, no live-data evaluation, no LLM in the `⊑`/`⊓` path. That is exactly the property a free-text `expr` could not give and the reason a *closed* algebra was mandated by the GT-1-signed hypothesis (§2, §6-A #2).

### 2.1 Why the lattice is closed (the crux)

`⊑` must be **decidable and total** so the subset gate is a write-time structural check, not a runtime hope. That holds **iff** the meet `⊓` never escapes the admissible element set (FR-4): for any admissible `x, y`, `x ⊓ y` is itself a node / tag-set / interval / scope-set / `⊥` — never an arbitrary predicate. The four kinds are individually closed under `⊓` (ancestor-meet for nodes, set-intersection for tags, interval-overlap for intervals) and scope-set closes the union dimension; `⊥` (empty scope) is the bottom. A free-form predicate would break closure (you cannot structurally prove containment of an arbitrary boolean expression), so it is **expelled** from the delegable sublattice (FR-6) rather than admitted and special-cased.

### 2.2 Two scopes, never conflated

The `scope` here is **resource scope** (which resources/records/values a grant reaches), carried on `grant`. It is **distinct** from the **admin/org scope** carried on `assignment` (T-0022 — which org subtree a role is assigned within). The subset check in this ADR is over **resource scope only**; admin-scope narrowing is E3.3/T-0029 and is out of scope. The lattice's hierarchy-node kind *does* support both a `resource` hierarchy and an `org` hierarchy as two disjoint, non-comparable hierarchies (the `hierarchy` discriminant), but a `grant.scope` for this task uses the `resource` hierarchy (org-tree nodes appear only when `mgmt_object:*` resource-types are later activated).

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Free-form predicate / arbitrary `expr` as the scope** | `⊑` becomes undecidable — you cannot structurally prove one boolean expression implies another without a theorem prover or live-data evaluation. Monotonic narrowing degrades to post-hoc audit; self-elevation becomes possible-but-logged. This is the "was: arbitrary `expr`, unsound" the hypothesis (§2, §6-A #2) explicitly rejected. Free-form predicates survive only as **owner-only, non-delegable** escape hatch (FR-6), outside the lattice. |
| **Second authority subsystem (parallel record-ACL table + separate field-visibility store)** | Two sources of truth for "who may touch this record/field"; they drift, and a permission held in one but not the other is a silent leak or a silent denial. Hypothesis §3 Q5 / §6-A #2: record-rights = `operation × scope` in **one** tuple; tools/fields are *derived*. NF-1 forbids any parallel store (FF-7 lints for it). |
| **Grant binds to slugs / display names** | Renaming a resource would silently re-target or orphan grants (T-0014 NF-3 rename-safety violated). Grants bind to **immutable UUIDs** drawn from `ResourceRef` (T-0014 §5). FF-8 lints that no `node_id` is a slug. |
| **Grant attaches directly to a person/agent** | Couples authority to identity; substitution, audit, and least-privilege all break. Grants attach to a **`role`** (the principal); humans and agents both reach grants only through role assignments (T-0022). |
| **Post-hoc audit of self-elevation (detect-and-revoke) instead of a write-time gate** | "Narrowing" becomes a hope checked after damage. The closed lattice makes the subset check a **pre-persistence** structural decision (FR-5); a widening grant never lands. Detect-and-revoke is the anti-pattern T-0013 §2 names (discipline not structure). |
| **A `⊤` (top / "all") element in the delegable lattice** | An implicit unbounded top makes every scope `⊑ ⊤`, so any chain could widen back to "all" through a top-typed parent. "All" authority, if it exists, is an **owner-only** construct (FR-6), not a delegable lattice element; the closure properties (§2.1) are stated over the delegable sublattice that **excludes** any implicit top. `⊥` (bottom) is kept (it is the well-defined empty meet); `⊤` is not. |
| **Cross-kind coercion (e.g. a tag-set implicitly ⊑ a hierarchy-node)** | Would require a semantic bridge between unrelated domains; there is none, and inventing one re-introduces undecidability. Distinct kinds are **incomparable** unless a scope-set explicitly contains a same-kind member (FR-3). `meet` of distinct non-set kinds is `⊥`. |
| **Store scopes in raw input form; normalize only at compare time** | Comparison would depend on input member order / interval direction / duplicate tags, making `⊑`/`⊓` non-deterministic and the fitness functions flaky. **Canonical-form-at-write** (NF-5) makes every stored scope normalized, so comparison is order-independent and idempotent (AC-8). |
| **Mint the lattice algebra inside `src/core/types.ts` / `jobStore.ts` (edit existing files)** | Collides with frozen job-model types and the in-memory store; couples authority to the job apparatus. The algebra is a **new self-contained file** `src/core/grant-lattice.ts` (additive, no edits to existing exports — FE-W23-0008 compatibility: existing `types.ts`/`jobStore.ts` public symbols are untouched). |

None of these re-opens a founder-ratified product decision; they are the standard alternatives for a delegation-authority model, recorded so the choice is auditable.

---

## 4. Object model

### 4.1 `grant` — the single authority table (Postgres types authoritative; DDL is T-0053)

| Field | Type | Meaning / constraint |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; T-0013 RLS key |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `role_id` | `uuid NOT NULL` | the **principal**; FK `(tenant_id, role_id) → role(tenant_id, id)` (role table is T-0022) |
| `resource_type` | `text NOT NULL` | `application \| registry \| record` (T-0014 `ResourceRef.kind`), plus reserved `mgmt_object:*` / `effect_resource` for later epics. Resource *identity* lives in `scope`, not here. |
| `resource_facet` | `jsonb NULL` | which slice/fields of the resource; absent ⇒ whole-resource. Only ever **narrows**. Grammar interlocks E4.3 masking — kept minimal (§7). |
| `operation` | `text NOT NULL` | `read \| create \| update \| delete \| approve \| transition \| invoke` (guard semantics of the last three are E4.2/E5.4, not here) |
| `scope` | `jsonb NOT NULL` | a **canonical** closed-lattice element (§4.2): node, tags, interval, or scope-set. The **only** place resource/subtree/value reach is expressed. |
| `constraint` | `jsonb NULL` | optional further condition. For a **delegable** grant it must be lattice-expressible; the conservative default (§7) is **no constraint beyond the lattice** — a richer constraint forces owner-only/non-delegable (FR-6). |
| `delegable` | `boolean NOT NULL DEFAULT true` | may this grant be the **parent** of a narrower delegated grant. Free-form-scope grants are forced `false` (FR-6). |
| `granted_by` | `text NOT NULL` | subject identity that minted the grant (audit linkage, FR-7) |
| `valid_from` | `bigint NULL` | unix epoch ms; null ⇒ effective immediately |
| `valid_until` | `bigint NULL` | unix epoch ms; null ⇒ no expiry. Outside the window ⇒ **zero** capability on the read-path (TTL = removed capability). |
| `created_at` | `bigint NOT NULL` | unix epoch ms |

- **TS mirror** (the `Grant` type the build delivers): `{ tenantId, id, roleId, resourceType, resourceFacet?, operation, scope, constraint?, delegable, grantedBy, validFrom?, validUntil?, createdAt }`.
- **Binding invariant:** every hierarchy-node `node_id` in `scope` is an **immutable UUID** drawn from a `ResourceRef` (`applicationId | registryId | recordId`, T-0014 §5) or an org-tree UUID — **never a slug** (T-0014 NF-3; AC-12 / FF-8).
- **Tenant inheritance (T-0013):** `tenant_id` leading PK, FORCE RLS + default-DENY, scoped uniqueness, all access via `withTenant`; the subset check runs only within one tenant's grants (NF-4 / AC-15).

### 4.2 Scope-lattice formalism (the static-now algebra)

**Domain `S` — four admissible element kinds (the closed set):**

```ts
type Hierarchy = "resource" | "org";
type NodeLevel = "application" | "registry" | "record" | "department" | "position";

type ScopeElement =
  | { kind: "node";     hierarchy: Hierarchy; nodeId: string; nodeLevel: NodeLevel } // self + entire subtree
  | { kind: "tags";     tags: string[] }            // canonical: sorted, de-duplicated
  | { kind: "interval"; axis: string; lo: number; hi: number } // canonical: lo ≤ hi
  | { kind: "set";      members: AtomElement[] };   // canonical: flattened, no nested set, no ⊑-redundant member

type AtomElement = Exclude<ScopeElement, { kind: "set" }>; // a set's members are never sets (flattened)
type Scope = ScopeElement;            // a grant.scope is any element kind
const BOTTOM = { kind: "set", members: [] } as const;       // ⊥ — empty reach, the canonical empty scope-set
```

> `node_id` carries an immutable UUID; the **containment hierarchy** (who is whose descendant) is **not** embedded in the element — it is supplied to the algebra as an injected `AncestryOracle` (§5.2). At build-time this is an in-memory adjacency lookup; at T-0053 it is backed by the `application⊃registry_def⊃record` FK chain (and later the org tree). This keeps the algebra pure and the hierarchy a *data* fact, not a hard-coded table.

**Partial order `⊑` (`isNarrowerOrEqual(child, parent)` — structural, decidable, total):**

| Case | `a ⊑ b` holds iff |
|---|---|
| node ⊑ node | `a.hierarchy === b.hierarchy` **and** (`a.nodeId === b.nodeId` **or** `a.nodeId` is a descendant of `b.nodeId` in that hierarchy). Reflexive (same node ⇒ true). |
| tags ⊑ tags | `a.tags ⊆ b.tags` (set inclusion) |
| interval ⊑ interval | `a.axis === b.axis` **and** `b.lo ≤ a.lo` **and** `a.hi ≤ b.hi` |
| element ⊑ set | ∃ member `m ∈ b` with `element ⊑ m` (fits entirely inside one member) |
| set ⊑ X | ∀ member `a ∈ A`: `a ⊑ X` (every piece of the child contained in the parent) |
| cross-kind (non-set) | **false** — incomparable; no implicit coercion |

`⊑` always returns a **boolean** — never throws, never "unknown" (AC-3). `⊥ ⊑ anything` is true (empty set, vacuously every member contained); `nonempty ⊑ ⊥` is false.

**Meet `⊓` (`meet(x, y)` — greatest lower bound / intersection, closed):**

| Case | `x ⊓ y` |
|---|---|
| node ⊓ node (same hierarchy) | if one is an ancestor of the other ⇒ the **descendant** (smaller subtree); disjoint subtrees ⇒ `⊥` |
| tags ⊓ tags | set **intersection** (canonical-sorted; empty ⇒ `⊥`) |
| interval ⊓ interval (same axis) | `[max(lo), min(hi)]`, or `⊥` if it inverts |
| set ⊓ X | `{ m ⊓ X : m ∈ members }` with `⊥` members dropped, then canonicalized |
| distinct-kind, non-set | `⊥` |

`meet` is **closed** (AC-7): the result is always an admissible element (node / tags / interval / set / `⊥`), never an arbitrary predicate.

**Canonical form (NF-5; `normalize(scope)`):** interval `lo ≤ hi` (swap if reversed, reject if a single point is required to invert); tags sorted + de-duplicated; scope-set **flattened** (no nested sets — a set member that is itself a set is spliced in), with **`⊑`-redundant members dropped** (if `m1 ⊑ m2` both present, drop `m1`). `normalize` is **idempotent**: `normalize(normalize(s)) === normalize(s)` (AC-8). `⊑`/`⊓` operate on canonical forms and are therefore **deterministic regardless of input member order**.

### 4.3 Write-time subset gate (the monotonic-narrowing invariant)

```ts
// validateNarrowing(parent, child, oracle) — the FR-5 gate, pre-persistence.
// parent = the granter's own grant (same resource_type × operation);
// child  = the proposed delegated grant.
// Returns ok | a typed rejection; NEVER mutates, NEVER persists.
type NarrowingResult =
  | { ok: true }
  | { ok: false; reason: "scope_widens" | "facet_widens" | "constraint_widens"
                       | "parent_non_delegable" | "free_form_non_delegable" };
```

Accept iff **all** hold: `parent.delegable === true`; the parent's scope is **not** a free-form predicate (FR-6); `isNarrowerOrEqual(child.scope, parent.scope, oracle) === true`; and `child.resourceFacet` / `child.constraint` do **not** widen the parent's (a facet/constraint absent on the child but present on the parent narrows or equals; a child facet must be `⊑` the parent facet — minimal grammar, §7). Any failure ⇒ a **distinct typed rejection before persistence** (AC-9). The **genesis tenant-owner** is the un-parented root: owner-minted grants are **not** subset-checked against a parent (there is none above the owner); every grant the owner delegates downward becomes, from then on, a subset-checked parent (FR-5).

### 4.4 Free-form scope (owner-only escape hatch, FR-6)

A scope outside the closed lattice is represented as `{ kind: "freeform"; predicate: string }` (NOT an `AtomElement` — it is **not** admissible in the lattice). Invariants enforced by the write path: only the genesis tenant-owner may mint a `freeform` grant; such a grant is forced `delegable = false`; any delegation whose **parent** is a `freeform` grant is rejected (`validateNarrowing` returns `free_form_non_delegable`). `isNarrowerOrEqual` against a `freeform` element is **false** for any lattice child (containment of an arbitrary predicate is unprovable), so a `freeform` parent can never admit a child — structurally, not by policy.

### 4.5 Validity-window evaluation helper (FR-2 / AC-13; resolver-contract surface)

```ts
// isEffective(grant, nowMs) — the validity-window contract T-0021 consumes.
// (valid_from == null || now >= valid_from) && (valid_until == null || now < valid_until)
function isEffective(grant: Grant, nowMs: number): boolean;
```

An out-of-window grant confers **zero** capability — `isEffective` returns `false` and the resolver treats it as absent (FR-8 read-path enforcement is T-0021; here only the helper + invariant). This ADR fixes the helper as the single place validity is decided, so revocation-removes-capability (FR-8) and TTL-is-removal (FR-2) share one code path.

### 4.6 Audit obligation (FR-7 — obligation + fields only; ledger is T-0016)

Grant **create** and **revoke** code paths MUST emit a first-class event into the per-tenant audit floor (T-0016), carrying at minimum:

```ts
type GrantAuditEvent = {
  kind: "grant.create" | "grant.revoke";
  actor: string;        // granted_by (create) / revoker (revoke)
  subjectRoleId: string;
  capability: { resourceType: string; operation: string; resourceFacet?: unknown };
  scope: Scope;
  proposedBy?: string;  // when via LLM-proposes/human-confirms (E3.5)
  confirmedBy?: string;
};
```

T-0018 builds **no ledger**; it fixes the obligation (every create/revoke site emits) and the field set, so the grant trail (E3.6) is queryable from the unified audit. FF-9 lints the call obligation.

---

## 5. Build contract (static-now — the follow-on coder's deliverable)

A coder implements the **scope-lattice algebra** immediately after this ADR as a self-contained pure-TS module with vitest fitness tests. This section is the **binding contract**.

### 5.1 Module boundary & file path

- **New file:** `src/core/grant-lattice.ts` — self-contained, **additive**. It MUST NOT modify `src/core/types.ts` or `src/core/jobStore.ts` in any way that changes their existing exports (FE-W23-0008 compatibility: those public symbols are frozen by `src/__tests__/*`). All new types (`Grant`, `ScopeElement`, etc.) are **declared in and exported from** `grant-lattice.ts`.
- **Tests:** `src/__tests__/grant-lattice.test.ts` (vitest, matches the existing `src/__tests__/*.test.ts` convention picked up by `vitest run`).
- **No DB, no I/O, no network, no LLM** in this module — it is pure functions over in-memory values plus an injected `AncestryOracle`.

### 5.2 Public API surface (the exact exports)

```ts
// --- types ---
export type Hierarchy = "resource" | "org";
export type NodeLevel = "application" | "registry" | "record" | "department" | "position";
export type Operation = "read" | "create" | "update" | "delete" | "approve" | "transition" | "invoke";
export type ResourceType = "application" | "registry" | "record" | `mgmt_object:${string}` | "effect_resource";

export type ScopeElement =
  | { kind: "node"; hierarchy: Hierarchy; nodeId: string; nodeLevel: NodeLevel }
  | { kind: "tags"; tags: string[] }
  | { kind: "interval"; axis: string; lo: number; hi: number }
  | { kind: "set"; members: AtomElement[] };
export type AtomElement = Exclude<ScopeElement, { kind: "set" }>;
export type FreeformScope = { kind: "freeform"; predicate: string };
export type Scope = ScopeElement;                 // delegable grants
export type GrantScope = ScopeElement | FreeformScope; // grant.scope incl. owner-only free-form

export interface Grant {
  tenantId: string; id: string; roleId: string;
  resourceType: ResourceType; resourceFacet?: unknown;
  operation: Operation; scope: GrantScope; constraint?: unknown;
  delegable: boolean; grantedBy: string;
  validFrom?: number; validUntil?: number; createdAt: number;
}

// Injected hierarchy fact (pure): is `a` the same as, or a descendant of, `b`?
export interface AncestryOracle {
  isDescendantOrSelf(hierarchy: Hierarchy, descendantId: string, ancestorId: string): boolean;
}

// --- algebra ---
export function normalize(s: ScopeElement): ScopeElement;          // canonical form (NF-5), idempotent
export function isNarrowerOrEqual(child: ScopeElement, parent: ScopeElement, oracle: AncestryOracle): boolean; // ⊑
export function meet(x: ScopeElement, y: ScopeElement, oracle: AncestryOracle): ScopeElement;                  // ⊓ (closed)
export function isBottom(s: ScopeElement): boolean;                // ⊥ test (empty scope-set)
export const BOTTOM: ScopeElement;                                // canonical ⊥

// --- gate ---
export function validateNarrowing(
  parent: Grant, child: Grant, oracle: AncestryOracle,
): { ok: true } | { ok: false; reason:
    "scope_widens" | "facet_widens" | "constraint_widens"
  | "parent_non_delegable" | "free_form_non_delegable" };

// --- resolver-contract helpers ---
export function isEffective(grant: Grant, nowMs: number): boolean; // validity window (AC-13)
```

**Semantics are §4.2–4.5 verbatim.** `isNarrowerOrEqual`/`meet` assume canonical inputs (callers normalize at write-time); both are total and side-effect-free. Cross-kind non-set comparison ⇒ `false`/`⊥`. A `freeform` `parent.scope` ⇒ `validateNarrowing` returns `free_form_non_delegable` (never inspects the child).

### 5.3 Fitness functions that become vitest tests NOW (AC → assertion)

| FF | Rule (asserted) | Maps AC | vitest assertion |
|---|---|---|---|
| **FF-1** | `⊑` is total & decidable | AC-3 | over the node/tag/interval/set fixture matrix, `isNarrowerOrEqual(a,b)` returns a boolean for **every** pair, never throws, and matches the FR-3 truth table |
| **FF-2** | hierarchy-node subset | AC-4 | descendant ⊑ ancestor ⇒ `true`; disjoint subtree ⇒ `false`; ancestor ⊑ descendant (wider) ⇒ `false`; same node ⇒ `true` |
| **FF-3** | tag & interval subset | AC-5 | `{a,b}⊑{a,b,c}` true, `{a,d}` false; `[10,40]⊑[0,50]` true, `[10,60]` false; mismatched `axis` ⇒ false |
| **FF-4** | scope-set subset | AC-6 | element ⊑ set iff it fits one member; `A⊑B` iff every member of A ⊑ B; an escaping member ⇒ false |
| **FF-5** | meet closure | AC-7 | `meet(x,y)` is always an admissible element (node/tags/interval/set/⊥); disjoint node⊓node=⊥; interval=overlap-or-⊥; tags=intersection |
| **FF-6** | canonical-form idempotence + order-independence | AC-8 | `normalize(normalize(s))` deep-equals `normalize(s)`; `isNarrowerOrEqual`/`meet` give identical results under permuted set-member / tag order; non-canonical interval/tag/nested-set input is normalized |
| **FF-7** | monotonic narrowing provable / no self-elevation | AC-9, NF-3 | a child ⊑ parent (non-widening facet/constraint) ⇒ `validateNarrowing.ok===true`; node-widening, tag-superset, interval-widening, escaping-set-member each ⇒ `ok===false` with the correct `reason`; **structural impossibility**: there is no input for which a non-`⊑` child returns `ok` |
| **FF-8** | free-form owner-only / non-delegable | AC-10 | `validateNarrowing` with a `freeform` parent ⇒ `free_form_non_delegable`; a `freeform` grant constructed with `delegable=true` is rejected by the write-path constructor (forced `false`) |
| **FF-9** | validity window = capability | AC-13 | `isEffective` false for past `validUntil` / future `validFrom`; true in-window; null bounds ⇒ open-ended |

### 5.4 Which ACs are static-now (vitest NOW) vs activates-in-T-0053 (DB, deferred)

- **Static-now (vitest in this build):** AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9 (algorithm on an in-memory grant store), AC-13. Plus the **TS-type** half of AC-2 (the `Grant` type mirrors the FR-2 floor, compile-checked by `tsc --noEmit`).
- **Static-now lint (this build or a small ci/checks script):** AC-11 (no parallel record-ACL table — assert the model fixture has only `grant`), AC-12 (no `grant.scope` `node_id` is a slug — UUID-shape check), AC-14 (every grant create/revoke call site emits an audit event), and the lint half of AC-15 (the subset check runs inside `withTenant`).
- **Activates-in-T-0053 (live-DB probe authored later):** the DB half of AC-1 (FORCE RLS `(true,true)`, default-DENY count 0), the DB-constraint half of AC-2 (NULL-floor ⇒ constraint violation), the DB-write-path half of AC-9, the rename-test half of AC-12, the ledger half of AC-14, and the cross-tenant-count half of AC-15.

---

## 6. Fitness functions (CI gating — design-level)

Each is an executable rule for `npm run ci` (`tsc --noEmit && eslint src && vitest run`). `gating` = static-now (runnable today) or activates-in-T-0053 (live-DB probe authored now, gated on Postgres).

| FF | Rule | ci_check | gating |
|---|---|---|---|
| **FF-A1** | `⊑` decidable & total; meet closed; canonical idempotent; narrowing provable; free-form non-delegable; validity-window | `vitest run src/__tests__/grant-lattice.test.ts` — the §5.3 suite (FF-1..FF-9) green | static-now |
| **FF-A2** | `Grant` TS type mirrors the FR-2 floor (`roleId, resourceType, operation, scope` required; full field set) | `tsc --noEmit` over `src/core/grant-lattice.ts` + a compile-time fixture asserting the shape | static-now |
| **FF-A3** | Lattice module is self-contained & additive (no edit to frozen `types.ts`/`jobStore.ts` exports; no DB/IO import) | `ci/checks/grant-lattice-isolation.sh`: assert `src/core/grant-lattice.ts` imports nothing from `jobStore`/`http`/`pg`/`fs`/`net`; `git diff` touches no existing export in `types.ts`/`jobStore.ts` | static-now |
| **FF-A4** | Single authority subsystem — no parallel record-ACL / field-visibility table in the model | `ci/checks/single-authority.sh`: grep the model fixture / type space for a second authority table (`*_acl`, `field_visibility`, `record_rights`); >0 ⇒ fail (NF-1 / AC-11) | static-now |
| **FF-A5** | Grant binds to UUIDs, not slugs | `ci/checks/grant-uuid-binding.sh`: every `node:nodeId` in any `grant.scope` fixture matches the UUID shape and is sourced from a `ResourceRef`/org-tree id; a slug/display-name ⇒ fail (AC-12) | static-now (+ live rename test T-0053) |
| **FF-A6** | Every grant create/revoke site emits a `GrantAuditEvent` | `ci/checks/grant-audit-emit.sh`: each grant create/revoke call site is accompanied by an audit-emit with the FR-7 field set; a site with no emit ⇒ fail (AC-14) | static-now (+ live ledger T-0016) |
| **FF-A7** | Grant is a registered T-0013 tenant table, FORCE RLS, default-DENY | `grant` in `known_tenant_tables` fixture (static-now); live `relrowsecurity AND relforcerowsecurity`=(t,t); no tenant context ⇒ count 0 (AC-1) | static-now (fixture) + activates-in-T-0053 |
| **FF-A8** | FR-2 floor NOT NULL at DB; subset check runs inside `withTenant`; tenant isolation of grants | live: NULL on `tenant_id/role_id/resource_type/operation/scope` ⇒ constraint violation; context=A ⇒ count tenant-B grants 0; static-now lint: subset-check call path is inside `withTenant` (AC-2, AC-15) | static-now (lint) + activates-in-T-0053 |

---

## 7. Open items — resolved with conservative defaults (non-blocking)

- **Numeric-axis registry.** Interval scopes reference a named `axis` (e.g. an amount-limit). **Decision:** `axis` is a free `string` key in T-0018; there is **no** enforced axis registry yet — `⊑`/`⊓` require only `axis` *equality* (mismatched axis ⇒ incomparable / `⊥`), so the algebra is axis-agnostic. A canonical axis vocabulary + units is fixed where criticality is designed (E4.5); it does not change the lattice algebra. Units are the *caller's* responsibility (compare only same-axis intervals).
- **`resource_facet` grammar.** **Decision (minimal):** treat `resourceFacet` as an **opaque, optional narrowing token** in T-0018 — its only contract is "absent ⇒ whole-resource; present ⇒ a strict narrowing." The subset gate's facet rule is conservative: a child facet must equal or be a structural subset of the parent's; if facet-subset is not yet decidable (grammar undefined), a **present child facet under an absent parent facet narrows (ok), and a present parent facet requires an equal/absent-or-subset child** — richer facet algebra is deferred to E4.3/T-0033. No facet grammar is invented here.
- **`constraint` grammar for delegable grants.** **Decision (conservative default per spec §6):** a **delegable** grant carries **no `constraint` beyond what the lattice expresses**; any richer (free-form) constraint forces the grant **owner-only / non-delegable** (FR-6). `validateNarrowing` therefore treats a child `constraint` that is not absent-or-equal-to-parent as `constraint_widens` until a lattice-expressible constraint grammar exists.
- **Genesis owner identity.** The single `tenant-owner` per tenant (the lattice root) is provisioned by tenant-init (T-0013/E3.1 territory). **Decision:** T-0018 relies only on its *existence* as the un-parented root; the algebra takes "is this principal the owner?" as an injected boolean at the write path, not a lattice concern.

---

## 8. Consequences

**Positive.**
- **Self-elevation is structurally impossible** (NF-3): a widening grant cannot pass `validateNarrowing`, and there is no input that makes a non-`⊑` child return `ok` (FF-7). This is the core E2.3 correctness guarantee, provable now in vitest — before any DB exists.
- **One authority subsystem** (NF-1): tools, masked fields, record-rights are derived projections (T-0021), so there is exactly one place to reason about, audit, and revoke authority.
- **Rename-safe** (T-0014 NF-3): grants bind to immutable UUIDs; slug renames never re-target reach.
- **Resolver-ready** (NF-6): T-0021 consumes a closed, unambiguous table + algebra and need not re-open E2.3 — the same way T-0014 §5 handed *this* task a closed `ResourceRef`.
- **The hard part ships early.** The load-bearing algebra is pure TS with no DB dependency, so the riskiest invariant (monotonic narrowing) is verified the moment the coder finishes — the DB work in T-0053 is then mechanical wiring.

**Negative / accepted costs.**
- The `AncestryOracle` is injected; the in-memory build-time oracle must agree with the eventual FK-backed one in T-0053 (a thin seam, tested at both ends — flagged for T-0053).
- `resource_facet` / `constraint` algebra is deliberately minimal now; a future facet/constraint grammar (E4.3/T-0033) must extend `validateNarrowing` *additively* without weakening the scope gate.
- Canonical-form-at-write adds a `normalize` step on every grant write; this is cheap (small finite scopes) and is the price of deterministic comparison.

---

## 9. Non-goals (hard boundaries — MUST NOT be built in T-0018)

1. **SQL DDL / migrations / RLS policy bodies for `grant`** — T-0053. This ADR fixes invariants + lattice algebra; `CREATE TABLE`/indexes/RLS land there.
2. **The PDP / `grant_resolver` runtime** (resolution order, masking, action-time binding, caching, the gateway chokepoint) — **T-0021 (E2.5)**. This ADR builds the table + algebra the resolver *reads*, not the resolver.
3. **The audit floor itself** (`audit_event` table, hash-chain, monotonic `tenant_seq`, append-only enforcement) — **T-0016 (E2.8)**. Only the emit *obligation* + minimum fields (FR-7 / §4.6) are fixed here.
4. **`role` / `assignment` tables + org/admin scope** — **T-0022 (E3.2)** / **T-0017 (E3.1)**. Admin/org scope on `assignment` is **distinct** from resource scope here; admin-scope narrowing is E3.3/T-0029. The subset check here is over **resource scope only**.
5. **Structural grant editor UI + LLM-proposes/human-confirms** — **T-0030 (E3.4)** / **T-0039 (E3.5)**. The `proposed_by`/`confirmed_by` audit obligation is recorded; no authoring UI or LLM proposer is built.
6. **Toolset resolution / `mcp_tool` registry / effect-resource verification** — **T-0043 (E5.3)** / **T-0034 (E4.4)**. The `mgmt_object:*` / `effect_resource` resource-type values are reserved, not their semantics.
7. **`role_criticality` / dual-control** — **T-0040 / T-0044**; computed *from* grants, not here.
8. **Substitutions / TTL'd delegation mechanics** — **T-0035 (E4.7)**. T-0018 fixes only that an out-of-window grant confers zero capability (§4.5).
9. **Value-aware masking (E4.3 / T-0033)** — only that a facet *narrows* and participates in the subset gate is fixed.

---

## 10. Traceability (AC → design)

| AC | Covered by |
|---|---|
| AC-1 | §4.1 `grant` as T-0013 tenant table + FF-A7 |
| AC-2 | §4.1 floor NOT NULL + TS mirror `Grant` + FF-A2 / FF-A8 |
| AC-3 | §4.2 `⊑` total/decidable + §5.3 FF-1 / FF-A1 |
| AC-4 | §4.2 node ⊑ node (AncestryOracle) + §5.3 FF-2 |
| AC-5 | §4.2 tags/interval ⊑ + §5.3 FF-3 |
| AC-6 | §4.2 element⊑set / set⊑set + §5.3 FF-4 |
| AC-7 | §4.2 `⊓` closed + §5.3 FF-5 |
| AC-8 | §4.2 `normalize` canonical/idempotent + §5.3 FF-6 |
| AC-9 | §4.3 `validateNarrowing` write-time gate + §5.3 FF-7 / FF-A1 (static) + FF-A8 (live DB) |
| AC-10 | §4.4 free-form owner-only/non-delegable + §5.3 FF-8 |
| AC-11 | §2 single subsystem (derived projections) + FF-A4 |
| AC-12 | §4.1 UUID binding (ResourceRef) + FF-A5 |
| AC-13 | §4.5 `isEffective` + §5.3 FF-9 |
| AC-14 | §4.6 `GrantAuditEvent` obligation + FF-A6 |
| AC-15 | §4.1 tenant inheritance + FF-A8 (subset check inside `withTenant`) |

---

## 11. Runtime target

Pure-TS lattice module runs **locally** in `npm run ci` (no external resource). The `grant` **table** activates in the Postgres silo stack (founder home server `/srv/choros`, deploy founder-gated GT-4) at **T-0053** — same infra as T-0013/T-0014, no *new* infra dependency introduced by T-0018. T-0018 itself provisions nothing; the static-now build needs no server.
