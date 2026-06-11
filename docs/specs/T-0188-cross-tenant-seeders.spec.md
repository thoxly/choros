# T-0188 · Cross-tenant seeders for invoke_proposal / notification / email_channel_config / notification_preference / report_page / report_page_dep

## Summary

`ci/checks/db/cross_tenant.test.ts` iterates `KNOWN_TENANT_TABLES` (read from
`known_tenant_tables.txt`). Its `seedRowForTable` switch-statement is missing
cases for 6 tables added in migrations 043–052:

| Table | Migration | FK deps |
|---|---|---|
| `invoke_proposal` | 043 | none (caller_id/target_id are logical, no FK declared) |
| `notification` | 046 | `(tenant_id, recipient_id) → employee(tenant_id, id)` |
| `email_channel_config` | 047 | none (single row per tenant) |
| `notification_preference` | 048 | none (PK = tenant_id, event_kind, recipient_scope) |
| `report_page` | 051 | `(tenant_id, app_id) → application(tenant_id, id)` |
| `report_page_dep` | 052 | `(tenant_id, page_id) → report_page(tenant_id, id)` + `(tenant_id, registry_def_id) → registry_def(tenant_id, id)` |

The missing cases cause `seedRowForTable` to throw at the `default:` branch
during `beforeAll`, which makes vitest mark all 79 tests in the file as
skipped/failed. Coverage of the 6 new tables is effectively zero.

## Scope

- **In scope**: adding 6 seeder functions + 6 `case` entries in `seedRowForTable`
  (additive only — no existing code modified except the switch and seedState); adding a
  guard that fails a fitness check if a table in `known_tenant_tables.txt` has no
  corresponding seeder (self-testing invariant).
- **Out of scope**: fixing the pre-existing `effect_resource` fall-through bug (missing
  `break`); schema changes; modifications to any `ci/checks/*.sh` file.

## Functional requirements

1. Each of the 6 tables must have a dedicated seeder that inserts a minimally-valid
   row satisfying all NOT NULL + CHECK constraints and all declared FK chains.
2. `seedState` must track `report_page` IDs per tenant so `report_page_dep` can
   resolve its FK at seeding time (the two tables are adjacent in
   `known_tenant_tables.txt`, so ordering is guaranteed).
3. `email_channel_config` uses `ON CONFLICT DO NOTHING` because its PK is
   `(tenant_id)` — exactly one config row per tenant; a second seed call must be
   idempotent.
4. The guard must be implemented as a `describe` block inside
   `cross_tenant.test.ts` (additive) that compares `KNOWN_TENANT_TABLES` entries
   against a `SEEDED_TABLES` constant. Any table in `KNOWN_TENANT_TABLES` that
   is absent from `SEEDED_TABLES` must cause the corresponding test to fail (not
   skip). The guard must cover all existing seeded tables so a future addition to
   `known_tenant_tables.txt` without a seeder is caught immediately (self-test).
5. The test suite must run twice consecutively against the same clone DB (idempotency);
   `ON CONFLICT DO NOTHING` protects all seed functions that might collide on re-run.

## Non-functional requirements

- NF-1: Additive only — no existing seeder functions or cases removed or rewritten.
- NF-2: File does not import any module beyond what is already in scope
  (`pg`, `vitest`, `./_helpers.js`).
- NF-3: `tsc --noEmit` must pass after the change.
- NF-4: `npm run fitness` (static checks, no DB) must pass after the change.

## Acceptance criteria

| id | text | verifiable_as |
|---|---|---|
| AC-CT-1 | `seedRowForTable` has explicit `case` entries for all 6 missing tables | test |
| AC-CT-2 | `beforeAll` completes without error when DATABASE_URL points at a migrated DB (0 beforeAll failures) | test |
| AC-CT-3 | 0 skipped tests in `cross_tenant.test.ts` when run against a live DB (previously ≥75) | test |
| AC-CT-4 | Guard test fails (red) if a table in `KNOWN_TENANT_TABLES` is absent from `SEEDED_TABLES` | test |
| AC-CT-5 | Two consecutive `npm run fitness:db` runs produce identical results (idempotency) | test |
| AC-CT-6 | `tsc --noEmit` exits 0 | fitness |
| AC-CT-7 | `npm run fitness` exits 0 | fitness |

## Known side-finding

The existing `case 'effect_resource'` in `seedRowForTable` (line 619–622) is
missing a `break` before `case 'outbox'`, causing double seeding of outbox. This
is a pre-existing bug outside T-0188 scope — do not fix here; record for a
follow-up task.
