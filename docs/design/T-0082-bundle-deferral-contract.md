# T-0082 Bundle Deferral Contract

**Date:** 2026-06-11  
**Task:** T-0082 — E12.1: Bundle Coherence Unit + CI Guard  
**Analogous to:** `T-0027-bpmn-linter-deploy-contract.md`

---

## Purpose

This document is the explicit deferral contract for bundle members that are not
yet materialized as Choros database tables. It converts the "missing members"
from a silent gap into a documented, machine-enforced obligation: any future
task that adds a form-def or bpmn-def table MUST extend the bundle registry and
pass `bundle-coherence.sh` as part of its Definition of Done.

---

## Deferred members

The following three bundle members are present in `ci/checks/bundle_members.txt`
with `kind=external`. They are NOT errors in the CI guard — each is logged as
`[bundle-deferred]` and the guard exits 0. They represent work deferred to
future tasks.

| Member | Deferral reason | Where it lives today |
|---|---|---|
| `bpmn-process` | BPMN process definitions live in the Flowable engine (deployments API). No `choros.process_def` table exists yet. The BPMN-member boundary is already guarded by `bpmn-linter-isolation.sh` (T-0027). | Flowable REST API / `flowable-client.ts` |
| `form-code` | Floor-2 form code (JS/TS form logic) has no Choros table. Extensibility ADR §7 places this in the full git-under-the-hood target state, which requires `form_def` table (separate ADR + build task). | Not yet in Choros schema |
| `form-json-schema` | Floor-1 form JSON Schema has no Choros table. Same dependency as `form-code`. | Not yet in Choros schema |

---

## Promotion rule: external → choros_table

A deferred member MUST be promoted from `kind=external` to `kind=choros_table`
in `ci/checks/bundle_members.txt` when ALL of the following are true:

1. A Choros migration creates the corresponding table (e.g., `form_def`,
   `process_bundle`).
2. The table is added to `ci/checks/known_tenant_tables.txt` (standard DoD for
   any new tenant table).
3. The table has a key column carrying the bundle invariant (e.g., `schema_json`,
   `bpmn_xml`).
4. A DDL invariant for that column (e.g., `NOT NULL`) is verifiable via
   whitespace-tolerant grep over the migration file.

**This promotion is a DoD requirement for the task that creates the table.**
The task MUST:
- Update `ci/checks/bundle_members.txt`: change `kind` from `external` to
  `choros_table`, set `source` to the migration path, `table_or_path` to the
  table name, `key_column` to the invariant-bearing column.
- Verify `bundle-coherence.sh` exits 0 after the update.
- Include this in its PR handoff `files_changed` and `deviations_from_adr`
  (if any).

---

## BPMN-process special case

The `bpmn-process` member is `kind=external` but already has a partial coherence
guard: `bundle-coherence.sh` delegates to `bpmn-linter-isolation.sh` (T-0027),
which checks module-boundary invariants for the Flowable client. This delegation
is the day-1 coherence boundary for BPMN.

When a `choros.process_bundle` or equivalent table is created, the BPMN member
MUST be promoted following the same rule above. The `bpmn-linter-isolation.sh`
delegation may then be replaced or supplemented with DDL-grep invariants.

---

## Non-deferred members (already coherent)

| Member | Table | Key column | Migration |
|---|---|---|---|
| `object-schema` | `choros.registry_def` | `record_schema` | `migrations/004_registry_def.sql` |
| `grants` | `choros."grant"` | `resource_type` | `migrations/008_grant.sql` |

These are verified statically by `bundle-coherence.sh` on every CI run.

---

## Target state (not T-0082 scope)

The full target state from ADR §7 is git-under-the-hood: a content-addressed
bundle commit covering all five members. This requires:

- `form_def` and `form_schema` tables (separate ADR + build task).
- A `process_bundle` table or equivalent Choros-side BPMN anchor.
- The git-machinery layer (T-0084: changelog/diff validator, and subsequent tasks).

T-0082 establishes the coherence perimeter and this deferral contract as the
foundation. The git machinery is sequenced incrementally per ADR §11.
