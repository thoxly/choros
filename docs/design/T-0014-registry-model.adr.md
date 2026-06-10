# ADR · T-0014 — Resource/Object Model: Applications → Registries → Records

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-09
**Spec:** `docs/specs/T-0014-registry-model.spec.md` (status: ready, AC-1..AC-17)
**Foundation (do NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (DESIGN ready, GT-1 founder-approved tenancy fork). Every entity here is a T-0013 tenant-owned table.
**Feeds into:** T-0018 (grant/authority model — consumes the binding surface in §5), T-0015 (opaque handles — consumes record identity).

> This ADR is **design-only**. Choros has no Postgres today (jobStore is an in-memory
> `Map`). T-0014 fixes the *entities, columns, types, constraints, contracts and fitness
> functions* that any correct implementation MUST satisfy. The DDL / migrations / RLS
> policy bodies / index DDL land in **T-0053** (Postgres-in-compose), which is an infra
> dependency of this design, **not built here**. Following T-0013's discipline, every
> fitness function below carries a concrete `ci_check` *and* a `gating` note —
> **static-now** (a lint/script runnable in today's `npm run ci`) or **live-T-0053** (a
> live-DB probe authored now, activated when Postgres exists) — so none can be silently
> dropped. This ADR is the single field/type source of truth for `coder` (T-0053) and
> `tester`; any divergence below is a silent bug downstream.

---

## 1. Decision

Model the resource namespace as **three flat tenant-owned tables — `application`,
`registry_def`, `record` — in a fixed parent→child chain enforced structurally by
composite, tenant-id-leading foreign keys**, with no discriminator tables and no
inheritance machinery. Each table follows the T-0013 convention verbatim: `tenant_id uuid
NOT NULL` (no default) as the leading column of the primary key, of every composite index,
and of every FK; `ENABLE` + `FORCE ROW LEVEL SECURITY` with the one default-DENY policy
keyed on the `choros.tenant_id` GUC; all access through `withTenant()`. The three tables
are simply *added to T-0013's existing apparatus* (appended to the `known_tenant_tables`
fixture, covered by the same FF-2/FF-3/FF-5/FF-6/FF-7 probes) — **T-0014 introduces no new
isolation code-path**.

The hierarchy shape is pinned by FKs, not application logic:
`registry_def (tenant_id, application_id) → application (tenant_id, id)` and
`record (tenant_id, registry_id) → registry_def (tenant_id, id)`. Because the FK's leading
column is `tenant_id` and the FK target's PK leads with `tenant_id`, a cross-tenant
reference is **structurally impossible** — the same guarantee T-0013 gives, inherited for
free. The only shapes the FKs permit are Application⊃Registry⊃Record; an application
cannot reference an application, a record cannot parent a registry (FR-1).

A registry's *shape* is data, not schema: `registry_def.record_schema jsonb NOT NULL`
holds a JSON Schema (draft-07+), and `record.data jsonb` is validated against it **at the
application layer at write time** (a `validateRecordData()` contract, §4.3), before the
INSERT/UPDATE reaches Postgres. This is the proportional choice: evolving a registry's
fields is a row update on `registry_def`, never a DDL migration (NF-2); there is no
`registry_type` discriminator and no per-registry table. System-provisioned registries
(e.g. the agent registry) are *not a separate entity* — they are ordinary `registry_def`
rows with `is_system = true`, a flag that (a) is set only at tenant-init provisioning, never
by tenant-admin CRUD, and (b) gates the delete path so tenant admins cannot delete them
(FR-8, AC-14).

Identity is immutable and rename-safe: every entity's `id` is a UUID that never changes;
the human-facing key (`slug`) is mutable and **scoped-unique** —
`UNIQUE (tenant_id, slug)` for `application`,
`UNIQUE (tenant_id, application_id, slug)` for `registry_def`, and `record` has no slug
(identity is `(tenant_id, id)`). Renaming a slug therefore never breaks a downstream grant
binding, because grants bind to UUIDs, never slugs (NF-3).

