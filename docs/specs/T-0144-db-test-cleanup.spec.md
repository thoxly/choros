# Spec · T-0144 — Самоочистка db-тестов grant-editor

**Phase:** SPEC
**Status:** ready (no BLOCKING)
**Product:** Choros · CI / db fitness tier
**Base:** dev · branch `task/T-0144`
**Born from:** rt-choros-s9 observation — live dev-silo has ≈150 `grant` rows for
`DEV_ROLE_OWNER` + `resource_type LIKE 'mgmt_object:%'` instead of the seed-exact 17,
causing `genesis-owner-seed.test.ts` AC-12 / FF-12 to fail after N test runs.

---

## 1. Diagnosis

### 1.1 Affected tests

Five test cases in `ci/checks/db/grant-editor.test.ts` insert rows into
`choros."grant"` with `role_id = DEV_ROLE_OWNER` and `resource_type LIKE
'mgmt_object:%'` and then clean up with an **inline `DELETE`** at the end of the
`it()` body:

| Test | Line | resource_type | granted_by | Scope |
|------|------|---------------|------------|-------|
| AC-01 (happy-path INSERT) | ~181 | `mgmt_object:grant` | `'test'` | FIN_NODE |
| AC-07 (revoke: valid_until) | ~225 | `mgmt_object:role` | `'test'` | FIN_NODE |
| AC-14 (proposed_by set) | ~360 | `mgmt_object:role` | `'test'` | FIN_NODE |
| AC-20 (RLS cross-tenant) | ~447 | `mgmt_object:role` | `'test'` | FIN_NODE |
| FF-10 live (freeform POST) | ~575 | `mgmt_object:grant` | DEV_EMP_OWNER UUID | freeform |

**Problem:** if any `expect()` assertion before the cleanup line throws, Vitest
propagates the error and the rest of the `it()` body does NOT run — the `DELETE`
is skipped and the row remains in the DB permanently.

One additional test in `ci/checks/db/grant-editor.adversarial.test.ts`:

| Test | Line | resource_type | granted_by |
|------|------|---------------|------------|
| ADV-3 beforeAll (victim grant) | ~419 | `mgmt_object:role` | `'e-owner'` |

ADV-3 cleans up inside `afterAll()` — Vitest guarantees `afterAll` runs
regardless of test outcome. **ADV-3 is already safe; it must not be changed.**

### 1.2 Cascade victim

`genesis-owner-seed.test.ts` (T-0029) AC-12 / FF-12 asserts:

```sql
SELECT resource_type, operation, scope, delegable
  FROM choros."grant"
 WHERE tenant_id=$1 AND role_id=$2 AND resource_type LIKE 'mgmt_object:%'
```

expects **exactly 17 rows** (16 CRUD + 1 invoke, all from migration 026 seed,
all scoped to the 3-dept FOREST_SET). Every leaked test row increments this
count, making the assertion fail deterministically once ≥1 run had a mid-test
error (or once the first pass finishes but a future pass encounters a real
regression).

### 1.3 Distinguishing markers

Seed rows (migration 026) can always be identified by:
- `granted_by = 'seed'`
- `scope` = the canonical 3-dept FOREST_SET JSON
- `id` values are stable deterministic UUIDs (`e1000000-…` series)

Leaked test rows can always be identified by:
- `granted_by IN ('test', 'd0000000-0000-0000-0000-0000000000ff')` ← all five
  contaminating tests use one of these two values
- `scope` ≠ FOREST_SET (FIN_NODE single-node or freeform scope)
- `id` values are random UUIDs (crypto.randomUUID() or server-generated)

This deterministic marker exists → one-shot cleanup script is feasible and
included in scope.

---

## 2. Chosen mechanism

**`afterAll` DELETE by ID, using module-level `let` variables.**

Rationale:
- Inline cleanup inside `it()` is not guaranteed to run if an assertion fails.
- Wrapping each `it()` in a `try/finally` block would work, but it clutters test
  logic significantly.
