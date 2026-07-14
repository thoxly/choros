# Spec · T-0014 — Resource/Object Model: Applications → Registries → Records

**Status:** ready  
**Phase:** SPEC  
**Date:** 2026-06-09  
**Task:** E2.2 — Resource/object model (registry_def)  
**ADR dependency:** T-0013 Tenant Isolation Foundation (design/T-0013-tenant-isolation.adr.md)  
**Feeds into:** T-0018 (RBAC grant model / authority model), T-0015 (opaque object handles)

---

## 1. Summary

Choros organizes business data in a three-level namespace: **Application → Registry → Record**. An `application` is a domain container (e.g. "Procurement", "HR"). A `registry` is a typed collection inside an application (e.g. "Counterparties", "Purchase Requests"). A `record` is a single instance inside a registry. The `registry_def` entity defines the shape and metadata of a registry — its name, the JSON Schema governing records, its application parent, and display settings.

This namespace is the **binding surface for future authorization grants**: a grant (T-0018) will reference a node in this hierarchy (an application, a registry, or a record) as its resource target. This spec pins the entities, their relationships, identity/naming rules, what a `registry_def` must contain, and the grant-binding surface — without designing the grant model itself.

Every entity is tenant-owned. The entire object model inherits the T-0013 isolation invariants: `tenant_id NOT NULL` as the leading PK column, scoped uniqueness, and FORCE RLS.

---

## 2. Functional Requirements

### FR-1 — Three-level namespace

The resource namespace has exactly three levels, in fixed hierarchical order:

```
Tenant
 └── Application (1…N per tenant)
      └── Registry (1…N per application)
           └── Record (0…N per registry)
```

No other hierarchy shape is permitted. An application cannot contain another application. A record cannot contain a registry.

### FR-2 — `application` entity

An `application` is a domain container owned by a tenant. It has:

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; RLS key (T-0013 §3.1) |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `slug` | `text NOT NULL` | URL-safe identifier; `UNIQUE (tenant_id, slug)` — uniqueness is **scoped to tenant**, never global |
| `display_name` | `text NOT NULL` | Human-readable label |
| `description` | `text` | Optional prose description |
| `created_at` | `bigint NOT NULL` | unix epoch ms |
| `updated_at` | `bigint NOT NULL` | unix epoch ms |

An application `slug` is the primary human-facing reference key within a tenant's namespace. The same `slug` value may exist in different tenants (scoped uniqueness, never global). Deleting an application is only permitted when it has no registries.

### FR-3 — `registry_def` entity (registry definition)

A `registry_def` defines the shape and metadata of a registry. It is owned by exactly one application within the tenant. It has:

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; RLS key |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `application_id` | `uuid NOT NULL` | FK → `application(tenant_id, id)`; composite FK leading column is `tenant_id` (T-0013 §3.1) |
| `slug` | `text NOT NULL` | URL-safe identifier; `UNIQUE (tenant_id, application_id, slug)` — uniqueness scoped to `(tenant_id, application_id)` |
| `display_name` | `text NOT NULL` | Human-readable label |
| `description` | `text` | Optional prose description |
| `record_schema` | `jsonb NOT NULL` | JSON Schema (draft-07 or later) governing the shape of records in this registry |
| `is_system` | `boolean NOT NULL DEFAULT false` | Marks platform-provisioned registries (e.g. the agent registry); system registries cannot be deleted by tenant admins |
| `created_at` | `bigint NOT NULL` | unix epoch ms |
| `updated_at` | `bigint NOT NULL` | unix epoch ms |

The `slug` of a `registry_def` is unique within its application within its tenant. The same `slug` may exist in different applications or different tenants. Deleting a `registry_def` is only permitted when it has no records.

### FR-4 — `record` entity

A `record` is a single instance within a registry. It stores its data as a JSONB blob validated against the parent `registry_def.record_schema`. It has:

| Field | Type | Constraints |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | leading PK column; RLS key |
| `id` | `uuid NOT NULL` | PK is `(tenant_id, id)` |
| `registry_id` | `uuid NOT NULL` | FK → `registry_def(tenant_id, id)`; composite FK leading column is `tenant_id` |
| `data` | `jsonb NOT NULL` | Record payload; MUST conform to the parent `registry_def.record_schema` at write time |
| `created_at` | `bigint NOT NULL` | unix epoch ms |
| `updated_at` | `bigint NOT NULL` | unix epoch ms |
| `created_by` | `text NOT NULL` | subject identity (user or agent id) that created the record |

Records have no slug. They are identified by their UUID `id` within `(tenant_id, registry_id)`. Records do not exist outside a registry.

### FR-5 — Scoped identity / naming rules

Uniqueness scoping summary, inheriting T-0013 §3.1:

| Entity | Business key uniqueness scope |
|---|---|
| `application` | `(tenant_id, slug)` |
| `registry_def` | `(tenant_id, application_id, slug)` |
| `record` | no slug; identity is `(tenant_id, id)` |

No name or slug is globally unique. All uniqueness is tenant-scoped or tenant+application-scoped. This is a hard invariant, not a convention.

### FR-6 — Referential integrity across the namespace

1. A `registry_def` MUST reference an `application` within the same tenant: `FK (tenant_id, application_id) → application(tenant_id, id)`.
2. A `record` MUST reference a `registry_def` within the same tenant: `FK (tenant_id, registry_id) → registry_def(tenant_id, id)`.
3. Cross-tenant foreign keys are forbidden. Every FK's leading column is `tenant_id` to enforce this structurally (T-0013 §3.1).

### FR-7 — Grant-binding surface (the namespace as an authorization target)

The three-level hierarchy defines the **resource granularity levels** at which future authorization grants (T-0018) may bind. The permitted resource reference shapes are:

| Granularity | Reference shape | Meaning |
|---|---|---|
| Application-level | `{ kind: "application", tenant_id, application_id }` | Grant covers all registries and records within the application |
| Registry-level | `{ kind: "registry", tenant_id, application_id, registry_id }` | Grant covers all records within a single registry |
| Record-level | `{ kind: "record", tenant_id, registry_id, record_id }` | Grant covers a single record |

These reference shapes are the **contract surface** this spec defines for T-0018 to consume. T-0014 does not define grant entities, grant resolution logic, or permission semantics — those are T-0018. This spec fixes only that a grant resource reference MUST be expressible as one of the three shapes above, and that every component UUID in the reference is scoped under the same `tenant_id`.

### FR-8 — System-provisioned registries

The platform MAY provision system registries (e.g. the agent registry described in CONCEPT.md §7) as `registry_def` rows with `is_system = true`. These are:
- Provisioned at tenant initialization time (not by tenant admin CRUD).
- Visible in the namespace and grantable as authorization targets just like user-defined registries.
- Protected from deletion by tenant admins (`is_system = true` gates the delete path).
- No separate entity type — they are `registry_def` rows with a flag.

---

## 3. Non-Functional Requirements

### NF-1 — Tenant isolation (inherited from T-0013, non-negotiable)