Finally, this ADR fixes — and *only* fixes — the **grant-binding surface** (§5): three
stable reference shapes (`application`, `registry`, `record`) that T-0018 will consume as
the resource target of a grant. T-0014 defines the *shape and constructability* of these
references from the three tables' columns; it does **not** define grant entities,
permission semantics, or resolution logic (that is T-0018), nor opaque handles (T-0015).
The surface is a typed, side-effect-free constructor over already-present columns — the
thinnest possible contract that lets T-0018 proceed without re-opening this model.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Table-per-registry (each registry gets its own physical table, columns from its schema)** | DDL on every registry create/field-add; explodes the migration surface and the `known_tenant_tables` fixture; makes RLS/FK auditing per-tenant-unbounded; defeats NF-2 (schema evolution without DDL). The JSONB+JSON-Schema model gives typed records with a fixed, auditable table count (3). |
| **Single polymorphic `node` table with a `level` enum (application/registry/record in one table, self-FK to parent)** | A self-referential `parent_id` cannot structurally forbid the illegal shapes (record-parents-registry, app-parents-app) — those become *runtime* checks, i.e. discipline not structure, the exact anti-pattern T-0013 §2 rejects. Three typed tables with directed FKs make the hierarchy a property of the schema. Also muddies the grant surface (§5 shapes would all collapse to one ambiguous reference). |
| **Separate `system_registry` table for `is_system` registries** | Two entity types for one concept; system registries must be "such-same objects" (CONCEPT.md §7) — equally grantable, equally listable. A boolean flag on `registry_def` is minimal and keeps the grant surface uniform (FR-8). A second table would need its own RLS/FK/grant-shape duplication for zero benefit. |
| **`registry_type` discriminator column to branch behavior in MVP** | No MVP behavior branches on type yet (NF-2); adding a discriminator now is speculative generality. Behavioral differentiation that *does* exist (system vs user) is the `is_system` boolean; opaque-handle semantics are T-0015's concern. Add a discriminator only when a second behavior actually arrives. |
| **DB-side `CHECK (jsonb_matches_schema(record_schema, data))` for record validation** | Postgres has no core JSON-Schema validator; it needs the `pg_jsonschema` extension (non-standard, not in the silo compose baseline) and pins validation to whatever draft that extension supports. Validating at the application layer (§4.3) keeps the DB to standard Postgres, lets the validator match the `record_schema` draft exactly, and gives a clearer error path. The DB still enforces `data jsonb NOT NULL` and FK/RLS; only *schema-conformance* is app-layer (AC-17). |
| **Global slugs (e.g. an application slug unique across all tenants)** | Directly violates T-0013's scoped-uniqueness invariant and the "decorative tenant_id trap" (T-0013 §2): two tenants must independently own `slug='procurement'`. All uniqueness is `(tenant_id, …)`-scoped. |
| **Grants bind to `slug` (human-readable resource path)** | A slug rename would silently re-target or orphan every grant on that node. Grants bind to immutable UUIDs (NF-3); slug is a display/lookup key only. Fixed in the §5 reference shapes (UUID-only). |

None of these re-open a founder-approved fork; they are the standard alternatives recorded
for downstream traceability.

---

## 3. Object model

Postgres types are authoritative; the TS-side mirror (camelCase, `string` for `uuid`,
`number` for `bigint` epoch-ms — matching `src/core/types.ts:Job`) is noted where
load-bearing. All three tables are T-0013 tenant tables: they inherit §3.1 of the T-0013
ADR (tenant_id NOT NULL leading PK, FORCE RLS, default-DENY policy, scoped uniqueness) in
full — that convention is **not** restated per-field below; only entity-specific columns
and constraints are pinned here.

