# ADR · T-0030 — Structural grant editor (E3.4)

**Phase:** DESIGN. **Status:** `ready` (no founder gate; GT-1 for E3.4 signed).
**Spec:** `docs/specs/T-0030-grant-editor.spec.md` (20 AC). **Machine contract:**
`docs/design/T-0030.adr.contract.json` (schema `schemas/adr.schema.json`, 0 errors).
**Base:** worktree `task/T-0030-grant-editor`, branched from `dev` `066ac39`.

---

## 1. Decision (one paragraph)

T-0030 ships the **structural grant write-API** and wires the existing `ra-role-editor.jsx`
progressive-disclosure UI to it. The design is **additive-only against the existing grant
authority tables** (`"grant"` and `role_assignment` — both already RLS-enabled and registered in
`known_tenant_tables.txt`). No new tenant table is introduced. One additive migration
(`030_grant_proposed_confirmed.sql`) adds `proposed_by` / `confirmed_by` nullable text columns
to the existing `"grant"` table (matching the `role_assignment` schema introduced by migration
020) — these columns record the proposal/confirmation semantics required by FR-1/FR-7/AC-14.
Four new HTTP routes (`POST /api/grants`, `POST /api/grants/:id/revoke`,
`POST /api/role-assignments`, `POST /api/role-assignments/:id/revoke`) are placed in a new
module `src/http/grants.ts`. Every write goes through `validateAdminDelegation` from the already-frozen
`src/core/scoped-admin.ts` **verbatim** — no re-implementation of narrowing logic. Actor identity
is resolved from the `X-Dev-User` header (day-1 dev auth; T-0054 seam). The admin context
(`isGenesisOwner`, `adminGrants`, `adminOrgScope`) is loaded from the DB via two new helpers
added to `src/db/org.ts`: `isGenesisOwnerForTenant` and `loadAdminContext`. Scope parsing reuses
`normalize` from `grant-lattice.ts`. Every successful create/revoke emits a `GrantAuditEvent`
into the `audit_event` table; the emit and the INSERT are wrapped in a single `withTenant`
transaction so atomicity is guaranteed. `GET /api/rights/dictionaries` returns closed
dictionaries from seed data (day-1; DB-backed dictionary resolution is out of scope). The read
routes in `src/http/rights.ts` are **not touched** — they remain seed-backed until T-0053.

---

## 2. Module boundaries and layer assignments

### 2.1 New module: `src/http/grants.ts`

Registers the four write routes. Responsible for:
1. Extracting actor id from `X-Dev-User` header (reuse `DEV_USER_HEADER` from `auth.ts`).
2. Reading and validating the JSON body via `readJsonBody` from `router.ts`.
3. Calling `parseScopeElement(raw)` (local helper, see §2.3).
4. Loading `AdminContext` via `loadAdminContext` (DB helper, see §2.2).
5. Calling `validateAdminDelegation(admin, target, oracle)` — abort with 403 on `{ok:false}`.
6. Executing the DB write inside `withTenant` in a single transaction that also appends the
   `GrantAuditEvent` to `audit_event`.
7. Returning 201 (create) or 200 (revoke) with the persisted row id.

Also registers `GET /api/rights/dictionaries` (FR-8) — seed-backed, no DB.

### 2.2 Extended: `src/db/org.ts`

Two new exported async helpers (follow the existing `withTenant` + `assertUuid` pattern):

**`isGenesisOwnerForTenant(actorEmployeeId, tenantId, nowMs, db)`** — AC-15 / NF-3:
```
SELECT ra.id
  FROM choros.role_assignment ra
  JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
 WHERE ra.tenant_id = $tenantId
   AND ra.employee_id = $actorEmployeeId
   AND r.slug = 'tenant-owner'
   AND ra.confirmed_by IS NOT NULL
   AND (ra.valid_from IS NULL OR ra.valid_from <= $nowMs)
   AND (ra.valid_until IS NULL OR ra.valid_until > $nowMs)
 LIMIT 1
```
Returns `boolean`. Runs inside `withTenant` (GUC set).

**`loadAdminContext(actorEmployeeId, tenantId, nowMs, db)`** — FR-2 / NF-3:
Builds the full `AdminContext`. Three-query sequence inside one `withTenant` call:
1. Call `isGenesisOwnerForTenant` (boolean).
2. Load all confirmed, in-window `role_assignment` rows for the actor.
3. For each assignment, load all confirmed, in-window, `delegable=true` grants on the
   assigned role where `resource_type` is one of `MGMT_OBJECT_KINDS`.

