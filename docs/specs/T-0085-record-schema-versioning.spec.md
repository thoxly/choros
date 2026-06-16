# Spec · T-0085 — Per-record expand/contract object-schema versioning (day-1 data model)

**Status:** ready  
**Phase:** SPEC  
**Date:** 2026-06-12  
**Task:** T-0085 (E12.4 · extensibility, prio TBD)

---

## 1. Context

ADR extensibility-and-authoring.md §7 (Развилка 4 — версионность + миграция инстансов) and §9.5 (инженерные гарды day-1) establish that **per-record expand/contract object-schema versioning** must be embedded in the data model from day-1, not retrofitted later.

The mechanism supports:
- **DRAIN-by-default:** old process instances complete on their original record-schema version.
- **Forward-only rollback:** deployments cannot downgrade schema version while old instances exist on the old version.
- **Deprecation-first + expand/contract:** non-destructive schema migration (add field, deprecate field, then drop only after all records upgraded).

Current state (as of migration 005, 004, 017):
- `record` table: stores tenant-scoped `(tenant_id, id)`, registry reference, JSONB `data`, audit timestamps.
- `registry_def` table: stores the **canonical** `record_schema` (JSON Schema).
- `data_classification` table: stores field-level data classification by schema version (`facet_schema_version` field).

**The gap:** no per-record schema version tracking. All records implicitly assume the current `registry_def.record_schema`; there is no way to identify which version of the schema a given record was stored under, nor to validate/migrate records independently by version.

---

## 2. Precise problem: why this matters day-1

From ADR §14 (CONCEPT):

> **Миграция инстансов при изменении процесса — заложить в модель данных с первого дня, потом дорого.**

When a registry's `record_schema` changes:

1. **Old process instances** (BPMN instances referencing old schema) must be able to read/write records using the old version.
2. **New records** created after schema change must use the new version.
3. **Migration** (expand/contract, deprecation-first) happens independently; records can live under multiple versions simultaneously.
4. **Rollback** must be prevented if old instances still depend on old schema (red-line).

Without per-record schema versioning:
- Changing `registry_def.record_schema` silently invalidates all old records (read fails, write fails, CI gates miss the incompatibility).
- No way to validate that a record conforms to its intended schema version.
- No way to distinguish "record created under v1" from "record created under v2" after the fact.
- Camunda-grade live-migration (mapping, expand/contract) becomes impossible — the system can't know what version the data is in.

---

## 3. Functional requirements

**FR-1 — Per-record schema version tracking**

Each `record` row must store an immutable `schema_version` integer column indicating which version of `registry_def.record_schema` the record conforms to. The column MUST:

- Be NOT NULL (no default deferral; default applied at INSERT).
- Be immutable after creation (no UPDATE allowed; triggers enforce).
- Default to the current registry's `record_schema` version at the time of INSERT (see FR-3).

**FR-2 — Registry schema version counter**

`registry_def` table MUST store a `record_schema_version` integer column (initially 1, incremented on each schema change):

- NOT NULL, DEFAULT 1 on table creation.
- When `record_schema` JSONB is updated (via any UPDATE statement), `record_schema_version` is atomically incremented by a trigger.
- The version is content-aware: changing `record_schema` always increments (no semantic diff — bumps on every UPDATE, simplifies contract).

**FR-3 — Default schema version at insertion**

Any INSERT into `record` without explicit `schema_version` MUST default to the current `registry_def.record_schema_version` for that record's registry. Implemented via:

- BEFORE INSERT trigger on `record` that reads the registry's current version and sets `schema_version` if NULL.
- Alternative: application-enforced (API always populates `schema_version`); trigger is a safety net.

**FR-4 — Schema validation and compatibility checking**

A **suite of utilities** (SQL functions or TypeScript helpers) MUST exist to validate a record against its stored schema version:

- `check_record_schema_compat(tenant_id, record_id, registry_id) → {compliant: bool, errors: string[]}`
  - Reads the record's `schema_version`, looks up the corresponding schema version in git (or from a schema-history table).
  - Validates the record's `data` JSONB against that historical schema.
  - Returns errors if incompatible.
- CI must invoke this on sample records (see AC-2).

**FR-5 — Forward-only rollback prevention (red-line)**

The system MUST prevent rollback (reverting `registry_def.record_schema` to an older version) if any record exists with `schema_version > target_version`:

- Query: `SELECT COUNT(*) FROM record WHERE registry_id = $1 AND schema_version > $2`.
- If count > 0, the rollback is blocked; human-gate required (red-line).
- Error message: «Cannot rollback to schema version N: X records exist on version M > N. Migrate all records forward-only or delete them.»

