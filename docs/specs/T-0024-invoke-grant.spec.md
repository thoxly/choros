# Spec · T-0024 — Invoke-Grant: scoped to agent_role + org_scope; request vs command split

**Title:** E5.4 · Invoke-grant scoped to `agent_role + org_scope`; `request` (propose-task) vs `command` (execute) split — day-1 grant + schema
**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task type:** standard_code · product: choros

**Authoritative sources (do NOT re-open):**
- `playbooks/rbac-backlog.md#E5.4` (GT-1, founder-signed 2026-06-08)
- `playbooks/rbac-backlog.md#E5.1` — agent_card schema (T-0020, DONE)
- `playbooks/rbac-backlog.md#E5.2` — agent provisioning (T-0042, in-flight)
- `CONCEPT.md` §3 (agent = employee) + §8 (A2A standard)

**Foundation used (do NOT contradict):**
- `src/core/grant-lattice.ts` (T-0018) — `Operation` type already contains `"invoke"`; `ResourceType` allows `mgmt_object:${string}`; `GrantAuditEvent` is the canonical audit shape.
- `migrations/008_grant.sql` — `choros."grant"` table schema (operation TEXT, resource_type TEXT, scope JSONB).
- `migrations/030_grant_proposed_confirmed.sql` — `proposed_by` / `confirmed_by` columns on `choros."grant"` already exist.
- `migrations/032_agent_card.sql` (T-0020) — `agent_card(tenant_id, employee_id)` exists; T-0020 spec confirms T-0024 reads `employee.id` + `agent_card.employee_id`.
- `src/core/grant-resolver.ts` (T-0021) — `resolveFor` already handles `op="invoke"`; `InvokeContext` is the additive 5th param for effect-grant checking.
- `src/core/audit-grant-encoder.ts` (T-0031) — `AuditEventInput` / `encodeGrantAuditEvent` are the canonical audit seam.
- Migration numbers 041/042 occupied by sisters (T-0041, T-0042). **T-0024 is allocated migration slot 043**.

**Sister-task boundaries (HARD):**
- **T-0060 (E1.4)** — owns worker-API authentication. T-0024 does NOT add auth middleware.
- **T-0042 (E5.2)** — owns agent hiring / Keycloak service-account provisioning. T-0024 reads agent identity from the already-provisioned `agent_card`; does NOT modify provisioning.
- **E5.8 (Stage-2)** — A2A call-graph depth/fan-out breakers. Out of scope; not implemented here.

---

## 1. Summary

Add an **invoke-grant** as a first-class grant capability: a caller (human or agent) holding an invoke-grant for a target agent may **request** (creates a proposed task, human-gated) or **command** (executes immediately) that agent. Grant storage reuses the existing `choros."grant"` table with `operation = 'invoke'` and a new `resource_type = 'agent'` scoped to `(agent_role, org_scope)`. Both paths are audited via the canonical T-0031 audit seam. Runtime minimum for `command`: grant-check + audit; actual agent execution dispatch is out of scope for day-1.

---

## 2. Functional requirements

**FR-1 — Invoke-grant is an explicit capability.**
An invoke-grant is a row in `choros."grant"` with `operation = 'invoke'` and `resource_type = 'agent'`. A caller without such a row for the target agent is denied. No implicit or role-only path exists; the grant must be explicit.

**FR-2 — Scope = agent_role × org_scope.**
An invoke-grant's `scope` is a lattice `ScopeElement` over the **org** hierarchy (the same `kind: "node", hierarchy: "org"` shape used elsewhere), expressing which org subtree the invocation right covers. The target is identified by `resource_facet.agent_role_id` (the role id of the target agent employee) plus the grant's org-scope node. The invoker must hold a grant whose org-scope contains the invoker's own org position AND whose `resource_facet.agent_role_id` matches the target agent's assigned role.