### 3.1 `application` — domain container (1…N per tenant)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, no default; **leading PK column**; RLS key (T-0013 §3.1) |
| `id` | `uuid` | `NOT NULL`; PK is `(tenant_id, id)` |
| `slug` | `text` | `NOT NULL`; URL-safe; `UNIQUE (tenant_id, slug)` — scoped to tenant, never global |
| `display_name` | `text` | `NOT NULL`; human-readable label |
| `description` | `text` | nullable; optional prose |
| `created_at` | `bigint` | `NOT NULL`; unix epoch ms |
| `updated_at` | `bigint` | `NOT NULL`; unix epoch ms |

- **PK:** `(tenant_id, id)`. **Scoped unique:** `(tenant_id, slug)`.
- **Delete rule:** permitted only when the application has no `registry_def` children
  (FR-2; enforced structurally by the child FK + delete-blocking at the API layer, AC-12).
- TS mirror: `{ tenantId, id, slug, displayName, description?, createdAt, updatedAt }`.

### 3.2 `registry_def` — registry definition (1…N per application)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, no default; **leading PK column**; RLS key |
| `id` | `uuid` | `NOT NULL`; PK is `(tenant_id, id)` |
| `application_id` | `uuid` | `NOT NULL`; **FK `(tenant_id, application_id)` → `application (tenant_id, id)`** — leading FK column is `tenant_id` (T-0013 §3.1) |
| `slug` | `text` | `NOT NULL`; URL-safe; `UNIQUE (tenant_id, application_id, slug)` — scoped to `(tenant, application)` |
| `display_name` | `text` | `NOT NULL`; human-readable label |
| `description` | `text` | nullable; optional prose |
| `record_schema` | `jsonb` | `NOT NULL`; JSON Schema (draft-07+) governing every `record.data` in this registry |
| `is_system` | `boolean` | `NOT NULL DEFAULT false`; `true` ⇒ platform-provisioned, delete-protected from tenant admins (FR-8) |
| `created_at` | `bigint` | `NOT NULL`; unix epoch ms |
| `updated_at` | `bigint` | `NOT NULL`; unix epoch ms |

- **PK:** `(tenant_id, id)`. **Scoped unique:** `(tenant_id, application_id, slug)`.
  **FK:** `(tenant_id, application_id) → application(tenant_id, id)` (same-tenant only).
- **Index (NF-5):** `(tenant_id, application_id)` to list registries of an application.
- **Delete rule:** permitted only when (a) `is_system = false` *and* (b) no `record`
  children (FR-3, FR-8; AC-13, AC-14).
- TS mirror: `{ tenantId, id, applicationId, slug, displayName, description?, recordSchema:
  JSONSchema, isSystem: boolean, createdAt, updatedAt }`.

### 3.3 `record` — registry instance (0…N per registry)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, no default; **leading PK column**; RLS key |
| `id` | `uuid` | `NOT NULL`; PK is `(tenant_id, id)` |
| `registry_id` | `uuid` | `NOT NULL`; **FK `(tenant_id, registry_id)` → `registry_def (tenant_id, id)`** — leading FK column is `tenant_id` |
| `data` | `jsonb` | `NOT NULL`; payload; MUST conform to parent `registry_def.record_schema` at write time (validated app-layer, §4.3) |
| `created_at` | `bigint` | `NOT NULL`; unix epoch ms |
| `updated_at` | `bigint` | `NOT NULL`; unix epoch ms |
| `created_by` | `text` | `NOT NULL`; subject identity (user/agent id) that created the record |

- **PK:** `(tenant_id, id)`. No slug — identity is `(tenant_id, id)` (FR-4).
  **FK:** `(tenant_id, registry_id) → registry_def(tenant_id, id)` (same-tenant only).
- **Index (NF-5):** `(tenant_id, registry_id)` to list records of a registry.
- A record cannot exist without its parent `registry_def` (NF-4, structural via FK).
- TS mirror: `{ tenantId, id, registryId, data: Record<string, unknown>, createdAt,
  updatedAt, createdBy }`.

