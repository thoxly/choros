# ADR · T-0024 — Invoke-Grant: scoped to `agent_role + org_scope`; `request` vs `command` split

**Task:** T-0024 · E5.4 · standard_code · product: choros
**Phase:** DESIGN
**Status:** ready
**Date:** 2026-06-11
**Spec:** `docs/specs/T-0024-invoke-grant.spec.md` (status=ready, 14 AC)
**Migration slot:** 043 (041=T-0060, 042=T-0042 — HARD seam)

---

## 1. Decision (one paragraph)

Model the **invoke-grant** as an ordinary row in the existing `choros."grant"` table
(`operation = 'invoke'`, `resource_type = 'agent'`, lattice `scope` over the **org**
hierarchy, target role carried in `resource_facet.agent_role_id`) — **no new grant
subsystem, no new authority store**. Two HTTP routes — `POST /api/invoke/request`
(propose) and `POST /api/invoke/command` (execute-stub) — read the caller from
`X-Dev-User`, resolve the target agent's assigned role from `agent_card` + the
target's `role_assignment`, and call the **existing** PDP `resolveFor(.., "invoke")`
(T-0021) with its signature **unchanged**. `request` durably inserts a row into a new
tenant-isolated table `choros.invoke_proposal` (migration 043, `status='proposed'`)
and emits an `"invoke.request"` audit event; `command` emits `"invoke.command"` and
returns `202 { invocation_id }` with dispatch left as a day-1 no-op stub. Both audit
writes go through the **single canonical seam** `appendAuditEvent` (T-0031/T-0068) via
a new `encodeInvokeAuditEvent` pure encoder mirroring `encodeGrantAuditEvent`. All
file changes to shared modules are **strictly additive** (new routes, new encoder
export, new table) — no edit to existing logic of `grant-lattice.ts`,
`grant-resolver.ts`, `grants.ts`, or `router.ts`.

---

## 2. Context & constraints

- The authority core is **closed**: `Operation` already contains `"invoke"`
  (`grant-lattice.ts:25-32`); `resolveFor` already takes `op: Operation` and handles
  `op === "invoke"` (the T-0034 effect-grant branch). T-0024 introduces **no second
  decision path** (NF-2).
- `ResourceType` is `"application" | "registry" | "record" | mgmt_object:${string} |
  "effect_resource"`. The DB column is plain `TEXT`. The spec (§5) leaves the
  spelling of the invoke target's `resource_type` to DESIGN. **Decision:** use the
  literal string `"agent"` in the DB and treat it as a value that widens the TS
  `ResourceType` only at the call boundary (cast, as `grants.ts` already does:
  `resourceType as Grant["resourceType"]`). We do **NOT** edit the `ResourceType`
  union in `grant-lattice.ts` (frozen-file / additive-only seam, NF-1, AC-13). See
  §4.1 + Alt-A.
- Three sister tasks merge in parallel. `grant-lattice.ts` + `router.ts` are
  touch-additive-only; `grants.ts` gets new routes but no edits to T-0030/T-0044
  logic; provisioning/auth zones (T-0042/T-0060) are untouched.
- `schema.test.ts` runs strict anti-decorative mode: **every** `choros` base table on
  disk MUST be listed in `ci/checks/known_tenant_tables.txt` or CI reds. Therefore
  `invoke_proposal` MUST be added to that file (AC-12). See §7 for the interaction
  with the sister `grant-trail-no-new-table.sh` freeze check.

---

## 3. Object model

### 3.1 New table `choros.invoke_proposal` (migration 043)

| column       | type    | notes                                                        |
|--------------|---------|--------------------------------------------------------------|
| `tenant_id`  | uuid    | NOT NULL; leading PK column (T-0013 lead-tenant invariant)   |
| `id`         | uuid    | NOT NULL                                                     |
| `caller_id`  | uuid    | NOT NULL — invoking employee id (the `X-Dev-User` subject)   |
| `target_id`  | uuid    | NOT NULL — target agent employee id                          |
| `goal`       | text    | NOT NULL                                                     |
| `context`    | jsonb   | NULL — optional structured invocation context               |
| `status`     | text    | NOT NULL `CHECK (status IN ('proposed','cancelled'))`        |
| `created_at` | bigint  | NOT NULL — epoch-ms                                          |
|              |         | `PRIMARY KEY (tenant_id, id)`                                |

