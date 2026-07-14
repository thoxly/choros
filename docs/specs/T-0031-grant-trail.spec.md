# Spec · T-0031 — Grant trail (E3.6)

**Epic/Story:** E3.6 — Grant trail: who granted/revoked what (proposed_by+confirmed_by) in the
unified per-tenant audit.

**Status:** `ready` (no blocking founder questions — GT-1 signed for E3.6; the grant-trail-in-
unified-audit requirement and the proposed_by/confirmed_by columns are direct implementation of
the signed model).

**Phase:** SPEC. Machine-readable contract: `docs/specs/T-0031.spec.contract.json`
(schema `schemas/spec.schema.json`).

**Deps (both done on base dev `0de43cc`):**
- E2.8 (T-0016): `audit_event` schema + `audit_head` + append contract (`appendAuditEvent`
  pseudocode pinned in ADR §4.3; real implementation is T-0053). The floor is physically present
  as migrations `006_audit_event.sql` + `007_audit_head.sql` with correct DDL, triggers, and
  privilege posture.
- E3.2 (T-0022): `role_assignment` table with `proposed_by`/`confirmed_by` columns (migration
  `020_role_assignment.sql`). The `grant` table already has the necessary columns (migration
  `008_grant.sql`).

**Parallel task seam (T-0030 / E3.4):** T-0030 owns the write-path for grants — the HTTP
endpoints (`POST /api/grants`, `POST /api/grants/:id/revoke`, `POST /api/role-assignments`,
`POST /api/role-assignments/:id/revoke`), the `validateAdminDelegation` call, and the
`INSERT`/`UPDATE` DB statements. **T-0031 owns:**
1. The **encoder** — the function `encodeGrantAuditEvent(e: GrantAuditEvent): AuditEventInput`
   that maps a `GrantAuditEvent` (from `src/core/grant-lattice.ts` FR-7) to an `AuditEventInput`
   for the T-0016 append path — the **contractual seam that T-0030's coder will call**.
2. The **grant-trail query API** — `GET /api/grant-trail` (filterable by role, actor, subject)
   and the DB query function that reads `audit_event` rows whose `type ∈ {grant.create,
   grant.revoke, assignment.create, assignment.revoke}`.
3. The **read side of the grant-trail UI** — wiring `GrantTrailScreen` (already in
   `web/src/screens/rights/ra-grant-trail.jsx`) to the live API endpoint.

---

## 0. One-line summary

Ship the `encodeGrantAuditEvent` encoder (the `GrantAuditEvent` → `AuditEventInput` contract
T-0030 will call at every grant write call-site) and the grant-trail read API (`GET
/api/grant-trail`) plus UI wiring so that every grant create/revoke/assignment change is
permanently queryable as a first-class row in the unified per-tenant `audit_event` floor.

---

## 1. Context: what already exists (do not rebuild)

### 1.1 Audit floor (T-0016)

`audit_event` schema: `type text NOT NULL`, `actor text NOT NULL`, `subject text NULL`,
`scope jsonb NULL`, `via text NULL`, `proposed_by text NULL`, `confirmed_by text NULL`,
`payload jsonb NOT NULL`, `occurred_at bigint NOT NULL`, plus chain columns (`seq`, `id`,
`prev_hash`, `row_hash`, `vocab_version`). Append-only enforced by dual mechanism (privilege +
trigger). Every new event *kind* maps to a row in this table — no separate log table is ever
created (T-0016 ADR §2 explicitly rejected a separate `grant_log`).

The append contract (`appendAuditEvent` pseudocode from T-0016 ADR §4.3) is the **single
sanctioned write path** into `audit_event`. The live implementation is T-0053. T-0031 uses it
via an `AuditEventInput` shape.

### 1.2 `GrantAuditEvent` shape (T-0018 FR-7)

Already defined in `src/core/grant-lattice.ts`:

```ts
export type GrantAuditEvent = {
  kind: "grant.create" | "grant.revoke";
  actor: string;
  subjectRoleId: string;
  capability: { resourceType: string; operation: string; resourceFacet?: unknown };
  scope: Scope;
  proposedBy?: string;
  confirmedBy?: string;
};
```

T-0031 does **not** redefine this type. The encoder imports it verbatim.

### 1.3 Existing write-path obligations (T-0030 spec §1.5 / AC-12, AC-13)