All three entities (`application`, `registry_def`, `record`) are tenant-owned tables subject to the full T-0013 isolation contract:
- `tenant_id uuid NOT NULL` with no default, leading PK column.
- `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on every table.
- One default-DENY RLS policy per table keyed on the transaction-local GUC `choros.tenant_id`.
- No cross-tenant FK possible (structural enforcement via leading `tenant_id` on all FKs).
- All uniqueness scoped to tenant (or tenant+application); never global.
- All access through `withTenant(tenantId, ...)` wrapper — no raw queries outside transaction context.

### NF-2 — Extensibility: future registry types

The `registry_def.record_schema` field (JSONB, JSON Schema) enables schema evolution without DDL changes: adding fields to a registry is a schema update on `registry_def`, not a table migration. The object model does not need a separate `registry_type` discriminator in the MVP — all registries share the same structure; behavioral differentiation (system vs user, opaque handle semantics per T-0015) is achieved via flags and the `is_system` field, not separate tables.

### NF-3 — Stable namespace references for grants

Application IDs, registry IDs, and record IDs are immutable UUIDs. Renaming a `slug` or `display_name` does NOT change the `id`. This ensures grant bindings (T-0018) referencing an `application_id` or `registry_id` remain valid after a rename operation.

### NF-4 — No orphaned data

The model enforces structural no-orphan via FK constraints: a `registry_def` cannot exist without its parent `application`; a `record` cannot exist without its parent `registry_def`. Cascade delete policy (soft-delete vs hard-delete with cascade) is an implementation choice for T-0053; the spec requires that the choice is explicit and does not produce orphaned rows.

### NF-5 — Performance: tenant-id as leading index column

Per T-0013, `tenant_id` is the leading column of every composite index. For this model, the primary access pattern is `(tenant_id, application_id)` → list registries, and `(tenant_id, registry_id)` → list records. Indexes MUST be ordered accordingly.

---

## 4. Out of Scope

The following are explicitly NOT part of T-0014:

1. **Grant / authority model (T-0018):** who has what permission on what resource, role definitions, grant resolution logic, the `grant` table schema — all T-0018.
2. **Opaque object handles (T-0015):** the mechanism by which processes reference records without embedding data in process variables — T-0015.
3. **Database migrations / DDL:** authoring the actual `CREATE TABLE` SQL, RLS policy bodies, index DDL — T-0053. This spec defines the object model contract; DDL is T-0053's zone.
4. **UI / API endpoints:** no UI views, REST route definitions, or API contract for CRUD operations on applications/registries/records.
5. **Record-level access control enforcement:** the `record` entity has the necessary identity fields to be a grant target (FR-7), but the enforcement logic is T-0018.
6. **Flowable process integration:** how running process instances reference registry records via the external worker API is T-0015 / Etap 2 scope.
7. **Keycloak / identity provisioning:** user and agent identity, JWT claims beyond `tenant_id` — T-0013 and identity tasks.
8. **Agent registry as a product feature:** the agent registry is an example of a system-provisioned registry (`is_system=true`); its specific schema and provisioning logic are Etap 2 tasks, not T-0014.

---

## 5. Acceptance Criteria

Each criterion below is phrased as a CI-checkable test or fitness function. All live-DB criteria activate in T-0053 (when Postgres exists); static checks can run now.

| ID | Text | Verifiable as |
|---|---|---|
| **AC-1** | For every table in `{application, registry_def, record}`: `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = $table` returns `(true, true)`. Zero exceptions. | test (live-T-0053) |
| **AC-2** | For every table in `{application, registry_def, record}`: inserting a row with `tenant_id = NULL` as `choros_migrator` MUST raise a NOT NULL violation. | test (live-T-0053) |
| **AC-3** | With no `SET LOCAL choros.tenant_id`, `SELECT count(*) FROM application` (and registry_def, record) as `choros_app` returns 0 (default-DENY posture). | test (live-T-0053) |
| **AC-4** | With `SET LOCAL choros.tenant_id = tenant_A`, `SELECT count(*) FROM application WHERE tenant_id = tenant_B` returns 0 for any `tenant_B ≠ tenant_A`. Same for registry_def and record. | test (live-T-0053) |
| **AC-5** | Two different tenants MAY each have an `application` with `slug = 'procurement'` — no uniqueness violation. A second `application` with `slug = 'procurement'` within the SAME tenant MUST raise a unique violation. | test (live-T-0053) |
| **AC-6** | Two different applications within the same tenant MAY each have a `registry_def` with `slug = 'requests'` — no uniqueness violation. A second `registry_def` with `slug = 'requests'` within the SAME `(tenant_id, application_id)` MUST raise a unique violation. | test (live-T-0053) |
| **AC-7** | Inserting a `registry_def` with an `application_id` that does not exist in `application` for the same `tenant_id` MUST raise a FK violation. | test (live-T-0053) |
| **AC-8** | Inserting a `record` with a `registry_id` that does not exist in `registry_def` for the same `tenant_id` MUST raise a FK violation. | test (live-T-0053) |
| **AC-9** | For every FK on `{registry_def, record}` (i.e. `application_id`, `registry_id`), `SELECT attnum FROM pg_attribute WHERE attname = 'tenant_id'` for the referencing index MUST be position 1 (leading column). Verified by the FF-5 probe from T-0013. | test (live-T-0053) |
| **AC-10** | Renaming an `application.slug` (UPDATE) does NOT change `application.id`. The `registry_def` rows still reference the same `(tenant_id, application_id)` and no FK violation occurs. | test (live-T-0053) |
| **AC-11** | Renaming a `registry_def.slug` does NOT change `registry_def.id`. Any record in `record` still has a valid `registry_id`. | test (live-T-0053) |
| **AC-12** | Attempting to delete an `application` that has at least one `registry_def` MUST either raise a FK violation (if hard-delete with no cascade) or the application-level API MUST reject the operation with an explicit error (if soft-delete). Result: no orphaned `registry_def` row exists without a parent `application`. | test (live-T-0053) |
| **AC-13** | Attempting to delete a `registry_def` that has at least one `record` MUST either raise a FK violation or the API MUST reject with an explicit error. No orphaned `record` row. | test (live-T-0053) |
| **AC-14** | A `registry_def` with `is_system = true` cannot be deleted via the tenant-admin API path — the delete MUST be rejected with an explicit error. | test (live-T-0053) |
| **AC-15** | A valid grant-binding reference for a registry-level grant `{ kind: "registry", tenant_id, application_id, registry_id }` can be constructed from the `registry_def` row: all three UUID fields exist as columns, none is null, and `application_id` references a real `application.id` within the same tenant. Verified by a static schema lint that checks the three reference shapes in FR-7 against the column definitions of the three tables. | fitness (static-now) |
| **AC-16** | The `known_tenant_tables` CI fixture (introduced by T-0013 FF-2) is extended to include `application`, `registry_def`, and `record`. CI fails if any of these three tables lacks FORCE RLS. | test (static-now + live-T-0053) |
| **AC-17** | Inserting a `record` with `data` that does not conform to the parent `registry_def.record_schema` MUST be rejected at the application layer before the INSERT reaches the database. A conforming `data` payload MUST be accepted. | test (live-T-0053) |

---

## 6. Open Items / Resolved Ambiguities

The following potential ambiguities were evaluated against the source documents and resolved without escalation:

- **"Application" as container vs. registry:** CONCEPT.md §7 states "'Приложения' — справочники и реестры … JSON Schema + JSONB". The discovery doc Q13 explicitly posits "3 уровня данных (Раздел/Приложение → Реестр → Запись)" as the founder's hypothesis. This spec adopts that 3-level hierarchy, with `application` as the container and `registry_def` as the typed collection inside it.
- **`registry_def` vs. `registry` naming:** the task title explicitly names `registry_def` as the definition entity (the schema/metadata), distinct from individual records. This spec models `registry_def` as the definition table and `record` as instances, consistent with the task scope.
- **System registries:** CONCEPT.md §7 describes the agent registry as "такие же объекты с правами чтения/записи" — same objects with read/write rights. This spec models system registries as `registry_def` rows with `is_system = true`, not a separate table, which is the minimal and consistent approach.
- **Record-level grant granularity:** CONCEPT.md §7 states "права на уровне **записей** через роли". This spec includes record-level as a permitted grant-binding granularity in FR-7 while deferring the enforcement mechanism to T-0018.

No blocking questions remain.
