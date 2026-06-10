# Spec · T-0030 — Structural grant editor (E3.4)

**Epic/Story:** E3.4 — Structural grant editor (capability-not-text): *role-authoring UI as structural
grants — menu of registries/objects (read/write/scope) + tasks/steps + operations/limits, progressive
disclosure; editing routes through the gateway-backed grant API.*

**Status:** `ready` (no blocking founder questions — GT-1 already signed for E3.4; the
capability-not-text red-line and the write-API-through-validateAdminDelegation gate are direct
implementation of the signed model).

**Phase:** SPEC. Machine-readable contract: `docs/specs/T-0030.spec.contract.json`
(schema `schemas/spec.schema.json`).

**Deps (both done on base dev `066ac39`):**
- E3.2 (T-0022): `role` + `role_assignment` tables, `proposed_by`/`confirmed_by` semantics.
- E2.5 (T-0021): `grant_resolver` / PDP — the gateway every object read/write routes through.
- E3.3 (T-0029): `validateAdminDelegation` (the mandatory write-path gate that proves subset narrowing
  along both resource-scope and org-scope axes, with `isGenesisOwner` injected from the DB).

---

## 0. One-line summary

Ship a **structural grant write-API** (`POST /api/grants`, `POST /api/grants/:id/revoke`,
`POST /api/role-assignments`, `POST /api/role-assignments/:id/revoke`) and a **role-editor
web screen** that composes grants from closed-lattice dictionaries (registry/op/scope) with
progressive disclosure (simple presets ↔ advanced atoms), where every write is gated by
`validateAdminDelegation` with `isGenesisOwner` resolved from the DB, and every create/revoke
emits a `GrantAuditEvent` into the audit floor.

---

## 1. Context: what already exists (do not rebuild)

### 1.1 Authority algebra and narrowing gate (T-0018 + T-0029)

`src/core/grant-lattice.ts` ships the closed lattice `(S, ⊑, ⊓, ⊥)`, the `Grant` TypeScript
mirror, `GrantAuditEvent` (the audit-emit shape every create/revoke site MUST use, FR-7 of T-0018),
`Operation` union (`read|create|update|delete|approve|transition|invoke`), and `validateNarrowing`.

`src/core/scoped-admin.ts` ships `validateAdminDelegation(admin, target, oracle)` — the write-path
gate that T-0030 calls **before every INSERT**. Its contract is frozen for T-0030 (NF-7 of T-0029):
- `AdminContext.isGenesisOwner`: **injected boolean** — T-0030 resolves it from the DB (query: does
  the actor hold the `tenant-owner` role via a confirmed, in-window `role_assignment`?), never
  derived inside the lattice.
- Rejection union: `scope_widens | facet_widens | constraint_widens | parent_non_delegable |
  free_form_non_delegable | org_scope_widens | no_admin_authority`.
- `MGMT_OBJECT_KINDS` constant frozen: `mgmt_object:role | mgmt_object:agent | mgmt_object:process
  | mgmt_object:grant`.

### 1.2 Existing HTTP + DB layer

`src/http/rights.ts` is **read-only** — it returns in-memory seed data. T-0030 extends it
(or adds a new module) with **write routes**. The read routes are NOT replaced day-1 (they
may stay seed-backed until T-0053 wires the Postgres DAO — the write routes need DB access
for the admin-context query and the INSERT; reads may remain seed-backed).

`src/http/router.ts` provides `readJsonBody`, `HttpError`, `mapDomainError` — reuse verbatim.

`src/db/org.ts` is the existing DB access module — T-0030 adds DB helpers for:
(a) resolving `isGenesisOwner` for the acting principal,
(b) loading the actor's covering mgmt-grants (`adminGrants`) and their `org_scope`,
(c) INSERT into `"grant"` and `role_assignment`,
(d) soft-revoke of a `grant` or `role_assignment` (by setting `valid_until = now`).

### 1.3 Web screen (already rendered, read-only)

`web/src/screens/rights/screen-rights.jsx` renders the read-only role list + grant matrix
from `GET /api/rights`.