T-0030 spec states: *"Every `POST /api/grants` and every revoke call site MUST emit this event
into the audit floor (`audit_event` table via the T-0016 append path) as the call's side-effect."*
T-0030's FR-6 / AC-12 / AC-13 are the **obligations**; T-0031's encoder is the **mechanism** T-0030
will call to fulfill them. The encoder is T-0031's primary deliverable — T-0030's coder will import
it from `src/core/audit-grant-encoder.ts` (the module T-0031 delivers) and call it before the
`appendAuditEvent` call.

### 1.4 `AuditEventInput` type (defined by the encoder module T-0031 ships)

T-0016 ADR §4.3 pseudocode calls `appendAuditEvent(tx, e: AuditEventInput)`. The concrete
TypeScript type `AuditEventInput` is defined by T-0031 in `src/core/audit-grant-encoder.ts`
(since T-0053 does not yet exist). Its fields map directly to the `audit_event` columns:

```ts
export type AuditEventInput = {
  id: string;           // stable UUID (caller-minted, e.g. crypto.randomUUID())
  type: string;         // e.g. "grant.create"
  actor: string;
  subject: string | null;
  scope: unknown | null; // JCS-serialized ScopeElement | null
  via: string | null;
  proposed_by: string | null;
  confirmed_by: string | null;
  payload: unknown;     // JCS-serialized event detail object
  occurred_at: number;  // epoch-ms bigint as TS number (safe for 2^53)
};
```

### 1.5 Grant-trail UI component (already rendered, read-only)

`web/src/screens/rights/ra-grant-trail.jsx` renders `GrantTrailScreen`. It reads from the
`TRAIL` constant in `ra-data.jsx` (static seed, 10 rows). T-0031 wires it to `GET
/api/grant-trail` so it renders live data from `audit_event`.

The UI screen already has column slots for: timestamp, event ID, action (grant/revoke/narrow),
actor (who granted/revoked), subject (to whom), role + grant (role name + op + resource), scope,
and provenance (proposed_by + confirmed_by list). T-0031 day-1 data maps onto these columns.

### 1.6 Migration seam

Last shipped migration: `029_lock_sweep_buckets.sql`. T-0031 requires no new DDL table — grant
events are rows in the existing `audit_event` table and the encoder reads from the existing
`grant` and `role_assignment` tables. If a seed migration is added (e.g. dev-silo sample trail
rows), it is numbered **030+** and is INSERT-only into existing tables. No
`known_tenant_tables.txt` change is needed.

### 1.7 Assignment events (role_assignment changes)