Constructs `adminOrgScope` as the union of assignment `org_scope` values (a `{kind:"set",...}`
when multiple assignments exist, or the single element when only one). Returns `AdminContext`.

**Note on T-0053 boundary:** `loadAdminContext` is the only DB read the write-path requires.
`GET /api/rights` read routes remain seed-backed. The T-0053 Postgres DAO replaces those read
paths; this function is the write-path only.

### 2.3 Scope parsing helper (local to `src/http/grants.ts`)

`parseScopeElement(raw: unknown): ScopeElement | null` — validates incoming JSON:
- Returns `null` if `raw` is not an object or `kind` is not `"node"|"tags"|"interval"|"set"`.
- For `"node"`: checks `hierarchy` (`"resource"|"org"`), `nodeId` (string), `nodeLevel` string.
- For `"tags"`: checks `tags` is string[].
- For `"interval"`: checks `axis` string, `lo`/`hi` numbers.
- For `"set"`: recursively validates each member (depth 1 only — sets are flattened).
- Calls `normalize(element)` before returning (NF-4).

Freeform scope (`kind:"freeform"`) is **never admitted via the API**; it is only permissible
when `isGenesisOwner === true` and the raw body explicitly passes `scope: {kind:"freeform",...}`
— in that case `parseScopeElement` returns the freeform literal as a `GrantScope` (the Union
type from `grant-lattice.ts`), and the handler detects it and verifies `isGenesisOwner`. A
non-owner freeform attempt returns 400 `INVALID_SCOPE` before `validateAdminDelegation` is called.

### 2.4 Audit emit (transactional)

`GrantAuditEvent` is imported verbatim from `src/core/grant-lattice.ts` (NF-6). Emitting to
`audit_event` follows the T-0016 audit-append path: `INSERT INTO choros.audit_event (...)`.
The emit and the grant/assignment INSERT run **inside the same `withTenant` transaction** (one
`BEGIN` / `COMMIT` wrapping the `client.query` for the grant INSERT and the `audit_event`
INSERT). This is the lesson of T-0062: transactional correctness requires the side-effect to
be within the same transaction as the data mutation — there is no outbox for audit emission.

**Mapping `GrantAuditEvent` → `audit_event` columns:**
```
audit_event.type        = e.kind           ("grant.create" | "grant.revoke")
audit_event.actor       = e.actor          (actorEmployeeId string)
audit_event.subject     = e.subjectRoleId  (role UUID string)
audit_event.scope       = e.scope          (jsonb)
audit_event.proposed_by = e.proposedBy     (nullable)
audit_event.confirmed_by= e.confirmedBy    (nullable)
audit_event.payload     = { capability: e.capability }   (jsonb NOT NULL)
audit_event.occurred_at = nowMs            (epoch-ms bigint)
audit_event.via         = "grant-editor"   (constant tag)
```
`prev_hash`, `row_hash`, `vocab_version`, `seq` are computed/assigned by the DB-side append
helper following the T-0016 chain (the existing hash-chain mechanics; the write-path calls the
same append helper already used by the actor-event path — or a direct raw INSERT with an
inline SHA-256 chain step if no helper exists yet; day-1 the raw INSERT is acceptable given
the audit chain is maintained per-tenant).

### 2.5 Migration `030_grant_proposed_confirmed.sql`

Additive ALTER TABLE on `choros."grant"`:
```sql
ALTER TABLE choros."grant"
  ADD COLUMN IF NOT EXISTS proposed_by  text NULL,
  ADD COLUMN IF NOT EXISTS confirmed_by text NULL;
```
No new table, no `known_tenant_tables.txt` change, no `cross_tenant.test.ts` seedRowForTable
case needed (AC-19 vacuously holds). The grant table PK, RLS, and GRANT to `choros_app`
remain unchanged.

### 2.6 Route registration in `src/server.ts`

`registerGrantsRoutes(router, pool)` added to `buildRouter`. The function accepts the pg
pool so the write-path can call `withTenant` directly (same pattern as org routes).

---

## 3. Object model

### 3.1 `GrantWriteRequest` — POST /api/grants body

