# ADR-T0666 — сохранение формы: owner bypass + засев роли process_designer

Status: ready
Task: T-0666 (substrate/P0 — столп 2, интерфейс из блоков на данных)
Base: dev@ba8dba4, branch `task/T-0666-forms-save-access`

## 1. Problem

`checkRole` (`src/http/binding.ts:153-180`) gates `POST /api/forms/binding`
(+ `POST /tenants/.../binding`, `PATCH .../edits` in `floor1-editor.ts`,
`POST /api/dmn-rule-tables...` in `dmn-rule-table.ts` — all three routes call
this SAME function) by a strict `role_assignment` lookup for
`role.slug = 'process_designer'` in keycloak auth mode. The role is not seeded
anywhere (no dev-tenant migration, no `registerTenant`, no backfill), so the
lookup always returns `count=0` — 403 FORBIDDEN for EVERY actor, including the
tenant owner. LIVE_PROOF T-0656 had to grant the role by hand in the DB to
save a form binding — a workaround the product does not itself provide.

Every other mgmt-configuration surface (org structure, LLM-connection config,
system-agent operation, rights delegation) already gives the owner day-one
access via an owner short-circuit resolved from `isGenesisOwnerForTenant` /
`loadAdminContext` (`src/db/org.ts`). `checkRole` is the one conventional
(non-PDP-grant) authz path that never got this short-circuit.

## 2. Decision

### 2.1. Variant A (required) — owner bypass in `checkRole`

Add `pool: pg.Pool` as a parameter to `checkRole`. In keycloak mode, before the
`role_assignment` lookup:

```ts
if (await isGenesisOwnerForTenant(pool, tenantId, actorSlug, Date.now())) {
  return; // owner short-circuit — same authority path as capability-grants-dao.ts
}
```

**Why `isGenesisOwnerForTenant`, not a new lookup.** It is the SAME function
`capability-grants-dao.ts` already calls (`canConfigureLlmConnection`,
`canActorOperateSystemAgents`):

```ts
// src/db/capability-grants-dao.ts:57
if (await isGenesisOwnerForTenant(pool, tenantId, actorSlug, nowMs)) return true;
```

