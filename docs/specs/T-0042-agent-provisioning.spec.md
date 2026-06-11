# Spec · T-0042 — Agent Provisioning (E5.2)

**Epic/Story:** E5.2 — Agent provisioning: hiring = management grant `{mgmt_object:agent, create, scope}`;
Keycloak service account created on hire; rights layer sees only subject + role; structural least-privilege
(0 roles → 0 tools), not a default-deny config.

**Status:** `ready` (no blocking founder questions — GT-1 signed for E5; agent-as-employee, mgmt_object:agent
grant shape, Keycloak-as-identity, and structural least-privilege are all ratified).

**Phase:** SPEC. Machine-readable contract: `docs/specs/T-0042.spec.contract.json`
(schema: `schemas/spec.schema.json`).

**Migration seam:** migration file number reserved for this task = **042** (041 reserved by T-0041/E4.8,
043 reserved by T-0043/E5.3).

---

## 0. One-line summary

Ship the **agent hiring API**: requires a management grant `{mgmt_object:agent, create, scope}` to
provision a new `employee(kind='agent')` row + `agent_card` row + Keycloak service account; a freshly
hired agent with no role assignment has **zero tool access by construction** (structural, not config).
Identity (Keycloak `kc_client_id`) is decoupled from rights (role → grants).

---

## 1. Context: what already exists (do not rebuild)

T-0042 is deliberately thin — it composes finished pieces:

- **`employee` table + `agent_card` table (T-0020/E5.1, REAL, migration 032).** `employee(kind='agent')`
  rows already exist in the dev fixture; `agent_card(tenant_id, employee_id, kc_client_id, …)` is real.
  T-0042 ships the *creation path* for these rows, not the schema (which already exists).

- **`mgmt_object:agent` resource-type (T-0029/E3.3, REAL).** The genesis `tenant-owner` already holds
  delegable grants on `mgmt_object:agent, create, …`. T-0042 enforces that calling the hire endpoint
  requires a covering grant on `mgmt_object:agent` with operation `create` and an org-scope that admits
  the target position. The admin-narrowing checker (`scoped-admin.ts`) already exists.

- **`grant-lattice.ts` (T-0018, REAL).** `ResourceType` already includes `` `mgmt_object:${string}` ``.
  `validateNarrowing` is the subset gate. T-0042 does NOT modify this file.

- **`grant-resolver.ts` (T-0021, REAL).** The read-path PDP resolves grants at action-time.
  T-0042 does NOT modify this file.

- **`mcp-tool-registry.ts` (T-0043/E5.3, REAL).** `resolveAgentToolset` is already the query over
  grants: `toolset = f(grants)`. A new agent with no role assignment → no grants → no tools.
  T-0042 does NOT modify this file.

- **Keycloak compose + realm (T-0054/E0.4).** Service accounts (`service_accounts_enabled: true`) and
  the `agent-*` client pattern are already established. T-0042 creates a new Keycloak client for each
  newly hired agent via the Keycloak Admin REST API at hire-time.

- **Dev-auth layer.** The `x-dev-user` header stub and `CHOROS_AUTH_MODE` switch (T-0054) MUST remain
  intact and unchanged. T-0042's hire endpoint MUST work under `CHOROS_AUTH_MODE=dev` (authority check
  uses the mgmt-grant model, not JWT).

**Sister task boundaries (hard, do not cross):**
- **T-0060 (E1.4):** owns JWT validation middleware for worker-API endpoints. T-0042 does NOT touch
  JWT validation; it only calls the Keycloak Admin REST API to create a service account.
- **T-0024 (E5.4):** owns invoke-grants (who can CALL an agent) and request/command split. T-0042
  ends at hire; invocation is out of scope.

---

## 2. Functional requirements

### FR-1 — Hire requires a management grant

**Calling the hire endpoint requires** that the caller holds a confirmed, in-window grant with:
- `resource_type = 'mgmt_object:agent'`
- `operation = 'create'`
- `scope` (org hierarchy, `hierarchy:'org'`) that admits the target `position_id` of the new agent