### 3.4 Uniqueness-scope summary (FR-5, inherits T-0013 §3.1)

| Entity | Business-key uniqueness scope |
|---|---|
| `application` | `(tenant_id, slug)` |
| `registry_def` | `(tenant_id, application_id, slug)` |
| `record` | none (no slug); identity `(tenant_id, id)` |

No name or slug is globally unique. This is a hard invariant, not a convention (FF-3).

---

## 4. Contracts (pseudocode — implementation is `coder`'s zone, T-0053)

### 4.1 Persistence access (inherits T-0013 `withTenant`)

All reads/writes of these three tables go through the T-0013 `withTenant(tenantId, fn)`
wrapper (T-0013 §4.1). No raw query outside a `withTenant` transaction. RLS filters by
`choros.tenant_id`; FK predicates are same-tenant by construction. T-0014 adds **no new
persistence primitive** — it adds three tables to the existing apparatus.

### 4.2 Grant-binding reference shapes (the surface T-0018 consumes — §5)

```ts
// Stable, UUID-only resource references. Discriminated union on `kind`.
// All component ids are uuids; every component is scoped under the SAME tenant_id.
// This is a DATA SHAPE + a side-effect-free constructor. It is NOT the grant model.
type ResourceRef =
  | { kind: "application"; tenantId: string; applicationId: string }
  | { kind: "registry";    tenantId: string; applicationId: string; registryId: string }
  | { kind: "record";      tenantId: string; registryId: string;    recordId: string };

// Constructors — built purely from columns already present on the three tables.
// They perform NO authorization decision (that is T-0018); they only assemble a ref.
function appRef(a:  { tenantId: string; id: string }): ResourceRef;
//   => { kind:"application", tenantId:a.tenantId, applicationId:a.id }
function registryRef(r: { tenantId: string; applicationId: string; id: string }): ResourceRef;
//   => { kind:"registry", tenantId:r.tenantId, applicationId:r.applicationId, registryId:r.id }
function recordRef(rec: { tenantId: string; registryId: string; id: string }): ResourceRef;
//   => { kind:"record", tenantId:rec.tenantId, registryId:rec.registryId, recordId:rec.id }
//
// INVARIANT (checked by FF-6, AC-15): every uuid field referenced by a constructor
// exists as a NOT NULL column on the corresponding table, so a ResourceRef is always
// constructable from a persisted row — no null component is possible.
```

### 4.3 Record-data validation (FR-4, NF-2; AC-17)

```ts
// Application-layer JSON-Schema validation, invoked on EVERY record write
// (create + update) BEFORE the INSERT/UPDATE reaches Postgres. Fail-closed.
function validateRecordData(recordSchema: JSONSchema, data: unknown):
  | { ok: true }
  | { ok: false; errors: ValidationError[] };
// Semantics:
//   compile recordSchema (draft-07+); validate(data);
//   on failure => reject the write with ValidationError; NEVER reach the DB INSERT.
//   on success => proceed to withTenant(...) INSERT/UPDATE.
// Caller contract (the record write path):
//   const v = validateRecordData(registryDef.recordSchema, input.data);
//   if (!v.ok) throw new RecordSchemaViolationError(v.errors);   // app-layer reject
//   return withTenant(tenantId, tx => tx.insert("record", { ...input, data }));
```

### 4.4 Delete-guard contracts (FR-2, FR-3, FR-8; AC-12/13/14)

```ts
// application delete: blocked if it has registries (no-orphan, NF-4).
function deleteApplication(ref): void;
//   if (countRegistries(ref) > 0) throw new HasChildrenError("application has registries");
//   // else: DB FK (no cascade) also raises if a child slipped in (defense in depth, AC-12)

// registry_def delete: blocked if is_system OR has records.
function deleteRegistry(ref): void;
//   const rd = load(ref);
//   if (rd.isSystem) throw new SystemRegistryProtectedError();          // AC-14
//   if (countRecords(ref) > 0) throw new HasChildrenError("registry has records"); // AC-13
```