`web/src/screens/rights/ra-role-editor.jsx` already renders the **full progressive-disclosure
editor UI** in static/frontend-only form — presets (simple mode) and grant atoms (advanced
mode), `ScopePicker` (org-tree + tag-set + numeric interval), LLM-proposes panel. This UI
is the day-1 target; T-0030 wires its submit path to the new write-API.

`web/src/screens/rights/ra-data.jsx` exports `RESOURCES` (the resource/registry menu),
`ORG_TREE`/`ORG_BY_ID` (the scope picker lattice), `SCOPE_TAGS`, `PRESETS` (simple-mode
bundles), and the `axesFromGrants` criticality helper.

T-0030 day-1: the editor UI already exists; T-0030 adds the API `onSubmit` handler that
`POST`s the grant-set diff to the write-API and handles the `proposed_by`/`confirmed_by`
flow.

### 1.4 Migration seam

Last shipped migration: `028_actor_event_seq_no_decrement.sql`. Migration 026 comment cites
`023–025 = T-0062 reserved`. T-0030 migrations are numbered **030+** (the prompt instruction
"029=T-0063 in flight" means 029 is reserved). T-0030 may require no new DDL tables (write
paths land in the existing `grant` and `role_assignment` tables — both already RLS-enabled
and registered in `known_tenant_tables.txt`). If no new table is created, no
`known_tenant_tables.txt` or `cross_tenant` change is needed; the AC records this vacuously.

### 1.5 Audit contract (T-0018 FR-7 / T-0016)

`GrantAuditEvent` is the frozen emit shape:
```ts
{ kind: "grant.create" | "grant.revoke"; actor: string; subjectRoleId: string;
  capability: { resourceType: string; operation: string; resourceFacet?: unknown };
  scope: Scope; proposedBy?: string; confirmedBy?: string; }
```
Every `POST /api/grants` and every revoke call site MUST emit this event into the audit floor
(`audit_event` table via the T-0016 append path) as the call's side-effect. `actor_event`
(E4.1/T-0019) covers guarded transitions — grant-write is an **mgmt_object:grant write**, not
a guarded transition (no `actor_event` row needed at this layer; the `GrantAuditEvent` to
`audit_event` is the AC-15 obligation).

---

## 2. Functional requirements

**FR-1 Structural grant create (capability-not-text).**
`POST /api/grants` accepts a body composed entirely from dictionaries:
- `role_id`: existing role UUID (from `role` table).
- `resource_type`: one of the registered resource types (application/registry/record or a
  `mgmt_object:*` kind from `MGMT_OBJECT_KINDS`).
- `resource_facet`: optional — an object `{ fields: string[] }` naming the visible fields, or null
  (whole-resource).
- `operation`: one of the T-0018 `Operation` union literals.
- `scope`: a `ScopeElement` (node / tags / interval / set) — NOT free-text; the API rejects any
  scope that does not parse as a valid lattice `ScopeElement`.
- `constraint`: optional jsonb — any extra constraint payload; nil = none.
- `delegable`: boolean (default true).
- `valid_from`, `valid_until`: optional bigint epoch-ms.
- `proposed_by`: optional string (actor id) — when the write is a proposal (e.g. LLM-proposed via
  E3.5), the proposer is recorded; `confirmed_by` remains null until confirmation.
- `confirmed_by`: optional string — the confirming human actor; a grant with `confirmed_by IS NULL`
  is a PROPOSAL (not yet effective per T-0022/T-0020 contract).

**FR-2 Every grant write gated by `validateAdminDelegation`.**
Before INSERT, the API resolves the acting principal's `AdminContext` from the DB:
- `isGenesisOwner`: true iff the actor holds the `tenant-owner` role via a confirmed, in-window
  `role_assignment` in the request's tenant.
- `adminGrants`: all confirmed, in-window, delegable `mgmt_object:*` grants reachable through the
  actor's confirmed in-window assignments.
- `adminOrgScope`: the union of the actor's administering `role_assignment.org_scope` values.