This is enforced at the **write-path** before any row is inserted, using the existing
`validateAdminDelegation` / `scoped-admin.ts` checker. A caller without the management grant is
rejected before any side effect occurs. The rejection reason is a distinct typed value
(e.g. `no_mgmt_grant` or a `NarrowingResult` rejection reason).

### FR-2 — Hiring creates employee + agent_card rows (additive)

On a successful hire, the system creates:
1. An `employee` row: `tenant_id`, new `id` (UUID), `position_id`, `kind = 'agent'`, `slug`, timestamps.
2. An `agent_card` row: `tenant_id`, `employee_id` (FK → employee), `kc_client_id` (the client-id
   assigned by Keycloak — see FR-3), `llm_endpoint/llm_model/llm_secret_handle` = NULL (dormant),
   `autonomy_threshold` = NULL (dormant), `budget_policy_id/escalation_rule_id` = NULL (deferred).
3. The creation is **atomic** (both rows in one transaction or an equivalent all-or-nothing path).
4. If the Keycloak service account creation fails (FR-3), the DB rows are NOT committed (rollback).

### FR-3 — Keycloak service account created at hire-time

On a successful hire, the system calls the Keycloak Admin REST API to create a new confidential OIDC
client with:
- `clientId` = a deterministic slug derived from the agent's `slug` (e.g. `agent-<slug>`). The exact
  generation rule is autonomous (DESIGN), but MUST be unique per tenant realm and stored as
  `agent_card.kc_client_id`.
- `serviceAccountsEnabled: true`
- `grant_type: client_credentials`
- A Keycloak user attribute `actor_type = agent` on the service-account user.
- A dev client secret (committed for dev; production secret is founder-held per RL-1 / E0.7).

The `kc_client_id` returned by Keycloak is stored in `agent_card.kc_client_id` (which has a UNIQUE
constraint on `(tenant_id, kc_client_id)`). The system MUST NOT persist a `kc_client_id` that already
exists; duplicate detection returns a typed error (e.g. `client_id_conflict`).

**Out-of-scope for T-0060:** JWT validation of the agent's token is T-0060. T-0042 only creates the
service account; it does not validate tokens.

### FR-4 — Rights layer sees only subject + role (identity decoupled from rights)

The `agent_card.kc_client_id` is an identity artifact only. The rights layer (`grant-resolver.ts`,
`mcp-tool-registry.ts`) operates on `(tenant_id, subjectId = employee_id)` → role assignments → grants
→ toolset. The `kc_client_id` is NOT a parameter in any grant lookup. This is not configurable;
it is a structural invariant: identity (Keycloak) and authorization (role→grants) are separate layers.

No new column or FK from `grant`, `role`, `assignment`, or `mcp_tool` to `kc_client_id` or
`agent_card` is introduced by this task.

### FR-5 — Freshly hired agent has zero tool access by construction (structural)

A newly hired agent has:
- No `role_assignment` rows (hiring does not auto-assign any role).
- Therefore no grants reachable through `resolveAgentToolset` (T-0043: `grants = []` → no tool passes
  `isToolReachable`).
- Tool access = 0, NOT because there is a "default-deny config" applied to new agents, but because
  `toolset = query(grants)` and `grants = []` for a role-less agent.

The zero-access state MUST be demonstrable by calling `resolveAgentToolset` against the newly created
agent's `employee_id` and asserting the result is an empty array.

### FR-6 — Hire is audited

Every successful hire emits a `GrantAuditEvent`-analogous audit record (or the equivalent tenant audit
event type) capturing:
- `actor`: the caller's `employee_id` (the admin performing the hire).
- `subject`: the new agent's `employee_id`.
- `capability`: `{resourceType: 'mgmt_object:agent', operation: 'create'}`.
- `scope`: the org-scope admitted by the admin's covering grant.
- Timestamps.

This audit event MUST be written atomically with the DB rows (same transaction or equivalent). If the
audit write fails, the hire is rolled back.

### FR-7 — Hire endpoint is idempotent on client retry (optional NF)

A hire request bearing a client-supplied idempotency key (or a stable `slug` + `position_id` pair)
that duplicates an already-created agent MUST return the existing record without creating a second
Keycloak client or second DB row. This is a "best effort" idempotency seam; the exact mechanism is
autonomous (DESIGN). If omitted, the unique constraint on `(tenant_id, kc_client_id)` provides a
write-time guard.