**FR-6 — Expand/contract patterns (non-destructive migration)**

ADR specifies three primary patterns; the data model must support them:

- **Expand:** Add a new field to `record_schema` with default/optional value. Old records (lower version) can coexist; reads fill in default; writes use new field.
- **Contract (deprecation-first):** Mark a field as deprecated in `record_schema` (e.g., `"deprecated": true` in JSON Schema); reads still work; writes to new records exclude the field; old records keep the field.
- **Contract (drop):** Only after ALL records migrate forward (all `schema_version ≥ target`), the field is dropped from the schema. Blocked by FR-5 if old records exist.

Data model impact: `record_schema` JSON Schema MAY contain `"deprecated": true` markers (non-standard JSON Schema, application-interpreted). No schema table changes needed; these are semantic flags in the JSONB.

**FR-7 — Schema history (audit trail)**

There MUST be a way to reconstruct **any past version** of `registry_def.record_schema`:

- Option A (git-backed): Store schema versions in a config/migrations/ directory; git tags/refs mark versions. CI imports schema versions into a `registry_schema_history` table on deploy.
- Option B (table-backed): Create a `registry_schema_history(tenant_id, registry_id, schema_version, schema_json, created_at)` table; every schema change appends a row.

ADR §7 specifies git-under-hood; recommend Option A with Option B as fallback for runtime lookup. Minimal day-1 requirement: Option B table.

---

## 4. Non-functional requirements

**NF-1 — Schema version immutability after creation**

`record.schema_version` MUST NOT be writable after INSERT. Any UPDATE attempt on this column MUST raise an error (trigger or constraint).

**NF-2 — Atomic version increment**

When `registry_def.record_schema` is updated, incrementing `record_schema_version` MUST be atomic with the schema update (single transaction, no race condition).

**NF-3 — Backward compatibility (reads)**

Records with `schema_version < current` MUST remain readable. Read queries do not fail because schema version is older; validation is opt-in (FR-4).

**NF-4 — CI gate (schema-compat check)**

`npm run fitness` MUST include a check that:
- Samples records from multiple registries (at least 5 records per registry or all records if < 5).
- Validates each record against its stored `schema_version`.
- Exits non-zero if any record fails validation.
- Includes a self-test that verifies the check detects a synthetic incompatibility.

**NF-5 — No breaking changes to existing migrations**

Migrations 001–017 (including record.sql, registry_def.sql, data_classification.sql) MUST remain unchanged. The schema-versioning infrastructure is added in a NEW migration (e.g., 049, TBD by sequencing).

**NF-6 — Tenant isolation (RLS-respect)**

The new columns (`record.schema_version`, `registry_def.record_schema_version`, any history table) MUST respect the T-0013 RLS contract:
- tenant_id is a leading PK column (or leading FK filter for history table).
- Default-DENY RLS policies on any table that stores per-tenant data.
- choros_app role receives only DML (SELECT, INSERT, UPDATE, DELETE), not CREATE/ALTER.

**NF-7 — PostgreSQL compatibility**

All DDL, triggers, and queries MUST work on PostgreSQL 14+ (current baseline). No vendor-specific extensions beyond what Choros already uses (jsonb, uuid, range types).

---

## 5. Out of scope

- **Full in-flight live-migration UI/UX:** expand/contract are supported by the data model; the agent's UI to author migrations (Floor-2 code) is T-0086+.
- **Schema versioning for form-schema, DMN, MCP-grants:** T-0085 is object-schema only. Form-schema and MCP-grants versioning (ADR §7 «связка») are separate tasks (T-0088, T-0089).
- **Git-backed schema history:** Option A (git/config/schemas/) is OUT. Day-1 uses table-backed history (Option B). Git integration is Stage-2.
- **Camunda-grade fromActivity→toActivity mapping:** ADR §7 specifies mapping as on-demand escalation (not day-1). T-0085 provides the data model hook; mapping logic is Stage-2.
- **Migration execution** (applying expand/contract to all records in a registry): Contract is data-model only. Execution (running migrations, updating records) is T-0086.
- **Semantic changelog generation:** ADR §7 specifies changelog + one-click promote; T-0085 provides audit/versioning; changelog UI is T-0087.

---

## 6. Acceptance criteria

### AC-1 — record.schema_version column created (migration, data)

A new migration (e.g., 049_record_schema_versioning.sql) adds `schema_version integer NOT NULL` column to `record` table:

```sql
ALTER TABLE choros.record ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
```

Migration completes successfully on existing databases; all existing records are seeded with `schema_version = 1` (current baseline).

**Verifiable as:** migration