`GrantAuditEvent` covers grant-level changes (`grant.create` / `grant.revoke`). Assignment-level
changes (`role_assignment` create/revoke) also belong in the grant trail (E3.6: "who granted/
revoked what … proposed_by+confirmed_by"). T-0031 extends the encoder to handle assignment
events by defining two additional event types: `assignment.create` and `assignment.revoke`. The
encoder module exports a second shape `AssignmentAuditEvent` and a second encoder function
`encodeAssignmentAuditEvent`.

---

## 2. Functional requirements

**FR-1 Encoder — `encodeGrantAuditEvent(e: GrantAuditEvent): AuditEventInput`.**
A pure function exported from `src/core/audit-grant-encoder.ts`. Accepts a `GrantAuditEvent`
(from `grant-lattice.ts`) and returns an `AuditEventInput` ready to pass to `appendAuditEvent`:
- `type` ← `e.kind` (`"grant.create"` or `"grant.revoke"`)
- `actor` ← `e.actor`
- `subject` ← `e.subjectRoleId`
- `scope` ← `e.scope` (the `Scope` / `ScopeElement` value; JCS-serialization is the append
  path's responsibility)
- `via` ← `null` (grant writes come via the HTTP write-API, not via a BPMN/tool path; the
  T-0030 write-API route MAY override this to its path)
- `proposed_by` ← `e.proposedBy ?? null`
- `confirmed_by` ← `e.confirmedBy ?? null`
- `payload` ← `{ resourceType: e.capability.resourceType, operation: e.capability.operation,
   ...(e.capability.resourceFacet !== undefined ? { resourceFacet: e.capability.resourceFacet } : {}) }`
- `occurred_at` ← caller-supplied `nowMs: number` (second parameter)
- `id` ← caller-supplied stable UUID OR generated by the encoder (`crypto.randomUUID()`)

The function is **pure and IO-free** — no DB/network/LLM calls.

**FR-2 Encoder — `encodeAssignmentAuditEvent(e: AssignmentAuditEvent, nowMs: number): AuditEventInput`.**
A pure encoder for role-assignment changes. `AssignmentAuditEvent` shape:
```ts
export type AssignmentAuditEvent = {
  kind: "assignment.create" | "assignment.revoke";
  actor: string;
  employeeId: string;
  roleId: string;
  orgScope: unknown;    // ScopeElement (hierarchy: "org")
  proposedBy?: string;
  confirmedBy?: string;
};
```
Mapping:
- `type` ← `e.kind`
- `actor` ← `e.actor`
- `subject` ← `e.employeeId`
- `scope` ← `e.orgScope`
- `proposed_by` ← `e.proposedBy ?? null`
- `confirmed_by` ← `e.confirmedBy ?? null`
- `payload` ← `{ roleId: e.roleId }`
- `occurred_at` ← `nowMs`

**FR-3 Grant-trail query function — `queryGrantTrail(db, tenantId, opts): Promise<GrantTrailRow[]>`.**
A DB query function exported from `src/db/audit-grant-trail.ts` that reads `audit_event` rows
where `type IN ('grant.create', 'grant.revoke', 'assignment.create', 'assignment.revoke')` for
the given tenant. Supports optional filter parameters:
- `roleId?: string` — filter `subject = roleId` (for grant events) or `payload->>'roleId' = roleId`
  (for assignment events)
- `actor?: string` — filter `actor = actor`
- `subject?: string` — filter `subject = subject`
- `limit?: number` — default 100, max 500
- `beforeSeq?: number` — cursor-based pagination (rows with `seq < beforeSeq`)

Returns `GrantTrailRow[]` — a TS type defined in `src/db/audit-grant-trail.ts` that mirrors
the `audit_event` columns needed by the UI:

```ts
export type GrantTrailRow = {
  seq: number;
  id: string;
  type: string;
  actor: string;
  subject: string | null;
  scope: unknown | null;
  proposed_by: string | null;
  confirmed_by: string | null;
  payload: unknown;
  occurred_at: number;
};
```

The function runs inside `withTenant` (T-0013 pattern from `src/db/org.ts`), sets
`choros.tenant_id` GUC, and uses RLS — no raw `tenant_id` filter in the WHERE clause is
required (RLS applies it), but the function also sends `tenant_id` in the GUC for defense-
in-depth matching the existing pattern.

**FR-4 Grant-trail HTTP endpoint — `GET /api/grant-trail`.**
Registered in `src/http/grant-trail.ts` (new module). Query params:
- `role_id` (optional) — maps to `roleId` filter
- `actor` (optional) — maps to `actor` filter
- `subject` (optional) — maps to `subject` filter
- `limit` (optional, default 100, max 500) — integer
- `before_seq` (optional) — cursor for pagination

Returns HTTP 200 with JSON body `{ rows: GrantTrailRow[], hasMore: boolean }`.
Falls back to static seed data (`TRAIL` from `ra-data.jsx` reformatted) when `DATABASE_URL` is
not set (dev without Postgres), using the same HTTP pattern as `src/http/audit.ts` and
`src/http/rights.ts`.

**FR-5 UI wiring — `GrantTrailScreen` reads from `/api/grant-trail`.**
`web/src/screens/rights/ra-grant-trail.jsx` is wired: on mount it fetches
`GET /api/grant-trail` and replaces the static `TRAIL` constant with the API response. Filter
tab changes (grant/revoke/all) and the "only critical" toggle re-filter the in-memory result
(day-1: client-side filter over the fetched batch; server-side filter via query params for role
& actor is available for deep links). A "load more" control triggers `before_seq` pagination.

**FR-6 Encoder is the contractual seam for T-0030.**
The encoder module `src/core/audit-grant-encoder.ts` exports:
- `encodeGrantAuditEvent(e: GrantAuditEvent, nowMs: number): AuditEventInput`
- `encodeAssignmentAuditEvent(e: AssignmentAuditEvent, nowMs: number): AuditEventInput`
- `AuditEventInput` type
- `AssignmentAuditEvent` type

T-0030's coder imports and calls `encodeGrantAuditEvent` at every grant write call-site
(before calling `appendAuditEvent`) and `encodeAssignmentAuditEvent` at every assignment write
call-site. This seam is ADDITIVE for T-0030: T-0030 only adds import + call-site; it does not
change the encoder's implementation.

---

## 3. Non-functional requirements

**NF-1 Encoder is pure and IO-free.**
`src/core/audit-grant-encoder.ts` performs no DB/network/LLM calls. Equal inputs → equal
output. It imports only from `src/core/grant-lattice.ts` (for `GrantAuditEvent`, `Scope`
types) and Node's `crypto` module for UUID generation (optional; caller may pass `id`). A
static lint asserts no `pg`, `fetch`, or external-IO import in this module.

**NF-2 Encoder does not redefine `GrantAuditEvent`.**
The encoder imports `GrantAuditEvent` verbatim from `src/core/grant-lattice.ts`. It does not
extend, re-export, or narrow the type. Static lint asserts the canonical source is unchanged.

**NF-3 No new tenant table.**
Grant trail data lives entirely in `audit_event`. No new table is created. `known_tenant_tables.txt`
is not changed. If a seed migration is added (INSERT-only into `audit_event` for dev-silo sample
rows), it is numbered 030+ and follows T-0013 invariants.

**NF-4 Trail query is RLS-scoped; no cross-tenant leakage.**
`queryGrantTrail` always runs inside `withTenant` (sets GUC). No raw `tenant_id = $n` where
clause is added without the GUC also being set. CI cross-tenant probe (`cross_tenant.test.ts`)
confirms no leakage (existing test covers `audit_event` via `known_tenant_tables.txt`).

**NF-5 Chain compatibility: the encoder emits rows that hash-chain correctly.**
`encodeGrantAuditEvent` output fields match the `audit_event` column set exactly (including all
nullable fields set to `null` when absent). The `occurred_at` field is epoch-ms bigint (TS
`number` ≤ 2^53 safe). The `payload` is a plain JSON-serializable object (no Buffer, no
circular refs). The encoder does NOT set chain columns (`seq`, `prev_hash`, `row_hash`,
`vocab_version`) — those are the append path's responsibility (T-0016 §4.3 contract).

**NF-6 No edit to `audit_event` DDL.**
T-0031 adds no columns and no migrations to `audit_event` or `audit_head`. The existing schema
already has `proposed_by`, `confirmed_by`, `scope`, `payload`, and `type`.

**NF-7 HTTP error codes are machine-readable.**
- Invalid `limit` (non-integer or > 500) → 400 `INVALID_PARAM`.
- Invalid `before_seq` (non-integer) → 400 `INVALID_PARAM`.
- DB unavailable → 503 (trail fallback to seed data if `DATABASE_URL` absent).

**NF-8 Backward-compatible static fallback.**
When `DATABASE_URL` is not set, `GET /api/grant-trail` returns seed data from the static
`TRAIL` constant (reformatted to `GrantTrailRow` shape). This preserves the current UI
behavior in the dev-no-Postgres environment.

---

## 4. Out of scope (day-1)

- **`appendAuditEvent` live implementation** — this is T-0053 (Postgres-in-compose). T-0031
  delivers the encoder that produces `AuditEventInput`; the live append path that consumes it
  is T-0053. Day-1 ACs are verifiable with a mock/stub `appendAuditEvent`.
- **T-0030 call-sites** — T-0030's coder calls the encoder at its HTTP write call-sites.
  T-0031 delivers the encoder and its contract; the actual call-sites are T-0030's BUILD
  output. A fitness lint in T-0031 asserts that T-0030 call-site stubs exist (see AC-11).
- **`assignment.narrow` event type** — the UI shows `action: "narrow"` in the static seed.
  Day-1 scope for T-0031 is `grant.create`, `grant.revoke`, `assignment.create`,
  `assignment.revoke`. The "narrow" action (scope reduction on an existing grant) is a future
  event type; the filter tabs in the UI gracefully skip unknown types.
- **Role_criticality flag on trail rows** — the `crit` field in the static `TRAIL` seed
  (derived from `axesFromGrants`) is a client-side decoration. Day-1 API response does not
  include a pre-computed `crit` flag; the UI recomputes it client-side if needed (or defers).
- **Export / download** — the "Экспорт" button in `GrantTrailScreen` is a future feature.
- **Server-side filter by action type** — day-1, `type` filter is client-side. The query
  function supports actor/subject/roleId server-side filters only; action-type server-side
  filter is deferred.
- **Dual-control gate confirmation audit** — T-0044 (E4.6) will emit additional confirmation
  events; their encoding is T-0044's concern.
- **LLM-proposes grant workflow audit** — T-0039 (E3.5) uses `proposed_by`/`confirmed_by`;
  the encoder already threads those fields, but the workflow is T-0039's scope.
- **Keycloak / JWT auth** — dev: X-Dev-User header; prod auth = T-0054.

---

## 5. Acceptance criteria

| Id | Text | Verifiable as |
|----|------|---------------|
| AC-01 | `encodeGrantAuditEvent({ kind: "grant.create", actor: "u1", subjectRoleId: "role-x", capability: { resourceType: "record", operation: "read" }, scope: { kind: "node", hierarchy: "org", nodeId: "dept-1", nodeLevel: "department" } }, 1000)` returns an `AuditEventInput` with `type="grant.create"`, `actor="u1"`, `subject="role-x"`, `scope` equal to the supplied ScopeElement, `proposed_by=null`, `confirmed_by=null`, `payload.resourceType="record"`, `payload.operation="read"`, `occurred_at=1000`. | test |
| AC-02 | `encodeGrantAuditEvent` with `proposedBy="llm"` and `confirmedBy="u2"` returns `proposed_by="llm"` and `confirmed_by="u2"` in the output. | test |
| AC-03 | `encodeGrantAuditEvent` with `kind="grant.revoke"` returns `type="grant.revoke"`. | test |
| AC-04 | `encodeGrantAuditEvent` with `capability.resourceFacet` present includes `resourceFacet` in `payload`; absent resourceFacet produces no `resourceFacet` key in `payload`. | test |
| AC-05 | `encodeAssignmentAuditEvent({ kind: "assignment.create", actor: "u1", employeeId: "emp-1", roleId: "role-x", orgScope: { kind: "node", hierarchy: "org", nodeId: "dept-1", nodeLevel: "department" } }, 2000)` returns `type="assignment.create"`, `actor="u1"`, `subject="emp-1"`, `scope` equal to `orgScope`, `payload.roleId="role-x"`, `occurred_at=2000`. | test |
| AC-06 | `encodeAssignmentAuditEvent` with `kind="assignment.revoke"` returns `type="assignment.revoke"`. | test |
| AC-07 | The encoder output for both `encodeGrantAuditEvent` and `encodeAssignmentAuditEvent` contains no chain columns (`seq`, `prev_hash`, `row_hash`, `vocab_version`) — those fields are absent from the returned object. | test |
| AC-08 | `encodeGrantAuditEvent` is pure: called twice with the same arguments returns structurally equal objects (same `type`, `actor`, `subject`, `scope`, `payload`, `occurred_at`, `proposed_by`, `confirmed_by`). The `id` field MAY differ if the encoder generates UUIDs, OR the encoder MUST accept an optional `id` override parameter that makes the output deterministic when provided. | test |
| AC-09 | Static lint: `src/core/audit-grant-encoder.ts` imports `GrantAuditEvent` and `Scope` from `grant-lattice.ts` and contains no `pg`, `fetch`, `http`, `https`, `net`, or `child_process` import. | fitness |
| AC-10 | Static lint: `src/core/grant-lattice.ts` exports the `GrantAuditEvent` type unchanged from its current definition — T-0031 adds no new exports to and makes no edits to `grant-lattice.ts`. | fitness |
| AC-11 | Static lint: there exist at least two call-site stub usages of `encodeGrantAuditEvent` in the codebase (in `src/core/audit-grant-encoder.ts` unit tests) demonstrating the T-0030 call contract: `const input = encodeGrantAuditEvent(event, nowMs)` followed by `appendAuditEvent(tx, input)` (mocked). This validates the seam is callable from T-0030 without further changes to the encoder. | fitness |
| AC-12 | `GET /api/grant-trail` (no filters) returns HTTP 200 with a JSON body `{ rows: [...], hasMore: boolean }` where `rows` is an array of `GrantTrailRow` objects each containing `seq`, `id`, `type`, `actor`, `subject`, `scope`, `proposed_by`, `confirmed_by`, `payload`, `occurred_at`. | test |
| AC-13 | `GET /api/grant-trail?role_id=<id>` returns only rows where `subject = <id>` or `payload.roleId = <id>` (depending on event type). | test |
| AC-14 | `GET /api/grant-trail?actor=<id>` returns only rows where `actor = <id>`. | test |
| AC-15 | `GET /api/grant-trail?limit=5` returns at most 5 rows; `hasMore=true` when there are more rows available. | test |
| AC-16 | `GET /api/grant-trail?limit=600` returns HTTP 400 `INVALID_PARAM`. | test |
| AC-17 | `GET /api/grant-trail?before_seq=abc` (non-integer) returns HTTP 400 `INVALID_PARAM`. | test |
| AC-18 | `GET /api/grant-trail` when `DATABASE_URL` is not set returns HTTP 200 with static seed data (fallback, ≥ 1 row). | test |
| AC-19 | `queryGrantTrail` runs inside `withTenant` (uses `choros.tenant_id` GUC). Cross-tenant probe: rows inserted for tenant A are not returned when queried as tenant B. Verified by the existing `cross_tenant.test.ts` flow (audit_event is already in `known_tenant_tables.txt`; no new table = no new row needed in that fixture). | test |
| AC-20 | `queryGrantTrail` returns only rows where `type IN ('grant.create', 'grant.revoke', 'assignment.create', 'assignment.revoke')`. A row with `type='approve'` inserted into `audit_event` is NOT returned by `queryGrantTrail`. | test |
| AC-21 | `GrantTrailScreen` mounts, calls `fetch('/api/grant-trail')`, and renders the response rows in the trail table (verified by manual check or a DOM smoke test asserting ≥1 `.chs-trailrow` element after fetch resolves). The static `TRAIL` constant in `ra-data.jsx` is no longer used as the primary data source for `GrantTrailScreen` — it becomes the fallback for the static-no-Postgres path only. | manual |
| AC-22 | No new tenant table is created by T-0031. `known_tenant_tables.txt` is unchanged. Verified by a fitness lint asserting no new `CREATE TABLE` in any migration numbered 030+ that T-0031 ships, except INSERT-only seeds. | fitness |
| AC-23 | If T-0031 ships a seed migration (INSERT into `audit_event`), it is numbered 030+ and is idempotent (`ON CONFLICT DO NOTHING` or equivalent). | fitness |

---

## 6. Contractual seam for T-0030 (DESIGN handoff)

T-0030's coder uses T-0031's encoder at every grant and assignment write call-site. The seam
is frozen here so T-0030 can sit on it additively:

```ts
// T-0030 write-API (pseudocode — T-0030's coder writes this, not T-0031)
import { encodeGrantAuditEvent, encodeAssignmentAuditEvent } from
  "../core/audit-grant-encoder.js";

// In POST /api/grants handler, after validateAdminDelegation passes and before DB INSERT:
const auditInput = encodeGrantAuditEvent(
  {
    kind: "grant.create",
    actor: req.actor,
    subjectRoleId: body.role_id,
    capability: {
      resourceType: body.resource_type,
      operation: body.operation,
      ...(body.resource_facet ? { resourceFacet: body.resource_facet } : {}),
    },
    scope: body.scope,
    proposedBy: body.proposed_by,
    confirmedBy: body.confirmed_by,
  },
  Date.now(),
);
await appendAuditEvent(tx, auditInput);   // T-0016 append path (T-0053 live impl)
```

**Invariants frozen for T-0030:**
- `src/core/audit-grant-encoder.ts` module path and exported names are stable.
- `AuditEventInput` type is complete — T-0030 passes it as-is to `appendAuditEvent`.
- `encodeGrantAuditEvent` and `encodeAssignmentAuditEvent` are pure; T-0030 may call them
  outside a DB transaction context.
- T-0030 supplies `proposed_by`/`confirmed_by` from its HTTP request body; the encoder
  threads them. T-0030 does NOT emit `proposed_by`/`confirmed_by` directly — it goes through
  the encoder.

---

## 7. Shim seam notes for DESIGN

- **`src/core/audit-grant-encoder.ts`** — new pure module. Imports `GrantAuditEvent`, `Scope`
  from `grant-lattice.ts`. Exports `AuditEventInput`, `AssignmentAuditEvent`,
  `encodeGrantAuditEvent`, `encodeAssignmentAuditEvent`. Contains its own unit tests (or a
  companion `audit-grant-encoder.test.ts` in `src/__tests__/`).
- **`src/db/audit-grant-trail.ts`** — new DB module. Imports `withTenant` pattern from
  `src/db/org.ts` (or a shared helper). Exports `GrantTrailRow`, `queryGrantTrail`. Uses
  `DATABASE_URL` from the pool; falls back to returning `[]` when unavailable (the HTTP layer
  serves static seed in that case).
- **`src/http/grant-trail.ts`** — new HTTP module. Exports `registerGrantTrailRoutes(router,
  pool?)`. Registered in `src/server.ts` (or `src/index.ts`) alongside the existing route
  registrations.
- **`web/src/screens/rights/ra-grant-trail.jsx`** — edit: replace `TRAIL` data-source with
  `useEffect` fetch to `/api/grant-trail`. The `TRAIL` import from `ra-data.jsx` becomes the
  initial/fallback state.
- **Migration seam**: T-0031 ships no DDL. If seed rows are added they are numbered `030_`
  and INSERT into `audit_event` only.