### FR-8 — No Keycloak RBAC (Keycloak roles ≠ Choros rights)

Keycloak realm roles are NOT used to express Choros rights. The Keycloak service account carries
only `actor_type = agent` as an attribute. All role-to-grant resolution lives in the Choros TS
core. T-0042 MUST NOT assign any Keycloak realm role to the newly created service account.

---

## 3. Non-functional requirements

- **NF-1 — No second authority subsystem.** The hire authorization check uses the existing
  `mgmt_object:agent` grant shape and `scoped-admin.ts`. No new admin table, flag, or ACL store.
- **NF-2 — Additive-only changes to shared files.** `grant-lattice.ts`, `grant-resolver.ts`,
  `mcp-tool-registry.ts`, `router.ts`, and `auth.ts` are modified **additively only** (new routes,
  new imports, new exports). No refactoring of existing logic. Parallel sister tasks (T-0024, T-0060)
  merge into dev sequentially; no edit may break their seam.
- **NF-3 — Dev-auth compatibility.** The hire endpoint MUST work under `CHOROS_AUTH_MODE=dev`.
  The authority check uses the mgmt-grant model, not live JWT. Existing tests using `x-dev-user`
  must remain green.
- **NF-4 — Atomic DB + Keycloak.** If Keycloak service account creation fails, the DB transaction
  is rolled back. If the DB commit fails after a successful Keycloak call, the task MUST attempt
  to delete the orphan Keycloak client (best-effort rollback; audit the failure if the delete also
  fails).
- **NF-5 — Migration seam.** If T-0042 needs a DB migration, it is numbered **042** (both 041 and
  043 are reserved). The migration MUST be additive (no edit of prior migrations), keep T-0013
  tenant invariants (FORCE RLS / default-DENY / `tenant_id` leading), and be idempotent (ON CONFLICT
  DO NOTHING on seeds). Current assessment: no new table is required (employee + agent_card already
  exist from migration 032); IF the architect decides a new table is needed (e.g. a hire-event log),
  migration 042 is the slot.
- **NF-6 — No production credentials committed.** The Keycloak Admin REST credentials used to create
  clients are environment-variable-injected. Dev defaults may be committed; production secrets are
  founder-held (RL-1).
- **NF-7 — Keycloak Admin REST calls are behind an injected port.** The live HTTP call to Keycloak
  Admin API MUST be behind an injected interface (port/adapter pattern), so tests can substitute an
  in-memory fake. The core hire logic MUST remain unit-testable without a running Keycloak.

---

## 4. Out of scope (explicit non-goals)

1. **JWT validation of the agent's token** — T-0060 (E1.4). T-0042 creates the service account;
   T-0060 validates its tokens.
2. **Invoke-grants (who can call the agent) and request/command split** — T-0024 (E5.4).
3. **Role assignment to the new agent** — a separate admin action (E3.2/T-0022 write-path). Hire
   ends at employee + agent_card + Keycloak client creation; role assignment is a subsequent step.
4. **Agent runtime (LLM endpoint wiring, autonomy enforcement, A2A)** — Stage-2 (E5.6–E5.10);
   `llm_endpoint/llm_model/autonomy_threshold` columns exist but are runtime-dormant.
5. **BYO-LLM secret custody** — T-0025/E5.5. `llm_secret_handle` is stored but lifecycle is E5.5.
6. **Budget policy attachment** — T-0023/E4.9. `budget_policy_id` FK is deferred.
7. **Agent de-provisioning / offboarding** — not specified in E5.2; out of scope for this task.
8. **Keycloak Organizations / pooled tenancy** — deferred per tenancy ADR §6.
9. **Production Keycloak deploy** — E0.7, founder-gated (GT-4, RL-1).
10. **Dual-control gate on the hire action itself** — T-0044/E4.6. The hire requires a mgmt grant
    (FR-1) but dual-control gating (if the grant is criticality-class A/B/C) is T-0044's concern.
    T-0042 does not implement the confirmation_flag path.

---

## 5. Acceptance criteria (machine-checkable)