### 4.5 System-registry provisioning (FR-8)

```ts
// is_system=true rows are created ONLY at tenant initialization, never via tenant-admin CRUD.
// The tenant-admin CRUD surface MUST NOT accept is_system as a client-settable field on create.
function provisionSystemRegistry(tenantId, appId, def): registry_def; // is_system:=true, internal only
// Tenant-admin createRegistry(...) ALWAYS writes is_system=false (default); client cannot override.
```

---

## 5. Grant-binding surface (the T-0018 contract this ADR fixes)

This is the *only* externally-consumed contract T-0014 owns. It pins **what a grant points
at**, not who-may-do-what (T-0018).

| Granularity | Reference shape | Covers | Constructable from |
|---|---|---|---|
| Application | `{ kind:"application", tenant_id, application_id }` | all registries + records in the application | `application` row: `tenant_id`, `id` |
| Registry | `{ kind:"registry", tenant_id, application_id, registry_id }` | all records in one registry | `registry_def` row: `tenant_id`, `application_id`, `id` |
| Record | `{ kind:"record", tenant_id, registry_id, record_id }` | a single record | `record` row: `tenant_id`, `registry_id`, `id` |

Invariants the surface guarantees to T-0018:
1. Every component is an **immutable UUID** present as a `NOT NULL` column on the named
   table — so any persisted node yields a fully-populated reference (no null component).
2. Every component is scoped under the **same `tenant_id`** (cross-tenant FKs are
   impossible, §1 / T-0013), so a reference can never span tenants.
3. References are **rename-stable** (NF-3): a `slug`/`display_name` change does not change
   any `id`, so an existing reference stays valid.

T-0018 MUST be expressible as binding to exactly one of these three shapes. T-0014 does not
define grant rows, roles, inheritance, or resolution — only this surface (FR-7).

---

## 6. Fitness functions