```ts
{
  role_id:        string;          // UUID — must resolve in role table
  resource_type:  string;          // ResourceType literal
  operation:      Operation;       // grant-lattice.ts union
  scope:          unknown;         // parsed by parseScopeElement — 400 if invalid
  resource_facet?: unknown;        // optional jsonb
  constraint?:    unknown;         // optional jsonb
  delegable?:     boolean;         // default true
  granted_by:     string;          // actor slug / id
  valid_from?:    number;          // epoch-ms
  valid_until?:   number;          // epoch-ms
  proposed_by?:   string;          // actor id — proposal provenance
  confirmed_by?:  string;          // actor id — confirmation; absent = PROPOSAL
}
```

### 3.2 `RoleAssignmentWriteRequest` — POST /api/role-assignments body

```ts
{
  employee_id:   string;           // UUID
  role_id:       string;           // UUID
  org_scope:     unknown;          // ScopeElement, hierarchy:"org"
  source:        string;
  granted_by:    string;
  valid_from?:   number;
  valid_until?:  number;
  proposed_by?:  string;
  confirmed_by?: string;
}
```

### 3.3 `AdminContext` (from `src/core/scoped-admin.ts` — FROZEN)

```ts
{
  isGenesisOwner: boolean;
  adminGrants:    Grant[];
  adminOrgScope:  ScopeElement;
}
```

### 3.4 `GrantAuditEvent` (from `src/core/grant-lattice.ts` — FROZEN)

```ts
{
  kind:         "grant.create" | "grant.revoke";
  actor:        string;
  subjectRoleId:string;
  capability:   { resourceType: string; operation: string; resourceFacet?: unknown };
  scope:        Scope;
  proposedBy?:  string;
  confirmedBy?: string;
}
```

---

## 4. API contracts

### POST /api/grants
- Auth: `X-Dev-User` header → actor employee id. 401 if missing.
- Body: `GrantWriteRequest` (JSON).
- Validation: `parseScopeElement(body.scope)` → 400 `INVALID_SCOPE` if null (and not freeform
  or not genesis owner). Role id / employee id existence checked via DB → 404.
- Gate: `validateAdminDelegation(admin, {kind:"grant", childGrant, targetOrgScope}, oracle)`.
  403 `ADMIN_GATE_REJECTED` + typed reason on `{ok:false}`.
- Write: `INSERT INTO choros."grant" (..., proposed_by, confirmed_by)` + `INSERT INTO
  choros.audit_event` in one transaction.
- Response: 201 `{ id: "<uuid>" }`.

### POST /api/grants/:id/revoke
- Auth: `X-Dev-User` header.
- Fetch the grant row (404 if missing or wrong tenant).
- Gate: `validateAdminDelegation` with `{kind:"grant", childGrant: <the grant row>,
  targetOrgScope: <grant's org context>}`. The org context for a `resource` grant is derived
  from the admin's own scope (day-1: the admin's `adminOrgScope` acts as the target's org
  context because resource grants carry no org-scope column themselves).
- Write: `UPDATE choros."grant" SET valid_until = $nowMs WHERE tenant_id=$t AND id=$id` +
  audit `INSERT` in one transaction.
- Response: 200 `{ id }`.

### POST /api/role-assignments
- Auth: `X-Dev-User` header.
- Body: `RoleAssignmentWriteRequest`.
- Validate `org_scope` via `parseScopeElement` (must be `hierarchy:"org"` node/set).
- Gate: `validateAdminDelegation(admin, {kind:"assignment", targetOrgScope: body.org_scope}, oracle)`.
- Write: `INSERT INTO choros.role_assignment (...)` + audit `INSERT` in one transaction.
- Response: 201 `{ id }`.

### POST /api/role-assignments/:id/revoke
- Fetch the assignment row (404 if missing).
- Gate: `validateAdminDelegation(admin, {kind:"assignment", targetOrgScope: <assignment.org_scope>}, oracle)`.
- Write: `UPDATE choros.role_assignment SET valid_until = $nowMs` + audit `INSERT`.
- Response: 200 `{ id }`.

### GET /api/rights/dictionaries
- No auth required (read-only dictionary).
- Response: 200 `{ resources, operations, orgTree, scopeTags }` — static seed from
  `ra-data.jsx` constants served as JSON (day-1; not DB-backed).

---

## 5. AncestryOracle for the write-path