`test` = unit/integration test runnable in `npm run ci` (with in-memory Keycloak port or test double).
`fitness` = static lint / compile check / grep-based assertion.
`manual` = documented step (used sparingly, only where automation is not practical at SPEC time).

---

**AC-1** — Management grant required: hire blocked without grant
```
test: call POST /api/agents/hire (or equivalent) as a caller whose grants do NOT include
{mgmt_object:agent, create, <covering scope>};
→ response HTTP 403 (or equivalent typed rejection);
→ zero employee rows and zero agent_card rows created;
→ zero Keycloak Admin API calls made.
```
`verifiable_as: test`

**AC-2** — Management grant required: hire succeeds with grant
```
test: call POST /api/agents/hire as a caller who holds a confirmed in-window grant
{mgmt_object:agent, create, scope = org-root-or-admitting-subtree};
→ response HTTP 201 (or 200) with the new agent's employee_id and kc_client_id;
→ exactly one employee row (kind='agent') and one agent_card row are created.
```
`verifiable_as: test`

**AC-3** — Scope narrowing: hire rejected when target position is outside admin's org-scope
```
test: admin holds grant {mgmt_object:agent, create, scope = department D1 subtree};
call hire with position_id in department D2 (disjoint from D1);
→ response HTTP 403; zero DB rows; zero Keycloak calls.
```
`verifiable_as: test`

**AC-4** — Keycloak service account created on hire
```
test: after a successful hire, query the Keycloak Admin REST API (or the injected port's
capture log in test): the client with clientId = agent_card.kc_client_id exists,
has serviceAccountsEnabled = true, grant type = client_credentials,
and the service-account user attribute actor_type = agent.
```
`verifiable_as: test`

**AC-5** — kc_client_id stored in agent_card
```
test: SELECT kc_client_id FROM choros.agent_card WHERE employee_id = <new_agent_id>;
→ returns a non-empty string matching the clientId created in AC-4.
```
`verifiable_as: test`

**AC-6** — Atomicity: DB rollback on Keycloak failure
```
test: inject a Keycloak Admin port that fails after being called;
call hire; assert:
  → HTTP error (5xx or typed error);
  → no employee row and no agent_card row committed to DB.
```
`verifiable_as: test`

**AC-7** — Atomicity: Keycloak orphan cleanup on DB failure
```
test: inject a DB that fails on commit after Keycloak succeeds;
call hire; assert:
  → HTTP error;
  → the Keycloak Admin port's delete call was invoked for the orphan client
    (best-effort; the test verifies the attempt, not the Keycloak side-effect).
```
`verifiable_as: test`

**AC-8** — Zero tool access by construction (structural, not config)
```
test: after hire (no role assigned), call resolveAgentToolset(tenantId, newAgent.employee_id, now);
→ returns [] (empty array);
→ verify this is because getGrants returns [] for this subject (not because a deny-list blocks tools).
```
`verifiable_as: test`

**AC-9** — Identity decoupled from rights: kc_client_id not in grant lookup
```
fitness: grep the grant-resolver.ts, grant-lattice.ts, and mcp-tool-registry.ts source files;
assert none of them reference 'kc_client_id', 'agent_card', or 'kc_' in any expression
(i.e. Keycloak identity is invisible to the rights layer).
```
`verifiable_as: fitness`

**AC-10** — No Keycloak realm role assigned to new service account
```
test: after hire, query Keycloak Admin API (or test double) for the new client's service-account
user role mappings; assert the list is EMPTY (no realm roles assigned).
```
`verifiable_as: test`

**AC-11** — Hire is audited
```
test: after a successful hire, query the audit log (or the audit-event capture in test);
assert exactly one audit record with actor = caller.employee_id, subject = new agent's employee_id,
capability = {resourceType: 'mgmt_object:agent', operation: 'create'}, and a non-null scope.
```
`verifiable_as: test`

**AC-12** — Duplicate slug / kc_client_id rejected
```
test: attempt to hire an agent whose derived kc_client_id already exists in agent_card
(tenant_id, kc_client_id UNIQUE);
→ response = typed error (e.g. 409 Conflict or 'client_id_conflict');
→ no second DB row created; no second Keycloak client created.
```
`verifiable_as: test`