Following T-0013's discipline: each is an executable CI rule with a concrete `ci_check` and
a `gating` note. **static-now** = runnable in today's `npm run ci` (TS/eslint/vitest +
`ci/checks/*.sh|*.ts` lints; the repo is zero-runtime-dep, ajv is a transitive devDep).
**live-T-0053** = live-DB probe authored now, wired into the `db-isolation` CI job when
Postgres exists. FF-1..FF-3 **extend** T-0013's existing probes to the three new tables
(they are not new isolation logic); FF-4..FF-8 are T-0014-specific.

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | The three new tables (`application`, `registry_def`, `record`) are in the `known_tenant_tables` fixture and each has FORCE RLS — extends T-0013 FF-2. | static-now: assert `ci/checks/known_tenant_tables.txt` contains all three names (`grep -qx` each; CI fails if missing) — this is what makes them flow into every T-0013 probe. live: T-0013 FF-2 SQL (`relrowsecurity AND relforcerowsecurity`) over `= ANY($tenant_tables)` now includes the three, MUST return 0 RLS-less rows. | static-now + live-T-0053 |
| **FF-2** | Default-DENY + cross-tenant isolation hold on the three tables — extends T-0013 FF-3/FF-6/FF-7. | live: as `choros_app` with no `SET LOCAL`, `SELECT count(*)` on each of the three = 0; with context=A, `count(*) WHERE tenant_id=B` = 0 for read, `UPDATE/DELETE … WHERE tenant_id=B` affects 0 rows. (Reuses T-0013 probe parametrized over the new tables.) | live-T-0053 |
| **FF-3** | Scoped uniqueness + `tenant_id NOT NULL`: `application(tenant_id,slug)`, `registry_def(tenant_id,application_id,slug)`; no global slug; NULL tenant_id rejected. | live: insert same `slug` under two tenants (and `registry_def` same slug under two apps) succeeds; duplicate within scope ⇒ unique violation; `INSERT … tenant_id=NULL` as `choros_migrator` ⇒ NOT NULL violation. static-now: `ci/checks/scoped_unique.sql` lint asserts every `UNIQUE` on the three tables has `tenant_id` as column 1 (no bare-`slug` unique). | live-T-0053 + static-now |
| **FF-4** | FK integrity + `tenant_id`-leading FK on `registry_def` and `record` — extends T-0013 FF-5 probe to the new FKs. | live: `INSERT registry_def` with non-existent `application_id` (same tenant) ⇒ FK violation; `INSERT record` with non-existent `registry_id` ⇒ FK violation; T-0013 `tenant_id_leading.sql` probe asserts column-1 of both FKs is `tenant_id` (`pg_constraint contype='f'`). static-now: `ci/checks/fk_tenant_leading.sql` lint over migration DDL asserts each FK on the two tables names `(tenant_id, …)` and targets a `(tenant_id, id)` PK. | live-T-0053 + static-now |
| **FF-5** | `record.data` is validated against the parent `registry_def.record_schema` at the app layer before any DB write; non-conformant ⇒ rejected, conformant ⇒ accepted. | static-now: `src/.../record.test.ts` (vitest) — calls `validateRecordData(schema, data)` with a conformant and a non-conformant payload, asserts `{ok:true}` / `{ok:false}` respectively; plus a lint asserting every `record` insert/update call site is preceded by `validateRecordData` (grep for unguarded `insert("record"`). live: integration test that a non-conformant insert is rejected before the INSERT executes (DB row count unchanged). | static-now (unit + lint) + live-T-0053 (integration) |
| **FF-6** | The three grant-binding reference shapes (§5) are constructable from the three tables — every UUID component is a NOT NULL column, no null component possible. | static-now: `src/.../resourceRef.test.ts` (vitest) builds `appRef/registryRef/recordRef` from fixture rows and asserts each yields a fully-populated `ResourceRef` (no undefined field); plus `ci/checks/ref_shape_lint.ts` cross-checks each shape's required uuid fields against the column list of its table in the object-model fixture — fails if a referenced column is absent or nullable. | static-now |
| **FF-7** | `is_system` delete-protection: a tenant-admin delete of a `registry_def` with `is_system=true` is rejected; `is_system` is not client-settable on create. | static-now: `src/.../deleteRegistry.test.ts` asserts `deleteRegistry` on an `is_system=true` row throws `SystemRegistryProtectedError`, and `createRegistry` ignores/rejects a client-supplied `isSystem=true` (always persists `false`). live: integration test that the DELETE is rejected and the row survives. | static-now (unit) + live-T-0053 (integration) |
| **FF-8** | No-orphan delete guards: deleting an `application` with registries, or a `registry_def` with records, is blocked (API reject and/or DB FK), leaving zero orphaned rows. | static-now: vitest asserts `deleteApplication`/`deleteRegistry` throw `HasChildrenError` when children exist. live: with hard-delete-no-cascade FKs, the DELETE raises a FK violation; post-condition query finds 0 `registry_def` without parent `application` and 0 `record` without parent `registry_def`. | static-now (unit) + live-T-0053 (integration) |

**CI wiring:** static-now checks join the existing `npm run ci` (`tsc --noEmit && eslint
src && vitest run`) as `src/**/*.test.ts` vitest specs and `ci/checks/*.sh|*.sql|*.ts`
lints. FF-1 specifically requires the `known_tenant_tables` fixture (introduced by T-0013
FF-2) to gain the three table names — that single fixture edit is what folds these tables
into *all* of T-0013's live RLS/isolation probes, which is why FF-2/FF-4's live halves are
"extends T-0013 probe" rather than new SQL. Live-T-0053 checks are authored as
`ci/checks/*.sql` / `*.test.ts` now and activated by the `db-isolation` CI job (Postgres
service container) in T-0053.