**FR-3 — `request` mode: creates a proposed task.**
A `POST /api/invoke/request` call (body: `target_agent_id`, `goal`, `context?) checks the invoke-grant, then inserts a row into a new `invoke_proposal` table with `status = 'proposed'` and audits the act. The proposal is NOT automatically executed; a human gate is required to promote it to execution (out of scope for day-1 beyond the `proposed` row insert).

**FR-4 — `command` mode: executes with grant check + audit.**
A `POST /api/invoke/command` call checks the invoke-grant, writes an audit event of type `"invoke.command"`, and returns `202 Accepted` with `{ invocation_id }`. Day-1 runtime-minimum: the grant check and the audit record are durable. Actual dispatch to the agent runtime is a no-op stub on day-1 (Stage-2 connects the real dispatch path).

**FR-5 — Both paths emit audit events.**
`request` emits `"invoke.request"` audit event; `command` emits `"invoke.command"` audit event. Both use the canonical `AuditEventInput` / `appendAuditEvent` seam (T-0031). The `actor` field is the calling subject's employee id; `subject` is the target agent employee id; `payload` carries `{ mode, target_agent_id, agent_role_id, org_scope, goal }`.

**FR-6 — Invoke-grant can be granted and revoked via the existing grants API.**
`POST /api/grants` with `operation: "invoke"` and `resource_type: "agent"` creates an invoke-grant. `POST /api/grants/:id/revoke` revokes it. Both operations pass through `validateAdminDelegation` (T-0029) and emit `grant.create` / `grant.revoke` audit events via the existing `writeGrantAuditEvent` seam — no new admin delegation logic.

**FR-7 — Invoke-grant is delegable under the standard narrowing gate.**
`delegable: true` is the default. Sub-delegation is governed by `validateNarrowing` (T-0018) — scope can only narrow, never widen. A `delegable: false` grant is non-transferable.

**FR-8 — Target must be a provisioned agent.**
Before inserting an `invoke_proposal` or recording `invoke.command`, the API checks that `target_agent_id` resolves to a row in `agent_card` (i.e., an `employee` with `kind = 'agent'`). Attempting to invoke a non-agent employee is rejected with `400 VALIDATION`.

**FR-9 — `invoke_proposal` schema (new table, migration 043).**
The new table `choros.invoke_proposal` carries:
```
tenant_id      uuid NOT NULL
id             uuid NOT NULL (PK with tenant_id)
caller_id      uuid NOT NULL  -- invoking employee id
target_id      uuid NOT NULL  -- target agent employee id
goal           text NOT NULL
context        jsonb NULL
status         text NOT NULL CHECK (status IN ('proposed', 'cancelled'))
created_at     bigint NOT NULL
PRIMARY KEY (tenant_id, id)
```
Table obeys all T-0013 tenant-isolation invariants: RLS enabled+forced, tenant-isolation policy on `choros.tenant_id` GUC, `choros_app` DML grant, registered in `ci/checks/known_tenant_tables.txt`.

---

## 3. Non-functional requirements

**NF-1 — Additive only.**
No column or table owned by T-0018/T-0020/T-0021/T-0030 is modified. Changes to `grant-lattice.ts`, `grant-resolver.ts`, `grants.ts` are additive only (new routes, not edited logic). Sister tasks (T-0060, T-0042) do not need re-merge.

**NF-2 — Pure grant-check core is unchanged.**
`resolveFor` in `grant-resolver.ts` already handles `op = "invoke"`. T-0024 does NOT add a second grant-check path. The HTTP handlers call `resolveFor(.., "invoke")` using the existing PDP.

**NF-3 — Audit via canonical seam only.**
All audit writes go through `appendAuditEvent` (T-0016/T-0031 chain). No local/partial audit writers. The invoke audit events use the same `AuditEventInput` shape and preimage rule as grant and lifecycle events.

**NF-4 — Fail-closed on missing invoke-grant.**
If the invoker has no covering invoke-grant for the target agent (grant absent, expired, or scope mismatch), the response is `403 FORBIDDEN`, no `invoke_proposal` row is inserted, and no audit event for the attempt is written beyond a 403 response. (The audit of the denial is an optional future enhancement, not a day-1 requirement.)

**NF-5 — Tenant isolation.**
Every read and write is inside a `withTenantTx` block with the `choros.tenant_id` GUC set. Cross-tenant checks go through the same T-0021 tenant-gate that exists in `resolveFor`.

**NF-6 — No auth middleware.**
T-0024 reads the caller identity from the `X-Dev-User` header (same dev convention as other routes). Production auth is T-0060's scope.

---

## 4. Out of scope

- **A2A call-graph breakers** (E5.8, Stage-2) — depth/fan-out DAG protection.
- **Actual agent dispatch** — day-1 `command` is a stub (grant-check + audit + 202). Real dispatch to the agent runtime is Stage-2.
- **`request` proposal promotion** — the human gate that promotes `proposed → executing` is a future task.
- **`invoke_proposal` cancellation flow** — `status = 'cancelled'` column is present in schema but no cancel endpoint is day-1.
- **Keycloak service-account invocation** — how the agent runtime authenticates is T-0042/T-0060's domain.
- **Agent provisioning (hire/fire)** — T-0042.
- **BYO-LLM secret-handle resolution** — T-0025.
- **`autonomy_threshold` / confidence-based routing** — E5.6/E5.7, Stage-2.

---

## 5. Constraints for DESIGN

- **Migration slot 043** is reserved for this task. Migrations 041 and 042 are occupied by sisters.
- All changes to shared files (`grant-lattice.ts`, `grants.ts`, `router.ts`) must be **additive** (new exports or new route registrations only). No refactoring of existing logic; sisters are merging in parallel.
- The `invoke_proposal` table must be registered in `ci/checks/known_tenant_tables.txt`.
- `resource_type = 'agent'` is a new string constant; it does NOT require a change to the `ResourceType` union in `grant-lattice.ts` (the union already admits `mgmt_object:${string}` and plain `"effect_resource"`; `"agent"` is a valid plain string in the `operation` + `resource_type` TEXT columns of the DB; the TS type can accept it via the existing `ResourceType` widening pattern used by other task's new types, or as `mgmt_object:agent`). **Decision on `resource_type` constant spelling is DESIGN's call** — this spec only requires uniqueness and consistency.
- The org-hierarchy scope check in `resolveFor` uses the injected `AncestryOracle`. Day-1 uses the seed oracle from `grants.ts`; the Postgres DAO is T-0053's territory.

---

## 6. Acceptance criteria

**AC-1** — `POST /api/invoke/request` with a valid invoke-grant returns `201 Created` and a row exists in `invoke_proposal` with `status = 'proposed'` and the correct `caller_id`, `target_id`, `goal`.
*(verifiable as: test)*

**AC-2** — `POST /api/invoke/request` where the caller has no covering invoke-grant (grant absent or scope mismatch) returns `403 FORBIDDEN` and no row is inserted in `invoke_proposal`.
*(verifiable as: test)*

**AC-3** — `POST /api/invoke/command` with a valid invoke-grant returns `202 Accepted` with a JSON body containing `invocation_id` (a UUID).
*(verifiable as: test)*

**AC-4** — `POST /api/invoke/command` where the caller has no covering invoke-grant returns `403 FORBIDDEN`.
*(verifiable as: test)*

**AC-5** — After a successful `POST /api/invoke/request`, exactly one audit event of type `"invoke.request"` appears in `audit_event` with `actor = caller_id`, `subject = target_agent_id`, and `payload.mode = "request"`.
*(verifiable as: test)*

**AC-6** — After a successful `POST /api/invoke/command`, exactly one audit event of type `"invoke.command"` appears in `audit_event` with `actor = caller_id`, `subject = target_agent_id`, and `payload.mode = "command"`.
*(verifiable as: test)*

**AC-7** — Attempting to invoke a `target_agent_id` that is NOT a row in `agent_card` (or is a `kind = 'human'` employee) returns `400 VALIDATION` regardless of grant presence.
*(verifiable as: test)*

**AC-8** — An invoke-grant created via `POST /api/grants` with `operation: "invoke"` and `resource_type: "agent"` is stored in `choros."grant"` and a `grant.create` audit event is emitted.
*(verifiable as: test)*

**AC-9** — An invoke-grant revoked via `POST /api/grants/:id/revoke` results in `POST /api/invoke/request` returning `403 FORBIDDEN` (grant no longer covers the caller).
*(verifiable as: test)*

**AC-10** — `invoke_proposal` has RLS enabled + forced; a query run with a different `choros.tenant_id` GUC returns no rows from another tenant's proposals.
*(verifiable as: test)*

**AC-11** — A delegated invoke-grant (sub-grant with narrower org_scope) is valid for `POST /api/invoke/command` only within its narrower scope; a target outside the sub-grant's scope returns `403`.
*(verifiable as: test)*

**AC-12** — `invoke_proposal` is listed in `ci/checks/known_tenant_tables.txt`; the existing frozen-file fitness check passes (no CI red).
*(verifiable as: fitness)*

**AC-13** — `grant-lattice.ts` fitness test count does not decrease (additive-only check): the 122 fitness tests from T-0018 still all pass after T-0024 lands.
*(verifiable as: fitness)*

**AC-14** — No change to `resolveFor`'s existing API surface: the function signature (parameters, return types) is unchanged; a caller omitting the new optional invoke-grant context compiles without error.
*(verifiable as: fitness)*
