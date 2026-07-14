# ADR · T-0085 — Per-record expand/contract object-schema versioning (E12.4, day-1)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-12
**Task:** E12.4 — per-record schema version tracking, rollback guard, TS validation utility, CI fitness gate
**Spec:** `docs/specs/T-0085-record-schema-versioning.spec.md` (status: ready, AC-1..AC-10, date 2026-06-12)
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — `tenant_id` leading PK, `ENABLE`+`FORCE ROW LEVEL SECURITY`, default-DENY policy `USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)`, `choros_app` NOBYPASSRLS non-owner, `SET LOCAL choros.tenant_id` contract.
- `migrations/004_registry_def.sql` (T-0014) — `registry_def(tenant_id, id, record_schema jsonb NOT NULL, …)` baseline; `GRANT SELECT, INSERT, UPDATE, DELETE TO choros_app`.
- `migrations/005_record.sql` (T-0014) — `record(tenant_id, id, registry_id, data jsonb NOT NULL, …)` baseline; FK `(tenant_id, registry_id) → registry_def(tenant_id, id)`; `GRANT SELECT, INSERT, UPDATE, DELETE TO choros_app`.
- `migrations/017_data_classification.sql` (T-0033) — `data_classification.facet_schema_version integer NOT NULL` already names the schema-version axis; no FK back to `registry_def.record_schema_version` (logical descriptor, not row ID — same pattern as `role_id` in `grant`).
- `docs/design/extensibility-and-authoring.md` §7 — ratified decisions: DRAIN-by-default, per-record expand/contract day-1, rollback forward-only/blocked, Camunda-mapping = on-demand Stage-2 escalation.
- `docs/design/extensibility-and-authoring.md` §9.5 (gard #5) — «Per-record expand/contract object-schema versioning заложить в модель данных с day-1 (§14 «потом дорого»)». NOT re-opened here.

**Migration slot:** `056` (highest on-disk slot is `055_fix_mcp_tool_demo_tenant.sql`; slot `070` is the next free slot (head is 069 on dev b02e24b)).

---

## 1. Decision

**Add `schema_version integer NOT NULL DEFAULT 1` to `record` and `record_schema_version integer NOT NULL DEFAULT 1` to `registry_def` in a single new migration `070_record_schema_versioning.sql`. Three triggers enforce invariants at the DB layer: (a) BEFORE INSERT on `record` defaults `schema_version` from the registry's current `record_schema_version`; (b) BEFORE UPDATE on `registry_def` increments `record_schema_version` atomically when `record_schema` changes; (c) BEFORE UPDATE on `record` raises an error if any attempt to modify `schema_version`. A fourth SQL function `choros.fn_check_rollback_safe(tenant_id, registry_id, target_version)` returns `FALSE` when records with `schema_version > target_version` exist — the forward-only rollback gate. A new `registry_schema_history(tenant_id, registry_id, schema_version, schema_json, created_at)` table — with tenant_id-leading PK, ENABLE+FORCE RLS, default-DENY policy, `SELECT, INSERT` grant to `choros_app` — provides the runtime schema-history lookup needed by the TS validation utility and the CI gate. A pure TypeScript module `src/core/record-schema-validator.ts` exports `validateRecordAgainstSchema` (AJV-backed, no pg/fs/net, DATABASE_URL-free, unit-testable). A bash CI check `ci/checks/record-schema-compat.sh` (static assertions + self-test section, skip if no DATABASE_URL) is added to `npm run fitness`. `registry_schema_history` is appended to `ci/checks/known_tenant_tables.txt`.**

### 1.1 Single migration file (056), not a split

All DDL for both column additions, all four trigger functions, the rollback-safe SQL function, and the `registry_schema_history` table are applied in one `run.mjs` transaction. Splitting across two files gains nothing (intra-file FK ordering resolves within the file; the runner applies one file per transaction, so one file is strictly atomic). Slot 069 is taken (bundle_commit). Next free = 070.

### 1.2 Trigger semantics: content-aware, not diff-aware

`fn_registry_def_schema_version_increment` fires `WHEN (NEW.record_schema IS DISTINCT FROM OLD.record_schema)`. The `IS DISTINCT FROM` operator handles NULL equality correctly, and it bumps on every schema change without semantic JSON diffing. ADR §7 explicitly says «bumps on every UPDATE» — no semantic diff — so this is the right simplification. The schema-change-classifier (T-0177) handles semantic diff independently; T-0085 only tracks *that* a change happened.

### 1.3 `registry_schema_history` as table-backed audit (Option B)

ADR §7 and spec §3 FR-7 allow Option A (git-backed) or Option B (table-backed); spec §5 out-of-scope explicitly says «day-1 uses table-backed history (Option B). Git integration is Stage-2.» The table is the runtime lookup target for `validateRecordAgainstSchema` — there is no in-process alternative that does not require a DB query or a hardcoded schema bundle. Trigger `fn_registry_def_schema_version_audit` appends a row to `registry_schema_history` AFTER UPDATE on `registry_def` when `record_schema` changes. This is a separate AFTER trigger (not the BEFORE increment trigger) so the row captures the `NEW.record_schema_version` after it has already been incremented.

### 1.4 `validateRecordAgainstSchema` is pure TypeScript (no pg)

The function signature is:

```typescript
validateRecordAgainstSchema(
  record: { data: object; schema_version: number },
  schemaHistory: SchemaHistoryMap,
): { valid: boolean; errors: string[] }
```

`SchemaHistoryMap = Map<number, object>` — a plain map from version number to JSON Schema object. Callers (API layer, CI check) are responsible for hydrating the map from `registry_schema_history` rows. This keeps the pure-core module free of pg/fs/net (AC-10 npm test without DATABASE_URL). The unit tests in `src/__tests__/record-schema-validator.test.ts` use inline hardcoded `SchemaHistoryMap` values.

### 1.5 Rollback gate is a SQL function, not a trigger

`choros.fn_check_rollback_safe(p_tenant_id, p_registry_id, p_target_version)` returns `boolean`. It does NOT auto-block the UPDATE on `registry_def.record_schema_version` — that would prevent legitimate rollback after a full forward-migration. Instead it is a pre-flight query that the application or operator runs before attempting a rollback. Per spec FR-5 and ADR §7, lossy-migration + rollback with live instances is a red-lined human-gate; the function provides the gate test, not an automatic deny trigger.

### 1.6 CI check structure (static-first, DB-optional)

`ci/checks/record-schema-compat.sh` has two sections:

1. **Static assertions (always run, no DATABASE_URL needed):** module exists, exports present, no forbidden imports.
2. **DB section (skips cleanly if `DATABASE_URL` unset):** samples up to 5 records per registry, validates each against its stored schema version via a plpgsql inline query, includes a SELF-TEST that inserts a v1 record, bumps the schema to v2, and asserts that the v1 record fails v2 validation but passes v1.

This mirrors the pattern in `budget-dormancy.sh` (static) and `db-isolation-*.sh` (DB-gated).

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Store schema version in `data` JSONB (e.g., `data._schema_version`)** | Violates schema/data separation: the JSONB `data` is the object payload, not metadata. Schema version bleeds into the product's data model; Field-level classification and validation code must now skip the meta-key. The column approach is clean, queryable, indexable, and immutable via trigger — the data blob is opaque payload only. |
| **Derive version from `registry_def.updated_at` or a hash of `record_schema`** | `updated_at` is not a version counter (it can be updated without schema change; it is not monotonically increasing in the database sense). A hash is content-addressable but not ordered — you cannot express «records on version ≤ N» for rollback-safe queries. A monotone integer is the only correct type for a version counter. |
| **Semantic diff trigger (increment only if JSON Schema meaning changed)** | ADR §7 explicitly rejects semantic-diff: «bumps on every UPDATE, simplifies contract». Semantic diffing belongs to the schema-change-classifier (T-0177); mixing it into the versioning trigger couples two responsibilities and creates test complexity for no day-1 benefit. |
| **Auto-blocking trigger on `registry_def.record_schema_version` UPDATE** | Would prevent legitimate schema management operations (e.g., resetting a draft registry). ADR §7 specifies forward-only rollback as a red-lined human-gate, not an automatic DB-level deny. The SQL function provides the check; the gate is enforced at the application/operator layer where context is available. |
| **Option A (git-backed schema history)** | Spec §5 explicitly parks git-backed history as Stage-2 out-of-scope for T-0085. Runtime lookup of historical schemas requires either a DB table or a bundled config directory; the table is the simpler day-1 choice and does not require git integration at deploy time. |
| **Single combined BEFORE UPDATE trigger (increment + immutability on same trigger)** | Two separate triggers (`registry_def_schema_version_increment` and `record_schema_version_immutable`) on different tables are already separate. On `record`, the immutability check is a BEFORE UPDATE. Combining the increment and the audit-append into one trigger would require mixing BEFORE (for the NEW.record_schema_version value) with AFTER (for the audit row); PostgreSQL triggers must be one or the other. Split is correct. |
| **Separate migration for `registry_schema_history` table** | The history table is a direct dependency of the version-tracking mechanism; applying column additions without the history table leaves the system in a state where `registry_def.record_schema_version` increments but history is unrecorded. One atomic transaction (single migration file) is safer. |

---

## 3. Object model (full DDL contract for coder/tester)

All new tables: schema `choros`; PK `(tenant_id, …)`; `ENABLE`+`FORCE ROW LEVEL SECURITY`; policy `<table>_tenant_isolation USING (tenant_id = current_setting('choros.tenant_id', true)::uuid) WITH CHECK (same)`. Timestamps `bigint` (epoch-ms). Validated live pattern per T-0023/T-0033 precedent.

### 3.1 Column additions (migration 056, rev-2 per review F-1)

**`choros.record`** — additive `ALTER TABLE` (two-step: backfill, then drop permanent DEFAULT):

```sql
ALTER TABLE choros.record ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE choros.record ALTER COLUMN schema_version DROP DEFAULT;
```

The first ALTER initializes existing rows to 1 (backfill). The second DROP DEFAULT is critical: it ensures all subsequent INSERTs bypass the column default and go through the BEFORE INSERT trigger `record_schema_version_default`, which reads the registry's current `record_schema_version`. WITHOUT the DROP, Postgres applies DEFAULT 1 before the trigger fires, causing the trigger's `IF NEW.schema_version IS NULL` check to never execute — all new records would get v1 regardless of the registry's version.

| Field | Type | Constraint |
|---|---|---|
| `schema_version` | `integer NOT NULL` (no DEFAULT after migration) | Immutable after INSERT (trigger `record_schema_version_immutable`); defaults to registry's `record_schema_version` at INSERT (trigger `record_schema_version_default`) |

**`choros.registry_def`** — additive `ALTER TABLE`:

| Field | Type | Constraint |
|---|---|---|
| `record_schema_version` | `integer NOT NULL DEFAULT 1` | Incremented by trigger `registry_def_schema_version_increment` on every UPDATE that changes `record_schema` |

### 3.2 `registry_schema_history` (new table)

| Field | Type | Constraint |
|---|---|---|
| `tenant_id` | `uuid NOT NULL` | Leading PK column |
| `registry_id` | `uuid NOT NULL` | PK col 2; FK `(tenant_id, registry_id) → registry_def(tenant_id, id)` |
| `schema_version` | `integer NOT NULL` | PK col 3 |
| `schema_json` | `jsonb NOT NULL` | The full `record_schema` at this version |
| `created_at` | `bigint NOT NULL` | epoch-ms; set at append time |

Primary key: `(tenant_id, registry_id, schema_version)`.
Foreign key: `FOREIGN KEY (tenant_id, registry_id) REFERENCES choros.registry_def(tenant_id, id)`.
RLS: `ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY`.
Policy: `registry_schema_history_tenant_isolation USING (tenant_id = current_setting('choros.tenant_id', true)::uuid) WITH CHECK (same)`.
Grant: **`SELECT, INSERT ON choros.registry_schema_history TO choros_app`** (no UPDATE, no DELETE — history is append-only).

### 3.3 Trigger functions (migration 056)

**`choros.fn_record_schema_version_default()` — BEFORE INSERT on `choros.record`**

```sql
IF NEW.schema_version IS NULL THEN
  SELECT record_schema_version INTO NEW.schema_version
    FROM choros.registry_def
   WHERE tenant_id = NEW.tenant_id AND id = NEW.registry_id;
  IF NEW.schema_version IS NULL THEN NEW.schema_version := 1; END IF;
END IF;
RETURN NEW;
```

Trigger name: `record_schema_version_default`. FOR EACH ROW.

**`choros.fn_record_schema_version_immutable()` — BEFORE UPDATE on `choros.record`**

```sql
IF NEW.schema_version != OLD.schema_version THEN
  RAISE EXCEPTION 'record.schema_version is immutable after creation'
    USING ERRCODE = 'restrict_violation';
END IF;
RETURN NEW;
```

Trigger name: `record_schema_version_immutable`. FOR EACH ROW.

**`choros.fn_registry_def_schema_version_increment()` — BEFORE UPDATE on `choros.registry_def`**

```sql
IF NEW.record_schema IS DISTINCT FROM OLD.record_schema THEN
  NEW.record_schema_version := OLD.record_schema_version + 1;
END IF;
RETURN NEW;
```

Trigger name: `registry_def_schema_version_increment`. FOR EACH ROW.

**`choros.fn_registry_def_schema_version_audit()` — AFTER UPDATE on `choros.registry_def`**

```sql
IF NEW.record_schema IS DISTINCT FROM OLD.record_schema THEN
  INSERT INTO choros.registry_schema_history
    (tenant_id, registry_id, schema_version, schema_json, created_at)
  VALUES
    (NEW.tenant_id, NEW.id, NEW.record_schema_version, NEW.record_schema,
     EXTRACT(EPOCH FROM clock_timestamp())::bigint * 1000);
END IF;
RETURN NULL;  -- AFTER trigger, return value ignored
```

Trigger name: `registry_def_schema_version_audit`. FOR EACH ROW.

### 3.4 SQL function

**`choros.fn_check_rollback_safe(p_tenant_id uuid, p_registry_id uuid, p_target_version integer) RETURNS boolean`**

```sql
DECLARE v_max integer;
BEGIN
  SELECT MAX(schema_version) INTO v_max
    FROM choros.record
   WHERE tenant_id = p_tenant_id AND registry_id = p_registry_id;
  IF v_max IS NULL THEN RETURN true; END IF;
  RETURN v_max <= p_target_version;
END;
```

Returns `TRUE` if rollback to `p_target_version` is safe (no records exist on a higher version). Returns `FALSE` if blocked (records exist with `schema_version > p_target_version`). Called by the application pre-flight before any schema rollback operation.

### 3.5 TypeScript module `src/core/record-schema-validator.ts`

```typescript
export type SchemaHistoryMap = Map<number, object>;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates record.data against the historical JSON Schema for the record's
 * stored schema_version. Pure: no pg, fs, net, http. DATABASE_URL not required.
 * The caller hydrates schemaHistory from registry_schema_history rows.
 */
export function validateRecordAgainstSchema(
  record: { data: object; schema_version: number },
  schemaHistory: SchemaHistoryMap,
): ValidationResult
```

Implementation: uses `ajv` (already in project dependencies) to compile the JSON Schema for `record.schema_version` from `schemaHistory` and validates `record.data`. If `schemaHistory` has no entry for `record.schema_version`, returns `{ valid: false, errors: ['schema version N not found in history'] }`.

No pg, fs, net, http, child_process, import.meta, process.env references. AJV is a pure in-process validator.

Unit tests live in `src/__tests__/record-schema-validator.test.ts`. Tests use hardcoded `SchemaHistoryMap` values and run under `npm test` without `DATABASE_URL`.

---

## 4. Migration plan

**`migrations/070_record_schema_versioning.sql`** — single file, applied in one transaction by `run.mjs`.

Intra-file order:
1. `ALTER TABLE choros.record ADD COLUMN schema_version integer NOT NULL DEFAULT 1` (existing rows seeded with 1).
2. `ALTER TABLE choros.registry_def ADD COLUMN record_schema_version integer NOT NULL DEFAULT 1` (existing registries seeded with 1).
3. `CREATE TABLE choros.registry_schema_history (…)` + RLS + policy + `SELECT, INSERT` grant.
4. `CREATE OR REPLACE FUNCTION choros.fn_record_schema_version_default()` + trigger `record_schema_version_default` BEFORE INSERT on `record`.
5. `CREATE OR REPLACE FUNCTION choros.fn_record_schema_version_immutable()` + trigger `record_schema_version_immutable` BEFORE UPDATE on `record`.
6. `CREATE OR REPLACE FUNCTION choros.fn_registry_def_schema_version_increment()` + trigger `registry_def_schema_version_increment` BEFORE UPDATE on `registry_def`.
7. `CREATE OR REPLACE FUNCTION choros.fn_registry_def_schema_version_audit()` + trigger `registry_def_schema_version_audit` AFTER UPDATE on `registry_def`.
8. `CREATE OR REPLACE FUNCTION choros.fn_check_rollback_safe(…)` RETURNS boolean.

### 4.1 `known_tenant_tables.txt` update

Append `registry_schema_history` to `ci/checks/known_tenant_tables.txt`. This causes the dynamic `FF-RLS`, `FF-LEAD`, and `FF-ROLE` checks in `ci/checks/db/schema.test.ts` to cover the new table automatically (additive, no test code changes). `cross_tenant.test.ts` will also need a `seedRowForTable` case for `registry_schema_history` (coder seam, mirrors T-0023/T-0033 precedent).

### 4.2 `npm run fitness` update (package.json)

Add `bash ci/checks/record-schema-compat.sh` to the `fitness` script in `package.json`. This is a coder seam: the ADR specifies the script; coder registers it in the fitness chain.

### 4.3 AJV dependency

`ajv` is a standard JSON Schema validator. Coder must confirm `ajv` is already a dependency (or add it). It is a pure in-process package with no pg/fs/net surface. If not present, `npm install ajv` (no infrastructure change).

---

## 5. CI check design: `ci/checks/record-schema-compat.sh`

```
#!/usr/bin/env bash
# T-0085 · FF-RSV-1..FF-RSV-5: record-schema-compat
#
# Section A — static assertions (no DATABASE_URL):
#   RSV-1: src/core/record-schema-validator.ts exists.
#   RSV-2: Module exports validateRecordAgainstSchema, SchemaHistoryMap,
#           ValidationResult (public surface).
#   RSV-3: Module imports no pg/fs/net/http/child_process/import.meta/process.env.
#
# Section B — DB probes (skip if DATABASE_URL unset):
#   RSV-4: Trigger self-test — INSERT record without schema_version, verify
#          schema_version equals registry's current record_schema_version.
#   RSV-5: SELF-TEST — insert v1 record, bump schema to v2, verify
#          fn_check_rollback_safe returns false; v1 record passes v1 validation,
#          fails v2 validation. Exit non-zero if SELF-TEST false.
```

The SELF-TEST section in Section B inserts a dev-tenant registry with a minimal v1 schema `{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}`, inserts a record `{"name":"Alice"}` (schema_version auto-defaults to 1), then UPDATEs the registry's `record_schema` to add a required field `{"required":["name","email"]}`, reads `record_schema_version` (should be 2), calls `fn_check_rollback_safe(tenant_id, registry_id, 1)` (should return false), and validates the v1 record against both v1 (pass) and v2 (fail — missing `email`). Cleans up via ROLLBACK (all inside a transaction). Exit 0 if all pass, exit 1 with diagnostic on any failure.

Section A runs always (static grep, no DB), so `npm run fitness` without DATABASE_URL stays green (AC-10).

---

## 6. Fitness functions

### FF-RSV-1 — Module exists and exports correct public surface
**Rule:** `src/core/record-schema-validator.ts` exists; exports `validateRecordAgainstSchema`, `SchemaHistoryMap`, `ValidationResult`.
**CI check:** `ci/checks/record-schema-compat.sh` Section A RSV-1/RSV-2 (static grep). Covers AC-7 structure.

### FF-RSV-2 — Module is pure (no pg/fs/net/http)
**Rule:** `src/core/record-schema-validator.ts` contains no `pg`, `node:fs`, `node:net`, `node:http`, `child_process`, `import.meta`, `process.env`.
**CI check:** `ci/checks/record-schema-compat.sh` Section A RSV-3. Covers AC-10 (npm test without DATABASE_URL — pure module cannot break non-DB test runs).

### FF-RSV-3 — Unit tests cover v1-pass/v2-fail scenario
**Rule:** `src/__tests__/record-schema-validator.test.ts` exists; tests cover (a) record validates against its own version, (b) record under v1 fails v2 schema when v2 adds a required field.
**CI check:** `npm test` (vitest, no DATABASE_URL). Covers AC-7.

### FF-RSV-4 — `registry_schema_history` is a tenant table (RLS + isolation)
**Rule:** `registry_schema_history` exists with ENABLE+FORCE RLS, `registry_schema_history_tenant_isolation` policy, `choros_app` SELECT/INSERT only (no UPDATE/DELETE).
**CI check:** `ci/checks/db/schema.test.ts` FF-RLS / FF-LEAD / FF-ROLE dynamic iteration once `registry_schema_history` is appended to `known_tenant_tables.txt`; additionally `ci/checks/db/schema.test.ts` can assert `has_table_privilege('choros_app','choros.registry_schema_history','UPDATE') = false`. Covers AC-9.

### FF-RSV-5 — `record.schema_version` immutable (trigger)
**Rule:** BEFORE UPDATE trigger on `record` raises `restrict_violation` if any UPDATE changes `schema_version`.
**CI check:** `ci/checks/record-schema-compat.sh` Section B RSV-4 self-test (attempt UPDATE schema_version, verify error). Covers AC-5.

### FF-RSV-6 — Default schema version on INSERT (trigger)
**Rule:** INSERT into `record` without explicit `schema_version` sets it to the registry's current `record_schema_version`.
**CI check:** `ci/checks/record-schema-compat.sh` Section B RSV-4. Covers AC-3.

### FF-RSV-7 — Registry schema version increments on schema change (trigger)
**Rule:** UPDATE `registry_def.record_schema` → `record_schema_version` increments by 1; second UPDATE increments again.
**CI check:** `ci/checks/record-schema-compat.sh` Section B SELF-TEST (update schema twice, verify v1→v2→3). Covers AC-4.

### FF-RSV-8 — Rollback guard function (forward-only)
**Rule:** `fn_check_rollback_safe(t, r, v)` returns FALSE when records exist with `schema_version > v`; returns TRUE when no such records exist.
**CI check:** `ci/checks/record-schema-compat.sh` Section B SELF-TEST (insert v2 record, check rollback to v1 blocked). Covers AC-6.

### FF-RSV-9 — Migration 056 applies cleanly; existing data seeded at version 1
**Rule:** Migration 056 runs without error on both a fresh Postgres and the live silo; all existing `record` rows have `schema_version = 1`; all existing `registry_def` rows have `record_schema_version = 1`.
**CI check:** `npm run fitness:db` (live DB probe via `db/schema.test.ts` dynamic iteration). Covers AC-1, AC-2.

### FF-RSV-10 — TypeScript compilation and existing tests green
**Rule:** `npx tsc --noEmit` exits 0; `npm test` exits 0 without `DATABASE_URL`.
**CI check:** `npm run ci` (tsc + eslint + fitness + vitest). Covers AC-10.

---

## 7. Traceability

| AC | Covered by |
|---|---|
| AC-1 | Migration 056 `ALTER TABLE record ADD COLUMN schema_version integer NOT NULL DEFAULT 1`; seeded on existing rows. FF-RSV-9 (db probe). |
| AC-2 | Migration 056 `ALTER TABLE registry_def ADD COLUMN record_schema_version integer NOT NULL DEFAULT 1`; seeded on existing registries. FF-RSV-9 (db probe). |
| AC-3 | Trigger `record_schema_version_default` (BEFORE INSERT on `record`). FF-RSV-6 / `record-schema-compat.sh` Section B. |
| AC-4 | Trigger `registry_def_schema_version_increment` (BEFORE UPDATE on `registry_def`, `IS DISTINCT FROM`). FF-RSV-7 / `record-schema-compat.sh` SELF-TEST. |
| AC-5 | Trigger `record_schema_version_immutable` (BEFORE UPDATE on `record`, `restrict_violation`). FF-RSV-5 / `record-schema-compat.sh` Section B. |
| AC-6 | SQL function `choros.fn_check_rollback_safe(tenant_id, registry_id, target_version)`. FF-RSV-8 / `record-schema-compat.sh` SELF-TEST. |
| AC-7 | `src/core/record-schema-validator.ts` + `validateRecordAgainstSchema(record, schemaHistory)`; unit tests in `src/__tests__/record-schema-validator.test.ts`. FF-RSV-1/FF-RSV-3. |
| AC-8 | `ci/checks/record-schema-compat.sh` (Section A static + Section B DB probes + SELF-TEST). FF-RSV-6/FF-RSV-7/FF-RSV-8. |
| AC-9 | `registry_schema_history` table: `(tenant_id, registry_id, schema_version)` PK, ENABLE+FORCE RLS, tenant-isolation policy, `SELECT, INSERT` grant to `choros_app`. FF-RSV-4 / `schema.test.ts` dynamic via `known_tenant_tables.txt`. |
| AC-10 | Pure TS module (no pg/fs/net); `validateRecordAgainstSchema` unit tests with inline `SchemaHistoryMap`; `npm test` without `DATABASE_URL`. FF-RSV-2/FF-RSV-10. |

---

## 8. Downstream contracts (frozen seams)

- **C-1 · T-0086 (expand/contract migration execution):** `record.schema_version` is the version axis T-0086 reads and updates during record migration. T-0086 MUST use `fn_check_rollback_safe` before any rollback operation. `schema_version` is immutable via trigger; T-0086 must INSERT new records at the target version (not UPDATE old ones).
- **C-2 · T-0033 `data_classification.facet_schema_version`:** already uses the logical version integer (no FK by design); `registry_def.record_schema_version` is now the authoritative counter that `facet_schema_version` values refer to.
- **C-3 · T-0177 schema-change-classifier:** reads `registry_def.record_schema` for before/after diff. T-0085 adds `record_schema_version` (counter) and `registry_schema_history` (history); T-0177 is additive and not broken.
- **C-4 · T-0087 changelog UI:** consumes `registry_schema_history` rows as the ordered version history. Table shape `(tenant_id, registry_id, schema_version, schema_json, created_at)` is the stable surface.
- **C-5 · T-0013 RLS contract:** `registry_schema_history` follows the T-0013 pattern exactly (tenant_id leading PK, ENABLE+FORCE RLS, default-DENY, choros_app DML restricted). No deviation.

---

## 9. Runtime target

PostgreSQL 14+ in the silo docker-compose stack (T-0053). The migration runner `migrations/run.mjs` applies `070_record_schema_versioning.sql` as `choros_migrator` in one transaction. `choros_app` (NOBYPASSRLS, non-owner) receives per-table grants as specified. The AFTER trigger `registry_def_schema_version_audit` appends to `registry_schema_history` within the same transaction as the schema update (atomic; no race between version increment and history append). Day-1 the tables are live and functional; the validation utility is callable by any API layer that hydrates a `SchemaHistoryMap` from `registry_schema_history`.