---

## 7. Traceability (AC-1..AC-17 → design)

| AC | Covered by |
|---|---|
| AC-1 (FORCE RLS on all 3 tables) | §1 (T-0013 convention inherited) · §3.1–3.3 · **FF-1** (extends T-0013 FF-2) |
| AC-2 (tenant_id=NULL rejected) | §3.1–3.3 `tenant_id NOT NULL` · **FF-3** |
| AC-3 (no context ⇒ 0 rows / default-DENY) | §1 / T-0013 §4.3 policy inherited · **FF-2** (extends T-0013 FF-3) |
| AC-4 (cross-tenant read = 0) | §1 / T-0013 §4.3 USING inherited · **FF-2** (extends T-0013 FF-6) |
| AC-5 (application slug scoped-unique) | §3.1 `UNIQUE(tenant_id,slug)` · §3.4 · **FF-3** |
| AC-6 (registry_def slug scoped-unique) | §3.2 `UNIQUE(tenant_id,application_id,slug)` · §3.4 · **FF-3** |
| AC-7 (registry_def FK to application) | §3.2 FK · §1 · **FF-4** |
| AC-8 (record FK to registry_def) | §3.3 FK · §1 · **FF-4** |
| AC-9 (tenant_id leading column of every FK) | §3.2/§3.3 composite FKs lead with tenant_id · **FF-4** (extends T-0013 FF-5) |
| AC-10 (rename application.slug keeps id/FK) | §1 (UUID immutable, slug mutable) · §3.1 · NF-3 · **FF-3** (slug update path) / §5 invariant 3 |
| AC-11 (rename registry_def.slug keeps id/FK) | §1 · §3.2 · NF-3 · §5 invariant 3 |
| AC-12 (delete application with children blocked) | §4.4 `deleteApplication` guard · §3.1 delete rule · **FF-8** |
| AC-13 (delete registry_def with records blocked) | §4.4 `deleteRegistry` guard · §3.2 delete rule · **FF-8** |
| AC-14 (is_system delete-protected) | §3.2 `is_system` · §4.4 / §4.5 · FR-8 · **FF-7** |
| AC-15 (3 grant-binding shapes constructable) | §4.2 constructors · §5 surface + invariants · **FF-6** |
| AC-16 (known_tenant_tables extended with 3 tables) | §1 (added to apparatus) · §6 CI wiring · **FF-1** |
| AC-17 (record.data ↔ record_schema validation) | §3.3 `data` · §4.3 `validateRecordData` · NF-2 · **FF-5** |

Every AC-1..AC-17 maps to at least one fitness function.

---

## 8. Runtime target

**Postgres in the silo `docker-compose` stack** (T-0013 §7), founder's home server
(`/srv/choros`), deploy founder-gated. The three tables are owned by `choros_migrator`,
read/written by the `NOBYPASSRLS` `choros_app` role through `withTenant`. No new
infrastructure beyond T-0013's: T-0014 adds three tables, three FKs, three unique
constraints, and the app-layer validation + ref-constructor code.

**Infra dependency — NOT built in T-0014:** the `CREATE TABLE`/index/RLS-policy DDL for the
three tables is delivered by **T-0053** (alongside T-0013's). T-0014 is design-only: it
authors the entities, columns, constraints, contracts, and fitness functions (with their
`ci_check`s) ready to wire when Postgres exists. No server/DB-host provisioning is
triggered here (that is GT-4, a founder gate).

---

## 9. Escalation

None. T-0014 sits entirely inside the GT-1 founder-approved tenancy fork
(`tenancy-and-delivery.md`) and the T-0013 isolation foundation, and the three-level
namespace is the founder's own hypothesis (spec §6, discovery Q13). No new high-leverage
product fork is introduced; the grant-binding surface is a thin, UUID-only contract handed
to T-0018, not a grant-model decision. Direction pre-approved — `status: ready`.