`validateAdminDelegation` requires an `AncestryOracle`. The write-path constructs a
**DB-backed oracle** (or a seed-backed fallback when `DATABASE_URL` is absent): it queries the
`department` table (and `position` table) to resolve `isDescendantOrSelf` over
`hierarchy:"org"`. A minimal oracle that covers day-1 (flat dept tree) can be seeded from the
`ORG_SEED` data in `org.ts`; the DB-backed version traverses `parent_id` columns. Day-1: use
the in-memory `ORG_SEED` oracle (T-0053 adds the Postgres traversal).

---

## 6. Web form wire-up (AC-17, AC-18)

`ra-role-editor.jsx` already renders the full UI. T-0030 adds only the `onSubmit` handler:

1. **Advanced mode:** iterate `grants` state, map each to a `GrantWriteRequest` atom (UI
   fields map directly: `uri → resource_type` mapped through `RESOURCES`, `ops[0] → operation`,
   `nodes/tags/range → scope` assembled as a `ScopeElement`). POST each to `/api/grants`.
2. **Simple (preset) mode:** expand `presetSel` into structural grant atoms using `PRESETS`
   data (client-side expansion before POST — no preset table, AC-18). Each expanded atom
   receives `confirmed_by = actorId`.
3. **LLM-proposes panel (static day-1):** when confirming a proposed grant, POST with
   `proposed_by = "llm"`, `confirmed_by = actorId`. The "Предложить гранты" button itself
   remains static (the BYO-LLM call is T-0039).
4. Error handling: a 403 response surfaces the `reason` field inline next to the grant row.
   A 201 response refreshes the confirmed-grants view.

---

## 7. Fitness functions

| Id | Rule | CI check |
|----|------|----------|
| FF-1 | `GrantAuditEvent` import — every write call-site in `src/http/grants.ts` that emits to `audit_event` imports `GrantAuditEvent` from `grant-lattice.ts`, not a local re-definition | `grep -n "GrantAuditEvent" src/http/grants.ts` asserts import from `grant-lattice.js`; `grep -rn "GrantAuditEvent" src/ \| grep -v "grant-lattice\|grants.ts\|\.test\."` asserts no other definition |
| FF-2 | `isGenesisOwner` never hardcoded — no `isGenesisOwner: true` literal outside `src/db/org.ts` | `grep -rn "isGenesisOwner.*true\|isGenesisOwner=true" src/ \| grep -v "src/db/org.ts"` must be empty |
| FF-3 | `validateAdminDelegation` not re-implemented — only imported from `scoped-admin.ts`; no local narrowing gate | `grep -rn "scope_widens\|facet_widens\|org_scope_widens" src/ \| grep -v "scoped-admin.ts\|grants.ts\|\.test\."` must be empty |
| FF-4 | Every DB write in grants write-path carries `tenant_id` as first parameter — no parameterized INSERT/UPDATE without `$1` being tenant_id | `grep -A3 "INSERT INTO choros\.\\"grant\\"" src/http/grants.ts \| grep -v "\$1"` must be empty; same for `role_assignment` |
| FF-5 | No new tenant table — `known_tenant_tables.txt` length unchanged; `grant` and `role_assignment` already present | `wc -l ci/checks/known_tenant_tables.txt` equals baseline (21 lines); `grep "^grant$\|^role_assignment$" ci/checks/known_tenant_tables.txt` must match |
| FF-6 | Audit emit inside same transaction as INSERT — the write handler must not call `client.release()` between the data INSERT and the audit INSERT | Static grep: `grep -n "client.release\|COMMIT" src/http/grants.ts` asserts `COMMIT` appears only once per handler and after both INSERTs |
| FF-7 | Scope parse reuses `normalize` from `grant-lattice.ts` — `parseScopeElement` calls `normalize` before returning | `grep -n "normalize(" src/http/grants.ts` asserts exactly one call per parse return path |
| FF-8 | No RLS bypass — no `SET ROLE` or `BYPASS RLS` in grants write-path | `grep -rn "BYPASS RLS\|SET ROLE\|choros_migrator" src/http/grants.ts` must be empty |
| FF-9 | `validateAdminDelegation` call before every INSERT — handler code flow: call gate → check `{ok:true}` → then `client.query("INSERT")` — never INSERT without prior gate | Integration tests AC-02/03/04/08/10 assert no row inserted on rejection; grep: `src/http/grants.ts` must not have any `INSERT INTO` before `validateAdminDelegation` call in handler flow |