Tenant-isolation contract (identical to `022_effect_resource.sql` / `032_agent_card.sql`):
`ENABLE` + `FORCE` ROW LEVEL SECURITY; policy
`USING/WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid)`;
`GRANT SELECT, INSERT, UPDATE, DELETE ... TO choros_app`; registered in
`known_tenant_tables.txt`. **No cross-table FK** is declared (T-0017 FK-lesson:
`caller_id`/`target_id` are logical employee references validated in the application
layer, mirroring `effect_resource`'s self-contained PK discipline). No seed rows →
the migration carries **no** `INSERT` (so the idempotency-seed-check is vacuous).

### 3.2 Invoke-grant row (existing `choros."grant"` table — NO schema change)

A logical shape, not a new table:

| field            | value                                                                  |
|------------------|------------------------------------------------------------------------|
| `operation`      | `'invoke'`                                                             |
| `resource_type`  | `'agent'`                                                              |
| `scope`          | lattice `ScopeElement` `{kind:"node", hierarchy:"org", nodeId, nodeLevel}` (or `set`/`tags`) — the org subtree the invoke right covers |
| `resource_facet` | `{ "agent_role_id": "<uuid>" }` — the target agent's assigned role id  |
| `delegable`      | `true` by default (FR-7); sub-delegation gated by `validateNarrowing`   |

### 3.3 `InvokeAuditEvent` (new pure encoder type — `audit-grant-encoder.ts`, additive export)

```
type InvokeAuditEvent = {
  kind: "invoke.request" | "invoke.command";
  actor: string;        // caller employee id
  targetAgentId: string; // subject = target agent employee id
  agentRoleId: string;
  orgScope: unknown;     // the grant's matched org ScopeElement
  goal: string;
}
```

Encoded by `encodeInvokeAuditEvent(e, nowMs, idOverride?) -> AuditEventInput` with
`type=e.kind`, `actor=e.actor`, `subject=e.targetAgentId`, `scope=e.orgScope`,
`payload={ mode, target_agent_id, agent_role_id, org_scope, goal }`
(`mode` = `"request"` for `invoke.request`, `"command"` for `invoke.command` — AC-5/AC-6).

---

## 4. Mechanism / contracts

### 4.1 `resource_type = "agent"` constant (rejected: editing the union)

The invoke target type is the literal `"agent"`, stored in the `TEXT` column and
applied to the TS `Grant` via the existing widening cast at the HTTP boundary
(`grants.ts:531` already does `resourceType as Grant["resourceType"]`). The
`ResourceType` union in `grant-lattice.ts` is **not** edited — that file is a frozen
seam and any edit would (a) break the additive-only contract with sisters and (b) risk
the 122-test count regression (AC-13). The grant-side matching in `resolveFor` keys on
`g.operation !== op` only; it does **not** filter on `resource_type` for the invoke
path, so `"agent"` flows through transparently.

### 4.2 Target-role resolution (the invoke-specific scope binding)

`resolveFor` matches a grant when `isNarrowerOrEqual(handleScope, g.scope, ancestry)`.
For invoke, the handle scope is the **target agent's org position** and the grant's
`resource_facet.agent_role_id` must equal the **target agent's assigned role**. Because
`resolveFor`'s signature is frozen (AC-14) and its handle is an `ObjectHandle` keyed on
the three resource kinds (application/registry/record — not agents), the HTTP handler
performs the invoke-specific binding **in `src/http/invoke.ts`**, NOT inside the PDP:

1. Load the target's `agent_card` row (FR-8) → 400 VALIDATION if absent / not an agent.
2. Load the target's **active** `role_assignment` → `(target_role_id, target_org_scope)`.
3. Load the caller's grants (the same DAO `loadRoleEffectiveGrants` shape used by
   `grants.ts`, scoped via the caller's role assignments — day-1 read inside
   `withTenantTx`; the live RLS DAO is T-0053).
