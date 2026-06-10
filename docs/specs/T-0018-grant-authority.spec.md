# Spec · T-0018 — `grant` Authority Table + Closed Scope Lattice

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-10
**Task:** E2.3 — `grant` authority table + closed scope lattice (provable monotonic narrowing)
**Authoritative source:** `playbooks/rbac-backlog.md#E2.3` (GT-1, founder-signed 2026-06-08) · `playbooks/rbac-discovery-phase1-hypothesis.md` §5 (object model: `grant`), §2 (closed scope lattice), §3 Q1/Q5, §6-A #2
**Foundation (do NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (every grant table is a T-0013 tenant table) · `docs/design/T-0014-registry-model.adr.md` §5 (the `ResourceRef` grant-binding surface this spec consumes)
**Siblings referenced, not built here:** T-0021 (E2.5 `grant_resolver`/PDP — *consumes* this table), T-0016 (E2.8 audit floor — grant issuance/revocation are rows in *its* ledger), T-0022 (E3.2 `assignment` — carries org/admin scope, distinct from resource scope here)

---

## 0. Note on scope of this task (DESIGN-only family)

Choros today is an in-memory TS/Node app — there is **no Postgres, no migrations, no
docker-compose**. Like its merged sibling T-0013, this task fixes the **invariants, object
model, contracts, and fitness functions** that any correct `grant`-authority implementation
MUST satisfy. The SQL DDL / migrations / RLS policy bodies and the runtime PDP wiring land in
**T-0053** (Postgres-in-compose) and **T-0021** (the resolver), **not here**. This spec orders
no one to write migration or resolver code today; it pins the authority table's shape, the
scope-lattice algebra, and the write-time subset invariant that makes monotonic narrowing
*provable*. Each acceptance criterion carries a `verifiable_as` and a gating note (static-now vs
activates-in-T-0053), mirroring T-0013.

---

## 1. Summary

`grant` is **the single authority object** in Choros: the atom of permission is a
**resource-operation grant**, not an MCP-tool and not a form-field (hypothesis §1, thesis).
Three things that look different — a human approving POs in their department, an agent-buyer's
`request-quote` tool being enabled, field X being visible to role Y — are **rows in this one
table**. Tools and form-fields are **derived, gateway-enforced projections** of `grant`
(capability-not-text: outside the held ops the tool/field is *physically absent + audited*).

A grant binds a **principal** (a `role`, never a person directly — agents and humans both reach
grants only through role assignments, T-0022) to a **capability** (`resource_type × operation`,
optionally narrowed by a `resource_facet`) over a **scope** drawn from a **closed scope
lattice**, with optional `constraint` and a validity window. The floor of all authority is
`resource × operation × scope`; everything richer (toolsets, masked fields, record-level rights)
is *derived* from these rows by the resolver (T-0021), with **no second permission subsystem**
(hypothesis §3 Q5: record-rights = `operation × scope` in one tuple).

The load-bearing invariant is the **closed scope lattice**. Delegable scopes are drawn from a
**closed algebra** — hierarchy-nodes (subtree containment), tag-sets (set inclusion), and numeric
intervals (canonical interval containment) — composed into scope-sets for cross-cutting roles.
Because every lattice element has a **decidable, structural partial order (`⊑`)**, "child grant's
scope ⊑ parent grant's scope" is checkable **at write-time**. This makes **monotonic narrowing
provable**: a delegated or derived grant can only *narrow*, never *widen*, the granter's
authority — self-elevation is structurally impossible, not merely audited after the fact.
Free-form predicate scopes, if ever needed, are **owner-only and non-delegable** (they sit
outside the lattice and the subset check refuses to admit them into any delegation chain).

This spec pins: the `grant` table fields and types; the closed scope-lattice elements, their
partial order, their meet (greatest lower bound); the closure property; the write-time subset
check (the monotonic-narrowing gate); how grants compose for resolution (the *contract* the
T-0021 resolver consumes, not the resolver itself); and the audit obligation (grant create/revoke
are first-class rows in the T-0016 ledger). Every entity is a T-0013 tenant-owned table.

---

## 2. Functional Requirements

### FR-1 — `grant` is the single authority table

- There is exactly **one** authority table, `grant`. No second table encodes "who may do what
  to which records." Record-level rights, field visibility, and agent toolsets are all *derived*
  from `grant` rows by the resolver (T-0021) — not stored in a parallel subsystem (hypothesis §3
  Q5; §6-A #2).
- The permission floor is `resource_type × operation × scope`. A grant MAY additionally carry a
  `resource_facet` (which slice/fields of the resource) and a `constraint` (further conditions),
  but these only *narrow*; they never grant authority absent the floor tuple.
- `grant` is a **T-0013 tenant-owned table**: `tenant_id uuid NOT NULL` is the leading PK column,
  FORCE RLS + default-DENY apply, all uniqueness is tenant-scoped, all access via `withTenant`.

### FR-2 — `grant` row shape

A `grant` row binds a role to a capability over a scope. Fields (Postgres types authoritative;
final DDL is T-0053):

| Field | Type | Constraints / meaning |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; RLS key (T-0013 §3.1) |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `role_id` | `uuid NOT NULL` | FK → `role(tenant_id, id)` (role table is T-0022/E3.2); the **principal** — grants attach to roles, never directly to a person |
| `resource_type` | `text NOT NULL` | the resource namespace target kind: one of the `ResourceRef.kind` values from T-0014 §5 (`application` \| `registry` \| `record`), plus `mgmt_object:*` and `effect_resource` kinds reserved for later epics. The resource *identity* is carried in `scope` (a hierarchy-node element), not duplicated here. |
| `resource_facet` | `jsonb NULL` | optional declaration of *which slice* of the resource the grant reaches (e.g. a set of record-schema field paths / typed facets). Absent ⇒ whole-resource (subject to masking, T-0033). A facet only ever *narrows*. |
| `operation` | `text NOT NULL` | the verb: `read` \| `create` \| `update` \| `delete` \| `approve` \| `transition` \| `invoke` (the guarded classes `approve`/`transition`/`invoke` are recognized here as operation values; their *guard semantics* are E4.2/E5.4, not this spec) |
| `scope` | `jsonb NOT NULL` | a **closed scope-lattice element** (FR-3): a single hierarchy-node, tag-set, or numeric-interval, or a **scope-set** (a set of such elements) for cross-cutting roles. This is the *only* place record/subtree reach is expressed. |
| `constraint` | `jsonb NULL` | optional additional condition (e.g. a state predicate). For delegable grants it must itself be lattice-expressible (FR-4); free-form predicates are owner-only/non-delegable (FR-6). |
| `delegable` | `boolean NOT NULL DEFAULT true` | whether this grant may be the *parent* of a narrower delegated grant. Owner-only free-form-scope grants are `delegable = false` (FR-6). |
| `granted_by` | `text NOT NULL` | subject identity that minted the grant (audit linkage, FR-7) |
| `valid_from` | `bigint NULL` | unix epoch ms; null ⇒ effective immediately |
| `valid_until` | `bigint NULL` | unix epoch ms; null ⇒ no expiry. A grant outside its validity window confers **zero** capability on the read-path (TTL = removed capability, consistent with hypothesis §3 Q6). |
| `created_at` | `bigint NOT NULL` | unix epoch ms |

- TS mirror: `{ tenantId, id, roleId, resourceType, resourceFacet?, operation, scope, constraint?, delegable, grantedBy, validFrom?, validUntil?, createdAt }`.
- The `scope` of a grant binds to the T-0014 resource namespace via a hierarchy-node lattice
  element whose node identifier is an immutable UUID drawn from a `ResourceRef` (T-0014 §5):
  application_id, registry_id, or record_id. Grants bind to **UUIDs, never slugs** (rename-safe,
  T-0014 NF-3).

### FR-3 — Closed scope lattice (elements + partial order + meet)

The scope domain is a **closed lattice** `(S, ⊑, ⊓)`. Only the following element kinds are
admissible in a **delegable** grant's `scope`; this closure is what makes the subset check
decidable and total.

**Element kinds (the closed set):**

1. **Hierarchy-node** — a node in a containment hierarchy (the T-0014 `application ⊃ registry ⊃
   record` namespace, or the org `department ⊃ position` tree for `mgmt_object` scopes). Shape:
   `{ kind: "node", hierarchy: <"resource"|"org">, node_id: <uuid>, node_level: <"application"|"registry"|"record"|"department"|"position"> }`. A node denotes itself **and its entire
   subtree** (an application-node covers all its registries and records; a department-node covers
   all sub-departments and positions).
2. **Tag-set** — a finite set of tags; reach is **set inclusion**. Shape:
   `{ kind: "tags", tags: <string[]> }`. (Used for cross-cutting attributes, e.g. classification
   labels.)
3. **Numeric-interval** — a closed interval in **canonical form** (normalized `[lo, hi]`, lo ≤ hi,
   over a named numeric axis). Shape: `{ kind: "interval", axis: <string>, lo: <number>, hi:
   <number> }`. (Used for value-bounded authority, e.g. "approve up to 50 000".)
4. **Scope-set** — a **finite set** of the above elements, denoting the **union** of their reach.
   Shape: `{ kind: "set", members: <Element[]> }`. This is how a cross-cutting role (e.g. "finance
   across many departments") is expressed without a single subtree (hypothesis §2: cross-cutting
   roles use scope-sets, not a single subtree).

**Partial order `⊑` ("is-a-subset-of", structural and decidable):**

- **Node ⊑ Node:** `a ⊑ b` iff `a.hierarchy = b.hierarchy` and `a.node_id` is `b.node_id` **or a
  descendant of `b.node_id`** in that hierarchy (subtree containment). Same node ⇒ `⊑` (reflexive).
- **Tags ⊑ Tags:** `a ⊑ b` iff `a.tags ⊆ b.tags` (set inclusion).
- **Interval ⊑ Interval:** `a ⊑ b` iff `a.axis = b.axis` and `b.lo ≤ a.lo` and `a.hi ≤ b.hi`
  (canonical interval containment).
- **Element ⊑ Set:** an element `e ⊑ S` (S a scope-set) iff **there exists** a member `m ∈ S` with
  `e ⊑ m` (the element fits entirely inside one member's reach).
- **Set ⊑ Set:** `A ⊑ B` iff **every** member `a ∈ A` satisfies `a ⊑ B` (each piece of the child's
  reach is contained in the parent's reach).
- **Cross-kind:** elements of different kinds are **incomparable** unless one side is a scope-set
  that contains a same-kind member; there is no implicit coercion between hierarchy/tags/interval.

**Meet `⊓` (greatest lower bound — the *intersection* of two scopes):**

- **Node ⊓ Node** (same hierarchy): if one is an ancestor of the other ⇒ the **descendant** (the
  smaller subtree); else (disjoint subtrees) ⇒ **⊥** (the empty scope, denoting no reach).
- **Tags ⊓ Tags:** set **intersection** of the tag sets.
- **Interval ⊓ Interval** (same axis): `[max(lo_a, lo_b), min(hi_a, hi_b)]`, or **⊥** if it inverts
  (empty intersection).
- **Set ⊓ X:** the set of pairwise meets `{ m ⊓ X : m ∈ members }` with `⊥` members dropped.
- Distinct-kind, non-set meet ⇒ **⊥**.

The lattice has a bottom **⊥** (empty scope — confers nothing). A top element is **not required**
for delegable grants (an unbounded "all" scope, if it exists at all, is an owner-only construct,
FR-6); the closure properties below are stated over the delegable sublattice that excludes any
implicit top.

### FR-4 — Closure property (what makes narrowing *provable*)

The delegable scope domain is **closed under `⊓`**: for any two admissible elements `x, y`, `x ⊓ y`
is itself an admissible element (a node, tag-set, interval, scope-set, or `⊥`) — never an
arbitrary predicate. Consequently:

- `⊑` is **decidable and total** over admissible scopes — a pure structural comparison with no
  runtime evaluation, no query against live data, and no LLM. (This is the property an unbounded
  free-text `expr` could not give, hypothesis §2 / §6-A #2 — "was: arbitrary `expr`, unsound".)
- For any parent scope `P` and proposed child scope `C`, exactly one of holds and is computable at
  write-time: `C ⊑ P` (the child is a structural subset — admissible) or `C ⋢ P` (the child widens
  in at least one dimension — rejected).
- A delegation chain `G0 ⊒ G1 ⊒ G2 ⊒ …` is therefore **monotonically narrowing by construction**:
  each link is a verified `⊑` step. No element in the chain can confer reach outside `G0`.

### FR-5 — Write-time subset check (the monotonic-narrowing gate)

- When a grant is **minted by delegation** (a non-owner principal creating/deriving a grant from
  one they hold), the write MUST be **rejected at write-time** unless the new grant is a
  **structural subset of the granter's own authority** on the same `resource_type × operation`:
  `child.scope ⊑ parent.scope` **and** the child's `resource_facet`/`constraint` do not widen the
  parent's (FR-3, FR-4). This check is **structural** (computed from the lattice elements), not a
  policy evaluation over data, and not a post-hoc audit (hypothesis §2: "subset is structural,
  checked at write-time").
- A grant write whose `scope` (or facet/constraint) is **not** a structural subset of the
  granter's scope MUST be **rejected** (the E2.3 acceptance line: "A grant write that is not a
  structural subset of the granter's scope is rejected at write-time").
- The check composes across the granter's **scope-set**: a child element is admitted iff it is
  `⊑` the *union* reach of the granter's scope (i.e. `child ⊑ parent-set`, FR-3 Set rules).
- The genesis `tenant-owner` (single per tenant, hypothesis §5) is the **root of the delegation
  lattice**: owner-minted grants are not subset-checked against a parent (there is none above the
  owner), but every grant the owner delegates *downward* is, from then on, the parent of a
  subset-checked chain.

### FR-6 — Free-form predicates are owner-only and non-delegable

- If a grant ever needs a scope that is **not** expressible in the closed lattice (a free-form
  predicate / arbitrary `expr`), that grant MUST be: (a) mintable **only** by the genesis
  `tenant-owner`, and (b) marked `delegable = false` — it can **never** be the parent of a
  delegated grant, because the subset check cannot prove containment of an arbitrary predicate
  (hypothesis §2: "Free-form predicates, if ever, are owner-only and non-delegable").
- The write path MUST reject any **non-owner** attempt to mint a free-form-scope grant, and MUST
  reject any delegation whose **parent** grant is a free-form-scope grant.

### FR-7 — Grant issuance/revocation are first-class audit rows

- Every grant **create** and **revoke** MUST emit a first-class event into the **per-tenant audit
  floor** (E2.8 / T-0016) — not a separate log (hypothesis §3 Q9; §6-A #8; backlog E3.6). The
  event records at minimum: actor (`granted_by` / revoker), subject (`role_id`), the capability
  (`resource_type × operation × resource_facet`), the `scope`, and — where the grant arose via the
  LLM-proposes/human-confirms path (E3.5) — `proposed_by` and `confirmed_by`.
- This spec **does not build** the audit floor (that is T-0016); it fixes the **obligation** that
  the grant write/revoke path produces these events, and the **minimum fields** they carry, so the
  grant trail (E3.6) is queryable from the unified audit.

### FR-8 — Revocation removes capability, not just UI

- Revoking a grant (delete, or `valid_until` reached) MUST remove the conferred capability on the
  **read-path** — the resolver (T-0021) sees the grant gone and the derived tool/field is
  physically absent, not merely hidden in the UI (capability-not-text; backlog E3.3 acceptance
  "removing the role removes the capability, not just hides UI"). This spec fixes the *invariant*;
  the read-path enforcement is T-0021.

---

## 3. Non-Functional Requirements

### NF-1 — Single authority, single subsystem

Record-rights, field visibility, and agent toolsets derive from the **one** `grant` table; no
second permission subsystem exists (hypothesis §3 Q5). Any design that introduces a parallel
record-ACL table or a separate field-visibility store violates this invariant.

### NF-2 — Capability-not-text (structural, gateway-verifiable)

Authority is a **structural** fact (a `grant` row with lattice scope), never a free-text role
label or a UI toggle. The resolver and gateway (T-0021) verify capability against rows; outside
the held grants, the tool/field is physically absent + audited (red-lines capability-not-text;
hypothesis §1).

### NF-3 — Provable monotonic narrowing (no self-elevation)

Monotonic narrowing is a **provable** property of the closed lattice + write-time subset check
(FR-3..FR-5), not a runtime hope. A delegated grant can never widen the granter's authority; a
fitness function can decide `child ⊑ parent` structurally (FF-3). This is the core correctness
guarantee of E2.3.

### NF-4 — Tenant isolation inherited (T-0013, non-negotiable)

`grant` is a T-0013 tenant table: `tenant_id NOT NULL` leading PK, FORCE RLS + default-DENY, scoped
uniqueness, access via `withTenant`. A grant for tenant A is invisible and unusable in tenant B's
context. The subset check operates only within a single tenant's grants.

### NF-5 — Canonical scope form (decidable comparison)

Every lattice element MUST be stored in **canonical form** (normalized interval `[lo ≤ hi]`,
de-duplicated/normalized tag-sets, flattened scope-sets with no nested sets and no `⊑`-redundant
members) so that `⊑` and `⊓` are deterministic and a CI fitness function can compare two scopes
without ambiguity (NF for FF-3/FF-4).

### NF-6 — Resolver-agnostic contract

This spec fixes the **table + lattice algebra + write-time gate** that the resolver (T-0021)
*consumes*; it does **not** fix resolution order, caching, masking, or PDP wiring. The grant model
must be complete and unambiguous enough for T-0021 to resolve against without re-opening E2.3
(parallels how T-0014 §5 handed this task a closed `ResourceRef` surface).

---

## 4. Out of Scope (deferred — MUST NOT be built in T-0018)

The following are explicitly **NOT** part of T-0018:

1. **SQL DDL / migrations / RLS policy bodies for `grant`** — T-0053 (Postgres-in-compose). This
   spec defines the table's invariants and lattice algebra; the `CREATE TABLE`, indexes, and RLS
   policy land in T-0053 alongside T-0013/T-0014's.
2. **The PDP / `grant_resolver` runtime (resolution, masking, action-time binding, caching)** —
   **T-0021 (E2.5)**. T-0018 fixes the *table and lattice the resolver reads*; it does not build
   the resolver, the gateway chokepoint, or value-aware masking (T-0033/E4.3).
3. **The audit floor itself** (`audit_event` table, hash-chain, monotonic `tenant_seq`, append-only
   DB enforcement, snapshots) — **T-0016 (E2.8)**. T-0018 fixes only the *obligation* and *minimum
   fields* of grant create/revoke events (FR-7); the ledger is built by T-0016 and the grant-trail
   query is E3.6/T-0031.
4. **The `role` and `assignment` tables / org & admin scope** — **T-0022 (E3.2)** and **T-0017
   (E3.1)**. Admin/org scope lives on the `assignment` (a node or set of nodes in the org tree),
   distinct from the **resource** scope on the `grant` defined here (hypothesis §2: two scopes). The
   subset check here is over resource scope; admin-scope narrowing is E3.3/T-0029.
5. **The structural grant editor UI and the LLM-proposes/human-confirms path** — **T-0030 (E3.4)**
   and **T-0039 (E3.5)**. T-0018 records the `proposed_by`/`confirmed_by` audit obligation (FR-7)
   but builds no authoring UI or LLM proposer.
6. **Toolset resolution / `mcp_tool` registry / effect-resource verification** — **T-0043 (E5.3)**,
   **T-0034 (E4.4)**. Agent toolset = a query over grants, but that query is downstream; here we
   reserve the `mgmt_object:*` / `effect_resource` resource-type values, not their semantics.
7. **`role_criticality` / dual-control** — **T-0040 (E4.5)** / **T-0044 (E4.6)**. Criticality is
   *computed from* grants; T-0018 supplies the grant rows it reads, not the computation.
8. **Substitutions / TTL'd delegation mechanics** — **T-0035 (E4.7)**. T-0018 fixes that a grant
   outside its validity window confers zero capability (FR-2 `valid_until`), but the routing-layer
   stand-in and TTL'd-delegation flows are E4.7.
9. **BPMN linter / engine state-mutation guard / opaque handles** — **T-0027/T-0028/T-0015**.

---

## 5. Acceptance Criteria

Each criterion is a CI-checkable test or fitness function. `gating` mirrors T-0013: **static-now**
= a TS/lint/unit check runnable in today's `npm run ci`; **live-T-0053** = a live-DB probe authored
now, activated when Postgres exists. The scope-lattice algebra (AC-3..AC-9) is **pure TS** and is
therefore fully **static-now** — it is the heart of E2.3 and does not wait for Postgres.

| ID | Text | Verifiable as | Gating |
|---|---|---|---|
| **AC-1** | `grant` is a registered T-0013 tenant table: it appears in the `known_tenant_tables` CI fixture; live, `relrowsecurity AND relforcerowsecurity` is `(true,true)` for `grant`; with no `SET LOCAL choros.tenant_id`, `SELECT count(*) FROM grant` as `choros_app` returns 0 (default-DENY). | test | static-now (fixture) + live-T-0053 |
| **AC-2** | A `grant` row carries the FR-2 floor (`role_id`, `resource_type`, `operation`, `scope`) all NOT NULL; inserting a grant with NULL `tenant_id`/`role_id`/`resource_type`/`operation`/`scope` raises a constraint violation; the TS `Grant` type mirrors the FR-2 columns exactly (compile-checked). | test | static-now (type) + live-T-0053 (constraints) |
| **AC-3** | The `⊑` relation is **decidable and total** over admissible scopes: for a fixture matrix of node/tag/interval/set pairs, `subsetEq(a,b)` returns a boolean (never throws, never "unknown") and matches the FR-3 truth table (subtree containment, set inclusion, interval containment, set rules, cross-kind incomparable). | fitness | static-now |
| **AC-4** | **Hierarchy-node subset:** a child node that is a descendant of the parent node ⇒ `subsetEq(child,parent)=true`; a node in a disjoint subtree, or an ancestor (wider) ⇒ `false`. | test | static-now |
| **AC-5** | **Tag-set & interval subset:** `{a,b} ⊑ {a,b,c}` true, `{a,d} ⊑ {a,b,c}` false; `[10,40] ⊑ [0,50]` true, `[10,60] ⊑ [0,50]` false (widens hi); mismatched `axis` ⇒ incomparable/false. | test | static-now |
| **AC-6** | **Scope-set subset:** an element is `⊑` a set iff it fits inside one member; `A ⊑ B` iff every member of A is `⊑ B`; a member of A outside every member of B ⇒ `false`. | test | static-now |
| **AC-7** | **Meet (`⊓`) closure:** for the fixture matrix, `meet(x,y)` returns an admissible element (node/tags/interval/set/⊥) — never an arbitrary predicate; node⊓node of disjoint subtrees = ⊥; interval⊓interval = the overlap or ⊥; tags⊓tags = intersection. | fitness | static-now |
| **AC-8** | **Canonical form:** any scope element accepted by the write path is in canonical form (interval `lo≤hi`; tag-set de-duplicated; scope-set flattened, no nested sets, no `⊑`-redundant members); a non-canonical input is normalized-then-stored or rejected, and `subsetEq`/`meet` are deterministic regardless of input member order. | fitness | static-now |
| **AC-9** | **Write-time subset gate (monotonic narrowing):** a delegated grant write with `child.scope ⊑ granter.scope` (and non-widening facet/constraint) is **accepted**; a delegated grant write whose scope (or facet/constraint) is **not** a structural subset of the granter's scope is **rejected at write-time** with a distinct error — before any persistence. Covers: node widening (child is ancestor/sibling-subtree of parent), tag superset, interval widening, and a scope-set member escaping the parent set. | test | static-now (algorithm on in-memory grant store) + live-T-0053 (DB write path) |
| **AC-10** | **Owner-only free-form, non-delegable:** a non-owner attempt to mint a free-form-predicate-scope grant is rejected; a free-form-scope grant is forced `delegable=false`; any delegation whose **parent** grant is free-form-scope is rejected at write-time. | test | static-now (+ live-T-0053) |
| **AC-11** | **Single subsystem (no parallel record-ACL):** a static lint asserts no second authority/record-ACL table or field-visibility store exists in the model fixture — record-rights are expressed only as `grant.operation × grant.scope` (FR-1, NF-1). | fitness | static-now |
| **AC-12** | **Grant binds to UUIDs, not slugs:** every hierarchy-node `node_id` in a `grant.scope` is a UUID drawn from a T-0014 `ResourceRef` (application/registry/record id) or an org-tree UUID; a static check asserts no `grant.scope` references a slug/display-name. Renaming the referenced resource's slug does not change the grant's reach. | fitness | static-now (+ live-T-0053 rename test) |
| **AC-13** | **Validity window = capability:** a grant with `valid_until` in the past (or `valid_from` in the future) confers **zero** capability — the resolver-contract fixture treats it as absent; an in-window grant confers its capability. (Read-path enforcement is T-0021; here the *contract* is asserted on the grant-evaluation helper.) | test | static-now |
| **AC-14** | **Audit obligation on issuance/revocation:** the grant create and revoke code paths emit an audit event carrying actor, subject (`role_id`), capability (`resource_type × operation × facet`), `scope`, and (when present) `proposed_by`/`confirmed_by`; a static lint asserts every grant create/revoke call site is accompanied by an audit-emit call (the emit *target* is T-0016's ledger; here only the call obligation + field set is checked). | fitness | static-now (+ live-T-0053 once ledger exists) |
| **AC-15** | **Tenant isolation of grants:** with `SET LOCAL choros.tenant_id = A`, `SELECT count(*) FROM grant WHERE tenant_id = B` returns 0; the subset check never reads grants outside the current tenant context (a tenant-B grant can never be the parent of a tenant-A delegation). | test | live-T-0053 (+ static-now lint that the subset check runs inside `withTenant`) |

---

## 6. Open Items (non-blocking)

Tracked for the architect/implementer; none requires founder decision before DESIGN.

- **Numeric-axis registry.** Interval scopes reference a named `axis` (e.g. an amount-limit axis).
  The set of recognized axes and their units is an implementation convention to be fixed in DESIGN
  (T-0018 ADR) / the criticality work (E4.5); it does not change the lattice algebra.
- **`resource_facet` schema.** FR-2 leaves `resource_facet` as `jsonb` declaring field-path slices;
  its exact shape interlocks with typed facets + data-classification (E4.3/T-0033). T-0018 fixes
  only that a facet *narrows* and is part of the subset check (FR-5); the facet grammar is refined
  where masking is designed.
- **`constraint` grammar for delegable grants.** FR-4 requires a delegable `constraint` to be
  lattice-expressible; the precise admissible-constraint grammar (beyond scope) may be tightened in
  DESIGN. The conservative default is: a delegable grant carries no `constraint` beyond what the
  lattice expresses; richer constraints make the grant owner-only/non-delegable (FR-6).
- **Genesis owner identity.** The single `tenant-owner` per tenant (the lattice root) is provisioned
  by tenant-init (T-0013/E3.1 territory); T-0018 only relies on its existence as the un-parented
  root of the delegation lattice.

No blocking questions remain. The closed lattice, the write-time subset invariant, the single-table
authority model, and the audit obligation are all direct, mechanical encodings of the GT-1-signed
hypothesis (§2, §3 Q1/Q5, §5, §6-A #2) and the backlog E2.3 acceptance line — no new product
decision is introduced. **Status: ready.**