### AC-2 — registry_def.record_schema_version column created and incremented (migration, data)

The same migration adds `record_schema_version integer NOT NULL DEFAULT 1` to `registry_def`:

```sql
ALTER TABLE choros.registry_def ADD COLUMN record_schema_version integer NOT NULL DEFAULT 1;
```

Existing registries are seeded with version 1. Any subsequent UPDATE to `registry_def.record_schema` increments `record_schema_version` via trigger (see AC-3).

**Verifiable as:** migration

### AC-3 — Before-insert trigger defaults schema_version (fitness)

A trigger `record_schema_version_default` on `record` BEFORE INSERT:
- If `schema_version` is NULL, reads the registry's current `record_schema_version`.
- Sets `schema_version = registry_def.record_schema_version` from the foreign registry.
- Trigger is tested: INSERT without schema_version explicitly; verify the inserted row has the correct version.

**Verifiable as:** fitness (manual INSERT test in CI)

### AC-4 — Before-update trigger increments registry version (fitness)

A trigger `registry_def_schema_version_increment` on `registry_def` BEFORE UPDATE:
- When `record_schema` JSONB column is modified, increment `record_schema_version` by 1.
- Trigger prevents UPDATE to `schema_version` column directly (raises error).
- Test: UPDATE `record_schema`; verify `record_schema_version` increments; verify second UPDATE increments again.

**Verifiable as:** fitness

### AC-5 — Record schema version immutability enforced (fitness)

A trigger `record_schema_version_immutable` on `record` BEFORE UPDATE:
- Raises error if any UPDATE attempts to modify `schema_version` column: `NEW.schema_version != OLD.schema_version`.
- Test: Attempt to UPDATE a record's schema_version; verify error; verify old value unchanged.

**Verifiable as:** fitness

### AC-6 — Rollback prevention (forward-only) (fitness)

A SQL function `check_rollback_safe(registry_id, target_version) → bool` and corresponding CI check:
- Queries: `SELECT MAX(schema_version) FROM record WHERE registry_id = $1`.
- Returns FALSE if max_version > target_version (rollback not safe).
- Test: Insert record with schema_version = 2; attempt rollback to version 1; verify blocked.

**Verifiable as:** fitness

### AC-7 — Schema compatibility check utility (test)

TypeScript function `validateRecordAgainstSchema(record: {data: object, schema_version: number}, schemaHistory: SchemaHistoryMap) → {valid: bool, errors: string[]}`:
- Given a record's `data` JSONB and `schema_version`, look up the historical schema from `schemaHistory` map.
- Validate `data` against that schema using `ajv` (or equivalent JSON Schema validator).
- Return validation result.
- Test: Create a record under v1 schema; update registry schema to v2 (expand: add field); validate record against v1 schema (should pass); validate against v2 schema (should fail — missing field).

**Verifiable as:** test (unit test, no DATABASE_URL required)

### AC-8 — CI gate: schema-compat sampling (fitness)

A new CI check `ci/checks/record-schema-compat.sh`:
- Samples up to 5 records per registry from a test database.
- Validates each record against its stored `schema_version` (using function from AC-7).
- Exits non-zero if any record fails validation.
- Includes a SELF-TEST section that:
  - Inserts a record under v1 with a field.
  - Updates the registry schema to v2 (adds required field).
  - Validates the v1 record against both v1 (PASS) and v2 (FAIL expected) schema.
  - Verifies the check correctly detects the incompatibility.

**Verifiable as:** fitness

### AC-9 — RLS and tenant isolation respected (migration, test)

If a new history table is created (registry_schema_history):
- `tenant_id` is a leading PK column.
- RLS policies ENABLE + FORCE on the table; default-DENY policy filters by tenant_id.
- choros_app role receives only DML (SELECT, INSERT); no CREATE/ALTER permissions.
- Data isolation test: Insert history under tenant A; set session tenant_id to B; verify SELECT returns 0 rows.

**Verifiable as:** test (data isolation test in vitest)

### AC-10 — TypeScript compilation and existing tests green (fitness)

`npx tsc --noEmit` exits 0.
`npm test` exits 0 without ambient `DATABASE_URL`.

**Verifiable as:** fitness, test

---

## 7. Blocking questions

None. The ADR §7/§9.5 are explicit:
- Per-record schema versioning is required day-1 (ADR §14, §9.5 point 5).
- DRAIN-by-default (old instances use old version) is the architectural default (Flowable native, ADR §7).
- Expand/contract patterns (deprecation-first) are specified (ADR §7).
- Forward-only rollback prevention is a red-line (ADR §7 «rollback forward-only»).
- CI coherence gate (§9.4) includes schema-compat checking.

