# ADR · T-0031 — Grant trail encoder + read API (E3.6)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-11
**Task:** E3.6 — Grant trail: who granted/revoked what (proposed_by+confirmed_by) in the unified per-tenant audit.
**Spec:** `docs/specs/T-0031-grant-trail.spec.md` (status: ready, AC-01..AC-23) · `docs/specs/T-0031.spec.contract.json`

**Foundation (do NOT contradict):**
- `docs/design/T-0016-audit-floor.adr.md` — `audit_event` is the single append-only hash-chained floor; T-0031 adds rows, never tables; the only sanctioned write path is `appendAuditEvent(tx, e: AuditEventInput)`.
- `docs/design/T-0018-grant-authority.adr.md` — `GrantAuditEvent` shape (FR-7) is the canonical event type; T-0031 imports it verbatim; `grant-lattice.ts` is NOT edited.
- `docs/design/T-0013-tenant-isolation.adr.md` — `audit_event` is an ordinary FORCE-RLS default-DENY tenant table; all DB reads go through `withTenant` + `choros.tenant_id` GUC.
- `docs/design/T-0022-roles-assignments.adr.md` — `role_assignment.proposed_by`/`confirmed_by` columns exist (migration 020); `grant.proposed_by`/`confirmed_by` are added by T-0030 (migration 030, parallel task).

**Parallel seam (T-0030):** T-0030 is in-flight on its own branch and owns migration 030 (`ALTER TABLE grant ADD COLUMN IF NOT EXISTS proposed_by/confirmed_by`). This task's encoder reads those values from the `GrantAuditEvent` shape (not directly from the `grant` table), so T-0031 has **no hard dependency on migration 030 for its code to work**. The query layer (`queryGrantTrail`) reads only `audit_event` columns — all present since migration 006. No order-of-merge constraint; the encoder is purely functional and T-0030's coder adds the call-sites additively.

---

## 1. Decision

**Ship three new source modules — `src/core/audit-grant-encoder.ts` (pure IO-free encoder), `src/db/audit-grant-trail.ts` (RLS-scoped trail query), `src/http/grant-trail.ts` (HTTP route) — plus UI wiring in `web/src/screens/rights/ra-grant-trail.jsx`, with zero new DDL. All grant and assignment change events are recorded as rows in the existing `audit_event` floor by having T-0030 call the encoder at each write call-site. The grant trail is read via `GET /api/grant-trail` which queries `audit_event` rows filtered by `type IN ('grant.create','grant.revoke','assignment.create','assignment.revoke')` inside `withTenant`.**

The mechanism is proportional: no new table, no new log, no separate channel — grant events are first-class rows in the unified audit floor (T-0016 ADR §2 explicitly rejected a separate `grant_log`). The encoder is the only new pure-core artifact; everything else is thin glue over existing infrastructure.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Separate `grant_log` table** | T-0016 ADR §2 explicitly rejected this: two tables = two append-only/chain/isolation code-paths + two 152-ФЗ/GDPR narratives. New event types are rows, never tables. Known-tenant-tables isolation test would need a new entry too. |
| **Encode `GrantAuditEvent` inline inside T-0030's HTTP handlers** | Creates duplicated mapping logic across call-sites; if the `AuditEventInput` shape evolves (e.g. a new nullable field), every T-0030 call-site must change independently. A single encoder module is the single source of truth for the mapping contract; T-0030 just imports and calls. |
| **Re-define `GrantAuditEvent` in the encoder module** | Violates NF-2 and the FE-W23-0008 compatibility rule: `GrantAuditEvent` is exported from `grant-lattice.ts` (T-0018 FR-7); a re-definition would silently diverge the two types. The encoder imports verbatim. |
| **Separate `assignment_log` for assignment events** | Same objection as `grant_log`. `assignment.create`/`assignment.revoke` are two more event types in `audit_event`. T-0031 provides `encodeAssignmentAuditEvent` for the same reason: a second pure encoder for assignment write call-sites in T-0030. |
| **Server-side `type` filter in the trail query (day-1)** | Deferred per spec §4. The four-type `IN` clause already narrows to grant-family events; UI tabs filter client-side over the fetched batch. Server-side `type` filter added in a future task. |
| **Pass `proposed_by`/`confirmed_by` from T-0031's query directly (skipping encoder)** | The encoder is the contractual seam for T-0030's write-path (spec §6). T-0031 cannot impose data at write time via the read-path; the read-path only surfaces what T-0030 wrote. |
| **Wait for T-0030 to merge before finalizing encoder** | The encoder depends on `GrantAuditEvent` shape (already live in `grant-lattice.ts`) and the `AuditEventInput` shape (defined by T-0031 itself). No runtime dependency on migration 030. Decoupled — parallel merge order is safe. |