4. A grant **covers** the call iff: `operation==='invoke'` ∧ `isEffective(g, now)` ∧
   `resource_facet.agent_role_id === target_role_id` ∧
   `isNarrowerOrEqual(target_org_scope, g.scope, SEED_ORACLE)`.
5. No covering grant → `403 FORBIDDEN`, no `invoke_proposal` row, no audit (NF-4).

This uses the **same** lattice primitives (`isNarrowerOrEqual`, `isEffective`) and the
**same** `SEED_ORACLE` already exported-by-pattern in `grants.ts` — it owns **no new
lattice math** (architect rule 2 / no-second-subsystem). The covering predicate is a
thin composition over T-0018 exports, kept in one helper `coversInvoke(grant, target,
now, oracle)` so the rule is testable in isolation.

> **Design note (PDP boundary):** the spec's NF-2 says "the HTTP handlers call
> `resolveFor(.., 'invoke')`". `resolveFor` is built around `ObjectHandle`
> (application/registry/record), which has **no agent kind** and whose signature is
> frozen (AC-14, object-handle.ts is frozen). Adding an agent handle-kind would break
> the frozen seam. We therefore satisfy NF-2's intent — "no second grant-check path,
> reuse the T-0018 lattice algebra" — by composing the **same exported primitives**
> (`isNarrowerOrEqual`/`isEffective`) the PDP itself uses, rather than threading a
> synthetic record handle through `resolveFor`. This is a **bounded interpretation**
> of NF-2, flagged in the contract under `open_forks` for orchestrator/coder
> confirmation: either (a) compose-the-primitives (this ADR's choice — zero frozen-seam
> edits) or (b) extend `ObjectHandle` with an `agent` kind in a future task and route
> through `resolveFor` then. Option (a) is correct day-1; (b) is a larger refactor that
> the frozen-seam contract forbids now.

### 4.3 HTTP routes (new file `src/http/invoke.ts`; wired in `server.ts` additively)

```
POST /api/invoke/request
  body: { target_agent_id: uuid, goal: string, context?: object }
  → 400 VALIDATION   if target_agent_id not an agent_card row / kind!='agent' / bad body
  → 403 FORBIDDEN    if no covering invoke-grant (fail-closed, no row, no audit)
  → 201 Created      { id }   + invoke_proposal row(status='proposed') + "invoke.request" audit
  (proposal-row INSERT and audit append in ONE withTenantTx — atomic, mirrors grants.ts)

POST /api/invoke/command
  body: { target_agent_id: uuid, goal: string, context?: object }
  → 400 / 403 as above
  → 202 Accepted     { invocation_id: uuid }   + "invoke.command" audit
  (audit append in withTenantTx; dispatch = no-op stub, invocation_id = randomUUID())
```

Caller identity via `extractActor`-style read of `X-Dev-User` (NF-6; same convention as
`grants.ts`). Route registration mirrors `registerGrantsRoutes(router, pool)` and is
added to `server.ts` under the existing `if (grantsPool)` block (DB-required routes) —
**additive**, no edit to existing registrations.

### 4.4 Audit seam (canonical only — NF-3)

A new `writeInvokeAuditEvent(client, tenantId, evt, nowMs)` helper in `invoke.ts`
encodes via `encodeInvokeAuditEvent` (additive export in `audit-grant-encoder.ts`) and
appends through `appendAuditEventInput` → `makePgAuditWriter().appendAuditEvent`, the
identical single sink `grants.ts` uses. No local/partial audit writer (the T-0031 lesson:
one preimage rule for the whole chain). `via=null`; `proposed_by=null`,
`confirmed_by=null` (invoke is not a dual-control grant change).

### 4.5 Grant create/revoke (FR-6 — no new code)

Invoke-grants are created/revoked through the **existing** `POST /api/grants` /
`POST /api/grants/:id/revoke` with `operation:"invoke"`, `resource_type:"agent"`,
`resource_facet:{agent_role_id}`. These already pass `validateAdminDelegation` and emit
`grant.create`/`grant.revoke` via `writeGrantAuditEvent`. **T-0024 adds zero grant-API
code** — AC-8/AC-9 are satisfied by the existing handlers accepting the new string
values (DB columns are TEXT; the scope is a valid lattice node).

