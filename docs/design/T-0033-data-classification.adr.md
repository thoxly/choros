# ADR · T-0033 — Data-classification + value-aware masking + typed facets + from→to guards

**Status:** ready (no escalation)
**Phase:** DESIGN
**Date:** 2026-06-10
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

3. **`ClassificationSource` injected port** — mirrors `GrantSource`/`RecordSource`: a pure, static-now lookup `getClassifications(resourceType, facetSchemaVersion): ClassificationRow[]` (in-memory now; the RLS-scoped Postgres DAO lands in T-0053). The resolver calls it **after** a covering grant is found (it never reads classification for a record it has no grant for). Threaded onto `ResolverDeps` as an **optional** field — when absent, the gateway degrades to the pre-T-0033 all-or-nothing behaviour (backward-compatible) BUT a *present, classified* facet with a *missing source* is treated as fail-closed maximal masking, never widened.

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

// Injected port — pure static-now; Postgres RLS DAO in T-0053. Mirrors GrantSource.
export interface ClassificationSource {
  getClassifications(resourceType: string, facetSchemaVersion: number): ClassificationRow[];
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

Inside `resolveFor` step 6 (the ONE projection point), after `const vis = visibleFields(...)`: if `deps.classifications` is present, build `MaskContext` (resourceType from `handle.ref.kind`/`ResourceType`, `facetSchemaVersion = readFacetVersion(handle.facet)`, `rows = deps.classifications.getClassifications(...)`, `clearance = deriveClearance(covering)`) and call `projectFields(raw, vis, ctx)`; else `projectFields(raw, vis)`. **Still one call, one function, one core** (AC-7).

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

### 4.2 Fail-closed ladder (NF-3, AC-4, AC-12)
Resolved to **maximal masking** (effectively `drop`/`redact`, never widen):
- `ClassificationSource` present but **no row** for `(resourceType, facetField, facetSchemaVersion)` of a field that the facet declares classified ⇒ unknown class ⇒ max mask.
- `facetSchemaVersion` of the handle facet has **no rows at all** for that version ⇒ the whole classified facet is max-masked (NOT widened to whole-resource) — AC-4/AC-12 version boundary.
- `class` value not in `DataClass` (corrupt row) ⇒ `selectTransform` returns the maximal transform.
- `clearance === null` (reader has no classified clearance) ⇒ every classified field maximally masked.
A field with **no classification row and not declared in any classified facet** keeps the T-0021 path (visible per grant, unmasked) — classification is *additive*; absence of a class is not a new denial of unclassified data.

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
| **FF-DC4** | Fail-closed on missing/mismatched classification: a classified facet whose `facetSchemaVersion` has no rows yields max masking, never whole-resource. | Pure-TS fitness: `maskFields` with empty `rows` for the version ⇒ classified keys dropped/redacted, raw never present. |
| **FF-DC5** | Value-aware: a non-dropping class yields a **present, transformed** value (deep-diff from raw, not absent). | Pure-TS fitness: `applyTransform(v,'partial'|'redact'|'hash')` present and `!== v`. |
| **FF-DC6** | Transform selected by (class, clearance), not field name: two differently-named fields same class+clearance ⇒ same transform; reclassify ⇒ different transform. | Pure-TS fitness over `selectTransform`/`maskFields`. |
| **FF-DC7** | Human==agent equivalence + single projection: both call-sites deep-equal; exactly one projection function. | `ci/checks/single-resolver.sh` stays green (no second `handle→fields` export); pure-TS deep-equal of two resolveFor call-paths. |
| **FF-DC8** | Rights-derived-only: masking computed from grant rows + `data_classification` only; **no parallel field-ACL store** in the new code. | `grant-resolver-isolation.sh` Check 2 green **+** new `ci/checks/data-classification-isolation.sh`: bans `_acl`/`field_visibility`/`record_rights`/`fieldVisibility` tokens in `data-classification.ts`, and bans `pg`/`fs`/`net`/`http` imports (Check 1 mirror). |
| **FF-DC9** | Purity/isolation: classification-aware code imports no `pg`/`fs`/`net`/`http`; frozen `object-handle.ts`/`grant-lattice.ts` unmodified. | `grant-resolver-isolation.sh` Check 1+3 green (those two files still byte-frozen); `data-classification-isolation.sh` import ban. |
| **FF-DC10** | Guarded reclassification: class change routes through `resolveFor(.., op∈{transition,approve})`; rejected without the op-grant; **no** direct-write path to `data_classification.class`. | `data-classification-isolation.sh` structural: no `mutate*/write*Classification` accessor outside the gateway path (analogue of `mutation-gateway-isolation.sh` G1/G6); pure-TS test of `evaluateReclassification` rejection. |
| **FF-DC11** | Direction-aware guard: down-classification rejected for an up-only subject; decision exposes `from→to` direction. | Pure-TS fitness over `classifyDirection`/`evaluateReclassification` (E4.6 dual-control floor). |
| **FF-DC12** | Typed-facet honors schema version: vN facet resolves vN rows; bumping version without rows fails closed. | TS unit (AC-12): `maskFields` with `facetSchemaVersion` mismatch ⇒ max mask. |
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