---

## 3. Object model

### 3.1 `AuditEventInput` (defined by T-0031, consumed by T-0030 + T-0053)

The concrete TypeScript type exported from `src/core/audit-grant-encoder.ts`. Maps directly onto `audit_event` columns that callers can supply (chain columns are excluded — they are `appendAuditEvent`'s responsibility):

| Field | TS type | Nullable | Maps to `audit_event` column | Notes |
|---|---|---|---|---|
| `id` | `string` | No | `id uuid` | Stable UUID; may be caller-minted or encoder-generated |
| `type` | `string` | No | `type text` | e.g. `"grant.create"`, `"assignment.revoke"` |
| `actor` | `string` | No | `actor text` | Who performed the write |
| `subject` | `string \| null` | Yes | `subject text` | Role ID (grant events) or employee ID (assignment events) |
| `scope` | `unknown \| null` | Yes | `scope jsonb` | `ScopeElement` or `null`; JCS-serialization is `appendAuditEvent`'s responsibility |
| `via` | `string \| null` | Yes | `via text` | `null` for encoder-produced events (T-0030 MAY set to its route path) |
| `proposed_by` | `string \| null` | Yes | `proposed_by text` | Threaded from `GrantAuditEvent.proposedBy` |
| `confirmed_by` | `string \| null` | Yes | `confirmed_by text` | Threaded from `GrantAuditEvent.confirmedBy` |
| `payload` | `unknown` | No | `payload jsonb` | Plain JSON-serializable object; JCS is `appendAuditEvent`'s responsibility |
| `occurred_at` | `number` | No | `occurred_at bigint` | Epoch-ms; safe for TS `number` (≤ 2^53) |

Chain columns (`seq`, `prev_hash`, `row_hash`, `vocab_version`) are **absent** from `AuditEventInput` — they are computed and inserted by `appendAuditEvent` (T-0016 §4.3 contract).

### 3.2 `AssignmentAuditEvent` (defined by T-0031, consumed by T-0030)

Exported from `src/core/audit-grant-encoder.ts`. Shape for assignment-level audit events:

| Field | TS type | Nullable | Notes |
|---|---|---|---|
| `kind` | `"assignment.create" \| "assignment.revoke"` | No | |
| `actor` | `string` | No | Who performed the assignment write |
| `employeeId` | `string` | No | `→ subject` in `AuditEventInput` |
| `roleId` | `string` | No | `→ payload.roleId` |
| `orgScope` | `unknown` | No | `ScopeElement` (hierarchy: `"org"`); `→ scope` |
| `proposedBy` | `string` | Yes | `→ proposed_by` |
| `confirmedBy` | `string` | Yes | `→ confirmed_by` |

### 3.3 `GrantTrailRow` (defined by T-0031, returned by the query and HTTP layers)

Exported from `src/db/audit-grant-trail.ts`. Mirrors the `audit_event` columns the trail UI needs:

| Field | TS type | Notes |
|---|---|---|
| `seq` | `number` | Per-tenant dense monotonic seq (bigint → TS number) |
| `id` | `string` | Stable UUID row identity |
| `type` | `string` | One of the four grant-family event types |
| `actor` | `string` | |
| `subject` | `string \| null` | |
| `scope` | `unknown \| null` | Deserialized jsonb |
| `proposed_by` | `string \| null` | |
| `confirmed_by` | `string \| null` | |
| `payload` | `unknown` | Deserialized jsonb |
| `occurred_at` | `number` | Epoch-ms |

### 3.4 `QueryGrantTrailOpts` (filter params to `queryGrantTrail`)

| Field | TS type | Default | Notes |
|---|---|---|---|
| `roleId` | `string \| undefined` | — | `subject = roleId` (grant events) OR `payload->>'roleId' = roleId` (assignment events) |
| `actor` | `string \| undefined` | — | `actor = actor` |
| `subject` | `string \| undefined` | — | `subject = subject` |
| `limit` | `number` | 100 | Max 500 |
| `beforeSeq` | `number \| undefined` | — | `seq < beforeSeq` (cursor pagination) |

---

## 4. Contracts

### 4.1 Encoder module (`src/core/audit-grant-encoder.ts`)

```ts
// Exports (the T-0030 call-seam contract — frozen here):
export type AuditEventInput = { /* §3.1 */ };
export type AssignmentAuditEvent = { /* §3.2 */ };

// Pure encoder — grant events:
export function encodeGrantAuditEvent(
  e: GrantAuditEvent,
  nowMs: number,
  idOverride?: string,         // optional: pass a deterministic UUID for tests
): AuditEventInput;

// Pure encoder — assignment events:
export function encodeAssignmentAuditEvent(
  e: AssignmentAuditEvent,
  nowMs: number,
  idOverride?: string,
): AuditEventInput;
```

Field mapping invariants (both encoders):
- Chain columns (`seq`, `prev_hash`, `row_hash`, `vocab_version`) are **absent** from output.
- `via` is `null` by default; T-0030 MAY call with an additional `via` param if needed (encoder signature admits it as an optional 4th param or T-0030 can set it post-call on the returned object — coder's choice, as long as `null` is the default).
- `id`: if `idOverride` is provided, use it; otherwise `crypto.randomUUID()`.
- Both functions import `GrantAuditEvent`, `Scope` from `../core/grant-lattice.js` (or `.ts`). They add NO imports from `pg`, `http`, `https`, `net`, `fetch`, `child_process`.

### 4.2 DB query module (`src/db/audit-grant-trail.ts`)

```ts
export type GrantTrailRow = { /* §3.3 */ };
export type QueryGrantTrailOpts = { /* §3.4 */ };

// Query runs inside withTenant (sets choros.tenant_id GUC):
export async function queryGrantTrail(
  pool: pg.Pool,
  tenantId: string,
  opts: QueryGrantTrailOpts,
): Promise<{ rows: GrantTrailRow[]; hasMore: boolean }>;
```

SQL invariants:
- `WHERE type IN ('grant.create', 'grant.revoke', 'assignment.create', 'assignment.revoke')`
- `ORDER BY seq DESC` (newest first for the trail UI)
- `roleId` filter: `(subject = $roleId OR payload->>'roleId' = $roleId)` (covers both grant and assignment events for the same role)
- Pagination: `seq < $beforeSeq` when `beforeSeq` provided; `LIMIT $limit + 1` then strip last row to set `hasMore`.
- Always executed inside `withTenant(pool, tenantId, ...)` — the pattern from `src/db/org.ts`; sets GUC + search_path + BEGIN/COMMIT/ROLLBACK.
- Returns `{ rows: GrantTrailRow[], hasMore: boolean }` — `hasMore` is `true` iff the raw query returned `limit + 1` rows.
- When `DATABASE_URL` is not set: the caller (HTTP layer) catches the `getOrgPool()` throw and returns seed data — the DB module itself does not need a fallback.

### 4.3 HTTP route module (`src/http/grant-trail.ts`)

```ts
export function registerGrantTrailRoutes(router: Router, pool?: pg.Pool): void;
// Registers: GET /api/grant-trail
```

HTTP invariants:
- Parses `role_id`, `actor`, `subject`, `limit`, `before_seq` from `req.url` query string.
- Validates `limit`: must be integer 1..500; if absent → 100; if > 500 or non-integer → `throw new HttpError(400, "INVALID_PARAM", "limit must be an integer 1–500")`.
- Validates `before_seq`: if present must be a non-negative integer; non-integer → `throw new HttpError(400, "INVALID_PARAM", "before_seq must be an integer")`.
- When `DATABASE_URL` is not set (or pool is absent): returns HTTP 200 with static seed data (`TRAIL` from `ra-data.jsx` reformatted to `GrantTrailRow` shape), `hasMore: false`.
- Authentication: reads `X-Dev-User` header for `tenantId` resolution (same pattern as `src/http/org.ts`); day-1 dev auth — prod auth is T-0054.
- Response: `{ rows: GrantTrailRow[], hasMore: boolean }`, `Content-Type: application/json`.

### 4.4 Server registration (additive edit to `src/server.ts`)

One additive line in `buildRouter`:
```ts
import { registerGrantTrailRoutes } from "./http/grant-trail.js";
// ...inside buildRouter():
registerGrantTrailRoutes(router, pool); // pool optional — static fallback when absent
```

This follows the identical pattern of `registerRightsRoutes`, `registerAuditRoutes`, etc. — no other changes to `server.ts`.

### 4.5 T-0030 call-seam (frozen for T-0030's coder)

```ts
// In T-0030's grant write handler (pseudocode):
import { encodeGrantAuditEvent } from "../core/audit-grant-encoder.js";
const auditInput = encodeGrantAuditEvent(
  { kind: "grant.create", actor, subjectRoleId: body.role_id,
    capability: { resourceType: body.resource_type, operation: body.operation,
                  ...(body.resource_facet ? { resourceFacet: body.resource_facet } : {}) },
    scope: body.scope, proposedBy: body.proposed_by, confirmedBy: body.confirmed_by },
  Date.now(),
);
await appendAuditEvent(tx, auditInput);
```

T-0030's coder adds this import and two call-sites (grant write + grant revoke) plus two more for assignment create/revoke (`encodeAssignmentAuditEvent`). The encoder module path, export names, and type signatures are stable from this ADR forward.

### 4.6 UI wiring (`web/src/screens/rights/ra-grant-trail.jsx`)

Replace the static `TRAIL` data-source with a `useEffect` fetch:
```jsx
const [rows, setRows] = useState(TRAIL_SEED);  // TRAIL from ra-data.jsx as initial state
const [hasMore, setHasMore] = useState(false);
useEffect(() => {
  fetch('/api/grant-trail')
    .then(r => r.json())
    .then(data => { setRows(data.rows); setHasMore(data.hasMore); })
    .catch(() => { /* keep seed */ });
}, []);
```
Filter tabs remain client-side (type filter over the fetched batch). "Load more" triggers a second fetch with `?before_seq=<minSeq>` appending to `rows`. The `TRAIL` constant becomes the initial/fallback state (NF-8 preserved: if API is unavailable, UI shows seed data).

---

## 5. Migration seam

T-0031 ships **no DDL migrations**. All grant-trail data lives in `audit_event` (migration 006). `known_tenant_tables.txt` is unchanged.

If a seed migration is added (INSERT-only dev-silo sample rows for the grant trail), it must be:
- Numbered `031_` (T-0030 owns `030_`; T-0031's seed is `031_grant_trail_seed.sql`).
- `INSERT INTO choros.audit_event … ON CONFLICT (tenant_id, seq) DO NOTHING` (idempotent).
- No `CREATE TABLE`, no DDL, no changes to `known_tenant_tables.txt`.

Day-1: no seed migration is required (static fallback in the HTTP route covers dev-no-Postgres).

---

## 6. T-0030 parallel seam — proposed_by/confirmed_by and merge order

T-0030's migration 030 adds `proposed_by`/`confirmed_by` to the `grant` table. T-0031's encoder maps these values from the `GrantAuditEvent` object — supplied by T-0030's HTTP handler from its request body — into `AuditEventInput.proposed_by`/`confirmed_by`. The encoder never reads from the `grant` table, so it has **no dependency on migration 030**.

The `queryGrantTrail` function reads only `audit_event` columns (all present since migration 006); it does not JOIN the `grant` table. Therefore:
- T-0031 can be merged before or after T-0030 without correctness impact.
- If T-0030 merges first, grant rows in `audit_event` will have `proposed_by`/`confirmed_by` populated (when the T-0030 HTTP handler passes them); if T-0030 has not merged yet, those rows will have `NULL` for those fields — the trail still renders correctly (UI column renders empty).

**Decision: no order-of-merge constraint. Both tasks are independently safe to land.**

---

## 7. Fitness functions

| ID | Rule | CI check |
|---|---|---|
| FF-0031-01 | `src/core/audit-grant-encoder.ts` contains no `pg`, `fetch`, `http`, `https`, `net`, or `child_process` import | `ci/checks/grant-trail-encoder-isolation.sh` — static grep on the file (static-now) |
| FF-0031-02 | `src/core/grant-lattice.ts` is not edited by T-0031 — no new exports, no mutations | `ci/checks/grant-trail-encoder-isolation.sh` Check-2: `git diff --quiet HEAD -- src/core/grant-lattice.ts` (static-now) |
| FF-0031-03 | `src/core/audit-grant-encoder.ts` imports `GrantAuditEvent` and `Scope` from `grant-lattice.ts` (not redefined) | `ci/checks/grant-trail-encoder-isolation.sh` Check-3: grep for `import.*GrantAuditEvent.*grant-lattice` (static-now) |
| FF-0031-04 | Unit tests for the encoder demonstrate the T-0030 seam: at least one test shows `const input = encodeGrantAuditEvent(event, nowMs)` followed by a mocked `appendAuditEvent(tx, input)` call | `ci/checks/grant-trail-encoder-isolation.sh` Check-4: grep in encoder test file for `appendAuditEvent` (static-now) |
| FF-0031-05 | `known_tenant_tables.txt` is unchanged by T-0031 — no new line added | `ci/checks/grant-trail-no-new-table.sh` Check-1: `git diff --quiet HEAD -- ci/checks/known_tenant_tables.txt` (static-now) |
| FF-0031-06 | No migration ≥ 031 shipped by T-0031 contains `CREATE TABLE` | `ci/checks/grant-trail-no-new-table.sh` Check-2: grep `CREATE TABLE` in any `03[1-9]_*.sql` or `0[4-9][0-9]_*.sql` added by T-0031 (static-now) |
| FF-0031-07 | Any seed migration ≥ 031 shipped by T-0031 contains `ON CONFLICT … DO NOTHING` (idempotent) | `ci/checks/grant-trail-no-new-table.sh` Check-3: for each new seed SQL, assert `ON CONFLICT` present (static-now) |
| FF-0031-08 | `GET /api/grant-trail?limit=600` returns 400 `INVALID_PARAM` | `src/__tests__/grant-trail.e2e.test.ts` AC-16 (static-now, in-memory store) |
| FF-0031-09 | `GET /api/grant-trail?before_seq=abc` returns 400 `INVALID_PARAM` | `src/__tests__/grant-trail.e2e.test.ts` AC-17 (static-now) |
| FF-0031-10 | `queryGrantTrail` returns only rows with `type IN (grant.create, grant.revoke, assignment.create, assignment.revoke)`; a row with `type='approve'` is NOT returned | `src/__tests__/grant-trail.db.test.ts` AC-20 (live-T-0053, skipped when `DATABASE_URL` absent) |

---

## 8. Traceability

| AC | Covered by |
|---|---|
| AC-01 | Encoder §4.1 — field mapping; unit test in `audit-grant-encoder.test.ts` |
| AC-02 | Encoder §4.1 `proposed_by`/`confirmed_by` passthrough; unit test |
| AC-03 | Encoder §4.1 `type ← e.kind`; unit test |
| AC-04 | Encoder §4.1 `payload` conditional `resourceFacet`; unit test |
| AC-05 | `encodeAssignmentAuditEvent` §4.1 / §3.2 mapping; unit test |
| AC-06 | `encodeAssignmentAuditEvent` `type ← e.kind`; unit test |
| AC-07 | `AuditEventInput` §3.1 — chain columns absent from type; unit test asserts no `seq`/`prev_hash`/`row_hash`/`vocab_version` keys |
| AC-08 | `idOverride` parameter in encoder signature §4.1; unit test with fixed id |
| AC-09 | FF-0031-01 (static lint on encoder imports) |
| AC-10 | FF-0031-02 (grant-lattice.ts unchanged) + FF-0031-03 (import source) |
| AC-11 | FF-0031-04 (seam test with mocked appendAuditEvent) |
| AC-12 | HTTP route §4.3; e2e test AC-12 |
| AC-13 | `queryGrantTrail` `roleId` filter §4.2; e2e test AC-13 |
| AC-14 | `queryGrantTrail` `actor` filter §4.2; e2e test AC-14 |
| AC-15 | `queryGrantTrail` `limit` + `hasMore` §4.2; e2e test AC-15 |
| AC-16 | FF-0031-08 (400 validation) |
| AC-17 | FF-0031-09 (400 validation) |
| AC-18 | Static fallback §4.3; e2e test without DATABASE_URL |
| AC-19 | RLS via `withTenant` §4.2; existing `cross_tenant.test.ts` covers `audit_event` (no new table = no new entry needed) |
| AC-20 | FF-0031-10 (`type IN` filter) |
| AC-21 | UI wiring §4.6; manual smoke test |
| AC-22 | FF-0031-05 + FF-0031-06 |
| AC-23 | FF-0031-07 |

---

## 9. Runtime target

Identical to existing Choros HTTP server: Node.js process on the founder's home server (`/srv/choros` docker-compose, Tailscale). No new external resource. The encoder module is pure; the DB query runs against the existing Postgres instance (T-0053). No GT-4 request needed.
