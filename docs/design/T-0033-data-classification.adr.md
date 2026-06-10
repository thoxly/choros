# ADR · T-0033 — Data-classification + value-aware masking + typed facets + from→to guards

**Status:** ready (no escalation) — **rev-2** (R-1 fail-closed version boundary; see §10)
**Phase:** DESIGN
**Date:** 2026-06-10 (rev-1) · 2026-06-10 (rev-2, R-1)

> **rev-2 (R-1, blocking).** Review found a fail-closed hole at the version/missing-row
> boundary: `maskFields` returned **raw** for a classified field whose facet-schema-version
> had no rows (AC-4/AC-12/NF-3 require maximal masking — "the field does not leak raw").
> Root cause: the model had no signal of "is this resource under classification governance?"
> independent of per-version row-presence, so "ungoverned (raw legal)" was indistinguishable
> from "governed but version-missing (must fail-closed)". **§10 is the binding amendment**; it
> adds a resource-level `governed` signal to the `ClassificationSource` lookup (computed in
> ONE port read, no second query) and re-specifies `maskFields` + FF-DC4/FF-DC12 so the
> version mechanism is isolated (the test fails on raw-fall-through with NON-null clearance,
> not via the null-clearance lever). Additive-only; all rev-1 green invariants preserved.
**Task:** E4.3 — raise the gateway facet from all-or-nothing field-presence to a (class × grant) value-aware projection, backed by a per-tenant `data_classification` table, typed schema-versioned facets, and a guarded `from→to` reclassification transition.
**Spec consumed:** `docs/specs/T-0033-data-classification.spec.md` (AC-1..AC-16, FR-1..FR-10, NF-1..NF-5).
**Authority:** GT-1-signed `rbac-discovery-phase1-hypothesis.md` (§3 Q10, §5, §6-A #6). No new product decision; mechanical decomposition of the signed map.

**Foundation (do NOT contradict — read as code, not prose):**
- `src/core/grant-resolver.ts` (T-0021) — the single projection chokepoint: `resolveFor(deps, handle, subject, op)`, `visibleFields(coveringGrants, handleFacet, raw)`, `projectFields(raw, visibleSet)`, `grantFacetFields(grant)`, `makeGrantResolver(deps)` (the `HandleResolver` swap), injected ports `GrantSource`/`RecordSource`, `ResolverDeps`.
- `src/core/grant-lattice.ts` (T-0018, **frozen**) — `Grant` (`resourceFacet?: unknown`, `operation`, `scope`), `Operation` (incl. `approve`/`transition`), `ScopeElement`, `isNarrowerOrEqual`, `isEffective`, `AncestryOracle`, `ResourceType`. No second authority subsystem may accrete.
- `src/core/object-handle.ts` (T-0015, **frozen**) — `Facet = {fields: string[]}`, `ObjectHandle`, `ResolveSubject`, `ResolvedView`, `HandleResolver`, `denyAllResolver`, `ResourceRef`.
- `migrations/008_grant.sql` / `004_registry_def.sql` — the tenant-table contract: `tenant_id` leading PK, `ENABLE`+`FORCE` RLS, `<table>_tenant_isolation` policy on `current_setting('choros.tenant_id', true)::uuid`, `GRANT … TO choros_app`, listed in `ci/checks/known_tenant_tables.txt`.
- `ci/checks/grant-resolver-isolation.sh` / `single-resolver.sh` / `mutation-gateway-isolation.sh` / `db/{tenant_id_leading,force_rls}.sql` / `db/schema.test.ts` — the fitness floor this ADR extends.

**RUN SEAM (frozen by orchestrator — OVERRIDES the spec's "next migration = 013"):** migration numbers 011/012 are taken by T-0116 (on dev) and 013–016 by T-0017 (org structure, merging to dev before T-0033). **T-0033 uses migration number `017`.** `known_tenant_tables.txt` is appended additively; the orchestrator does the merge-union.

**Siblings — declared as seams, NOT built here:** S-1 T-0041 (E4.8 `egress_policy`, joins on `class`); S-2 T-0034 (E4.4 external-effect resources, shares this gateway module); S-3 T-0040 (E4.5 `role_criticality`, consumes `data_classification`); S-4 T-0053 (Postgres `ClassificationSource` DAO + RLS + AC-15 DB-permission floor).

---

## 1. Context

The T-0021 gateway is the one function that turns an `ObjectHandle` into grant-filtered record fields, identically for a human form and an agent payload. Its facet today is **all-or-nothing**: `grantFacetFields` reads a grant's opaque `resourceFacet` as `{fields: string[]}`, `visibleFields` unions the named fields across covering grants (or all keys for a strictly-absent facet), and `projectFields` copies exactly those keys — a masked field is **physically absent** (capability-not-text). Absent/malformed facets fail closed to zero.

The signed §6-A #6 model raises this floor along three axes **without** opening a second resolution edge:

1. A field is no longer either fully present or fully gone. It carries a **classification** (`class`), and the pair **(class × reader's grant)** selects a **value transform** — raw pass-through, partial reveal, redaction, hash, or whole-drop. A lesser-granted reader of a classified field may see a *masked value* in place of the raw one.
2. A facet stops being an opaque `unknown` token and becomes a **typed, schema-versioned descriptor**: it carries the `facet_schema_version` it was minted against, and the gateway resolves classification rows for *that* version. A version with no rows fails closed.
3. The classification of a field is **mutable**, but only through a **guarded `from→to` transition** routed through `resolveFor(.., op∈{transition,approve})` — never a raw write — and the guard distinguishes **direction** (down-classification, which *widens* visibility, is the more privileged case).

Three invariants are **non-negotiable design constraints** (not design choices), inherited from T-0021 and the red-lines:
- **Single projection** — human-form output and agent-payload output are byte-identical because they flow through *one* projection function. No second `handle→fields` export may exist (`single-resolver.sh`).
- **Rights-derived-only** — every visibility/masking decision derives solely from T-0018 grant rows + `data_classification`. No parallel field-ACL/field-visibility store (`grant-resolver-isolation.sh` Check 2 + a new sibling check).
- **Pure / static-now / fail-closed** — the masking core imports no `pg`/`fs`/`net`/`http`; classification is read through an injected port (Postgres DAO deferred to T-0053); doubt resolves to *more* masking, never less.

---

## 2. Decision

**Value-aware masking is folded into the existing single projection by (a) a new pure, additive module `src/core/data-classification.ts` that owns the `class` enum, the closed transform vocabulary, the `ClassificationSource` injected port, the typed `TypedFacet` descriptor, the masking decision function `maskFields(...)`, and the `from→to` reclassification guard `evaluateReclassification(...)`; and (b) a surgical, additive extension of `src/core/grant-resolver.ts` that threads `ClassificationSource` through `ResolverDeps` and replaces the final `projectFields(raw, vis)` step with `maskFields(raw, vis, classCtx, grantClassAccess)` — still ONE projection call inside the ONE `resolveFor` core, with no new `handle→fields` export.**

Concretely:

1. **`class` is a stable, named, enumerable type** — a closed string-literal union `DataClass` (e.g. `"public" | "internal" | "confidential" | "restricted"`) exported from `data-classification.ts`. This is the **shared axis** S-1/S-3 join on (AC-14). `data_classification` does **not** carry an egress column (that is T-0041's table, keyed on `class`).

2. **`data_classification` table (migration `017`)** — per-tenant row `(tenant_id, resource_type, facet_field, facet_schema_version, class)`. Same tenant-table contract as `008_grant.sql`. PK is `(tenant_id, resource_type, facet_field, facet_schema_version)` — one class per field per schema version per tenant. **No cross-table FK** to `registry_def` (the `resource_type`/field is a logical descriptor, not a row reference; an FK to record-schema field names is not expressible — see §6 and the T-0017 lesson: an impossible FK in an ADR is a BUILD bounce). RLS `ENABLE`+`FORCE`, isolation policy, `choros_app` DML grant, listed in `known_tenant_tables.txt`.

3. **`ClassificationSource` injected port** — mirrors `GrantSource`/`RecordSource`: a pure, static-now lookup `getClassifications(resourceType, facetSchemaVersion)` (in-memory now; the RLS-scoped Postgres DAO lands in T-0053). **(rev-2, R-1: the return type is `ClassificationLookup = {governed, rows}`, NOT a bare `ClassificationRow[]` — see §10.2; `governed` carries the resource-level "is this under classification governance" signal that the version-boundary fail-closed decision needs.)** The resolver calls it **after** a covering grant is found (it never reads classification for a record it has no grant for). Threaded onto `ResolverDeps` as an **optional** field — when absent, the gateway degrades to the pre-T-0033 all-or-nothing behaviour (backward-compatible) BUT a *present, classified* facet with a *missing source* is treated as fail-closed maximal masking, never widened.

4. **Value transform vocabulary (closed set)** — `Transform = "reveal" | "partial" | "redact" | "hash" | "drop"`. A pure `applyTransform(value, transform): unknown`:
   - `reveal` → the raw value (pass-through).
   - `partial` → a structurally value-aware reveal of a non-sensitive remainder (e.g. last-4 of a string, `"****1234"`; non-strings degrade to `redact`). **Value-level** (AC-5): the output is deeply-different from raw and is *present* (not a dropped key).
   - `redact` → a fixed sentinel `"[redacted]"` (present key, opaque value).
   - `hash` → a deterministic, pure, non-reversible digest string (djb2-style, same family as `deriveHandleId`; **no key custody** — crypto is out of scope per spec §6-A #12). Determinism preserved (AC-13).
   - `drop` → the key is **omitted** entirely (the pre-T-0033 behaviour — capability-not-text — for the maximal-mask case).

5. **(class × grant) → transform selection** — the transform is chosen by `selectTransform(class, grantClassAccess): Transform`, where `grantClassAccess` is the reader's **clearance** *derived from the covering grant rows*, NOT a field-name lookup (AC-6). Clearance is the maximum `DataClass` the reader's covering grants confer (see §4.3); `selectTransform` maps `(fieldClass, clearance)` through a **monotone** table: clearance ≥ class ⇒ `reveal`; one step below ⇒ `partial`; further below ⇒ `redact`/`hash`/`drop` per the class's declared floor. The same (class, clearance) pair yields the same transform regardless of field name; re-classifying a field to a different class yields a different transform (AC-6).

6. **Typed facets** — `TypedFacet = { fields: string[]; schemaVersion: number }` is an **additive widening** of T-0015's `Facet = {fields: string[]}`: every `Facet` is structurally a `TypedFacet` with `schemaVersion` omitted (treated as version `0`/unversioned). `data-classification.ts` exports `TypedFacet` and a total `readFacetVersion(facet): number` (default `0`). **object-handle.ts is NOT edited** — the typed shape lives in the new module and is accepted structurally where `handle.facet` flows in. A facet whose `schemaVersion` has no matching classification rows ⇒ fail-closed maximal masking (AC-4, AC-12), never widened to whole-resource.

7. **`from→to` reclassification guard** — changing a field's `class` is a `transition`/`approve` op routed through `resolveFor` (FR-5, AC-10). `evaluateReclassification(from, to, op, grantsForOp): ReclassDecision` is a pure validator returning `{ allowed: boolean; direction: "up" | "down" | "lateral"; reason }`:
   - **direction** = `down` iff `to` is *more visible* (lower sensitivity) than `from` — a down-classification *widens* reach and is the privileged case (AC-11). `up` = more sensitive; `lateral` = equal-rank.
   - The guard is **additive-only authority**: it derives `allowed` from the same op-grant rows (`isEffective`, scope containment) the mutation guard already polices; it owns no new lattice math. A subject permitted only up-classification fails on a `down` direction. There is **no** direct-write path to `data_classification.class` that bypasses this op-check (structural: enforced by `data-classification-isolation.sh`, analogous to `mutation-gateway-isolation.sh`).

8. **Audit obligation (shape only, MAY)** — `maskFields` and `evaluateReclassification` each may return a static-now `AuditObligation` shape `{ type, actor, subject, via: "grant_resolver" | "classification", decision }` (AC-16). Durable append deferred to T-0053, exactly as T-0021 FR-8 / its `TODO(T-0053)` in `resolveFor`. The obligation shape is *defined and producible*; it is not threaded into `ResolvedView` in static-now (no payload widening of the frozen `ResolvedView`).

### 2.1 The frozen-file tension (load-bearing compatibility decision)

`grant-resolver.ts` is listed as a **frozen export file** in BOTH `grant-resolver-isolation.sh` Check 3 and `mutation-gateway-isolation.sh` G6-additive (they assert the file is byte-unchanged vs merge-base with dev). The spec **requires** masking to be folded into that file's projection path — so `grant-resolver.ts` **must** be edited. These two checks were written for T-0021/T-0028, where the resolver was downstream-frozen; T-0033 is the task that legitimately extends it.

**Resolution (coder contract):**
- `data-classification.ts` is a **new** module — it is additive and trips no frozen check.
- `object-handle.ts` and `grant-lattice.ts` stay **byte-frozen** (the `Facet`/`Grant`/`Operation` types are reused as-is; `TypedFacet`/`DataClass` are new types in the new module). `grant-resolver-isolation.sh` Check 3 keeps those two frozen and **drops `grant-resolver.ts` from its own frozen set is NOT needed** — Check 3 already only freezes `object-handle.ts`, `grant-lattice.ts`, `types.ts` (NOT grant-resolver.ts). ✅ no change to Check 3.
- `mutation-gateway-isolation.sh` G6-additive **does** freeze `grant-resolver.ts` — the coder MUST update this check to **remove `grant-resolver.ts` from the `FROZEN_EXPORTS` array** (keeping `object-handle.ts`, `grant-lattice.ts`), and the additive masking edit must preserve every existing G1/G6 invariant (no new writable-record accessor; single chokepoint). This is the FE-W23-0008 compatibility-contract rule made explicit: the import surface `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields` is **preserved** (only `ResolverDeps` gains an optional field and `projectFields` an optional 4th arg — see §3.1); the only breaking edit is to the *fitness check that froze the file*, which T-0033 is authorized to thaw.
- **Signature stability:** `ResolverDeps.classifications?` is optional and `projectFields`'s new `classCtx?` is optional ⇒ the existing `grant-resolver.test.ts` and the `HandleResolver` swap compile unchanged.

---

## 3. Object model & contracts

### 3.1 TypeScript (additive — all in `src/core/data-classification.ts` unless noted)

```ts
// The shared, stable, enumerable class axis (AC-14). Ordered most→least visible
// for the monotone transform table. S-1 (egress_policy) / S-3 (role_criticality)
// join on this exact symbol — they import DataClass, they do NOT redeclare it.
export type DataClass = "public" | "internal" | "confidential" | "restricted";
export const DATA_CLASS_ORDER: readonly DataClass[]; // ["public","internal","confidential","restricted"]

// Closed value-transform vocabulary. `drop` == capability-not-text (key omitted).
export type Transform = "reveal" | "partial" | "redact" | "hash" | "drop";

// One classification row (mirror of the data_classification table row).
export interface ClassificationRow {
  resourceType: string;        // T-0018 ResourceType (string-compatible)
  facetField: string;          // the record-schema field name
  facetSchemaVersion: number;  // the schema version this row classifies
  class: DataClass;
}

// rev-2 (R-1): the port returns a governance-bearing envelope, NOT a bare array,
// so the fail-closed version-boundary decision is computable from ONE port read
// (no second query). `governed` == R has >=1 classification row under ANY version.
// See §10.2/§10.4.
export interface ClassificationLookup {
  governed: boolean;          // R under classification governance (any version)
  rows: ClassificationRow[];  // rows for exactly (resourceType, facetSchemaVersion)
}
// Injected port — pure static-now; Postgres RLS DAO in T-0053. Mirrors GrantSource.
export interface ClassificationSource {
  getClassifications(resourceType: string, facetSchemaVersion: number): ClassificationLookup; // rev-2
}

// Typed, schema-versioned facet descriptor (additive widening of T-0015 Facet).
export interface TypedFacet { fields: string[]; schemaVersion: number; }
export function readFacetVersion(facet: { fields: string[]; schemaVersion?: number } | undefined): number; // default 0

// Reader clearance derived from covering grant rows (NOT a field-name lookup, NOT a new store).
// The max DataClass the subject's covering grants confer for this resource (§4.3).
export type Clearance = DataClass | null; // null == no classified clearance (⇒ maximal mask)

// (class × clearance) → transform. Monotone: clearance>=class ⇒ reveal.
export function selectTransform(fieldClass: DataClass, clearance: Clearance): Transform;

// Pure value transform. Deterministic; no IO; no key custody.
export function applyTransform(value: unknown, transform: Transform): unknown;

// The masking fold — REPLACES projectFields' body when a ClassificationSource is present.
// `present?:false` on a Transform=="drop" means key omitted (capability-not-text).
export interface MaskContext {
  governed: boolean;              // rev-2 (R-1): R under classification governance (any version) — §10
  rows: ClassificationRow[];      // for (resourceType, facetSchemaVersion)
  clearance: Clearance;
  facetSchemaVersion: number;
}
export function maskFields(
  rawFields: Record<string, unknown>,
  visibleFieldSet: ReadonlySet<string>,
  ctx: MaskContext | undefined,   // undefined ⇒ legacy projectFields behaviour
): Record<string, unknown>;

// from→to reclassification guard (pure validator; AC-10/AC-11).
export type ReclassDirection = "up" | "down" | "lateral";
export interface ReclassDecision {
  allowed: boolean;
  direction: ReclassDirection;
  reason: "ok" | "no_op_grant" | "direction_forbidden" | "unknown_class";
}
export function classifyDirection(from: DataClass, to: DataClass): ReclassDirection; // down == widening
export function evaluateReclassification(
  from: DataClass, to: DataClass, op: Operation, coveringGrants: Grant[],
): ReclassDecision;

// Audit obligation shape (MAY emit; durable append → T-0053). Mirror of T-0016.
export interface ClassificationAuditObligation {
  type: "mask_decision" | "reclassification";
  actor: string; subject: string;
  via: "grant_resolver" | "classification";
  decision: unknown;
}
```

### 3.2 Resolver extension (`src/core/grant-resolver.ts` — additive edits ONLY)

```ts
export interface ResolverDeps {
  grants: GrantSource;
  records: RecordSource;
  ancestry: AncestryOracle;
  classifications?: ClassificationSource; // NEW, optional — absent ⇒ legacy behaviour
  now?: () => number;
}

// projectFields gains an optional 4th param; existing 2-arg calls compile unchanged.
export function projectFields(
  rawFields: Record<string, unknown>,
  visibleFieldSet: ReadonlySet<string>,
  maskCtx?: MaskContext,          // NEW, optional — delegates to maskFields when present
): Record<string, unknown>;
```

Inside `resolveFor` step 6 (the ONE projection point), after `const vis = visibleFields(...)`: if `deps.classifications` is present, build `MaskContext` (resourceType from `handle.ref.kind`/`ResourceType`, `facetSchemaVersion = readFacetVersion(handle.facet)`, `const lookup = deps.classifications.getClassifications(...)` ⇒ `governed = lookup.governed`, `rows = lookup.rows` **(rev-2, R-1 — §10.6)**, `clearance = deriveClearance(covering)`) and call `projectFields(raw, vis, ctx)`; else `projectFields(raw, vis)`. **Still one call, one function, one core** (AC-7).

### 3.3 SQL — `migrations/017_data_classification.sql` (DDL pseudocode, FK-validated)

```sql
CREATE TABLE choros.data_classification (
  tenant_id            uuid NOT NULL,
  resource_type        text NOT NULL,         -- T-0018 ResourceType (logical; NO FK)
  facet_field          text NOT NULL,         -- record-schema field name (logical; NO FK)
  facet_schema_version integer NOT NULL,      -- the registry record-schema version classified
  class                text NOT NULL,         -- DataClass; CHECK enumerates the closed set
  created_at           bigint NOT NULL,
  updated_at           bigint NOT NULL,
  PRIMARY KEY (tenant_id, resource_type, facet_field, facet_schema_version),
  CONSTRAINT data_classification_class_chk
    CHECK (class IN ('public','internal','confidential','restricted'))
);
ALTER TABLE choros.data_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.data_classification FORCE ROW LEVEL SECURITY;
CREATE POLICY data_classification_tenant_isolation ON choros.data_classification
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON choros.data_classification TO choros_app;
```

**FK-semantics dry-run (T-0017 lesson):** the PK `(tenant_id, resource_type, facet_field, facet_schema_version)` is self-contained — all four columns are on this table, so the PK is constructible. There is intentionally **no** FK: `(tenant_id, resource_type)` does not map to a single foreign row (`resource_type` is a kind, not a row id), and `facet_field` names a JSONB key inside `registry_def.record_schema` (a field name, not a row — no relational target exists). Mirrors `008_grant.sql`'s deferred-FK discipline (`role_id` carries no FK to an undesigned table). `tenant_id` leads the PK ⇒ `tenant_id_leading.sql` passes; no composite index/FK leads with a non-`tenant_id` column. ✅

---

## 4. Mechanics (the load-bearing details)

### 4.1 What "value-aware mask" concretely is
Per the spec's explicit question — the mask is **not** only key-presence. For a classified field, `maskFields` looks up its `class` in `ctx.rows` (matched on `facetField` + `facetSchemaVersion`), computes `selectTransform(class, ctx.clearance)`, and:
- `reveal` ⇒ raw value copied (pre-T-0033 behaviour for a fully-cleared reader).
- `partial` ⇒ a **present, transformed** value (e.g. `"****1234"`) — proves value-level masking (AC-5).
- `redact` ⇒ a **present** sentinel `"[redacted]"`.
- `hash` ⇒ a **present** deterministic digest.
- `drop` ⇒ key **omitted** (the maximal mask == the old all-or-nothing absence).

So masking spans presence (`drop`) *and* value (`partial`/`redact`/`hash`) — strictly richer than, and backward-compatible with, T-0021's drop-only floor.

### 4.2 Fail-closed ladder (NF-3, AC-4, AC-12) — **AMENDED by §10 (rev-2, R-1)**
> **rev-2 (R-1):** the *version-boundary* sub-rule below was under-specified — `maskFields`
> could not tell "genuinely-unclassified field (raw correct)" from "classified field whose
> rows are missing for this version (must fail-closed)", so the second bullet did not hold in
> code (raw fall-through). The governing mechanism is now **§10**; the bullets here remain the
> *intent*, §10 is the *binding spec*. Read §10 for the row-presence vs. governance distinction.

Resolved to **maximal masking** (effectively `drop`/`redact`, never widen):
- `ClassificationSource` present but **no row** for `(resourceType, facetField, facetSchemaVersion)` of a field that the facet declares classified ⇒ unknown class ⇒ max mask. **(rev-2: "declares classified" is now defined by the governance signal of §10, not by row-presence.)**
- `facetSchemaVersion` of the handle facet has **no rows at all** for that version, **while the `(resourceType)` IS under classification governance** ⇒ the whole governed facet is max-masked (NOT widened to whole-resource) — AC-4/AC-12 version boundary. **(rev-2: gated on the governance signal — see §10.)**
- `class` value not in `DataClass` (corrupt row) ⇒ `selectTransform` returns the maximal transform.
- `clearance === null` (reader has no classified clearance) ⇒ every classified field maximally masked.
A field with **no classification row in a `(resourceType)` that is NOT under classification governance at all** keeps the T-0021 path (visible per grant, unmasked) — classification is *additive*; absence of governance is not a new denial of legacy unclassified data. **The distinction "ungoverned (raw legal) vs. governed-but-missing-for-this-version (fail-closed)" is the §10 mechanism.**

### 4.3 Clearance derivation (rights-derived-only, AC-8 / FR-8)
`deriveClearance(coveringGrants): Clearance` reads the reader's **already-covering** grant rows (same rows §`resolveFor` step 3 computed) and returns the maximum `DataClass` they confer. Clearance is carried as a typed marker on the grant's existing `resourceFacet`/`constraint` surface (a `class` clearance token inside the opaque facet object — no schema change to `Grant`, no new column, no `*_acl`/`field_visibility` store). This keeps the decision a pure function of (grant rows × classification rows): **no parallel field-visibility store** is introduced (`grant-resolver-isolation.sh` Check 2 + `data-classification-isolation.sh`).

### 4.4 Determinism & purity (NF-1, NF-5, AC-13)
`maskFields`, `selectTransform`, `applyTransform`, `evaluateReclassification` are total pure functions over their inputs; `hash` is a pure deterministic digest. The only IO is `ClassificationSource.getClassifications`, an injected port (in-memory now, Postgres in T-0053). `data-classification.ts` imports no `pg`/`fs`/`net`/`http`. Same (grants, record, classification rows, now) ⇒ deeply-equal masked output.

---

## 5. Fitness functions (CI-executable architecture rules)

| ID | Rule | CI check |
|----|------|----------|
| **FF-DC1** | `data_classification` is a tenant table: `tenant_id` leading PK, ENABLE+FORCE RLS, isolation policy, `choros_app` grant, listed in `known_tenant_tables.txt`. | `ci/checks/db/force_rls.sql` + `tenant_id_leading.sql` return 0 rows with the table present; `db/schema.test.ts` anti-decorative check (`known_tenant_tables.txt` ⊇ choros base tables) green after appending `data_classification`. |
| **FF-DC2** | Cross-tenant isolation: a class row under tenant A is invisible to a session bound to tenant B. | `db/two_tenant.test.ts`-style two-tenant probe: insert class row under A, `SET choros.tenant_id=B`, `SELECT` returns 0 rows (red without RLS, green with FORCE). |
| **FF-DC3** | Class-driven divergence: two subjects whose grants differ on a classified field get divergent output for the same (record, now). | Pure-TS fitness in `grant-resolver`/`data-classification` test: assert `maskFields` output differs by clearance only. |
| **FF-DC4** *(rev-2, R-1)* | Fail-closed split by governance: **(4a)** an **ungoverned** resource (`governed:false`, no rows anywhere) keeps fields raw (legacy floor); **(4b)** a **governed** resource whose requested version has **zero rows**, with **NON-null clearance**, max-masks the whole facet (raw never present, never widened to whole-resource). | Pure-TS fitness, two cases per §10.7: 4a `maskFields(ctx{governed:false, rows:[]})` ⇒ raw; 4b `maskFields(ctx{governed:true, rows:[], clearance:"restricted"})` ⇒ classified keys absent/`drop`, raw absent. |
| **FF-DC5** | Value-aware: a non-dropping class yields a **present, transformed** value (deep-diff from raw, not absent). | Pure-TS fitness: `applyTransform(v,'partial'|'redact'|'hash')` present and `!== v`. |
| **FF-DC6** | Transform selected by (class, clearance), not field name: two differently-named fields same class+clearance ⇒ same transform; reclassify ⇒ different transform. | Pure-TS fitness over `selectTransform`/`maskFields`. |
| **FF-DC7** | Human==agent equivalence + single projection: both call-sites deep-equal; exactly one projection function. | `ci/checks/single-resolver.sh` stays green (no second `handle→fields` export); pure-TS deep-equal of two resolveFor call-paths. |
| **FF-DC8** | Rights-derived-only: masking computed from grant rows + `data_classification` only; **no parallel field-ACL store** in the new code. | `grant-resolver-isolation.sh` Check 2 green **+** new `ci/checks/data-classification-isolation.sh`: bans `_acl`/`field_visibility`/`record_rights`/`fieldVisibility` tokens in `data-classification.ts`, and bans `pg`/`fs`/`net`/`http` imports (Check 1 mirror). |
| **FF-DC9** | Purity/isolation: classification-aware code imports no `pg`/`fs`/`net`/`http`; frozen `object-handle.ts`/`grant-lattice.ts` unmodified. | `grant-resolver-isolation.sh` Check 1+3 green (those two files still byte-frozen); `data-classification-isolation.sh` import ban. |
| **FF-DC10** | Guarded reclassification: class change routes through `resolveFor(.., op∈{transition,approve})`; rejected without the op-grant; **no** direct-write path to `data_classification.class`. | `data-classification-isolation.sh` structural: no `mutate*/write*Classification` accessor outside the gateway path (analogue of `mutation-gateway-isolation.sh` G1/G6); pure-TS test of `evaluateReclassification` rejection. |
| **FF-DC11** | Direction-aware guard: down-classification rejected for an up-only subject; decision exposes `from→to` direction. | Pure-TS fitness over `classifyDirection`/`evaluateReclassification` (E4.6 dual-control floor). |
| **FF-DC12** *(rev-2, R-1 — isolating test)* | Typed-facet honors schema version, **isolated from the null-clearance lever**: a **governed** resource has rows for version `2`; the handle facet is version `1`; **clearance is NON-null and maximal** (`restricted`). A classified field (`ssn`) MUST be max-masked/absent under v1 and raw MUST NOT appear — the failure is reachable ONLY via the version mechanism (truth-table row 3). Weakening §10.3 back to raw fall-through turns this RED on the **version** axis with clearance held maximal. | TS unit (AC-12) per §10.7: `maskFields(RAW, ALL_VISIBLE, ctx{governed:true, rows:[ssn@v2], clearance:"restricted", facetSchemaVersion:1})` ⇒ `"ssn" in out === false`, `out.ssn !== "123456789"`. |
| **FF-DC13** | Determinism: deeply-equal inputs ⇒ deeply-equal masked output (no IO outside injected ports). | Pure-TS fitness: double-invoke `maskFields`/`applyTransform('hash')`, deep-equal. |
| **FF-DC14** | Shared-axis contract: `DataClass` is a stable named type; the same symbol is the join shape S-1/S-3 read. | TS type-level contract test importing `DataClass`/`DATA_CLASS_ORDER` and asserting the `class` column shape (implements neither egress nor criticality). |
| **FF-DC15** | Audit obligation shape: a value-suppressing mask and a reclassification each produce a well-formed obligation (`via` set, actor/subject present); durable append → T-0053. | Pure-TS fitness over the returned `ClassificationAuditObligation`. |
| **FF-DC16** *(manual, T-0053)* | DB-permission floor: the Postgres class DAO is reachable only via the gateway; no `choros_app` raw read of a classified value bypasses masking. | Manual / activates with T-0053 (mirror of T-0021 AC-14 deferral). |
| **FF-DC17** | `grant-resolver.ts` import surface preserved (FE-W23-0008): `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/`grantFacetFields` still exported; only additive optional params. | grep export-symbol presence in `grant-resolver.ts`; `grant-resolver.test.ts` compiles/passes unchanged. |

**Coder note (frozen-check thaw):** `mutation-gateway-isolation.sh` G6-additive currently freezes `grant-resolver.ts`; the coder MUST drop `grant-resolver.ts` from its `FROZEN_EXPORTS` array (keep `object-handle.ts`, `grant-lattice.ts`) so the legitimate additive masking edit lands. All G1/G2/G6 *isolation* invariants stay. The two-tenant `db/two_tenant.test.ts` migration-count assertion (`expect(n).toBe(12)`) must bump to the post-T-0017/T-0033 count — the orchestrator's migration-number union sets the final number; coder reconciles at BUILD.

---

## 6. Rejected alternatives

| Option | Why not |
|--------|---------|
| Add masking as a **second** projection function (`maskProjectFields`) parallel to `projectFields`. | Opens a second `handle→fields` edge ⇒ `single-resolver.sh` red; human/agent divergence becomes writable. The fold MUST be the one function (AC-7, non-negotiable). |
| Edit `object-handle.ts` to make `Facet` carry `schemaVersion` + class. | Breaks the frozen-module invariant (`grant-resolver-isolation.sh` Check 3) and ripples through `parseHandle`/`serializeHandle` wire validation. `TypedFacet` as an additive widening in the new module is non-breaking. |
| Add a `class` lattice kind to `grant-lattice.ts` / a second authority subsystem for clearance. | NF-2: lattice math stays in T-0018; a second authority subsystem is exactly what `grant-resolver-isolation.sh` Check 2 forbids. Clearance is *derived from* existing grant rows, not a new algebra. |
| Put an FK `(tenant_id, resource_type, facet_field)` → `registry_def`. | Not expressible: `resource_type` is a kind, `facet_field` is a JSONB key name, not a row id. An impossible FK in DDL fails to apply = BUILD bounce (the T-0017 lesson). Logical descriptor, no FK — like `008_grant.role_id`. |
| Bake an `egress`/`allowed_endpoint` column into `data_classification`. | S-1: `egress_policy` is T-0041's table; T-0033 only fixes `class` as the join axis (AC-14). Pre-baking egress couples two tasks and pre-empts T-0041's schema. |
| Mask by field name (hard-coded `password`→redact). | AC-6 forbids per-field-name transforms; selection is `(class × grant)`. Field-name rules would be a parallel non-rights-derived store. |
| Store masking decisions / clearance in a `field_visibility` table. | FR-8 / AC-8: a parallel field-ACL store is banned; decision is grant-rows + `data_classification` only. |
| Reversible encryption/tokenization for `hash` with key custody. | Out of scope per spec §6-A #12 (gold-plating); `hash` is a pure non-reversible digest, no key management. |

---

## 7. Traceability (AC → design locus)

- **AC-1** → §3.3 DDL + FF-DC1. **AC-2** → FF-DC2 (two-tenant probe). **AC-3** → §2.5/§4.1 + FF-DC3.
- **AC-4** → §4.2 fail-closed ladder + FF-DC4. **AC-5** → §4.1 `partial`/`redact`/`hash` present-value + FF-DC5.
- **AC-6** → §2.5 `selectTransform` (class×clearance, not name) + FF-DC6. **AC-7** → §2/§3.2 single fold + `single-resolver.sh`/FF-DC7.
- **AC-8** → §4.3 clearance-from-grants + FF-DC8 (`data-classification-isolation.sh`). **AC-9** → §4.4 purity + FF-DC9.
- **AC-10** → §2.7 guard via `resolveFor` + FF-DC10. **AC-11** → §2.7 `classifyDirection` + FF-DC11.
- **AC-12** → §4.2 version boundary + FF-DC12. **AC-13** → §4.4 determinism + FF-DC13.
- **AC-14** → §2.1 `DataClass` shared axis + FF-DC14. **AC-15** → S-4/§2 deferral + FF-DC16 (manual, T-0053).
- **AC-16** → §2.8 obligation shape + FF-DC15.

---

## 8. Runtime / deploy target

Local / in-process TS (pure static-now), identical to T-0021. **No new external resource** — the Postgres-backed `ClassificationSource` DAO + RLS + the AC-15 DB-permission floor land with T-0053 (founder-gated only insofar as T-0053 already is). No founder gate introduced by T-0033.

---

## 9. Seams declared (sibling tasks — interface points, not implemented)

- **S-1 (T-0041 / E4.8 egress_policy):** `DataClass` is the join axis; `egress_policy(class, allowed_endpoint)` imports `DataClass`, does not redeclare it. No egress column in `data_classification`.
- **S-2 (T-0034 / E4.4 effect resources):** the gateway interface points are `resolveFor` + the `ClassificationSource`/`RecordSource` injected-port pattern; T-0034 stacks an effect-resource verification port additively onto `ResolverDeps`, no second resolver edge.
- **S-3 (T-0040 / E4.5 role_criticality):** consumes `data_classification` (reads `class` to derive `sensitive_read`); T-0033 owns the table, T-0040 the computation.
- **S-4 (T-0053 Postgres):** Postgres `ClassificationSource` DAO + RLS + AC-15 DB-permission floor; mirrors T-0021's `GrantSource`/`RecordSource` deferral.

---

## 10. rev-2 — fail-closed version boundary (R-1, amends §2.3 / §3.1 / §3.2 / §4.2)

> **Why this section exists.** Review R-1 (blocking, axis-4) found a fail-closed hole at the
> version/missing-row boundary: `maskFields` treated a field as classified **only if a row
> exists** for `(resourceType, facetField, facetSchemaVersion)`. When the handle facet's
> schema version has **no rows at all** (or a field that *should* be classified has no row for
> *its* version), every such field fell into the `cls === undefined` branch and was returned
> **raw** — the exact inverse of AC-4/AC-12/NF-3 ("the field does not leak raw"). The build's
> own FF-DC4/DC12 test documented the raw fall-through in a comment yet did not fail, because
> it reached "drop" through the **adjacent lever** (`clearance === null`), never isolating the
> version mechanism. **Root cause (architectural):** `TypedFacet = {fields, schemaVersion}`
> and `MaskContext = {rows, clearance, facetSchemaVersion}` carry **no per-field signal of
> "is-classified" independent of row-presence**, so "genuinely unclassified field (raw is the
> correct legacy answer)" is *structurally indistinguishable* from "classified field whose
> rows are missing for this version (must fail-closed)". This section gives the model that
> signal. It is **additive** to every rev-1 contract (no rev-1 symbol changes shape; rev-1
> green invariants — single-projection, purity, rights-derived-only, frozen modules — are
> untouched). The coder implements it as a strictly-additive edit.

### 10.1 The two states that must be distinguished

For a visible field `f` of a handle facet at version `V` over resource type `R`, after a
covering grant is found:

| State | Meaning | Required output |
|-------|---------|-----------------|
| **U — ungoverned** | `(R)` carries **no classification rows at all, at any version** ⇒ it is a legacy, all-or-nothing resource. Classification is *additive* and has nothing to say about it. | **raw** (the pre-T-0033 floor; legacy compatibility). |
| **G — governed** | `(R)` HAS classification rows under **at least one version** ⇒ `(R)` is under classification governance. | every visible field is **subject to fail-closed**: a field with no `class` resolvable for version `V` is treated as **unknown class ⇒ maximal mask** (`selectTransform` floor for an unknown class is `drop`), NEVER raw. This covers *both* "version `V` has zero rows" *and* "version `V` has rows for other fields but not `f`". |

The decision rule, stated once and bindingly:

> **A field is returned raw ONLY in state U (the resource is not governed at all). In state G,
> a field with no resolvable `class` for the handle's version fails closed to maximal masking.
> Doubt — including "is this resource governed?" being unanswerable — resolves to G (fail
> closed), never U.**

This is the security red-line "rule at doubt → zero visibility" made structural: legacy raw
survives **only** on an affirmatively-ungoverned resource; the moment a resource is touched by
classification, the version boundary is fail-closed for the **whole** facet.

### 10.2 The governance signal — computed without a second query

The `ClassificationSource` port is **extended additively** so the governance bit is computable
from what the resolver *already* fetches, i.e. **no second round-trip and no second store**
(rights-derived-only, AC-8, holds). `getClassifications` is widened to return a small envelope
instead of a bare array:

```ts
// rev-2: the port returns a governance-bearing result, not a bare ClassificationRow[].
// `governed` is TRUE iff resource_type R has >=1 classification row under ANY version
// (computed by the source from the SAME scan/state it uses for `rows`; the in-memory
// source folds it in O(1), the T-0053 Postgres DAO derives it via EXISTS in the SAME
// RLS-scoped statement — see §10.4). `rows` is still ONLY the rows for the requested
// `(R, version)` pair — the per-version slice is unchanged.
export interface ClassificationLookup {
  governed: boolean;          // R is under classification governance (any version)
  rows: ClassificationRow[];  // rows for exactly (resourceType, facetSchemaVersion)
}

export interface ClassificationSource {
  // rev-2: return type widened from ClassificationRow[] to ClassificationLookup.
  getClassifications(resourceType: string, facetSchemaVersion: number): ClassificationLookup;
}
```

**Why a port-shape change and not a second port call (rejected alternatives, §10.5):** a second
method (`isGoverned(R)`) would be a *second query* whose answer could skew from `rows` under a
concurrent write, and the review explicitly asked "what does the port return so the decision is
computable **without a second query**". Folding `governed` into the one result keeps the decision
a pure function of a **single** port read — atomic, deterministic, and impossible to desync from
`rows`. `governed` is **monotone-safe**: the source MUST set it `true` whenever it cannot prove
the resource ungoverned (fail-closed bias).

`MaskContext` gains the same bit (threaded from the lookup, not recomputed):

```ts
export interface MaskContext {
  governed: boolean;          // rev-2 — R is under classification governance (any version)
  rows: ClassificationRow[];  // rows for (resourceType, facetSchemaVersion)
  clearance: Clearance;
  facetSchemaVersion: number;
}
```

### 10.3 `maskFields` semantics in AC terms (the binding truth table)

`maskFields` builds `classByField` from `ctx.rows` filtered to `ctx.facetSchemaVersion` (rev-1
behaviour, unchanged). The **only** changed branch is the `cls === undefined` case, which now
forks on `ctx.governed`:

| # | Input (per visible field `f`) | `ctx.governed` | `class` for `f` at version `V` | Output for `f` | AC |
|---|---|---|---|---|---|
| 1 | `ctx === undefined` (no source) | — | — | **raw** (legacy projectFields) | back-compat |
| 2 | source present, `(R)` has no rows anywhere | `false` | none | **raw** (state U — ungoverned) | NF-3 floor / AC-4 boundary |
| 3 | source present, `(R)` governed, version `V` has **zero** rows | `true` | none | **max mask** (`drop`) — whole facet fails closed, never widened | **AC-4, AC-12** |
| 4 | source present, `(R)` governed, version `V` has rows but **not for `f`** | `true` | none | **max mask** (`drop`) for `f` | **AC-4** |
| 5 | source present, `(R)` governed, row for `f` at `V` exists, `class` resolvable | `true` | `c` | `selectTransform(c, clearance)` transform | AC-3/5/6 |
| 6 | row for `f` at `V` has a corrupt `class` (not a `DataClass`) | `true` | corrupt | **max mask** (`drop`) | NF-3 |

The replaced `maskFields` `cls === undefined` branch, normatively:

```ts
const cls = classByField.get(key);
if (cls === undefined) {
  // rev-2: governance decides raw-vs-fail-closed.
  if (ctx.governed) {
    // State G: governed resource, no class for THIS version/field ⇒ unknown class ⇒
    // maximal mask. selectTransform's unknown-class floor is `drop`; key omitted.
    continue;                       // == drop (capability-not-text), NEVER raw
  }
  out[key] = raw;                   // State U: ungoverned resource ⇒ legacy raw
  continue;
}
// classified field ⇒ (class × clearance) transform (rev-1, unchanged)
```

Rows 3 and 4 are the R-1 fix: under governance, a missing class — whether because the **version
has no rows** (row 3, the AC-12 version boundary) or because **this field has no row** (row 4) —
is **unknown class ⇒ `drop`**, identical to the existing corrupt-class path (row 6). No new
transform is introduced; the maximal mask is the already-defined `drop`.

### 10.4 `ClassificationSource` semantics (both implementations)

- **In-memory static-now source (this task):** holds a `ClassificationRow[]`. `getClassifications(R, V)`
  returns `{ governed: rows.some(r => r.resourceType === R), rows: rows.filter(r => r.resourceType === R && r.facetSchemaVersion === V) }`.
  `governed` is the existence of **any** row for `R` (any version) — one pass, O(n), no second query.
- **T-0053 Postgres DAO (deferred, declared here so the port shape is stable):** ONE RLS-scoped
  statement returns both — e.g. `SELECT … WHERE resource_type=$1 AND facet_schema_version=$2`
  for `rows`, with `governed` from `EXISTS (SELECT 1 FROM data_classification WHERE resource_type=$1)`
  evaluated **in the same statement / same transaction snapshot** (a `bool_or`/lateral or a single
  round-trip CTE). RLS guarantees `governed` reflects **only this tenant's** rows (cross-tenant
  classification cannot make another tenant's resource appear governed — NF-4 holds).
- **Fail-closed bias (NF-3):** any source that cannot determine governance (e.g. a future
  partial/erroring backend) MUST return `governed: true`. The port contract: *`governed: false`
  is an affirmative "I checked, there are no rows for this resource at any version"; absence of
  proof ⇒ `true`.*

### 10.5 rev-2 rejected alternatives

| Option | Why not |
|--------|---------|
| Keep the bare `ClassificationRow[]` return and infer governance from `rows.length > 0`. | This is the **bug**: an empty per-version slice is ambiguous (ungoverned vs. version-missing). The whole point of R-1 is that row-presence-for-this-version cannot carry the governance signal. |
| Add a **second** port method `isGoverned(R): boolean`. | A second query → can skew from `rows` under concurrent writes; the review asked for a decision computable **without a second query**. Folding `governed` into the one `getClassifications` result keeps it atomic and desync-proof. |
| Put an `is_classified` flag column on `data_classification` per `(R, field)`. | Doesn't solve the **zero-rows-for-a-version** case (row 3): if the version has no rows, there is no flag row to read either. Governance must be a **resource-level** existence fact, not a per-row flag. |
| Carry the classified-field set on `TypedFacet` (declare classified fields on the handle). | Would require editing the handle/`object-handle.ts` wire shape (frozen) or trusting a caller-supplied list as authority — moves the security decision off the rights-derived source onto an untrusted handle. Governance must derive from the `ClassificationSource` (the authority), not the handle. |
| A version-catalog (list of "known classified versions" per `R`). | Heavier than needed: the existence question ("is `R` governed at all?") subsumes the version question for the fail-closed decision — if `R` is governed and version `V` is empty, that already fails closed (row 3). A catalog adds state without changing any of the six truth-table rows. |

### 10.6 What changes vs. rev-1 (additive-only delta, for the coder)

1. `ClassificationSource.getClassifications` return type: `ClassificationRow[]` → `ClassificationLookup = {governed, rows}`. **All call sites** (`buildMaskContext` in `grant-resolver.ts`, the in-memory source, every test source) read `.rows` where they read the array before, and pass `.governed` into `MaskContext`. This is the **one** signature change; it is internal to the T-0033 surface (the port was *introduced* by T-0033 — it touches no FE-W23-0008 frozen import surface; `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/`grantFacetFields` are all unchanged, FF-DC17 stays green).
2. `MaskContext` gains `governed: boolean` (additive field).
3. `maskFields` `cls === undefined` branch forks on `ctx.governed` (§10.3 code). No other branch changes; `drop` is reused (no new transform).
4. `buildMaskContext` (`grant-resolver.ts`): `const lookup = source.getClassifications(R, V); return { governed: lookup.governed, rows: lookup.rows, clearance, facetSchemaVersion };`
5. The rev-1 `readFacetVersion` doc-comment claim "that policy lives in `maskFields`" is now **true** (the fail-closed version policy IS implemented in `maskFields` per §10.3) — the doc-comment no longer overstates.

### 10.7 Isolating the version mechanism in fitness (R-1's second demand)

FF-DC4 and **FF-DC12 are re-specified** so the test catches **raw fall-through at the version
boundary with NON-null clearance** — i.e. the failure can ONLY be reached through the version
mechanism, never through the `clearance === null` adjacent lever:

- **FF-DC12 (rev-2, the isolating test):** `(R)` is governed (rows exist for version `2`); the
  handle facet is version `1`; **clearance is NON-null and fully cleared** (e.g. `restricted`,
  the max). A classified field (`ssn`) MUST be **max-masked / absent** under version `1`, and
  `raw` (`"123456789"`) MUST NOT appear — because version `1` has no rows for a **governed**
  resource (truth-table row 3). With the rev-1 code this test is **RED** (it returns raw); with
  §10.3 it is GREEN. This is the negative-probe the review required: weakening §10.3 back to
  raw fall-through must turn this test red on the **version** axis, with clearance held maximal.
- **FF-DC4 (rev-2):** split into the two governance states. **(4a, state U)** an ungoverned
  resource (`governed: false`, zero rows anywhere) keeps fields raw (legacy floor) — the
  back-compat anchor. **(4b, state G)** a governed resource whose requested version has zero
  rows, with **non-null clearance**, max-masks the whole facet (no widening to whole-resource;
  raw never present). 4b is what rev-1's FF-DC4 *claimed* but did not exercise.

Both tests MUST set clearance **non-null** in the fail-closed assertion, so the only lever that
can produce the masked/absent output is the governance×version mechanism, not null clearance.
The orchestrator/coder MUST also update the rev-1 FF-DC4 test body (currently asserting
`["card","name","ssn"]` all raw for empty rows) — that assertion encoded the bug and is replaced
by 4a/4b above; an empty-rows-over-a-**governed**-resource now drops the classified keys.