- Vitest guarantees `afterAll()` runs regardless of test outcome (pass, fail, or
  timeout), making it the correct place for mandatory teardown.
- `afterAll` DELETE by the specific row ID is the most surgical: it deletes only
  the exact row created in the current run and does nothing if the row was already
  deleted (DELETE WHERE id=X is a no-op when the row does not exist).
- **No change to test semantics:** the assertions themselves are unchanged; only
  the location of the cleanup moves from the tail of `it()` into `afterAll`.
- The existing `describe`-level `beforeAll`/`afterAll` pattern used in ADV-1,
  ADV-2, and ADV-3 is a proven pattern in this file; replicating it for the five
  contaminating `describe` blocks is consistent.

**Not chosen:** transaction-wrapping (wrapping each test in a DB transaction and
rolling back in `afterAll`) would prevent AC-20's RLS cross-tenant check from
working correctly (two separate connections are required for that test), and would
require deep restructuring of the test client management.

---

## 3. Functional requirements

- **FR-1 — afterAll cleanup for every contaminating describe block.** Each of
  the five `describe` blocks listed in §1.1 must declare a module-level `let`
  variable to capture the inserted row ID, assign it in (or immediately after)
  the INSERT, and delete it in `afterAll`. The `afterAll` must use `migratorUrl()`
  (bypasses RLS) to perform the DELETE.

- **FR-2 — Cleanup is a no-op if the row was already deleted.** The `afterAll`
  DELETE is `WHERE id = $id` only — it runs regardless of whether the inline
  DELETE earlier in the `it()` body already removed the row. Both running is
  harmless. Optionally, the inline DELETE can be removed to avoid duplicate DELETEs,
  but the inline DELETE may be retained for clarity (deleting a non-existent row
  is idempotent).

- **FR-3 — FF-10 live test: grant ID extraction must not depend on assertion
  outcome.** The FF-10 test assigns `grantId` inside an async IIFE that contains
  `expect` calls. The variable must be extracted at the `describe` scope level so
  the `afterAll` can reach it even if an assertion inside the IIFE throws.
  Specifically, the `grantId` must be stored into a module-level `let` variable
  before the first assertion on `res.status`.

- **FR-4 — ADV-3 is not changed.** The adversarial test's ADV-3 already uses
  `afterAll` correctly; it must not be modified.

- **FR-5 — Assertions are not weakened.** No `expect()` calls are removed,
  changed, or skipped. Only the structural location of cleanup moves.

- **FR-6 — One-shot silo sanitation script.** A TypeScript (or plain JS) script
  `scripts/cleanup-test-grants.ts` is added. When run with `DATABASE_URL` set to
  the dev (or any contaminated) silo, it:
  1. DELETEs from `choros."grant"` all rows matching:
     `tenant_id = DEV_TENANT AND role_id = DEV_ROLE_OWNER AND
      resource_type LIKE 'mgmt_object:%' AND granted_by IN ('test',
      'd0000000-0000-0000-0000-0000000000ff')` (the two known test-actor markers)
  2. Prints the number of deleted rows and exits.
  3. Does NOT delete seed rows (granted_by = 'seed') and does NOT modify
     migration state. It is safe to run multiple times (idempotent: deletes 0
     rows after first run).

- **FR-7 — No migration.** No changes to any file under `db/migrations/`.

---

## 4. Non-functional requirements

- **NF-1 — Zero new dependencies.** The cleanup script uses the existing `pg`
  package. No new packages are added to `package.json`.

- **NF-2 — CI green in clean silo.** After this change, two consecutive runs of
  `npm run fitness:db` (against a freshly seeded DB) must leave the same row
  counts for `choros."grant"` (the db tier is idempotent). The run order of
  tests within the `db` tier must not matter.

- **NF-3 — ADV-1/ADV-2 count probes unaffected.** ADV-1 and ADV-2 use
  count-before / count-after probes on `choros."grant"` and already have
  `afterAll` cleanup. The T-0144 change must not introduce any ordering
  dependency between these count probes and the newly moved cleanups.

---

## 5. Out of scope