The data model design is straightforward; no conflicting interpretations.

---

## 8. Summary

**Per-record expand/contract object-schema versioning** is implemented via:

1. **New column `record.schema_version`** (NOT NULL, immutable, defaults to registry's current version at INSERT).
2. **New column `registry_def.record_schema_version`** (NOT NULL, incremented on schema change).
3. **Triggers** ensuring default-on-insert, atomic increment, immutability, forward-only rollback.
4. **Validation utilities** to check record conformance to historical schema versions.
5. **CI gate** sampling records and verifying schema compatibility.
6. **RLS compliance** for any new tables (history table).

This foundation enables:
- **DRAIN:** Old process instances read/write records using old schema version.
- **Deprecation-first:** Mark fields deprecated in schema; old records keep data; new records don't; drop only after all forward.
- **Rollback prevention:** Can't revert schema while old records exist under newer version.
- **Audit trail:** Schema history table tracks all versions.
- **Compat checking:** CI and runtime can validate any record against any schema version.

Out of scope: migration execution (T-0086), form-schema/MCP-grants versioning (T-0088/T-0089), UI/UX (T-0087), git-backed history (Stage-2).

---

## Appendix: example migration DDL (055, TBD by sequencing)

```sql
-- 055 · record schema versioning (T-0085) — per-record schema version tracking
-- for expand/contract migrations and DRAIN-by-default old-instance support.

-- ============================================================
-- 1. Add schema_version to record table
-- ============================================================

ALTER TABLE choros.record 
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1;

-- ============================================================
-- 2. Add record_schema_version to registry_def table
-- ============================================================

ALTER TABLE choros.registry_def
  ADD COLUMN record_schema_version integer NOT NULL DEFAULT 1;

-- ============================================================
-- 3. Trigger: default schema_version on record INSERT
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_record_schema_version_default()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.schema_version IS NULL THEN
    SELECT record_schema_version INTO NEW.schema_version
    FROM choros.registry_def
    WHERE tenant_id = NEW.tenant_id AND id = NEW.registry_id;
    IF NEW.schema_version IS NULL THEN
      -- Should not happen (FK constraint will catch), but explicit default to 1
      NEW.schema_version := 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER record_schema_version_default
BEFORE INSERT ON choros.record
FOR EACH ROW EXECUTE FUNCTION choros.fn_record_schema_version_default();

-- ============================================================
-- 4. Trigger: prevent schema_version UPDATE
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_record_schema_version_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.schema_version != OLD.schema_version THEN
    RAISE EXCEPTION 'record.schema_version is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER record_schema_version_immutable
BEFORE UPDATE ON choros.record
FOR EACH ROW EXECUTE FUNCTION choros.fn_record_schema_version_immutable();

-- ============================================================
-- 5. Trigger: increment registry_def schema_version on schema change
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_registry_def_schema_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.record_schema IS DISTINCT FROM OLD.record_schema THEN
    NEW.record_schema_version := OLD.record_schema_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER registry_def_schema_version_increment
BEFORE UPDATE ON choros.registry_def
FOR EACH ROW EXECUTE FUNCTION choros.fn_registry_def_schema_version_increment();

-- ============================================================
-- 6. Function: check if rollback is safe (forward-only)
-- ============================================================

CREATE OR REPLACE FUNCTION choros.fn_check_rollback_safe(
  p_tenant_id uuid,
  p_registry_id uuid,
  p_target_version integer
) RETURNS boolean AS $$
DECLARE
  v_max_version integer;
BEGIN
  SELECT MAX(schema_version) INTO v_max_version
  FROM choros.record
  WHERE tenant_id = p_tenant_id AND registry_id = p_registry_id;
  
  IF v_max_version IS NULL THEN
    RETURN true; -- No records exist, safe to rollback
  END IF;
  
  RETURN v_max_version <= p_target_version;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 7. Optional: registry_schema_history table (table-backed audit)
-- ============================================================

CREATE TABLE IF NOT EXISTS choros.registry_schema_history (
  tenant_id uuid NOT NULL,
  registry_id uuid NOT NULL,
  schema_version integer NOT NULL,
  schema_json jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, registry_id, schema_version),
  FOREIGN KEY (tenant_id, registry_id)
    REFERENCES choros.registry_def (tenant_id, id)
);

ALTER TABLE choros.registry_schema_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.registry_schema_history FORCE ROW LEVEL SECURITY;

CREATE POLICY registry_schema_history_tenant_isolation 
ON choros.registry_schema_history
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON choros.registry_schema_history TO choros_app;
```