If `validateAdminDelegation` returns `{ok: false}`, the API returns HTTP 403 with the typed
rejection reason in the body; the INSERT is never executed.

**FR-3 Structural grant revoke.**
`POST /api/grants/:id/revoke` soft-revokes a grant: sets `valid_until = now_ms` on the
`"grant"` row (the record stays in the table for audit integrity). Gated by
`validateAdminDelegation` with `kind: "grant"` (the admin must hold a covering mgmt-grant
on `mgmt_object:grant` over the target's org context). Emits `GrantAuditEvent` with
`kind: "grant.revoke"`.

**FR-4 Structural assignment create.**
`POST /api/role-assignments` creates a `role_assignment` row. Body:
- `employee_id`, `role_id`, `org_scope` (lattice `ScopeElement`, hierarchy `org`).
- `valid_from`, `valid_until` (optional).
- `source` (text), `granted_by` (actor id).
- `proposed_by` (optional), `confirmed_by` (optional — absent = proposal).

Gated by `validateAdminDelegation` with `kind: "assignment"` (org-axis gate; org-scope
of the target must be `⊑` the admin's `adminOrgScope`).

**FR-5 Structural assignment revoke.**
`POST /api/role-assignments/:id/revoke` soft-revokes: sets `valid_until = now_ms`. Gated
by `validateAdminDelegation` with `kind: "assignment"`.

**FR-6 Audit emit on every write.**
Every create (`POST /api/grants`, `POST /api/role-assignments`) and every revoke emits
a `GrantAuditEvent` into the `audit_event` table via the T-0016 audit-append path.
`proposed_by`/`confirmed_by` are threaded from the request body.

**FR-7 Progressive disclosure — UI wired to write-API (day-1).**
The existing `ra-role-editor.jsx` `RoleEditorScreen` is wired:
- "Запросить применение" button submits the current grant-set diff as `POST /api/grants`
  (one call per new grant, `confirmed_by` = acting user id for direct submissions).
- The LLM-proposes panel sets `proposed_by` = "llm", `confirmed_by` = null on the proposal
  grant rows; a separate "Подтвердить грант" button sends a confirmation call that sets
  `confirmed_by`.
- Simple (preset) mode expands presets into the same structural grant atoms before submit —
  no separate preset storage layer.

**FR-8 Dictionary endpoints (read-only, supports the picker).**
`GET /api/rights/dictionaries` returns the resource registry, operation list, scope-tag catalogue,
and org-tree — the closed dictionaries the UI picker is built from. These are the day-1 seed data
from `ra-data.jsx` (RESOURCES, ORG_TREE, SCOPE_TAGS, PRESETS) served from the API so the UI
is not hardcoded.

---

## 3. Non-functional requirements

**NF-1 Scope must parse as a structural lattice element.**
The write-API rejects any `scope` payload that does not parse to a valid `ScopeElement`
(node/tags/interval/set). Free-form scopes are accepted only if `isGenesisOwner === true`
(and are forced `delegable: false`). No free-text right descriptions.

**NF-2 Tenant isolation on every DB write.**
All INSERTs and UPDATEs carry `tenant_id` extracted from the authenticated request context
(X-Dev-User header in dev; Keycloak JWT in prod). RLS policies on `grant` and `role_assignment`
already enforce isolation; the write path must not bypass them.

**NF-3 `isGenesisOwner` is DB-resolved, never assumed.**
The admin-context query that sets `isGenesisOwner` must read the `role_assignment` table (joins
`role` where `slug = 'tenant-owner'`, `confirmed_by IS NOT NULL`, validity window check against
`now()`). Never hardcoded or assumed from a JWT claim.

**NF-4 No new scope algebra.**
Scope validation reuses `normalize` + `isNarrowerOrEqual` from `grant-lattice.ts`. No new
`ScopeElement` kind.

**NF-5 No DDL in T-0030 (unless a new table is required).**
Write routes land in the existing `grant` and `role_assignment` tables. If T-0030 adds no new
table, migrations numbered from 030+ are optional seed-only. If a helper table is added (e.g.
for dictionary versioning), it is numbered 030+, has `tenant_id` leading, RLS, `FORCE ROW LEVEL
SECURITY`, `GRANT` to `choros_app`, and is added to `known_tenant_tables.txt`.

**NF-6 `GrantAuditEvent` shape is frozen.**
T-0030 does not redefine `GrantAuditEvent`; it imports it from `grant-lattice.ts` verbatim.

**NF-7 `validateAdminDelegation` is not re-implemented.**
T-0030 imports `validateAdminDelegation` from `src/core/scoped-admin.ts` verbatim; the write-API
module does not reimplement narrowing logic.

**NF-8 HTTP error codes are machine-readable.**
- `validateAdminDelegation` rejection → 403 with `{ code: "ADMIN_GATE_REJECTED", reason: "<typed reason>" }`.
- Malformed scope → 400 `INVALID_SCOPE`.
- Unknown `role_id` / `employee_id` → 404.
- Tenant mismatch → 403 `CROSS_TENANT`.

---

## 4. Out of scope (day-1)

- LLM-proposes-grants / human-confirms full workflow = T-0039 (E3.5). T-0030 only wires the
  `proposed_by`/`confirmed_by` fields and the UI panel for the static preview; the BYO-LLM
  call is T-0039.
- DB-backed read resolution (T-0053 Postgres DAO): `GET /api/rights` may remain seed-backed;
  only the write path needs real DB access.
- `role_criticality` computation = T-0040 (E4.5). T-0030 displays criticality as a UI hint
  (already in `ra-role-editor.jsx` via `axesFromGrants`), but does not persist it.
- Dual-control gate = T-0044 (E4.6). T-0030 records `proposed_by`/`confirmed_by` in the schema
  but does not enforce the two-approver rule; that is T-0044's gate layered on top.
- SoD enforcement = T-0032 (E4.2). Grant writes are `mgmt_object:grant` writes, not guarded
  transitions; `actor_event` rows are not emitted at this layer.
- TTL-delegation / substitution mechanics = T-0035 (E4.7).
- Batch import / CSV-upload of grant sets.
- UI pagination, search, or filtering on the role rail (seed data is sufficient day-1).
- Keycloak integration / JWT auth (dev: X-Dev-User header; prod auth = T-0054 deliverable).

---

## 5. Acceptance criteria

| Id | Text | Verifiable as |
|----|------|---------------|
| AC-01 | `POST /api/grants` with a valid structural body (role_id, resource_type, operation, valid ScopeElement scope, delegable, granted_by) → 201 and a grant row inserted in `"grant"` table with correct `tenant_id` and the supplied fields. | test |
| AC-02 | `POST /api/grants` where `validateAdminDelegation` returns `{ok:false, reason:"scope_widens"}` → 403 with `code: "ADMIN_GATE_REJECTED"` and `reason: "scope_widens"`; no row inserted. | test |
| AC-03 | `POST /api/grants` where `validateAdminDelegation` returns `{ok:false, reason:"org_scope_widens"}` → 403 with `reason: "org_scope_widens"`; no row inserted. | test |
| AC-04 | `POST /api/grants` where `validateAdminDelegation` returns `{ok:false, reason:"no_admin_authority"}` → 403; no row inserted. | test |
| AC-05 | `POST /api/grants` with a free-text `scope` payload (not a parseable `ScopeElement`) → 400 `INVALID_SCOPE`; no row inserted. | test |
| AC-06 | `POST /api/grants` by the genesis owner (`isGenesisOwner = true`, resolved from DB) with any valid structural scope → 201; genesis owner is not subset-checked against a parent (validateAdminDelegation step 3 short-circuit). | test |
| AC-07 | `POST /api/grants/:id/revoke` by an authorized admin → 200; `valid_until` on the target grant row is set to the request time (epoch-ms); the row is NOT deleted. | test |
| AC-08 | `POST /api/grants/:id/revoke` by a principal without covering `mgmt_object:grant` authority → 403 `ADMIN_GATE_REJECTED`. | test |
| AC-09 | `POST /api/role-assignments` with valid body (employee_id, role_id, org_scope as org-hierarchy ScopeElement, granted_by) → 201 and a row inserted in `role_assignment` with correct `tenant_id`. | test |
| AC-10 | `POST /api/role-assignments` where the target `org_scope` escapes the admin's `adminOrgScope` (org_scope_widens) → 403 `ADMIN_GATE_REJECTED`; no row inserted. | test |
| AC-11 | `POST /api/role-assignments/:id/revoke` by authorized admin → 200; `valid_until` set; row not deleted. | test |
| AC-12 | Every successful `POST /api/grants` emits a `GrantAuditEvent` (`kind: "grant.create"`) into the `audit_event` table with correct `actor`, `subjectRoleId`, `capability` (`resourceType`, `operation`), `scope`, and (when present) `proposedBy` / `confirmedBy`. Static lint asserts the emit call-site imports `GrantAuditEvent` from `grant-lattice.ts`. | fitness |
| AC-13 | Every successful `POST /api/grants/:id/revoke` emits a `GrantAuditEvent` (`kind: "grant.revoke"`) into `audit_event`. | test |
| AC-14 | `POST /api/grants` with `proposed_by` set and `confirmed_by` absent → row inserted with `confirmed_by IS NULL` (PROPOSAL, not yet effective per T-0022 contract). Subsequent confirmation call sets `confirmed_by` to the confirming actor. | test |
| AC-15 | `isGenesisOwner` is resolved from the DB (role_assignment JOIN role WHERE slug = 'tenant-owner' AND confirmed_by IS NOT NULL AND validity window passes); it is never assumed or hardcoded. Static lint asserts no hardcoded `isGenesisOwner = true` outside the DB-query helper. | fitness |
| AC-16 | `GET /api/rights/dictionaries` returns a JSON body containing `resources` (array with uri and name), `operations` (array of operation literals), `orgTree` (array of org nodes with id/label/depth/children), and `scopeTags` (array with id/label). | test |
| AC-17 | Progressive-disclosure UI: the "Запросить применение" button in `RoleEditorScreen` triggers `POST /api/grants` for each grant in the current set; a 403 response surfaces the typed rejection reason inline; a 201 response adds the grant to the confirmed-grants view. | manual |
| AC-18 | Simple (preset) mode: selecting a preset and submitting expands it into structural grant atoms server-side (or client-side before POST) — no separate preset table; the resulting POST body is the same structural atom shape as advanced mode. | manual |
| AC-19 | No new tenant table is created by T-0030 (grant and role_assignment are the write targets; both already in `known_tenant_tables.txt`). If this changes during DESIGN, the new table must be added to `known_tenant_tables.txt` and have a `seedRowForTable` case in `cross_tenant.test.ts`. | fitness |
| AC-20 | Every DB write (`INSERT INTO "grant"`, `UPDATE "grant"`, `INSERT INTO role_assignment`, `UPDATE role_assignment`) includes `tenant_id` as the leading parameter; the RLS policy is not bypassed (no superuser path). | fitness |

---

## 6. Shim seam notes for DESIGN

- **`isGenesisOwner` DB query**: new helper in `src/db/org.ts` (or a new `src/db/rights.ts`):
  `isGenesisOwnerForTenant(actorEmployeeId, tenantId, nowMs, db)` — one query joining
  `role_assignment` → `role` WHERE `role.slug = 'tenant-owner'`.
- **Admin context load**: `loadAdminContext(actorEmployeeId, tenantId, nowMs, db)` — queries
  confirmed in-window assignments → their mgmt-grants → builds `AdminContext`.
- **Scope parsing**: `parseScopeElement(raw: unknown): ScopeElement | null` — validates and
  normalizes the incoming JSON scope. Freeform is admitted only if `isGenesisOwner`.
- **Migration seam**: T-0030 ships no DDL table. If a seed migration is needed (e.g. sample
  grant rows for the dev silo), it is numbered `030_...` and is INSERT-only into existing tables.