---

## 8. Rejected alternatives

### Alt A — Separate admin gateway service
Rejected: adds a network hop and a new deployment unit. The `validateAdminDelegation` function
is pure and already designed to be called inline before INSERT. No new subsystem warranted.

### Alt B — Persist preset expansions in a `preset` table
Rejected (AC-18, spec §4): presets are a UI convenience, not a data primitive. Expanding them
client-side before POST produces the same structural atoms as advanced mode — a separate table
would add DDL for zero semantic benefit and would contradict the capability-not-text principle.

### Alt C — Use the existing `actor_event` table for the audit emit
Rejected (spec §1.5): `actor_event` covers *guarded transitions* (SoD substrate). Grant writes
are `mgmt_object:grant` management writes, not guarded transitions. The correct target is
`audit_event` (T-0016 floor) via `GrantAuditEvent` (FR-7 of T-0018, explicitly frozen).
Emitting to `actor_event` would pollute the SoD substrate with management events and break the
semantic boundary established by T-0019.

### Alt D — Fire-and-forget audit emit (after transaction commit)
Rejected: a grant write that commits but whose audit emit then fails would produce a silent
audit gap. The lesson of T-0062 applies: wrap both mutations in a single transaction. Rollback
on audit insert failure is preferable to a committed grant with no audit record.

### Alt E — Build admin-context load from grant-resolver.ts (T-0021)
Rejected: `grant-resolver.ts` is read-path / PDP code and is explicitly not edited (NF-6 of
T-0029). The write-path needs a narrower helper that loads only the mgmt-grants for the acting
principal — `loadAdminContext` in `src/db/org.ts` is the right seam for this.

---

## 9. Traceability

| AC | Covered by |
|----|-----------|
| AC-01 | §4 POST /api/grants; §3.1 GrantWriteRequest; §2.1 grants.ts INSERT |
| AC-02 | §4 gate: `validateAdminDelegation` → 403 `ADMIN_GATE_REJECTED`; FF-9 |
| AC-03 | §4 gate `org_scope_widens` reason; FF-9 |
| AC-04 | §4 gate `no_admin_authority` reason; FF-9 |
| AC-05 | §2.3 `parseScopeElement` returns null → 400 `INVALID_SCOPE` |
| AC-06 | §2.2 `isGenesisOwnerForTenant` → `AdminContext.isGenesisOwner=true`; `validateAdminDelegation` step-3 short-circuit |
| AC-07 | §4 POST /api/grants/:id/revoke — `UPDATE valid_until=nowMs`; row not deleted |
| AC-08 | §4 revoke gate: no `mgmt_object:grant` authority → 403 `ADMIN_GATE_REJECTED` |
| AC-09 | §4 POST /api/role-assignments; §3.2 RoleAssignmentWriteRequest |
| AC-10 | §4 `org_scope_widens` gate for role-assignment write |
| AC-11 | §4 POST /api/role-assignments/:id/revoke — `UPDATE valid_until=nowMs` |
| AC-12 | §2.4 audit emit; FF-1 (GrantAuditEvent import lint) |
| AC-13 | §2.4 audit emit on revoke path |
| AC-14 | §3.1 `proposed_by`/`confirmed_by` in body; §2.5 migration 030 columns; INSERT preserves nullability |
| AC-15 | §2.2 `isGenesisOwnerForTenant` query; FF-2 (no hardcoded true) |
| AC-16 | §4 GET /api/rights/dictionaries — seed-backed response |
| AC-17 | §6 `ra-role-editor.jsx` submit handler |
| AC-18 | §6 preset expansion client-side before POST; no preset table |
| AC-19 | FF-5 (known_tenant_tables.txt unchanged); §2.5 no new table |
| AC-20 | §4 all INSERTs include tenant_id; FF-4 (tenant_id as $1); FF-8 (no RLS bypass) |

---

## 10. Runtime target

Node.js process on the Choros home server (same runtime as all other T-0013+ routes). No new
infra required — the write routes reuse the existing Postgres pool (`DATABASE_URL` env var) and
the `withTenant` helper already present in `src/db/org.ts`. T-0030 is self-sufficient in the
existing Docker Compose environment.