---

## 5. Fitness functions (architecture as CI code)

| id     | rule (the boundary it freezes)                                                                                   | ci_check (executable) |
|--------|-----------------------------------------------------------------------------------------------------------------|-----------------------|
| FF-IG-1 | `invoke_proposal` is a tenant table: present in `known_tenant_tables.txt` AND migration 043 has ENABLE+FORCE RLS + isolation policy + choros_app grant. | New `ci/checks/invoke-grant-isolation.sh`: assert `grep -qx 'invoke_proposal' ci/checks/known_tenant_tables.txt`; assert `migrations/043_invoke_proposal.sql` contains `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `current_setting('choros.tenant_id'`, and `TO choros_app`. Wired into `npm run fitness`. Also covered live by `ci/checks/db/schema.test.ts` FF-RLS. |
| FF-IG-2 | Migration number discipline: T-0024 owns ONLY slot 043; no edit to 041/042. | In `invoke-grant-isolation.sh`: assert `migrations/043_invoke_proposal.sql` exists and is the ONLY new `0[45][0-9]_*` migration added by this branch (`git diff --name-only` vs merge-base ∩ `migrations/`); fail if any 041/042 file is modified. |
| FF-IG-3 | `resolveFor` signature is unchanged (AC-14, additive-only). | `invoke-grant-isolation.sh`: `git diff` of `src/core/grant-resolver.ts` must not change the `export async function resolveFor(` parameter list; assert the exact signature line is byte-unchanged vs merge-base (or absent from the diff). |
| FF-IG-4 | `grant-lattice.ts` is byte-unmodified (AC-13: 122 fitness tests preserved; no union edit). | `invoke-grant-isolation.sh`: `git -C . diff --quiet <merge-base> -- src/core/grant-lattice.ts` must pass. (Mirrors the frozen-file check in `grant-resolver-isolation.sh`.) The 122-test invariant is then preserved by construction. |
| FF-IG-5 | No second authority store: `src/http/invoke.ts` derives the decision from T-0018 grant rows only (no `*_acl`, `field_visibility`, `record_rights`, or a local permission table). | `invoke-grant-isolation.sh`: `grep -nE '(_acl|field_visibility|record_rights|invoke_acl)' src/http/invoke.ts` (excluding comments) must be empty. |
| FF-IG-6 | Audit goes through the canonical seam only: `invoke.ts` imports `appendAuditEvent`/`makePgAuditWriter` (via the grants audit helper or db/audit-writer) and contains NO direct `INSERT INTO ... audit_event` / `audit_head`. | `invoke-grant-isolation.sh`: assert `invoke.ts` has no `audit_event`/`audit_head` literal INSERT; assert it references `appendAuditEvent` (or `encodeInvokeAuditEvent` + the shared `writeInvokeAuditEvent` helper). |
| FF-IG-7 | Fail-closed on absent grant: the `403` branch in `invoke.ts` precedes (lexically and at runtime) any `INSERT INTO choros.invoke_proposal` and any audit append. | New unit/integration test `src/__tests__/invoke-grant.test.ts` (AC-2/AC-4) asserts a 403 path leaves `invoke_proposal` row-count and `audit_event` count unchanged; FF lint additionally asserts the grant-check helper `coversInvoke` is called before the INSERT statement in the handler. |
| FF-IG-8 | Tenant isolation of the new table is real, not decorative (AC-10): a query under a different `choros.tenant_id` GUC returns zero foreign-tenant proposals. | Covered by the live `ci/checks/db/schema.test.ts` (FF-RLS, runs under `npm run fitness:db`) which now sees `invoke_proposal` as a known table and asserts FORCE RLS; plus a cross-tenant probe in `invoke-grant.test.ts`. |

> The `npm run fitness` aggregate command (package.json) must be extended to append
> `&& bash ci/checks/invoke-grant-isolation.sh` (additive — coder's wiring step).

---

## 6. Traceability (AC → design site)

| AC    | covered by |
|-------|------------|
| AC-1  | §4.3 `POST /api/invoke/request` → 201 + `invoke_proposal(status='proposed')`; test `invoke-grant.test.ts::request-happy` |
| AC-2  | §4.2 step 5 fail-closed 403, no row; FF-IG-7; test `request-no-grant` |
| AC-3  | §4.3 `POST /api/invoke/command` → 202 `{invocation_id}`; test `command-happy` |
| AC-4  | §4.2 step 5 403; test `command-no-grant` |
| AC-5  | §4.4 `encodeInvokeAuditEvent` `type='invoke.request'`, actor/subject/payload.mode; test `request-audit` |
| AC-6  | §4.4 `type='invoke.command'`, payload.mode='command'; test `command-audit` |
| AC-7  | §4.3 step 1 `agent_card` lookup → 400 VALIDATION for non-agent / human; test `target-not-agent` |
| AC-8  | §4.5 existing `POST /api/grants` accepts `operation:'invoke'`,`resource_type:'agent'`; test `grant-create-invoke` |
| AC-9  | §4.5 existing revoke sets `valid_until`; §4.2 step 4 `isEffective` then excludes it → 403; test `revoke-then-request-403` |
| AC-10 | §3.1 FORCE RLS + policy; FF-IG-8; live `schema.test.ts` + cross-tenant probe |
| AC-11 | §4.2 step 4 `isNarrowerOrEqual(target_org_scope, g.scope)` → sub-delegated narrower grant covers only its subtree; test `sub-delegated-scope` |
| AC-12 | §3.1 + FF-IG-1 `known_tenant_tables.txt` row + frozen-file check green post-merge |
| AC-13 | §4.1 + FF-IG-4 `grant-lattice.ts` byte-unmodified ⇒ 122 tests preserved |
| AC-14 | §4.2 design-note + FF-IG-3 `resolveFor` signature byte-unchanged |

---

## 7. Known seam tension (surfaced, not hidden)

Adding `invoke_proposal` to `ci/checks/known_tenant_tables.txt` is **required** by
`schema.test.ts` strict mode (AC-12) but **violates** `grant-trail-no-new-table.sh`
Check-1, which freezes that file relative to the dev merge-base. That check belongs to
**T-0031** and enforces *T-0031's own* "ship no DDL" obligation; it was never intended
to freeze the file for legitimately-new tenant tables in later tasks. Per the recorded
gotcha (`choros-ci-check-gotchas`: "sibling frozen-file FF-checks redden on in-flight
amendment branches by design; green post-merge to dev"), this RED is **expected
pre-merge** and resolves once `invoke_proposal` is part of dev's merge-base. The
architect's day-1 stance: **do not weaken `grant-trail-no-new-table.sh`** (that would
erode T-0031's guarantee); register the table as AC-12 requires, and let the sister
check go green at merge. This is logged under `open_forks` for the orchestrator: if the
freeze check must stay green on the T-0024 branch itself, the orchestrator may rebase
T-0024 onto a dev that already contains the row, or scope-limit Check-1 to T-0031's
migration window — a control-plane call, not an architecture one.

---

## 8. Runtime / deploy target

**Container** (the existing choros dev stack: single-Postgres substrate + the
node:http server). No new external resource: migration 043 runs through the existing
`migrations/run.mjs` lexicographic runner; the routes ride the existing server process.
No founder gate (GT-4) is triggered — no new server/DB host. Production auth for the new
routes is T-0060's scope (NF-6); day-1 uses `X-Dev-User`.

---

## 9. Out of scope (carried from spec §4 — design adds nothing here)

A2A call-graph breakers (E5.8); real agent dispatch (`command` stub only);
`proposed→executing` promotion; `invoke_proposal` cancel endpoint (column present, no
route); Keycloak service-account invocation (T-0042/T-0060); hire/fire (T-0042);
BYO-LLM secret resolution (T-0025); autonomy-threshold routing (E5.6/E5.7).