- Fixing test isolation for tests that use `role_id = DEV_ROLE_BUDGET` (ADV-1,
  ADV-2 — already safe via `afterAll`).
- Changing the genesis-owner-seed test logic.
- Fixing contamination in any table other than `choros."grant"` (no equivalent
  accumulation pattern was found in `role_assignment` — AC-09 cleanup is also
  inline but `role_assignment` is not counted by genesis-owner-seed).
- Wrapping tests in savepoints or transactions.
- Python or non-TypeScript scripts.
- Addressing any other db-tier flakiness beyond the exact pattern described here.

---

## 6. Acceptance criteria

### AC-1 — Idempotency of the db tier (no row accumulation)

**Verifiable as:** test

Two consecutive complete runs of `npm run fitness:db` (without resetting the DB
between runs) against a freshly seeded dev silo must produce:

```
COUNT(choros."grant" WHERE role_id=DEV_ROLE_OWNER AND resource_type LIKE 'mgmt_object:%')
= 17
```

after **each** run. This can be verified by running the fitness suite twice and
confirming `genesis-owner-seed.test.ts` is green both times.

### AC-2 — genesis-owner-seed.test.ts stable on clean silo after any number of runs

**Verifiable as:** test

`genesis-owner-seed.test.ts` must be green on a freshly seeded silo after an
arbitrary number of `npm run fitness:db` runs. The exact-17 assertion must never
fail due to leaked test rows.

### AC-3 — Existing assertions not weakened

**Verifiable as:** test

All assertions in `grant-editor.test.ts` and `grant-editor.adversarial.test.ts`
that were passing before T-0144 must remain present and passing after T-0144.
No `expect()` call is removed or guarded with a `try/catch` that would silently
swallow a failure.

### AC-4 — FF-10 grantId captured before first assertion

**Verifiable as:** manual / code review

In the FF-10 `describe` block, the variable that holds the HTTP-created grant
ID must be declared at the `describe` scope (not inside the `it()` IIFE) and
must be assigned **before** the first `expect()` call on the HTTP response.
The `afterAll` must use this variable to issue the DELETE.

### AC-5 — One-shot sanitation script runs without error and is idempotent

**Verifiable as:** manual

Running `npx tsx scripts/cleanup-test-grants.ts` (with `DATABASE_URL` pointing
to a contaminated silo) must:
- Delete all leaked test grants (count > 0 on contaminated silo, = 0 on clean silo).
- Exit 0.
- Print the deleted row count.
- Be idempotent: running it twice deletes 0 rows on the second run.

### AC-6 — No migration files touched

**Verifiable as:** fitness / code review

`git diff dev -- db/migrations/` must be empty after T-0144 is applied.

---

## 7. Live silo sanitation decision

**Included in scope as a cleanup script (FR-6).**

The deterministic marker `granted_by IN ('test', 'd0000000-0000-0000-0000-0000000000ff')`
is present in all five contaminating inserts. These values cannot appear in
legitimate production data (no human grants rows with `granted_by = 'test'`).
The script is idempotent, non-destructive to seed data, and requires no migration.

The script at `scripts/cleanup-test-grants.ts` is the one-time cleanup artifact.
Running it against the contaminated live dev silo (homeserver-vm,
`/srv/choros`) is a founder-or-developer action, not an automated step. The
script is also referenced in the implementation PR description so the developer
knows to run it once post-merge.

---

## 8. Traceability

| AC | Requirement | Root cause |
|----|-------------|-----------|
| AC-1 | FR-1, FR-2 — afterAll cleanup | Inline cleanup skipped on assertion failure |
| AC-2 | FR-1 — genesis-owner-seed stable | Row accumulation → count > 17 |
| AC-3 | FR-5 — assertions unchanged | No weakening allowed |
| AC-4 | FR-3 — FF-10 ID captured early | IIFE assigns grantId after assertion |
| AC-5 | FR-6 — sanitation script | 150+ leaked rows in live silo |
| AC-6 | FR-7 — no migration | Migration scope excluded |

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