**AC-13** — No second authority subsystem
```
fitness: static lint asserts the hire authorization path uses only grant rows
(mgmt_object:agent × create × org-scope) + the existing scoped-admin.ts / validateNarrowing;
no admin-specific table, flag, or ACL store is introduced by this task.
```
`verifiable_as: fitness`

**AC-14** — Additive-only changes to shared files
```
fitness: git diff --name-only of grant-lattice.ts, grant-resolver.ts, mcp-tool-registry.ts
against the dev base; assert none of these files are modified (or, if modified: only new
exports/imports are added; no existing function signatures are changed; the diff is +lines only).
```
`verifiable_as: fitness`

**AC-15** — Dev-auth compatibility
```
test: with CHOROS_AUTH_MODE=dev, call the hire endpoint using x-dev-user header for the
genesis-owner employee; assert the hire succeeds (AC-2 conditions). All pre-existing tests
that use x-dev-user must remain green.
```
`verifiable_as: test`

**AC-16** — Keycloak Admin port is injectable (no live Keycloak required for unit tests)
```
fitness: the hire service's constructor / factory accepts an injected interface for
Keycloak Admin operations (create_client, delete_client); the live HTTP adapter is a separate
file; unit tests run with an in-memory implementation of this interface.
```
`verifiable_as: fitness`

**AC-17** — Migration seam (if a new migration is added)
```
fitness: IF a migration file is added by T-0042, its filename prefix is '042_' (not 041 or 043);
it is additive (no edit to existing migration files); it keeps FORCE RLS / default-DENY /
tenant_id-leading on any new table DDL; seeds use ON CONFLICT DO NOTHING.
IF no migration is needed, this AC is satisfied vacuously (state it in the contract).
```
`verifiable_as: fitness`

---

## 6. Blocking questions

**None.** All architectural decisions are ratified:

- **Agent = polymorphic employee:** ratified in GT-1 / hypothesis §3 Q7 / CONCEPT §3 / T-0020.
- **Hire = management grant on `mgmt_object:agent, create`:** ratified in E5.2 raw spec and T-0029
  (scoped-admin, `mgmt_object:agent` is a named day-1 mgmt-object kind).
- **Keycloak as identity layer with service accounts:** ratified in CONCEPT §6, stack-and-fleet-ops
  §1, T-0054 (already implemented, AC-4 pattern established).
- **Structural 0-roles → 0-tools:** ratified in hypothesis §3 Q8 and E5.3 / T-0043 (`toolset =
  query(grants)` — if no grants, no tools; not a config toggle).
- **Identity decoupled from rights:** ratified in T-0054 §3 (NF-3) + T-0021 (subject = employee_id,
  not kc_client_id).
- **T-0060 owns JWT validation / T-0024 owns invoke-grants:** task-graph explicit; these are scope
  boundaries, not open questions.
- **Migration slot 042 is reserved and clear:** 041 = T-0041 (E4.8), 043 = T-0043 (E5.3).

---

## 7. Handoff notes for the architect (non-binding)

- The hire endpoint lives at the HTTP/router layer and calls a pure hire-service that composes:
  (a) the `scoped-admin.ts` / `validateAdminDelegation` check, (b) DB INSERT for employee + agent_card,
  (c) the injected Keycloak Admin port, (d) the audit-event write. All four in a single atomic unit.
- The Keycloak Admin port interface (create_client / delete_client) is the only new IO boundary;
  the rest is DB + existing pure core modules.
- The slug-to-kc_client_id derivation rule (e.g. `agent-<slug>` with truncation + uniqueness suffix)
  is an implementation detail for DESIGN; the UNIQUE constraint in the DB is the enforcement seam.
- `llm_endpoint`, `llm_model`, `llm_secret_handle`, `autonomy_threshold`, `budget_policy_id`,
  `escalation_rule_id` are stored in agent_card as NULLs; the hire request body does NOT need to
  include these fields (they are Stage-2 / separate tasks). Accepting them optionally is autonomous.
- If the architect judges a hire-event table is needed (FR-6 / NF-5), migration slot 042 is reserved.
  The current assessment is that the existing audit_event infrastructure suffices.