It is post-T-0658: the inner slug→employee subquery carries
`AND deactivated_at IS NULL` (`src/db/org.ts:721-748`, comment block explicitly
documents this as the gate closing the owner/admin short-circuit hole found by
T-0658's adversarial round). Using it here means:

- No sixth authority path / no new employee-lookup without the deactivation
  predicate (the explicit constraint from the task brief).
- A deactivated owner with a still-live KC token loses form-save access the
  SAME way T-0658 already proved for every other owner-gated mgmt path
  (`ci/checks/db/org-admin-deactivation.db.test.ts` already covers
  `isGenesisOwnerForTenant` fail-closing on deactivation — this task adds no
  new deactivation-gate test at the DB layer, it reuses the existing proof by
  reusing the existing function).

**Signature threading.** `isGenesisOwnerForTenant` needs a `pg.Pool` (it opens
its own tenant-scoped transaction via `withTenant`), while `checkRole` today
only receives an already-open `pg.PoolClient` (it runs inside the caller's
`withTenantTx`). All three call sites already have a `pool` in scope:

- `binding.ts` — both `POST` handlers close over `pool` (the route module's
  own parameter).
- `floor1-editor.ts::authorizeEditor(pool, tenantId, actorId)` — already
  typed `pool: pg.Pool | null`.
- `dmn-rule-table.ts::authorizeDesigner(pool, tenantId, actorSlug)` — already
  typed `pool: pg.Pool`.

So the signature change is additive at each call site (`checkRole(client, pool,
tenantId, actorSlug)`), no new plumbing needed beyond passing the parameter
already available.

**Why this fixes three routes with one change.** `checkRole` is documented in
its own comment ("single source of truth for the process_designer authz
convention") as the ONE function `floor1-editor.ts` and `dmn-rule-table.ts`
reuse verbatim — no second permission mechanism. The owner bypass therefore
also unblocks the Floor-1 editor and DMN rule-table save paths for the owner,
without touching those files' authz logic at all.

### 2.2. Variant B (additive) — seed the `process_designer` role

`process_designer` is a platform primitive (the role a tenant owner delegates
to a staff form-builder), not case content — seeding it in the platform
genesis layer is the same category of seed as `role-configurator` /
`role-reader` / `role-constructor-admin`. It is seeded but **never
auto-assigned** (identical posture to `role-constructor-admin`, T-0469): the
owner already has access via 2.1's bypass; the role existing is what makes
delegation to a non-owner employee *possible* (today it is impossible — the
role does not exist as a principal, so `POST /api/rights/...` role-assignment
UI has nothing to attach the constructor-employee to).

- `src/core/register.ts` — every NEW tenant gets a `process_designer` role row
  (created, not assigned) alongside the other tenant-zero rows, in the same
  transaction.
- `migrations/128_process_designer_role_backfill.sql` — backfills the role
  for EXISTING tenants, mirroring migration 118's set-driven,
  no-hardcoded-tenant, idempotent `INSERT ... SELECT ... FROM choros.tenant
  LEFT JOIN choros.role ... WHERE r.id IS NULL` pattern.

## 3. Rejected alternatives

- **New employee-lookup ad hoc in `checkRole`** (`SELECT id FROM
  choros.employee WHERE tenant_id=$1 AND slug=$2 AND deactivated_at IS NULL`
  inlined, then check `role.slug='tenant-owner'` locally) — rejected per the
  task brief's explicit warning: this would be a SIXTH authority-resolution
  path parallel to `getGrantsForSubject` / `isGenesisOwnerForTenant` /
  `loadAdminContext` / the report-page resolver / the self-absence resolver
  (all five enumerated in T-0658's ADR), reopening exactly the fragmentation
  T-0658 spent three adversarial rounds closing. Reusing
  `isGenesisOwnerForTenant` keeps the count at five, not six.
- **Auto-assigning `process_designer` to the owner via `role_assignment`
  instead of a code bypass** — rejected: assigning the owner ANOTHER role
  (rather than recognizing owner authority directly) would mean the owner's
  form-save access depends on a role_assignment row surviving future rights
  refactors, instead of on the single owner-authority predicate every other
  mgmt path already trusts. It would also NOT close the underlying gap that
  `checkRole` has no owner short-circuit at all — a future non-owner path
  reusing `checkRole` (there already are two: floor1-editor, dmn-rule-table)
  would still need this fix independently. Bypass in code (2.1) fixes the
  primitive; seeding the role (2.2) fixes the "assignable to someone else"
  problem — both are needed, neither alone is sufficient.
- **Softening `checkRole` to "authenticated" in keycloak mode** (matching the
  existing dev-mode footnote) — rejected: this is exactly the "access spilled
  to everyone" failure mode the task brief calls out as unacceptable; a
  rank-and-file employee without any role must still get 403.

## 4. Consequences

- `checkRole(client, pool, tenantId, actorSlug)` — new signature (pool
  inserted). All three call sites updated; no behavior change in dev mode
  (still soft-passes on "authenticated", no DB read).
- Owner (active, confirmed `tenant-owner` role_assignment) now saves form
  bindings / floor-1 edits / DMN rule tables in keycloak mode without a
  manual role grant.
- A deactivated owner (T-0658 gate) loses this bypass the same instant they
  lose every other owner-gated mgmt path — no new deactivation surface, reuses
  the existing one.
- A rank-and-file actor (not owner, no `process_designer` assignment) still
  gets 403 — access is not spilled to everyone.
- `process_designer` role now exists (seeded, unassigned) in every tenant —
  assignable to a real employee through the existing rights-assignment
  machinery, closing the "role doesn't exist to be granted" half of the bug.
